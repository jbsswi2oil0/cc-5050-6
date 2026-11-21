import { PdfBuilder, num, pdfString, type Ref } from './pdfBuilder.js';
import { applyPoint, invert, multiply, type Matrix } from './matrix.js';
import { gradientKey, gradientLocalMatrix, matrixKey, patternTileLayout } from './paintLayout.js';
import { expandBBox, pathBBox, transformBBox, transformPath } from './shapes.js';
import { toHex } from './color.js';
import type {
  BBox,
  ConversionPlan,
  ConversionState,
  LinearGradientPaint,
  ResourceLog,
  Scene,
  SceneNode,
  ScenePath,
  TileRaster,
} from './types.js';
import type { RasterImage } from './raster.js';

const BLEND_NAMES: Record<string, string> = {
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  darken: 'Darken',
  lighten: 'Lighten',
  'color-dodge': 'ColorDodge',
  'color-burn': 'ColorBurn',
  'hard-light': 'HardLight',
  'soft-light': 'SoftLight',
  difference: 'Difference',
  exclusion: 'Exclusion',
};

interface ImageEntry {
  name: string;
  ref: Ref;
}

export interface PdfBuildInput {
  scene: Scene;
  plan: ConversionPlan;
  tiles: TileRaster[];
  /** 已解码的位图对象，按对象 id 索引；缺失的位图会被跳过并记入 warnings。 */
  images?: Map<string, RasterImage>;
}

export interface PdfBuildOutput {
  bytes: Uint8Array;
  mapJson: string;
  xobjects: ImageEntry[];
  resources: ResourceLog;
}

/** 资源作用域：记录某个资源字典（页面 / Form / 图案）实际用到的名字。 */
interface ResourceScope {
  gs: Set<string>;
  patterns: Set<string>;
  xobjects: Set<string>;
}

const scopeStacks = new WeakMap<ConversionState, ResourceScope[]>();

function scopes(state: ConversionState): ResourceScope[] {
  let stack = scopeStacks.get(state);
  if (!stack) {
    stack = [];
    scopeStacks.set(state, stack);
  }
  return stack;
}

function currentScope(state: ConversionState): ResourceScope {
  const stack = scopes(state);
  return stack[stack.length - 1];
}

/** 名字只注册进当前（最内层）作用域：页面内容用的进页面字典，单元内用的进单元字典。 */
function useGs(state: ConversionState, name: string): void {
  currentScope(state).gs.add(name);
}

function usePattern(state: ConversionState, name: string): void {
  currentScope(state).patterns.add(name);
}

function useXObject(state: ConversionState, name: string): void {
  currentScope(state).xobjects.add(name);
}

