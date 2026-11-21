import { getProfile, isSupported, FEATURE_LABELS } from './capabilities.js';
import { expandBBox, intersectBBox, snapBBox } from './shapes.js';
import type {
  BBox,
  ConversionPlan,
  Feature,
  PlanEntry,
  RasterStrategy,
  RasterTilePlan,
  Refusal,
  Scene,
  SceneNode,
} from './types.js';

export interface PlanOptions {
  profileId: string;
  strict: boolean;
  /** 局部栅格的采样密度（像素 / 设计单位）。 */
  rasterScale: number;
}

const RASTER_FEATURES: Feature[] = [
  'blur',
  'filter-other',
  'blend-multiply',
  'blend-other',
  'mask',
  'gradient-alpha',
  'linear-gradient',
  'pattern',
];

const EFFECT_ORDER: Feature[] = [
  'filter-other',
  'blur',
  'blend-multiply',
  'blend-other',
  'mask',
  'gradient-alpha',
  'linear-gradient',
  'pattern',
];

export function buildPlan(scene: Scene, options: PlanOptions): ConversionPlan {
  const profile = getProfile(options.profileId);
  const entries: PlanEntry[] = [];
  const tiles: RasterTilePlan[] = [];
  const refusals: Refusal[] = [];
  const notes: string[] = [];
  const bundled = new Set<string>();

  const sharedBBox = new Map<string, BBox>();
  const intersectCache = new Map<string, BBox | null>();

  const clipOf = (node: SceneNode): BBox | null => {
    if (intersectCache.has(node.id)) return intersectCache.get(node.id)!;
    let box: BBox | null = node.worldBounds;
    let cursor: SceneNode | undefined = node;
    while (cursor) {
      if (cursor.clip) {
        const c = cursor.clip.bounds;
        box = box ? intersectBBox(box, c) : c;
      }
      cursor = cursor.parentId ? scene.byId.get(cursor.parentId) : undefined;
    }
    intersectCache.set(node.id, box);
    return box;
  };

  const visit = (node: SceneNode, ancestors: SceneNode[]): void => {
    if (bundled.has(node.id)) {
      entries.push({
        objectId: node.id,
        label: node.label,
        kind: node.kind,
        decision: 'raster',
        features: node.features,
        unsupported: [],
        reason: '随祖先一起合成为局部栅格，不再单独保留为矢量',
        bounds: clipOf(node) ?? node.worldBounds,
        depth: node.depth,
      });
      if (node.kind === 'group') for (const c of node.children) markBundled(c);
      return;
    }

    const rasterFeature = pickRasterFeature(node, ancestors, profile);
    const unsupportedByProfile = node.features.filter(
      (f) => isSupported(profile, f) === false && !node.parentId,
    );

    if (rasterFeature === 'filter-other') {
      refusals.push({
        objectId: node.id,
        label: node.label,
        feature: 'filter-other',
        reason: `${node.label} 使用了复合滤镜链，无法在局部栅格中可靠重建；无论严格与否都拒绝`,
      });
      entries.push({
        objectId: node.id,
        label: node.label,
        kind: node.kind,
        decision: 'reject',
        features: node.features,
        unsupported: ['filter-other'],
        reason: '复合 SVG 滤镜超出能力，不进行任何近似',
        bounds: clipOf(node) ?? node.worldBounds,
        depth: node.depth,
      });
      if (node.kind === 'group') for (const c of node.children) markBundled(c);
      return;
    }

    if (rasterFeature) {
      if (options.strict) {
        refusals.push({
          objectId: node.id,
          label: node.label,
          feature: rasterFeature,
          reason: `严格模式：需要 ${FEATURE_LABELS[rasterFeature]}，当前能力无法矢量表达，明确拒绝而不是偷偷降级为位图`,
        });
        entries.push({
          objectId: node.id,
          label: node.label,
          kind: node.kind,
          decision: 'reject',
          features: node.features,
          unsupported: [rasterFeature],
          reason: '严格模式下拒绝局部栅格化',
          bounds: clipOf(node) ?? node.worldBounds,
          depth: node.depth,
        });
        if (node.kind === 'group') for (const c of node.children) markBundled(c);
        return;
      }
      const tile = planTile(scene, node, rasterFeature, options.rasterScale);
      tiles.push(tile);
      entries.push({
        objectId: node.id,
        label: node.label,
        kind: node.kind,
        decision: 'raster',
        features: node.features,
        unsupported: [rasterFeature],
        reason: tile.reason,
        bounds: tile.paintBounds,
        depth: node.depth,
        strategy: tile.strategy,
        paintBounds: tile.paintBounds,
        readBounds: tile.readBounds,
      });
      if (node.kind === 'group') for (const c of node.children) markBundled(c);
      return;
    }

    if (unsupportedByProfile.length > 0) {
      // 顶层节点自身特性在当前档案中不可矢量表达，但也没有可用的栅格策略
      refusals.push({
        objectId: node.id,
        label: node.label,
        feature: unsupportedByProfile[0],
        reason: `${node.label} 的 ${unsupportedByProfile.map((f) => FEATURE_LABELS[f]).join('、')} 无法表达`,
      });
      entries.push({
        objectId: node.id,
        label: node.label,
        kind: node.kind,
        decision: 'reject',
        features: node.features,
        unsupported: unsupportedByProfile,
        reason: '缺少可用的转换策略',
        bounds: clipOf(node) ?? node.worldBounds,
        depth: node.depth,
      });
      return;
    }

    const decision =
      node.kind === 'group' ? 'vector-group' : node.kind === 'image' ? 'vector-image' : 'vector-path';
    entries.push({
      objectId: node.id,
      label: node.label,
      kind: node.kind,
      decision,
      features: node.features,
      unsupported: [],
      reason:
        decision === 'vector-group'
          ? node.opacity < 0.999
            ? '半透明组写成 PDF 隔离透明度组，子对象仍为矢量路径'
            : '组按嵌套裁剪/普通容器写入，子对象保持矢量'
          : decision === 'vector-image'
            ? '位图图像以 PDF 图像 XObject 写入'
            : node.kind === 'path' && node.resourceId
              ? `实例引用 #${node.resourceId}：几何写入共享 Form XObject，实例变换留在使用点 cm`
              : '按当前变换写入 PDF 矢量路径',
      bounds: clipOf(node) ?? node.worldBounds,
      depth: node.depth,
    });
    if (node.kind === 'group') {
      for (const child of node.children) visit(child, [...ancestors, node]);
    }
  };

  const markBundled = (node: SceneNode): void => {
    bundled.add(node.id);
    if (node.kind === 'group') for (const c of node.children) markBundled(c);
  };

  for (const child of scene.root.children) visit(child, [scene.root]);
  // paintOrder 同时包含组与路径，需按对象 id 去重
  const seen = new Set<string>();
  const deduped = entries.filter((e) => {
    if (seen.has(e.objectId)) return false;
    seen.add(e.objectId);
    return true;
  });

  const rasterCount = deduped.filter((e) => e.decision === 'raster').length;
  const refused = deduped.filter((e) => e.decision === 'reject').length;
  const vector = deduped.filter((e) => e.decision.startsWith('vector')).length;

  if (options.strict && refusals.length) {
    notes.push(`严格模式已拒绝 ${refusals.length} 个对象，转换中止，不会生成降级 PDF。`);
  } else if (refusals.length) {
    notes.push(`${refusals.length} 个对象无法可靠转换，已跳过。`);
  }
  if (rasterCount && !options.strict) {
    notes.push(
      `仅对 ${tiles.map((t) => `“${t.label}” ${fmtSize(t.paintBounds)}`).join('、')} 做局部栅格化；其余对象保持矢量。`,
    );
  }
  for (const t of tiles) {
    if (t.strategy === 'backdrop-blend') {
      notes.push(
        t.participationBounds
          ? `“${t.label}” 依赖背景：实际参与计算的边界为 ${fmtBox(t.participationBounds)}，栅格只写 ${fmtSize(t.paintBounds)}，不重绘页面底色。`
          : `“${t.label}” 下方没有背景元素，混合结果等于自身，无需回读背景。`,
      );
    } else if (t.feature === 'blur') {
      notes.push(
        `“${t.label}” 的模糊扩散需要回读 ${fmtSize(t.readBounds)}，写入 ${fmtSize(t.paintBounds)}，邻近对象不受影响。`,
      );
    }
  }

  return {
    profileId: profile.id,
    profileName: profile.name,
    strict: options.strict,
    status: refusals.length > 0 && options.strict ? 'refused' : 'ok',
    entries: deduped,
    tiles,
    refusals,
    stats: { vector, raster: rasterCount, refused },
    notes,
  };
}

