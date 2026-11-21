import type { BBox, LinearGradientPaint, Paint, PatternDef, Scene, SceneGroup, SceneNode } from './types.js';
import { formatMatrix } from './matrix.js';
import { toHex } from './color.js';

export interface EffectOptions {
  opacity: boolean;
  blend: boolean;
  filter: boolean;
  clip: boolean;
}

export const FULL_EFFECTS: EffectOptions = { opacity: true, blend: true, filter: true, clip: true };

export class SvgEmitter {
  private defs: string[] = [];
  private gradientIds = new Map<LinearGradientPaint, string>();
  private patternIds = new Map<string, string>();
  private clipIds = new Map<string, string>();
  private filterIds = new Map<string, string>();
  private seq = 0;

  constructor(
    private scene: Scene,
    private effects: EffectOptions = FULL_EFFECTS,
    /** resvg 怪癖补偿：userSpaceOnUse 图案的 x/y 只作平铺偏移、内容总被裁到 [0,w]×[0,h]，
     *  给 resvg 的文档需要把内容包一层 translate(-x,-y)（浏览器等正确渲染器不能加）。 */
    private resvgQuirk = false,
  ) {}

  takeDefs(): string {
    return this.defs.join('');
  }

  private gradientMarkup(paint: LinearGradientPaint): string {
    const existing = this.gradientIds.get(paint);
    if (existing) return existing;
    const id = `grad-${++this.seq}`;
    this.gradientIds.set(paint, id);
    const stops = paint.stops
      .map((s) => `<stop offset="${s.offset}" stop-color="${hex(s.color)}" stop-opacity="${round4(s.color.a)}"/>`)
      .join('');
    const transform = isIdentity(paint.gradientTransform)
      ? ''
      : ` gradientTransform="matrix(${formatMatrix(paint.gradientTransform)})"`;
    this.defs.push(
      `<linearGradient id="${id}" gradientUnits="${paint.gradientUnits}" x1="${paint.x1}" y1="${paint.y1}" x2="${paint.x2}" y2="${paint.y2}"${transform}>${stops}</linearGradient>`,
    );
    return id;
  }

  private patternMarkup(patternId: string, override?: { dx: number; dy: number } | null): string {
    const key = override ? `${patternId}|ovr:${override.dx},${override.dy}` : patternId;
    const existing = this.patternIds.get(key);
    if (existing) return existing;
    const def = this.scene.patterns.get(patternId);
    if (!def) return '';
    const id = `pat-${++this.seq}`;
    this.patternIds.set(key, id);
    const transform = isIdentity(def.patternTransform)
      ? ''
      : ` patternTransform="matrix(${formatMatrix(def.patternTransform)})"`;
    const contentUnits = def.contentUnits === 'objectBoundingBox' ? ' patternContentUnits="objectBoundingBox"' : '';
    const shapes = def.shapes
      .map((s) => {
        const fill = this.paintValue(s.fill);
        const opacity = s.opacity < 0.999 ? ` opacity="${round4(s.opacity)}"` : '';
        const fillOpacity =
          s.fill?.type === 'solid' && s.fill.color.a < 0.999 ? ` fill-opacity="${round4(s.fill.color.a)}"` : '';
        return `<path d="${escapeAttr(s.d)}" fill="${fill}" fill-rule="${s.fillRule}"${fillOpacity}${opacity}/>`;
      })
      .join('');
    // 「仅实例」原点覆盖 = 平移重复单元格点 → 平移内容（x/y 只决定裁剪窗口，不动格点）
    let content = shapes;
    if (override) content = `<g transform="translate(${round4(override.dx)} ${round4(override.dy)})">${content}</g>`;
    if (this.resvgQuirk && def.patternUnits === 'userSpaceOnUse' && (def.x !== 0 || def.y !== 0)) {
      content = `<g transform="translate(${round4(-def.x)} ${round4(-def.y)})">${content}</g>`;
    }
    this.defs.push(
      `<pattern id="${id}" patternUnits="${def.patternUnits}"${contentUnits} x="${def.x}" y="${def.y}" width="${def.width}" height="${def.height}"${transform}>${content}</pattern>`,
    );
    return id;
  }