export function buildPdf({ scene, plan, tiles, images }: PdfBuildInput): PdfBuildOutput {
  const builder = new PdfBuilder();
  const catalog = builder.alloc();
  const pages = builder.alloc();
  const page = builder.alloc();
  const contents = builder.alloc();
  const info = builder.alloc();

  const decisionById = new Map(plan.entries.map((e) => [e.objectId, e.decision]));
  const tileById = new Map(tiles.map((t) => [t.objectId, t]));

  const state: ConversionState = {
    builder,
    scene,
    pageFlip: [1, 0, 0, -1, 0, scene.height],
    sourceImages: images ?? new Map(),
    content: [],
    gStates: new Map(),
    gStateRefs: new Map(),
    shadingDefs: new Map(),
    shadingPatterns: new Map(),
    tilingPatterns: new Map(),
    cellForms: new Map(),
    pathForms: new Map(),
    patternRefs: new Map(),
    images: [],
    usedImageNames: new Set(),
    formXObjects: new Map(),
    planDecision: decisionById,
    planTiles: tileById,
    resourceLog: { shadings: [], shadingPatterns: [], tilingPatterns: [], forms: [], usage: [] },
  };

  scopes(state).push({ gs: new Set(), patterns: new Set(), xobjects: new Set() });

  state.content.push('q');
  // SVG 设计坐标是 y-down，PDF 是 y-up：整体翻转一次
  state.content.push(`1 0 0 -1 0 ${num(scene.height)} cm`);

  for (const child of scene.root.children) emitNode(state, child);

  state.content.push('Q');
  builder.stream(contents, new TextEncoder().encode(state.content.join('\n') + '\n'), '');

  const pageScope = scopes(state).pop()!;
  // 资源字典：只收页面作用域真正用到的名字
  const xobjectEntries = state.images.filter((x) => pageScope.xobjects.has(x.name));
  for (const { name, ref } of state.pathForms.values()) {
    if (pageScope.xobjects.has(name)) xobjectEntries.push({ name, ref });
  }
  const imageDict = xobjectEntries.length
    ? ` /XObject << ${xobjectEntries.map((x) => `/${x.name} ${x.ref.id} 0 R`).join(' ')} >>`
    : '';
  const gsEntries = [...state.gStateRefs.entries()].filter(([key]) => pageScope.gs.has(key));
  const gsDict = gsEntries.length
    ? ` /ExtGState << ${gsEntries.map(([key, ref]) => `/${key} ${ref.id} 0 R`).join(' ')} >>`
    : '';
  const patternEntries = [...state.patternRefs.entries()].filter(([key]) => pageScope.patterns.has(key));
  const patternDict = patternEntries.length
    ? ` /Pattern << ${patternEntries.map(([key, entry]) => `/${key} ${entry.ref.id} 0 R`).join(' ')} >>`
    : '';

  builder.set(
    page,
    `<< /Type /Page /Parent ${pages.id} 0 R /MediaBox [0 0 ${num(scene.width)} ${num(scene.height)}] /Resources <<${imageDict}${gsDict}${patternDict} /ProcSet [/PDF] >> /Contents ${contents.id} 0 R >>`,
  );
  builder.set(pages, `<< /Type /Pages /Kids [${page.id} 0 R] /Count 1 >>`);

  const mapJson = JSON.stringify(buildMap(scene, plan, state.resourceLog));
  const mapRef = builder.alloc();
  builder.stream(mapRef, new TextEncoder().encode(mapJson), '/Type /EmbeddedFile /Subtype /text#2Fjson');
  const filespec = builder.alloc();
  builder.set(
    filespec,
    `<< /Type /Filespec /F (inkplate-object-map.json) /UF (inkplate-object-map.json) /EF << /F ${mapRef.id} 0 R /UF ${mapRef.id} 0 R >> >>`,
  );
  builder.set(
    catalog,
    `<< /Type /Catalog /Pages ${pages.id} 0 R /Names << /EmbeddedFiles << /Names [(inkplate-object-map.json) ${filespec.id} 0 R] >> >> >>`,
  );
  builder.set(
    info,
    `<< /Title ${pdfString('Inkplate — SVG 转 PDF')} /Producer ${pdfString('Inkplate SVG→PDF Studio')} /Creator ${pdfString('Inkplate')} /ObjectMap ${pdfString(truncateForInfo(mapJson))} ${plan.strict ? '/StrictExport true' : '/StrictExport false'} >>`,
  );

  const bytes = builder.serialize(catalog, info);
  return { bytes, mapJson, xobjects: state.images, resources: state.resourceLog };
}

function emitNode(state: ConversionState, node: SceneNode): void {
  const decision = decisionOf(state, node);
  if (decision === 'reject') return;
  beginMarked(state, node);
  const clipPushed = applyOwnClip(state, node);
  if (decision === 'raster') {
    const raster = state.planTiles?.get(node.id);
    if (raster) emitTile(state, node, raster);
  } else if (node.kind === 'group') {
    emitGroup(state, node);
  } else if (node.kind === 'path') {
    emitPath(state, node);
  } else if (node.kind === 'image') {
    emitImage(state, node);
  }
  if (clipPushed) state.content.push('Q');
  state.content.push('EMC');
}

function emitGroup(state: ConversionState, node: Extract<SceneNode, { kind: 'group' }>): void {
  state.content.push('q');
  if (node.opacity < 0.999) {
    const name = gStateName(state, { alpha: node.opacity });
    state.content.push(`/${name} gs`);
  }
  if (node.blend !== 'normal' && node.blend) {
    const name = gStateName(state, { blend: node.blend });
    state.content.push(`/${name} gs`);
  }
  for (const child of node.children) emitNode(state, child);
  state.content.push('Q');
}

