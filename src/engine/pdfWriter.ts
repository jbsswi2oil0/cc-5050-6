import { PdfBuilder, num, pdfString, type Ref } from './pdfBuilder.js';
import { gradientWorldPoints } from './parseSvg.js';
import type { BBox, ConversionPlan, ConversionState, Scene, SceneNode, TileRaster } from './types.js';
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
    sourceImages: images ?? new Map(),
    content: [],
    gStates: new Map(),
    gStateRefs: new Map(),
    shadings: new Map(),
    shadingRefs: new Map(),
    images: [],
    usedImageNames: new Set(),
    formXObjects: new Map(),
    planDecision: decisionById,
    planTiles: tileById,
  };

  state.content.push('q');
  // SVG 设计坐标是 y-down，PDF 是 y-up：整体翻转一次
  state.content.push(`1 0 0 -1 0 ${num(scene.height)} cm`);

  for (const child of scene.root.children) emitNode(state, child);

  state.content.push('Q');
  builder.stream(contents, new TextEncoder().encode(state.content.join('\n') + '\n'), '');

  // 资源字典
  const imageDict = state.images.length
    ? ` /XObject << ${state.images.map((x) => `/${x.name} ${x.ref.id} 0 R`).join(' ')} >>`
    : '';
  const gsEntries = [...state.gStateRefs.entries()];
  const shadingEntries = [...state.shadingRefs.entries()];
  const gsDict = gsEntries.length
    ? ` /ExtGState << ${gsEntries.map(([key, ref]) => `/${key} ${ref.id} 0 R`).join(' ')} >>`
    : '';
  const shadingDict = shadingEntries.length
    ? ` /Shading << ${shadingEntries.map(([key, entry]) => `/${key} ${entry.ref.id} 0 R`).join(' ')} >>`
    : '';

  builder.set(
    page,
    `<< /Type /Page /Parent ${pages.id} 0 R /MediaBox [0 0 ${num(scene.width)} ${num(scene.height)}] /Resources <<${imageDict}${gsDict}${shadingDict} /ProcSet [/PDF] >> /Contents ${contents.id} 0 R >>`,
  );
  builder.set(pages, `<< /Type /Pages /Kids [${page.id} 0 R] /Count 1 >>`);

  const mapJson = JSON.stringify(buildMap(scene, plan));
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
    `<< /Title ${pdfString('叶与光 — SVG 转 PDF')} /Producer ${pdfString('Inkplate SVG→PDF Studio')} /Creator ${pdfString('Inkplate')} /ObjectMap ${pdfString(truncateForInfo(mapJson))} ${plan.strict ? '/StrictExport true' : '/StrictExport false'} >>`,
  );

  const bytes = builder.serialize(catalog, info);
  return { bytes, mapJson, xobjects: state.images };
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

function emitPath(state: ConversionState, node: Extract<SceneNode, { kind: 'path' }>): void {
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
  state.content.push(pdfCm(node.absTransform));
  state.content.push(pdfPath(node.d));

  if (node.fill) {
    if (node.fill.type === 'linear') {
      const name = shadingFor(state, node);
      state.content.push(`/${name} sh`);
    } else {
      const c = node.fill.color;
      state.content.push(`${num(c.r / 255)} ${num(c.g / 255)} ${num(c.b / 255)} rg`);
      state.content.push(node.fillRule === 'evenodd' ? 'f*' : 'f');
    }
  }
  if (node.stroke) {
    const sc = node.stroke;
    if (sc.a < 0.999) {
      // 描边透明度单独一层：用一次透明度组的软形式不可行，改为累积到 ExtGState
      state.content.push(`/${gStateName(state, { alpha: node.opacity * sc.a })} gs`);
    }
    state.content.push(`${num(sc.r / 255)} ${num(sc.g / 255)} ${num(sc.b / 255)} RG`);
    state.content.push(`${num(node.strokeWidth)} w`);
    state.content.push(`${capCode(node.lineCap)} J`);
    state.content.push(`${joinCode(node.lineJoin)} j`);
    state.content.push(`${num(node.miterLimit)} M`);
    if (node.dash.length) state.content.push(`[${node.dash.map(num).join(' ')}] 0 d`);
    if (node.fill) {
      // 需要重新描一遍路径
      state.content.push(pdfPath(node.d));
    }
    state.content.push('S');
  }
  state.content.push('Q');
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

  state.content.push('q');
  state.content.push(pdfCm(node.absTransform));
  const b: BBox = tile.paintBounds;
  // 像素行是 y-down，先翻转图像坐标系再放进 paintBounds
  state.content.push(`${num(b.w)} 0 0 ${num(-b.h)} ${num(b.x)} ${num(b.y + b.h)} cm`);
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
  if (found) return found;
  const ref = state.builder.alloc();
  const name = `GS${ref.id}`;
  const parts: string[] = ['<< /Type /ExtGState'];
  if (info.alpha != null) parts.push(`/ca ${num(info.alpha)} /CA ${num(info.alpha)}`);
  if (info.blend) parts.push(`/BM /${BLEND_NAMES[info.blend] ?? 'Normal'}`);
  parts.push('>>');
  state.builder.set(ref, parts.join(' '));
  state.gStateRefs.set(name, ref);
  table.set(key, name);
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

function shadingFor(state: ConversionState, node: Extract<SceneNode, { kind: 'path' }>): string {
  const existing = state.shadingRefs.get(node.id);
  if (existing) return existing.name;
  const fill = node.fill;
  if (!fill || fill.type !== 'linear') return '';
  const ref = state.builder.alloc();
  const pts = gradientWorldPoints(fill, node.localBounds, node.absTransform);
  const stops = fill.stops;
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
    `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${num(pts.x1)} ${num(pts.y1)} ${num(pts.x2)} ${num(pts.y2)}] /Function ${fnDict} /Extend [true true] >>`,
  );
  const name = `Sh${ref.id}`;
  state.shadingRefs.set(node.id, { name, ref });
  return name;
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

function buildMap(scene: Scene, plan: ConversionPlan): unknown {
  return {
    version: 1,
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
      return item;
    }),
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

function truncateForInfo(json: string): string {
  return json.length > 3000 ? json.slice(0, 3000) : json;
}