function pickRasterFeature(
  node: SceneNode,
  ancestors: SceneNode[],
  profile: ReturnType<typeof getProfile>,
): Feature | null {
  const own = node.features.filter((f) => RASTER_FEATURES.includes(f));
  for (const f of EFFECT_ORDER) {
    if (own.includes(f) && !isSupported(profile, f)) return f;
  }
  // 祖先的模糊/滤镜会把子孙一并纳入栅格，但只有最外层声明者负责建 tile
  for (const ancestor of ancestors) {
    if (ancestor.features.includes('blur') || ancestor.features.includes('filter-other')) {
      return null;
    }
  }
  return null;
}

function planTile(scene: Scene, node: SceneNode, feature: Feature, rasterScale: number): RasterTilePlan {
  const scale = Math.max(0.5, rasterScale);
  const blend = feature === 'blend-multiply' || feature === 'blend-other';
  const blur = feature === 'blur';
  const filter = node.kind === 'group' || node.kind === 'path' || node.kind === 'image' ? node.filter : null;

  const base = node.worldBounds;
  let paintBounds = base;
  if (blur) {
    const bleed = (filter?.stdDeviation ?? 0) * 3 + 2;
    paintBounds = expandBBox(base, bleed);
  }
  paintBounds = snapBBox(paintBounds, scale);
  const readBounds = paintBounds;

  let participationBounds: BBox | null = null;
  let backdropIds: string[] = [];
  let note = '';
  let strategy: RasterStrategy = 'alpha-effect';

  if (blend) {
    strategy = 'backdrop-blend';
    const index = scene.paintOrder.findIndex((n) => n.id === node.id);
    const before = scene.paintOrder.slice(0, Math.max(0, index));
    const intersecting = before.filter(
      (n) => !isAncestor(n, node, scene) && boxesOverlap(effectiveBounds(n), paintBounds),
    );
    backdropIds = intersecting.map((n) => n.id);
    for (const n of intersecting) {
      const piece = intersectBBox(effectiveBounds(n), paintBounds);
      participationBounds = participationBounds ? union(piece, participationBounds) : piece;
    }
    participationBounds = participationBounds ? snapBBox(participationBounds, scale) : null;
    note = participationBounds
      ? `背景 ${intersecting.length} 个元素仅在 ${fmtBox(participationBounds)} 内参与混合；栅格边界限制在对象自身的 ${fmtSize(paintBounds)}。`
      : '对象下方无可见背景元素，混合结果等于自身颜色。';
  } else if (blur) {
    note = `模糊扩散 ${fmtSize(paintBounds)} 由过滤器 σ=${round(filter?.stdDeviation ?? 0, 2)} 推导，只回读该范围。`;
  } else {
    note = '效果仅取决于对象自身像素。';
  }

  return {
    objectId: node.id,
    label: node.label,
    strategy,
    feature,
    reason: blend
      ? '混合模式需要与背景逐像素计算；受限档案不支持 PDF 原生 /BM，只能局部栅格化'
      : blur
        ? '高斯模糊超出 PDF 原生能力，只能局部栅格化'
        : `${FEATURE_LABELS[feature]} 当前档案不支持，局部栅格化`,
    paintBounds,
    readBounds,
    participationBounds,
    scale,
    backgroundDependent: blend,
    backdropIds,
    note,
  };
}

function effectiveBounds(node: SceneNode): BBox {
  if (node.kind !== 'group' && node.filter) {
    return expandBBox(node.worldBounds, node.filter.stdDeviation * 3 + 2);
  }
  return node.worldBounds;
}

function isAncestor(candidate: SceneNode, node: SceneNode, scene: Scene): boolean {
  let cursor: SceneNode | undefined = node;
  while (cursor?.parentId) {
    if (cursor.parentId === candidate.id) return true;
    cursor = scene.byId.get(cursor.parentId);
  }
  return false;
}

function boxesOverlap(a: BBox, b: BBox): boolean {
  return a.w > 0 && a.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function union(a: BBox, b: BBox): BBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function fmtSize(b: BBox): string {
  return `${Math.round(b.w)}×${Math.round(b.h)}`;
}

function fmtBox(b: BBox): string {
  return `x ${round(b.x)}–${round(b.x + b.w)} / y ${round(b.y)}–${round(b.y + b.h)}`;
}

function round(v: number, digits = 1): number {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}