function emitPath(state: ConversionState, node: ScenePath): void {
  if (!node.fill && !node.stroke) return;
  state.content.push('q');
  const fillAlpha = node.fill && node.fill.type === 'solid' ? node.fill.color.a : 1;
  const alpha = node.opacity * fillAlpha;
  if (alpha < 0.999) {
    state.content.push(`/${gStateName(state, { alpha })} gs`);
  }
  if (node.blend !== 'normal' && node.blend) {
    state.content.push(`/${gStateName(state, { blend: node.blend })} gs`);
  }
  // 实例变换（镜像/缩放/平移）留在使用点的 cm，不写进任何共享资源
  state.content.push(pdfCm(node.absTransform));

  const usage: ResourceLog['usage'][number] = {
    object: node.id,
    fillKind: node.fill ? (node.fill.type === 'solid' ? 'solid' : node.fill.type === 'linear' ? 'gradient' : 'pattern') : 'none',
  };

  // 填充设置留在使用点：纯色直接 rg；渐变/图案选择各自的 Pattern 包装
  if (node.fill?.type === 'solid') {
    const c = node.fill.color;
    state.content.push(`${num(c.r / 255)} ${num(c.g / 255)} ${num(c.b / 255)} rg`);
  } else if (node.fill?.type === 'linear') {
    // PDF 图案的 /Matrix 映射到「父内容流的默认坐标系」：
    // 页级内联填充的父流是页面内容流 → 写完整链路（页面翻转 · 实例变换 · 局部映射）；
    // 共享路径 Form 内填充的父流是该 Form → Do 点的 cm（翻转 · 实例变换）已成为
    // Form 的默认坐标系，/Matrix 只写局部映射，否则实例变换会被应用两次。
    const local = gradientLocalMatrix(node.fill, node.localBounds);
    const matrix = node.resourceId
      ? local
      : multiply(state.pageFlip, multiply(node.absTransform, local));
    const name = shadingPatternFor(state, node.fill, matrix, node.id);
    state.content.push(`/Pattern cs /${name} scn`);
    usage.resource = name;
  } else if (node.fill?.type === 'pattern') {
    const name = tilingPatternFor(state, node);
    if (name) {
      state.content.push(`/Pattern cs /${name} scn`);
      usage.resource = name;
      const info = state.resourceLog.tilingPatterns.find((t) => t.name === name);
      if (info) {
        usage.tileOriginLocal = [info.matrix[4], info.matrix[5]];
        const [dx, dy] = applyPoint(node.absTransform, info.matrix[4], info.matrix[5]);
        usage.tileOriginDesign = [round2(dx), round2(dy)];
        usage.periodLocal = info.step;
        const [x0, y0] = applyPoint(node.absTransform, 0, 0);
        const [ux, uy] = applyPoint(node.absTransform, info.step[0], 0);
        const [vx, vy] = applyPoint(node.absTransform, 0, info.step[1]);
        usage.periodDesign = [round2(Math.hypot(ux - x0, uy - y0)), round2(Math.hypot(vx - x0, vy - y0))];
      }
    }
  }

  if (node.stroke) {
    const sc = node.stroke;
    if (sc.a < 0.999) {
      state.content.push(`/${gStateName(state, { alpha: node.opacity * sc.a })} gs`);
    }
    state.content.push(`${num(sc.r / 255)} ${num(sc.g / 255)} ${num(sc.b / 255)} RG`);
    state.content.push(`${num(node.strokeWidth)} w`);
    state.content.push(`${capCode(node.lineCap)} J`);
    state.content.push(`${joinCode(node.lineJoin)} j`);
    state.content.push(`${num(node.miterLimit)} M`);
    if (node.dash.length) state.content.push(`[${node.dash.map(num).join(' ')}] 0 d`);
  }

  if (node.resourceId) {
    // 共享几何：路径只写进 Form XObject 一次，使用点 Do 引用
    const formName = pathFormFor(state, node);
    state.content.push(`/${formName} Do`);
    usage.pathForm = formName;
  } else {
    state.content.push(pdfPath(node.d));
    if (node.fill) state.content.push(node.fillRule === 'evenodd' ? 'f*' : 'f');
    if (node.stroke) {
      if (node.fill) state.content.push(pdfPath(node.d));
      state.content.push('S');
    }
  }
  state.content.push('Q');
  state.resourceLog.usage.push(usage);
}