  paintValue(paint: Paint | null, override?: { dx: number; dy: number } | null): string {
    if (!paint) return 'none';
    // 纯色只写不透明色值：透明度由 fill-opacity 单独携带（rgba()+fill-opacity 会双重作用）
    if (paint.type === 'solid') return toHex(paint.color);
    if (paint.type === 'pattern') {
      const id = this.patternMarkup(paint.id, override);
      return id ? `url(#${id})` : 'none';
    }
    return `url(#${this.gradientMarkup(paint)})`;
  }

  private clipMarkup(clipId: string, d: string, fillRule: string): string {
    const existing = this.clipIds.get(clipId);
    if (existing) return existing;
    const id = `clip-${++this.seq}`;
    this.clipIds.set(clipId, id);
    this.defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${escapeAttr(d)}" clip-rule="${fillRule}"/></clipPath>`);
    return id;
  }

  private filterMarkup(node: SceneNode): string | null {
    const filter = node.kind === 'group' || node.kind === 'path' || node.kind === 'image' ? node.filter : null;
    if (!filter || filter.kind !== 'blur' || !this.effects.filter) return null;
    const key = node.id;
    const existing = this.filterIds.get(key);
    if (existing) return existing;
    const id = `blur-${++this.seq}`;
    this.filterIds.set(key, id);
    this.defs.push(
      `<filter id="${id}" x="-100%" y="-100%" width="300%" height="300%" filterUnits="objectBoundingBox"><feGaussianBlur stdDeviation="${filter.stdDeviation}"/></filter>`,
    );
    return id;
  }

  /** 发射节点自身及其子树；node 使用绝对变换，保证不依赖祖先包装。 */
  emitTree(node: SceneNode, depth = 0): string {
    const open: string[] = [];
    const close: string[] = [];
    if (this.effects.opacity && node.opacity < 0.999) {
      open.push(`<g opacity="${round4(node.opacity)}">`);
      close.unshift('</g>');
    }
    if (this.effects.blend && node.blend && node.blend !== 'normal') {
      open.push(`<g style="mix-blend-mode:${node.blend}">`);
      close.unshift('</g>');
    }
    if (this.effects.clip && node.clip) {
      const id = this.clipMarkup(node.clip.id, node.clip.d, node.clip.fillRule);
      open.push(`<g clip-path="url(#${id})">`);
      close.unshift('</g>');
    }
    const filterId = this.filterMarkup(node);
    if (filterId) {
      open.push(`<g filter="url(#${filterId})">`);
      close.unshift('</g>');
    }

    if (node.kind === 'group') {
      const inner = node.children.map((c) => this.emitTree(c, depth + 1)).join('');
      return `${open.join('')}<g data-obj="${escapeAttr(node.id)}">${inner}</g>${close.join('')}`;
    }

    open.push(`<g transform="matrix(${formatMatrix(node.absTransform)})" data-obj="${escapeAttr(node.id)}">`);
    close.unshift('</g>');

    let shape: string;
    if (node.kind === 'path') {
      shape = `<path d="${escapeAttr(node.d)}" ${this.pathPaintAttrs(node)}/>`;
    } else if (node.kind === 'image') {
      shape = `<image x="${round4(node.localBounds.x)}" y="${round4(node.localBounds.y)}" width="${round4(node.width)}" height="${round4(node.height)}" href="${escapeAttr(node.href)}"/>`;
    } else {
      shape = '';
    }
    return `${open.join('')}${shape}${close.join('')}`;
  }