/** 共享路径 Form XObject：只含几何与绘制算子，颜色状态由使用点继承。 */
function pathFormFor(state: ConversionState, node: ScenePath): string {
  const signature = `${node.resourceId}|${node.fillRule}|${node.fill ? 'f' : ''}${node.stroke ? `s${node.strokeWidth}` : ''}`;
  const existing = state.pathForms.get(signature);
  if (existing) {
    const info = state.resourceLog.forms.find((f) => f.name === existing.name);
    if (info && !info.usedBy.includes(node.id)) info.usedBy.push(node.id);
    return existing.name;
  }
  const ref = state.builder.alloc();
  const name = `Fm${ref.id}`;
  const ops: string[] = [pdfPath(node.d)];
  if (node.fill) ops.push(node.fillRule === 'evenodd' ? 'f*' : 'f');
  if (node.stroke) {
    if (node.fill) ops.push(pdfPath(node.d));
    ops.push('S');
  }
  const bbox = node.stroke
    ? expandBBox(node.localBounds, (node.strokeWidth * node.miterLimit) / 2)
    : node.localBounds;
  state.builder.stream(
    ref,
    new TextEncoder().encode(ops.join('\n') + '\n'),
    `/Type /XObject /Subtype /Form /BBox [${num(bbox.x)} ${num(bbox.y)} ${num(bbox.x + bbox.w)} ${num(bbox.y + bbox.h)}] /Matrix [1 0 0 1 0 0] /Resources << >>`,
  );
  state.pathForms.set(signature, { name, ref });
  useXObject(state, name);
  state.resourceLog.forms.push({
    name,
    objectId: ref.id,
    kind: 'shared-path',
    sourceId: node.resourceId!,
    bbox: [round2(bbox.x), round2(bbox.y), round2(bbox.x + bbox.w), round2(bbox.y + bbox.h)],
    usedBy: [node.id],
  });
  return name;
}

/** 共享 Shading：色标与定义空间向量，同一渐变定义只写一份。 */
function shadingDefFor(state: ConversionState, paint: LinearGradientPaint): { name: string; ref: Ref } {
  const key = gradientKey(paint);
  const existing = state.shadingDefs.get(key);
  if (existing) return existing;
  const ref = state.builder.alloc();
  const stops = paint.stops;
  const fnRefs: Ref[] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i].color;
    const b = stops[i + 1].color;
    const fn = state.builder.alloc();
    state.builder.set(
      fn,
      `<< /FunctionType 2 /Domain [0 1] /C0 [${num(a.r / 255)} ${num(a.g / 255)} ${num(a.b / 255)}] /C1 [${num(b.r / 255)} ${num(b.g / 255)} ${num(b.b / 255)}] /N 1 >>`,
    );
    fnRefs.push(fn);
  }
  const fnDict =
    fnRefs.length === 1
      ? `${fnRefs[0].id} 0 R`
      : `<< /FunctionType 3 /Domain [0 1] /Functions [${fnRefs.map((f) => `${f.id} 0 R`).join(' ')}] /Bounds [${stops.slice(1, -1).map((s) => num(s.offset)).join(' ')}] /Encode [${stops.slice(0, -1).flatMap(() => [0, 1]).join(' ')}] >>`;
  state.builder.set(
    ref,
    `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${num(paint.x1)} ${num(paint.y1)} ${num(paint.x2)} ${num(paint.y2)}] /Function ${fnDict} /Extend [true true] >>`,
  );
  const name = `Sh${ref.id}`;
  const entry = { name, ref };
  state.shadingDefs.set(key, entry);
  const gradientId = findGradientId(state.scene, paint);
  state.resourceLog.shadings.push({
    name,
    objectId: ref.id,
    gradientId,
    coords: [paint.x1, paint.y1, paint.x2, paint.y2],
    stops: paint.stops.map((s) => ({ offset: s.offset, color: toHex(s.color) })),
  });
  return entry;
}

function findGradientId(scene: Scene, paint: LinearGradientPaint): string | null {
  for (const [id, g] of scene.gradients) {
    if (g === paint) return id;
  }
  return null;
}

/** 每使用点的 shading-pattern 包装：共享 Shading + 本使用点的坐标系矩阵 /Matrix。 */
function shadingPatternFor(
  state: ConversionState,
  paint: LinearGradientPaint,
  matrix: Matrix,
  userId: string,
): string {
  const shading = shadingDefFor(state, paint);
  const key = `${gradientKey(paint)}|${matrixKey(matrix)}`;
  const existing = state.shadingPatterns.get(key);
  if (existing) {
    const info = state.resourceLog.shadingPatterns.find((p) => p.name === existing.name);
    if (info && !info.usedBy.includes(userId)) info.usedBy.push(userId);
    usePattern(state, existing.name);
    return existing.name;
  }
  const ref = state.builder.alloc();
  const name = `P${ref.id}`;
  state.builder.set(
    ref,
    `<< /Type /Pattern /PatternType 2 /Shading ${shading.ref.id} 0 R /Matrix [${matrix.map(num).join(' ')}] >>`,
  );
  state.shadingPatterns.set(key, { name, ref });
  state.patternRefs.set(name, { name, ref });
  usePattern(state, name);
  state.resourceLog.shadingPatterns.push({
    name,
    objectId: ref.id,
    shading: shading.name,
    matrix: matrix.map((v) => round2(v)),
    usedBy: [userId],
  });
  return name;
}

/** 平铺图案：单元内容共享 Form XObject；原点覆盖只生成本实例的第二个 Pattern 字典。 */
function tilingPatternFor(state: ConversionState, node: ScenePath): string | null {
  if (node.fill?.type !== 'pattern') return null;
  const def = state.scene.patterns.get(node.fill.id);
  if (!def) return null;
  const layout = patternTileLayout(def, node.localBounds, node.patternOriginOverride);
  const cell = cellFormFor(state, def, layout.contentToTile);
  // 与渐变同理：/Matrix 相对父内容流的默认坐标系。
  // 页级内联填充写完整链路；共享路径 Form 内的填充只写局部 tileToLocal——
  // 实例变换由 Do 点的 cm 承担，于是同一图案定义在不同实例间共享同一字典，
  // 只有「仅实例」原点覆盖才派生额外字典。
  const matrix = node.resourceId
    ? layout.tileToLocal
    : multiply(state.pageFlip, multiply(node.absTransform, layout.tileToLocal));
  const key = `${def.id}|${matrixKey(matrix)}|${cell.name}`;
  const existing = state.tilingPatterns.get(key);
  if (existing) {
    const info = state.resourceLog.tilingPatterns.find((p) => p.name === existing.name);
    if (info && !info.usedBy.includes(node.id)) info.usedBy.push(node.id);
    usePattern(state, existing.name);
    return existing.name;
  }
  const ref = state.builder.alloc();
  const name = `P${ref.id}`;
  const [sx, sy] = layout.step;
  state.builder.stream(
    ref,
    new TextEncoder().encode(`/${cell.name} Do\n`),
    `/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 ${num(sx)} ${num(sy)}] /XStep ${num(sx)} /YStep ${num(sy)} /Matrix [${matrix.map(num).join(' ')}] /Resources << /XObject << /${cell.name} ${cell.ref.id} 0 R >> >>`,
  );
  state.tilingPatterns.set(key, { name, ref });
  state.patternRefs.set(name, { name, ref });
  usePattern(state, name);
  state.resourceLog.tilingPatterns.push({
    name,
    objectId: ref.id,
    patternId: def.id,
    matrix: layout.tileToLocal.map((v) => round2(v)),
    step: [round2(sx), round2(sy)],
    bbox: [0, 0, round2(sx), round2(sy)],
    cellForm: cell.name,
    override: node.patternOriginOverride ? { ...node.patternOriginOverride } : null,
    usedBy: [node.id],
  });
  return name;
}

/**
 * 图案单元内容 Form XObject：单元内渐变在此解析，矩阵与任何实例无关。
 * 内容在发射时直接烘进单元（tile）坐标、Form 不带 /Matrix——
 * 这样无论阅读器把图案的父坐标系理解为「Form 空间」还是「外层流空间」，
 * 单元内渐变的位置都一致（两种解释在 /Matrix 为单位阵时重合）。
 */
function cellFormFor(
  state: ConversionState,
  def: import('./types.js').PatternDef,
  contentToTile: Matrix,
): { name: string; ref: Ref } {
  const key = `${def.id}|${matrixKey(contentToTile)}`;
  const existing = state.cellForms.get(key);
  if (existing) return existing;

  // 单元内容在独立作用域发射，收集自己的资源字典
  scopes(state).push({ gs: new Set(), patterns: new Set(), xobjects: new Set() });
  const savedContent = state.content;
  state.content = [];
  const contentBBox = transformBBox(contentSpaceBBox(def), contentToTile);
  for (const shape of def.shapes) {
    if (!shape.fill) continue;
    state.content.push('q');
    const alpha = shape.opacity * (shape.fill.type === 'solid' ? shape.fill.color.a : 1);
    if (alpha < 0.999) state.content.push(`/${gStateName(state, { alpha })} gs`);
    if (shape.fill.type === 'solid') {
      const c = shape.fill.color;
      state.content.push(`${num(c.r / 255)} ${num(c.g / 255)} ${num(c.b / 255)} rg`);
    } else if (shape.fill.type === 'linear') {
      // 单元内渐变：Matrix 只含内容→单元的映射，实例变换永不进入共享单元
      const shapeBox = pathBBox(shape.d);
      const matrix = multiply(contentToTile, gradientLocalMatrix(shape.fill, shapeBox));
      const name = shadingPatternFor(state, shape.fill, matrix, `cell:${def.id}`);
      state.content.push(`/Pattern cs /${name} scn`);
    }
    state.content.push(pdfPath(transformPath(shape.d, contentToTile)));
    state.content.push(shape.fillRule === 'evenodd' ? 'f*' : 'f');
    state.content.push('Q');
  }
  const body = state.content.join('\n') + '\n';
  state.content = savedContent;
  const scope = scopes(state).pop()!;

  const ref = state.builder.alloc();
  const name = `Fm${ref.id}`;
  const gsPart = scope.gs.size
    ? ` /ExtGState << ${[...scope.gs].map((g) => `/${g} ${state.gStateRefs.get(g)!.id} 0 R`).join(' ')} >>`
    : '';
  const patPart = scope.patterns.size
    ? ` /Pattern << ${[...scope.patterns].map((p) => `/${p} ${state.patternRefs.get(p)!.ref.id} 0 R`).join(' ')} >>`
    : '';
  state.builder.stream(
    ref,
    new TextEncoder().encode(body),
    `/Type /XObject /Subtype /Form /BBox [${num(contentBBox.x)} ${num(contentBBox.y)} ${num(contentBBox.x + contentBBox.w)} ${num(contentBBox.y + contentBBox.h)}] /Resources <<${gsPart}${patPart} >>`,
  );
  const entry = { name, ref };
  state.cellForms.set(key, entry);
  state.resourceLog.forms.push({
    name,
    objectId: ref.id,
    kind: 'pattern-cell',
    sourceId: def.id,
    bbox: [round2(contentBBox.x), round2(contentBBox.y), round2(contentBBox.x + contentBBox.w), round2(contentBBox.y + contentBBox.h)],
    usedBy: [],
  });
  return entry;
}