  private pathPaintAttrs(node: Extract<SceneNode, { kind: 'path' }>): string {
    const attrs = [`fill="${this.paintValue(node.fill, node.patternOriginOverride)}"`, `fill-rule="${node.fillRule}"`];
    if (node.fill && node.fill.type === 'solid') attrs.push(`fill-opacity="${round4(node.fill.color.a)}"`);
    if (node.stroke) {
      attrs.push(
        `stroke="${toHex(node.stroke)}"`,
        `stroke-width="${node.strokeWidth}"`,
        `stroke-linecap="${node.lineCap}"`,
        `stroke-linejoin="${node.lineJoin}"`,
        `stroke-miterlimit="${node.miterLimit}"`,
        `stroke-opacity="${round4(node.stroke.a)}"`,
      );
      if (node.dash.length) attrs.push(`stroke-dasharray="${node.dash.join(' ')}"`);
    }
    return attrs.join(' ');
  }
}

export function wrapSvgDocument(opts: {
  width: number;
  height: number;
  viewBox: BBox;
  defs: string;
  inner: string;
  regionClip?: BBox | null;
}): string {
  const extra = opts.regionClip
    ? `<clipPath id="__region" clipPathUnits="userSpaceOnUse"><rect x="${opts.regionClip.x}" y="${opts.regionClip.y}" width="${opts.regionClip.w}" height="${opts.regionClip.h}"/></clipPath>`
    : '';
  const wrap = opts.regionClip ? '<g clip-path="url(#__region)">' : '<g>';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${opts.width}" height="${opts.height}" viewBox="${opts.viewBox.x} ${opts.viewBox.y} ${opts.viewBox.w} ${opts.viewBox.h}">
<defs>${opts.defs}${extra}</defs>${wrap}${opts.inner}</g>
</svg>`;
}

export interface SvgBuildOptions {
  include?: Set<string> | null;
  exclude?: Set<string> | null;
  beforeIndex?: number;
  region?: BBox;
  pixelWidth?: number;
  effects?: boolean;
  roots?: SceneNode[];
}

export interface SvgBuildResult {
  svg: string;
  width: number;
  height: number;
  scale: number;
  region: BBox;
}

/** 构造完整文档 SVG 或局部区域 SVG，两种用途共用同一套样式语义。 */
export function buildSvg(scene: Scene, options: SvgBuildOptions = {}): SvgBuildResult {
  const region = options.region ?? { x: 0, y: 0, w: scene.width, h: scene.height };
  const pixelWidth = Math.max(1, Math.round(options.pixelWidth ?? region.w));
  const scale = pixelWidth / Math.max(1e-6, region.w);
  const pixelHeight = Math.max(1, Math.round(region.h * scale));

  const exclude = options.exclude ?? new Set<string>();
  const allowed = new Set<string>();
  if (options.roots) {
    for (const root of options.roots) markSubtree(root, allowed);
  } else if (options.include) {
    for (const id of options.include) addWithAncestors(scene, id, allowed);
  } else if (options.beforeIndex != null) {
    scene.paintOrder.slice(0, options.beforeIndex).forEach((n) => addWithAncestors(scene, n.id, allowed));
  } else {
    for (const node of scene.paintOrder) addWithAncestors(scene, node.id, allowed);
  }
  for (const id of exclude) {
    const node = scene.byId.get(id);
    if (node) removeSubtree(node, allowed);
  }

  const effects = options.effects !== false;
  const emitter = new SvgEmitter(scene, effects ? FULL_EFFECTS : { opacity: true, blend: false, filter: false, clip: true });

  const roots = options.roots ?? scene.root.children.filter((c) => allowed.has(c.id));
  const inner = roots.map((r) => emitter.emitTree(r)).join('');

  const svg = wrapSvgDocument({
    width: pixelWidth,
    height: pixelHeight,
    viewBox: region,
    defs: emitter.takeDefs(),
    inner,
  });
  return { svg, width: pixelWidth, height: pixelHeight, scale, region };
}

/** 只渲染指定节点子树，丢弃祖先包装（祖先的裁剪/透明度由调用方另行处理）。 */
export function buildIsolatedSvg(
  scene: Scene,
  node: SceneNode,
  options: { region: BBox; pixelWidth: number; clipChain?: boolean; effects?: boolean },
): SvgBuildResult {
  const region = options.region;
  const pixelWidth = Math.max(1, Math.round(options.pixelWidth));
  const scale = pixelWidth / Math.max(1e-6, region.w);
  const pixelHeight = Math.max(1, Math.round(region.h * scale));
  const emitter = new SvgEmitter(
    scene,
    options.effects === false ? { opacity: true, blend: false, filter: false, clip: false } : FULL_EFFECTS,
    true,
  );

  const inner = emitter.emitTree(node);
  const svg = wrapSvgDocument({
    width: pixelWidth,
    height: pixelHeight,
    viewBox: region,
    defs: emitter.takeDefs(),
    inner,
  });
  return { svg, width: pixelWidth, height: pixelHeight, scale, region };
}

/** 渲染目标之前已绘制的全部对象，用于依赖背景的混合计算。 */
export function buildBackdropSvg(
  scene: Scene,
  target: SceneNode,
  options: { region: BBox; pixelWidth: number },
): SvgBuildResult {
  const index = scene.paintOrder.findIndex((n) => n.id === target.id);
  const before = scene.paintOrder.slice(0, Math.max(0, index));
  const region = options.region;
  const pixelWidth = Math.max(1, Math.round(options.pixelWidth));
  const scale = pixelWidth / Math.max(1e-6, region.w);
  const pixelHeight = Math.max(1, Math.round(region.h * scale));

  const excluded = new Set<string>();
  removeSubtree(target, excluded);
  for (const ancestor of ancestorsOf(scene, target)) excluded.add(ancestor.id);

  const roots: SceneNode[] = [];
  for (const node of before) {
    if (excluded.has(node.id)) continue;
    let hidden = false;
    let cursor: SceneNode | undefined = node;
    while (cursor?.parentId) {
      const parent = scene.byId.get(cursor.parentId);
      if (!parent) break;
      if (before.some((b) => b.id === parent.id) && !excluded.has(parent.id) && parent.id !== 'root') {
        hidden = true;
        break;
      }
      cursor = parent;
    }
    if (hidden) continue;
    roots.push(node);
  }
  const emitter = new SvgEmitter(scene, FULL_EFFECTS, true);
  const inner = roots.map((n) => emitter.emitTree(n)).join('');
  // 不额外套区域裁剪：resvg 在「透明层 + 全页矩形」同处一个裁剪组时会崩溃；
  // 瓦片本身通过 viewBox 裁剪，输出范围已经严格受限。
  const svg = wrapSvgDocument({
    width: pixelWidth,
    height: pixelHeight,
    viewBox: region,
    defs: emitter.takeDefs(),
    inner,
  });
  return { svg, width: pixelWidth, height: pixelHeight, scale, region };
}

function ancestorsOf(scene: Scene, node: SceneNode): SceneNode[] {
  const out: SceneNode[] = [];
  let cursor: SceneNode | undefined = node;
  while (cursor?.parentId) {
    const parent = scene.byId.get(cursor.parentId);
    if (!parent) break;
    out.push(parent);
    cursor = parent;
  }
  return out;
}

function markSubtree(node: SceneNode, into: Set<string>): void {
  into.add(node.id);
  if (node.kind === 'group') for (const c of node.children) markSubtree(c, into);
}

function removeSubtree(node: SceneNode, from: Set<string>): void {
  from.delete(node.id);
  if (node.kind === 'group') for (const c of node.children) removeSubtree(c, from);
}

function addWithAncestors(scene: Scene, id: string, into: Set<string>): void {
  let node = scene.byId.get(id);
  while (node) {
    into.add(node.id);
    node = node.parentId ? scene.byId.get(node.parentId) : undefined;
  }
}

function hex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function isIdentity(m: readonly number[]): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