/** 单元内容在内容空间中的包围盒（所有形状几何之并）。 */
function contentSpaceBBox(def: { shapes: { d: string }[]; x: number; y: number; width: number; height: number }): BBox {
  let box: BBox = { x: def.x, y: def.y, w: def.width, h: def.height };
  for (const s of def.shapes) {
    const b = pathBBox(s.d);
    const x = Math.min(box.x, b.x);
    const y = Math.min(box.y, b.y);
    box = {
      x,
      y,
      w: Math.max(box.x + box.w, b.x + b.w) - x,
      h: Math.max(box.y + box.h, b.y + b.h) - y,
    };
  }
  return box;
}

function emitImage(state: ConversionState, node: Extract<SceneNode, { kind: 'image' }>): void {
  const image = state.sourceImages.get(node.id);
  if (!image) {
    state.content.push(`% image ${node.id}: missing or unsupported source`);
    return;
  }
  const ref = state.builder.alloc();
  const alphaRef = state.builder.alloc();
  const rgbBytes = new Uint8Array(image.width * image.height * 3);
  const alphaBytes = new Uint8Array(image.width * image.height);
  let opaque = true;
  for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
    rgbBytes[p * 3] = image.data[i];
    rgbBytes[p * 3 + 1] = image.data[i + 1];
    rgbBytes[p * 3 + 2] = image.data[i + 2];
    alphaBytes[p] = image.data[i + 3];
    if (image.data[i + 3] < 255) opaque = false;
  }
  const smask = opaque ? '' : ` /SMask ${alphaRef.id} 0 R`;
  state.builder.stream(
    ref,
    rgbBytes,
    `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8${smask}`,
  );
  if (!opaque) {
    state.builder.stream(
      alphaRef,
      alphaBytes,
      `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8`,
    );
  } else {
    state.builder.set(alphaRef, '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 0 >>\nstream\n\nendstream');
  }
  const name = imageName(state, `Image_${node.id}`);
  state.images.push({ name, ref });
  useXObject(state, name);

  state.content.push('q');
  state.content.push(pdfCm(node.absTransform));
  // 图像单位正方形的第 0 行在 v=1；设计坐标里先按 (x, y+h) 放好再交给页面整体翻转
  const img = node.localBounds;
  state.content.push(
    `${num(img.w)} 0 0 ${num(-img.h)} ${num(img.x)} ${num(img.y + img.h)} cm`,
  );
  state.content.push(`/${name} Do`);
  state.content.push('Q');
}

function emitTile(state: ConversionState, node: SceneNode, tile: TileRaster): void {
  const ref = state.builder.alloc();
  const alphaRef = state.builder.alloc();
  const rgbBytes = new Uint8Array(tile.width * tile.height * 3);
  const alphaBytes = new Uint8Array(tile.width * tile.height);
  let opaque = true;
  for (let i = 0, p = 0; i < tile.rgba.length; i += 4, p++) {
    rgbBytes[p * 3] = tile.rgba[i];
    rgbBytes[p * 3 + 1] = tile.rgba[i + 1];
    rgbBytes[p * 3 + 2] = tile.rgba[i + 2];
    alphaBytes[p] = tile.rgba[i + 3];
    if (tile.rgba[i + 3] < 255) opaque = false;
  }
  const smask = opaque ? '' : ` /SMask ${alphaRef.id} 0 R`;
  state.builder.stream(
    ref,
    rgbBytes,
    `/Type /XObject /Subtype /Image /Width ${tile.width} /Height ${tile.height} /ColorSpace /DeviceRGB /BitsPerComponent 8${smask}`,
  );
  if (!opaque) {
    state.builder.stream(
      alphaRef,
      alphaBytes,
      `/Type /XObject /Subtype /Image /Width ${tile.width} /Height ${tile.height} /ColorSpace /DeviceGray /BitsPerComponent 8`,
    );
  } else {
    state.builder.set(alphaRef, '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 0 >>\nstream\n\nendstream');
  }
  const name = imageName(state, `Tile_${node.id}`);
  state.images.push({ name, ref });
  useXObject(state, name);

  state.content.push('q');
  state.content.push(pdfCm(node.absTransform));
  const b: BBox = tile.paintBounds;
  // paintBounds 在世界（设计）系；当前用户系是 absTransform 之后的局部系，
  // 所以图像摆放矩阵 = 局部化（absTransform 逆）· 世界系摆放（含像素行 y 翻转）。
  // 链式合成后 absTransform 抵消，镜像/缩放实例的瓦片也能落回原位。
  const placement = multiply(
    invert(node.absTransform),
    [b.w, 0, 0, -b.h, b.x, b.y + b.h],
  );
  state.content.push(pdfCm(placement));
  state.content.push(`/${name} Do`);
  state.content.push('Q');
}

/**
 * 只把节点自身的裁剪入栈；祖先裁剪随祖先的 q/Q 作用域自然继承。
 * 返回 true 表示调用方需要在画完内容后补一个 Q。
 */
function applyOwnClip(state: ConversionState, node: SceneNode): boolean {
  if (!node.clip) return false;
  state.content.push('q');
  state.content.push(pdfPath(node.clip.d));
  state.content.push(node.clip.fillRule === 'evenodd' ? 'W* n' : 'W n');
  return true;
}

function decisionOf(state: ConversionState, node: SceneNode): string {
  return state.planDecision?.get(node.id) ?? 'vector-path';
}

function gStateName(state: ConversionState, info: { alpha?: number; blend?: string }): string {
  const key = `${info.alpha != null ? `a${Math.round(info.alpha * 1000)}` : ''}${info.blend ? `b${info.blend}` : ''}`;
  const table = gStateNames(state);
  const found = table.get(key);
  if (found) {
    useGs(state, found);
    return found;
  }
  const ref = state.builder.alloc();
  const name = `GS${ref.id}`;
  const parts: string[] = ['<< /Type /ExtGState'];
  if (info.alpha != null) parts.push(`/ca ${num(info.alpha)} /CA ${num(info.alpha)}`);
  if (info.blend) parts.push(`/BM /${BLEND_NAMES[info.blend] ?? 'Normal'}`);
  parts.push('>>');
  state.builder.set(ref, parts.join(' '));
  state.gStateRefs.set(name, ref);
  table.set(key, name);
  useGs(state, name);
  return name;
}

const gStateKeyTables = new WeakMap<ConversionState, Map<string, string>>();
function gStateNames(state: ConversionState): Map<string, string> {
  let table = gStateKeyTables.get(state);
  if (!table) {
    table = new Map();
    gStateKeyTables.set(state, table);
  }
  return table;
}

function imageName(state: ConversionState, base: string): string {
  let name = base.replace(/[^\w]/g, '_');
  let i = 1;
  while (state.usedImageNames.has(name)) name = `${base.replace(/[^\w]/g, '_')}_${i++}`;
  state.usedImageNames.add(name);
  return name;
}

function pdfCm(m: [number, number, number, number, number, number]): string {
  return `${m.map(num).join(' ')} cm`;
}

function capCode(cap: 'butt' | 'round' | 'square'): number {
  return cap === 'round' ? 1 : cap === 'square' ? 2 : 0;
}

function joinCode(join: 'miter' | 'round' | 'bevel'): number {
  return join === 'round' ? 1 : join === 'bevel' ? 2 : 0;
}

/** 把归一化 SVG 路径（M/L/C/Z，空格分隔）转为 PDF 路径指令（操作符在参数之后）。 */
export function pdfPath(d: string): string {
  const out: string[] = [];
  const tokens = d.match(/[MLCZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  let args: string[] = [];
  let op: string | null = null;
  const emit = () => {
    if (!op) return;
    if (op === 'Z') out.push('h');
    else if (args.length) out.push(`${args.join(' ')} ${op.toLowerCase()}`);
    args = [];
  };
  for (const t of tokens) {
    if (/^[MLCZ]$/i.test(t)) {
      emit();
      op = t.toUpperCase();
    } else {
      args.push(t);
    }
  }
  emit();
  return out.join('\n');
}

function beginMarked(state: ConversionState, node: SceneNode): void {
  const tag = node.id.replace(/[^\w.+-]/g, '_');
  state.content.push(`/${tag} BMC`);
}

export const TRANSFORM_SPLIT_NOTES = [
  '写进共享资源：渐变色标与定义空间向量（Shading）、图案单元几何与单元内渐变（Form XObject）、平铺周期 XStep/YStep、共享路径几何（Form XObject）、平铺原点（Pattern /Matrix 的局部映射，实例间共享同一字典）。',
  '留在使用点：实例的镜像/缩放/平移（内容流 cm，作用于几何与图案定位）、objectBoundingBox→实例包围盒的映射（各使用点专属 Pattern 字典）、单实例图案原点覆盖（仅该实例派生一份新字典）。',
  '注意：PDF 图案的 /Matrix 映射到父内容流的默认坐标系。页级内联填充的父流是页面内容流，/Matrix 写完整链路（页面翻转 · 实例变换 · 局部映射）；共享路径 Form 内填充的父流是该 Form，Do 点的 cm 已成为其默认坐标系，/Matrix 只写局部映射——否则实例变换被应用两次。',
];

function buildMap(scene: Scene, plan: ConversionPlan, log: ResourceLog): unknown {
  const usageByObject = new Map(log.usage.map((u) => [u.object, u]));
  return {
    version: 2,
    generator: 'Inkplate SVG→PDF Studio',
    page: { width: scene.width, height: scene.height },
    profile: plan.profileId,
    profileName: plan.profileName,
    strict: plan.strict,
    status: plan.status,
    stats: plan.stats,
    notes: plan.notes,
    objects: plan.entries.map((e) => {
      const node = scene.byId.get(e.objectId);
      const usage = usageByObject.get(e.objectId);
      const item: Record<string, unknown> = {
        id: e.objectId,
        label: e.label,
        kind: e.kind,
        decision: e.decision,
        features: e.features,
        bounds: roundBox(node?.worldBounds ?? e.bounds),
        parent: node?.parentId ?? 'root',
        depth: e.depth,
        reason: e.reason,
      };
      if (e.strategy) item.strategy = e.strategy;
      if (e.paintBounds) item.paintBounds = roundBox(e.paintBounds);
      if (e.readBounds) item.readBounds = roundBox(e.readBounds);
      if (node?.kind === 'path' && node.resourceId) item.resourceId = node.resourceId;
      if (usage) {
        item.fill = usage.fillKind;
        if (usage.resource) item.paintResource = usage.resource;
        if (usage.pathForm) item.pathForm = usage.pathForm;
        if (usage.tileOriginLocal) {
          item.tileOriginLocal = usage.tileOriginLocal;
          item.tileOriginDesign = usage.tileOriginDesign;
          item.periodLocal = usage.periodLocal;
          item.periodDesign = usage.periodDesign;
        }
      }
      return item;
    }),
    resources: {
      transformSplit: TRANSFORM_SPLIT_NOTES,
      shadings: log.shadings,
      shadingPatterns: log.shadingPatterns,
      tilingPatterns: log.tilingPatterns,
      forms: log.forms,
    },
    tiles: plan.tiles.map((t) => ({
      objectId: t.objectId,
      label: t.label,
      strategy: t.strategy,
      feature: t.feature,
      paintBounds: roundBox(t.paintBounds),
      readBounds: roundBox(t.readBounds),
      participationBounds: t.participationBounds ? roundBox(t.participationBounds) : null,
      backgroundDependent: t.backgroundDependent,
      backdropIds: t.backdropIds,
      note: t.note,
    })),
    refusals: plan.refusals,
  };
}

function roundBox(b: BBox): BBox {
  const r = (v: number) => Math.round(v * 100) / 100;
  return { x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h) };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function truncateForInfo(json: string): string {
  return json.length > 3000 ? json.slice(0, 3000) : json;
}
