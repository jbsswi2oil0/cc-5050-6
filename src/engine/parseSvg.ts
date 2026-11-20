import path from 'node:path';
import { DOMParser, type Document, type Element } from 'linkedom';
import { parseColor, type Rgba } from './color.js';
import { applyPoint, IDENTITY, multiply, type Matrix } from './matrix.js';
import {
  ellipsePath,
  expandBBox,
  intersectBBox,
  linePath,
  normalizePath,
  parseTransform,
  pathBBox,
  polygonPath,
  rectPath,
  transformBBox,
  transformPath,
  unionAll,
  unionBBox,
} from './shapes.js';
import type {
  BBox,
  ClipRef,
  Feature,
  FilterInfo,
  LinearGradientPaint,
  Paint,
  Scene,
  SceneGroup,
  SceneImage,
  SceneNode,
  ScenePath,
} from './types.js';

const SKIP_TAGS = new Set([
  'defs', 'style', 'title', 'desc', 'metadata', 'clippath', 'mask', 'filter',
  'lineargradient', 'radialgradient', 'pattern', 'symbol', 'marker', 'foreignobject',
  'font', 'font-face', 'script',
]);
const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

interface Style {
  fill: string;
  fillOpacity: number;
  fillRule: 'nonzero' | 'evenodd';
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
  lineCap: 'butt' | 'round' | 'square';
  lineJoin: 'miter' | 'round' | 'bevel';
  miterLimit: number;
  dash: number[];
  opacity: number;
}

const ROOT_STYLE: Style = {
  fill: '#000000',
  fillOpacity: 1,
  fillRule: 'nonzero',
  stroke: 'none',
  strokeOpacity: 1,
  strokeWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  miterLimit: 4,
  dash: [],
  opacity: 1,
};

const INHERITABLE = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
]);

interface CssRule {
  selector: string;
  specificity: number;
  decls: Record<string, string>;
}

class StyleSheet {
  private rules: CssRule[] = [];

  constructor(css: string) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleRe = /([^{}]+)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = ruleRe.exec(clean))) {
      const selectorGroup = m[1].trim();
      if (!selectorGroup || selectorGroup.startsWith('@')) continue;
      const decls = parseDecls(m[2]);
      for (const selector of selectorGroup.split(',')) {
        const sel = selector.trim();
        if (!sel || /:/.test(sel.replace(/^[^:]*/, ''))) continue;
        this.rules.push({ selector: sel, specificity: specificity(sel), decls });
      }
    }
    this.rules.sort((a, b) => a.specificity - b.specificity);
  }

  /** 返回按优先级从低到高排列的声明。 */
  match(el: Element): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const rule of this.rules) {
      if (matches(el, rule.selector)) Object.assign(merged, rule.decls);
    }
    return merged;
  }
}

function specificity(sel: string): number {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length;
  const classes = (sel.match(/\.[\w-]+/g) ?? []).length;
  const tags = (sel.replace(/[#.][\w-]+/g, '').match(/[\w-]+/g) ?? []).length;
  return ids * 100 + classes * 10 + tags;
}

function matches(el: Element, selector: string): boolean {
  const parts = selector.trim().split(/\s+/);
  let node: Element | null = el;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!node) return false;
    if (i === parts.length - 1) {
      if (!matchCompound(node, part)) return false;
    } else {
      let cur: Element | null = node.parentElement;
      let found = false;
      while (cur) {
        if (matchCompound(cur, part)) {
          found = true;
          node = cur;
          break;
        }
        cur = cur.parentElement;
      }
      if (!found) return false;
    }
  }
  return true;
}

function matchCompound(el: Element, compound: string): boolean {
  const tagMatch = compound.match(/^[\w-]+/);
  if (tagMatch && (el.localName ?? el.tagName).toLowerCase() !== tagMatch[0].toLowerCase()) return false;
  const classes = compound.match(/\.[\w-]+/g) ?? [];
  const classList = (el.getAttribute('class') ?? '').split(/\s+/);
  for (const c of classes) if (!classList.includes(c.slice(1))) return false;
  const id = compound.match(/#([\w-]+)/);
  if (id && el.getAttribute('id') !== id[1]) return false;
  return true;
}

function parseDecls(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of text.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const key = decl.slice(0, idx).trim().toLowerCase();
    if (key && !key.startsWith('--')) out[key] = decl.slice(idx + 1).trim();
  }
  return out;
}

export interface ParseOptions {
  width?: number;
  height?: number;
}

export function parseSvg(source: string, options: ParseOptions = {}): Scene {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml') as unknown as Document;
  const root = doc.documentElement as unknown as Element;
  if (!root || (root.localName ?? root.tagName).toLowerCase() !== 'svg') {
    throw new Error('根元素不是 <svg>');
  }
  const warnings: string[] = [];
  const viewBox = readViewBox(root);
  const attrW = readLength(root.getAttribute('width'), 0);
  const attrH = readLength(root.getAttribute('height'), 0);
  const vbW = viewBox.w || attrW || 300;
  const vbH = viewBox.h || attrH || 150;
  const width = options.width ?? (attrW || vbW);
  const height = options.height ?? (attrH || vbH);
  if (width <= 0 || height <= 0) throw new Error('SVG 尺寸无效');

  let cssText = '';
  for (const styleEl of Array.from(root.querySelectorAll('style'))) {
    cssText += '\n' + (styleEl.textContent ?? '');
  }
  const sheet = new StyleSheet(cssText);

  const parser = new SceneParser(doc, sheet, warnings);
  parser.scanGradients(root);
  const viewTransform: Matrix = [
    width / (viewBox.w || vbW),
    0,
    0,
    height / (viewBox.h || vbH),
    (-(viewBox.x || 0) * width) / (viewBox.w || vbW),
    (-(viewBox.y || 0) * height) / (viewBox.h || vbH),
  ];

  const children: SceneNode[] = [];
  for (const child of Array.from(root.children)) {
    const node = parser.visit(child, { ...ROOT_STYLE }, viewTransform, 'root', 1);
    if (node) children.push(node);
  }
  const rootBounds: BBox = { x: 0, y: 0, w: width, h: height };
  const rootGroup: SceneGroup = {
    kind: 'group',
    id: 'root',
    label: '画布',
    transform: viewTransform,
    opacity: 1,
    blend: 'normal',
    clip: null,
    clipChain: [],
    localBounds: rootBounds,
    ownBounds: rootBounds,
    absTransform: IDENTITY,
    worldBounds: rootBounds,
    features: [],
    sourceTag: 'svg',
    depth: 0,
    parentId: null,
    children,
    filter: null,
    mask: false,
    isolated: false,
  };
  const byId = new Map<string, SceneNode>();
  for (const n of parser.allNodes) byId.set(n.id, n);
  byId.set('root', rootGroup);
  return {
    width,
    height,
    viewBox: { x: viewBox.x || 0, y: viewBox.y || 0, w: viewBox.w || vbW, h: viewBox.h || vbH },
    root: rootGroup,
    nodes: parser.allNodes,
    byId,
    gradients: parser.gradients,
    sourceSvg: source,
    warnings,
    paintOrder: parser.paintOrder,
  };
}

/** 把相对的 <image href> 转成绝对路径，避免依赖进程 cwd；data/http URL 原样保留。 */
function absolutizeHref(href: string): string {
  if (!href || /^data:/i.test(href) || /^https?:/i.test(href) || path.isAbsolute(href)) return href;
  return path.resolve(process.cwd(), href);
}

function readViewBox(el: Element): BBox {
  const vb = el.getAttribute('viewBox');
  if (!vb) return { x: 0, y: 0, w: 0, h: 0 };
  const [x, y, w, h] = vb.split(/[\s,]+/).map(Number);
  return { x: x || 0, y: y || 0, w: w || 0, h: h || 0 };
}

export function readLength(value: string | null, fallback: number): number {
  if (value == null || value === '') return fallback;
  const m = value.trim().match(/^(-?[\d.]+(?:e[-+]?\d+)?)\s*(px|pt|mm|cm|in|%)?$/i);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return fallback;
  const unit = (m[2] || 'px').toLowerCase();
  const factor: Record<string, number> = { px: 1, pt: 1, mm: 1, cm: 1, in: 1, '%': 1, '': 1 };
  // 画布尺寸统一按 1 SVG 用户单位 = 1 pt 处理，保证 PDF 与源图坐标一致。
  void factor;
  return n;
}

function parseOpacity(value: string | null | undefined, fallback = 1): number {
  if (value == null || value === '') return fallback;
  const m = value.trim().match(/^([\d.]+)(%?)$/);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, m[2] ? n / 100 : n));
}

class SceneParser {
  readonly allNodes: SceneNode[] = [];
  readonly paintOrder: SceneNode[] = [];
  readonly gradients = new Map<string, LinearGradientPaint>();
  private counter = 0;
  private clipCache = new Map<string, ClipRef>();

  constructor(
    private doc: Document,
    private sheet: StyleSheet,
    private warnings: string[],
  ) {}

  scanGradients(root: Element): void {
    for (const el of Array.from(root.querySelectorAll('linearGradient, radialGradient'))) {
      const tag = (el.localName ?? el.tagName).toLowerCase();
      if (tag === 'lineargradient') this.readLinearGradient(el);
      else this.warnings.push(`径向渐变 <${el.getAttribute('id') ?? '?'}> 暂无矢量支持，将按能力处理`);
    }
  }

  visit(
    el: Element,
    inherited: Style,
    parentAbs: Matrix,
    parentId: string | null,
    depth: number,
    inheritedClip = false,
  ): SceneNode | null {
    const tag = (el.localName ?? el.tagName).toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;
    if (tag === 'text') {
      this.warnings.push(`文本 <${el.getAttribute('id') ?? tag}> 未转换为轮廓，已跳过`);
      return null;
    }
    if (tag === 'use' || tag === 'foreignObject' || tag === 'symbol') {
      this.warnings.push(`<${tag}> 依赖外部/符号引用，未导出`);
      return null;
    }

    const style = this.computeStyle(el, inherited);
    const ownTransform = parseTransform(this.declValue(el, 'transform'));
    const abs = multiply(parentAbs, ownTransform);
    const blend = this.computedValue(el, 'mix-blend-mode') || 'normal';
    const ownOpacity = parseOpacity(this.computedValue(el, 'opacity'), 1);
    const clip = this.resolveClip(this.computedValue(el, 'clip-path'), abs);
    const filter = this.resolveFilter(this.computedValue(el, 'filter'), abs);
    const maskAttr = this.computedValue(el, 'mask');
    const mask = !!maskAttr && maskAttr !== 'none';
    const label = el.getAttribute('data-label') || el.getAttribute('aria-label') || el.getAttribute('id') || `${tag} ${this.counter + 1}`;
    const id = el.getAttribute('data-obj') || el.getAttribute('id') || `${tag}-${++this.counter}`;

    const commonFeatures: Feature[] = [];
    if (filter) commonFeatures.push(filter.kind === 'blur' ? 'blur' : 'filter-other');
    if (mask) commonFeatures.push('mask');
    if (blend === 'multiply') commonFeatures.push('blend-multiply');
    else if (blend !== 'normal') commonFeatures.push('blend-other');
    // 与祖先的裁剪叠加时才算「两层裁剪」；单个裁剪只是普通裁剪
    if (clip && inheritedClip) commonFeatures.push('nested-clip');

    if (tag === 'image') {
      const x = readLength(el.getAttribute('x'), 0);
      const y = readLength(el.getAttribute('y'), 0);
      const w = readLength(el.getAttribute('width'), 0);
      const h = readLength(el.getAttribute('height'), 0);
      const href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      const node: SceneImage = {
        kind: 'image',
        id,
        label,
        transform: ownTransform,
        opacity: ownOpacity,
        blend,
        clip,
        clipChain: [],
        localBounds: { x, y, w, h },
        ownBounds: transformBBox({ x, y, w, h }, ownTransform),
        absTransform: abs,
        worldBounds: transformBBox({ x, y, w, h }, abs),
        features: [...commonFeatures, 'image'],
        sourceTag: tag,
        depth,
        parentId,
        href: absolutizeHref(href),
        width: w,
        height: h,
        filter,
        mask,
      };
      this.register(node);
      this.paintOrder.push(node);
      return node;
    }

    if (tag === 'g' || tag === 'svg' || tag === 'a' || tag === 'switch') {
      let childAbs = abs;
      let childStyle = style;
      const vb = tag === 'svg' ? readViewBox(el) : null;
      if (vb && vb.w > 0 && vb.h > 0) {
        const w = readLength(el.getAttribute('width'), vb.w);
        const h = readLength(el.getAttribute('height'), vb.h);
        childAbs = multiply(abs, [w / vb.w, 0, 0, h / vb.h, (-vb.x * w) / vb.w, (-vb.y * h) / vb.h]);
      }
      const children: SceneNode[] = [];
      for (const child of Array.from(el.children)) {
        const node = this.visit(child, childStyle, childAbs, id, depth + 1, inheritedClip || !!clip);
        if (node) children.push(node);
      }
      if (children.length === 0) return null;
      if (ownOpacity < 0.999) commonFeatures.push('group-opacity');
      const union = unionAll(children.map((c) => c.worldBounds));
      const ownBounds = union ? this.clipToChain(union, clip, parentId, depth) : { x: 0, y: 0, w: 0, h: 0 };
      const group: SceneGroup = {
        kind: 'group',
        id,
        label,
        transform: ownTransform,
        opacity: ownOpacity,
        blend,
        clip,
        clipChain: [],
        localBounds: ownBounds,
        ownBounds: ownBounds,
        absTransform: abs,
        worldBounds: ownBounds,
        features: commonFeatures,
        sourceTag: tag,
        depth,
        parentId,
        children,
        filter,
        mask,
        isolated: ownOpacity < 1 || blend !== 'normal' || !!filter || mask,
      };
      this.register(group);
      this.paintOrder.push(group);
      return group;
    }

    if (!SHAPE_TAGS.has(tag)) return null;

    const d = normalizePath(this.shapeGeometry(el, tag));
    if (!d) return null;
    const localBox = pathBBox(d);
    const fill = this.resolvePaint(style.fill, style.fillOpacity, el, label);
    const stroke = parseColor(style.stroke, style.strokeOpacity);
    const scale = Math.max(Math.hypot(abs[0], abs[1]), Math.hypot(abs[2], abs[3])) || 1;
    const strokeWorldWidth = style.strokeWidth * scale;
    const world = transformPath(d, abs);
    let worldBox = pathBBox(world);
    if (stroke) worldBox = expandBBox(worldBox, strokeWorldWidth / 2);
    const founded = this.clipToChain(worldBox, clip, parentId, depth);

    const features: Feature[] = ['path'];
    if (style.fillRule === 'evenodd' && fill) features.push('evenodd');
    if (stroke) features.push('path');
    if (fill?.type === 'linear') {
      features.push('linear-gradient');
      if (fill.stops.some((s) => s.color.a < 0.999)) features.push('gradient-alpha');
    }
    const node: ScenePath = {
      kind: 'path',
      id,
      label,
      transform: ownTransform,
      opacity: ownOpacity,
      blend,
      clip,
      clipChain: [],
      localBounds: localBox,
      ownBounds: transformBBox(localBox, ownTransform),
      absTransform: abs,
      worldBounds: founded,
      features: [...commonFeatures, ...features],
      sourceTag: tag,
      depth,
      parentId,
      d,
      fill,
      fillRule: style.fillRule,
      stroke,
      strokeWidth: style.strokeWidth,
      lineCap: style.lineCap,
      lineJoin: style.lineJoin,
      miterLimit: style.miterLimit,
      dash: style.dash,
      filter,
      mask,
    };
    this.register(node);
    this.paintOrder.push(node);
    return node;
  }

  private register(node: SceneNode): void {
    this.allNodes.push(node);
  }

  private clipToChain(box: BBox, clip: ClipRef | null, parentId: string | null, depth: number): BBox {
    void parentId;
    void depth;
    if (!clip) return box;
    return intersectBBox(box, clip.bounds);
  }

  computeStyle(el: Element, inherited: Style): Style {
    const css = this.sheet.match(el);
    const inline = parseDecls(el.getAttribute('style') ?? '');
    const value = (prop: string): string | null => {
      if (inline[prop] != null) return inline[prop];
      if (css[prop] != null) return css[prop];
      return el.getAttribute(prop);
    };
    const cssOrInline = (prop: string): string | null => {
      if (inline[prop] != null) return inline[prop];
      if (css[prop] != null) return css[prop];
      return null;
    };
    void cssOrInline;

    const fill = value('fill') ?? inherited.fill;
    const stroke = value('stroke') ?? inherited.stroke;
    const fillRuleRaw = (value('fill-rule') ?? '').toLowerCase();
    const fillRule: 'nonzero' | 'evenodd' =
      fillRuleRaw === 'evenodd' ? 'evenodd' : fillRuleRaw === 'nonzero' ? 'nonzero' : inherited.fillRule;
    const joinRaw = (value('stroke-linejoin') ?? '').toLowerCase();
    const lineJoin: Style['lineJoin'] =
      joinRaw === 'round' || joinRaw === 'bevel' || joinRaw === 'miter' ? joinRaw : inherited.lineJoin;
    const capRaw = (value('stroke-linecap') ?? '').toLowerCase();
    const lineCap: Style['lineCap'] =
      capRaw === 'round' || capRaw === 'square' || capRaw === 'butt' ? capRaw : inherited.lineCap;
    const dashRaw = value('stroke-dasharray');
    let dash = inherited.dash;
    if (dashRaw != null) {
      if (dashRaw === 'none' || dashRaw.trim() === '') dash = [];
      else dash = dashRaw.split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v) && v >= 0);
    }
    return {
      fill,
      fillOpacity: parseOpacity(value('fill-opacity'), inherited.fillOpacity),
      fillRule,
      stroke,
      strokeOpacity: parseOpacity(value('stroke-opacity'), inherited.strokeOpacity),
      strokeWidth: value('stroke-width') != null ? readLength(value('stroke-width'), inherited.strokeWidth) : inherited.strokeWidth,
      lineCap,
      lineJoin,
      miterLimit: value('stroke-miterlimit') != null ? parseFloat(value('stroke-miterlimit') as string) || inherited.miterLimit : inherited.miterLimit,
      dash,
      opacity: parseOpacity(value('opacity'), 1) * (INHERITABLE.size ? 1 : 1),
    };
  }

  private computedValue(el: Element, prop: string): string | null {
    const inline = parseDecls(el.getAttribute('style') ?? '');
    if (inline[prop] != null) return inline[prop];
    const css = this.sheet.match(el);
    if (css[prop] != null) return css[prop];
    return el.getAttribute(prop);
  }

  private declValue(el: Element, prop: string): string | null {
    const inline = parseDecls(el.getAttribute('style') ?? '');
    if (inline[prop] != null) return inline[prop];
    const css = this.sheet.match(el);
    if (css[prop] != null) return css[prop];
    return el.getAttribute(prop);
  }

  private shapeGeometry(el: Element, tag: string): string {
    const num = (name: string, fallback = 0) => readLength(el.getAttribute(name), fallback);
    if (tag === 'path') return el.getAttribute('d') ?? '';
    if (tag === 'rect') {
      const rxAttr = el.getAttribute('rx');
      const ryAttr = el.getAttribute('ry');
      let rx = rxAttr != null ? num('rx') : 0;
      let ry = ryAttr != null ? num('ry') : 0;
      if (rxAttr != null && ryAttr == null) ry = rx;
      if (ryAttr != null && rxAttr == null) rx = ry;
      return rectPath(num('x'), num('y'), num('width'), num('height'), rx, ry);
    }
    if (tag === 'circle') {
      const r = num('r');
      return ellipsePath(num('cx'), num('cy'), r, r);
    }
    if (tag === 'ellipse') return ellipsePath(num('cx'), num('cy'), num('rx'), num('ry'));
    if (tag === 'line') return linePath(num('x1'), num('y1'), num('x2'), num('y2'));
    if (tag === 'polyline' || tag === 'polygon') {
      return polygonPath(el.getAttribute('points') ?? '', tag === 'polygon');
    }
    return '';
  }

  private resolvePaint(value: string, opacity: number, el: Element, label: string): Paint | null {
    const trimmed = value.trim();
    const urlMatch = trimmed.match(/^url\(\s*["']?#([^"')]+)["']?\s*\)(?:\s+(.+))?$/);
    if (urlMatch) {
      const gradient = this.gradients.get(urlMatch[1]);
      if (gradient) return withOpacity(gradient, opacity);
      const fallback = urlMatch[2] ? parseColor(urlMatch[2], opacity) : null;
      if (fallback) return { type: 'solid', color: fallback };
      this.warnings.push(`无法解析填充引用 #${urlMatch[1]}（${label}）`);
      return null;
    }
    const color = parseColor(trimmed, opacity);
    return color ? { type: 'solid', color } : null;
  }

  private readLinearGradient(el: Element): void {
    const id = el.getAttribute('id');
    if (!id) return;
    let stops = readStops(el);
    const href = el.getAttribute('href') || el.getAttribute('xlink:href');
    if (stops.length === 0 && href?.startsWith('#')) {
      const base = this.doc.querySelector(`[id="${href.slice(1)}"]`);
      if (base) stops = readStops(base);
    }
    if (stops.length < 2) return;
    const units = (el.getAttribute('gradientUnits') ?? 'objectBoundingBox') as
      | 'objectBoundingBox'
      | 'userSpaceOnUse';
    const coord = (name: string, fallback: number): number => {
      const raw = el.getAttribute(name);
      if (raw == null) return fallback;
      const m = raw.trim().match(/^(-?[\d.]+(?:e[-+]?\d+)?)(%)?$/i);
      if (!m) return fallback;
      const n = parseFloat(m[1]);
      return m[2] ? n / 100 : n;
    };
    this.gradients.set(id, {
      type: 'linear',
      x1: coord('x1', 0),
      y1: coord('y1', 0),
      x2: coord('x2', 1),
      y2: coord('y2', 0),
      gradientUnits: units === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox',
      gradientTransform: parseTransform(el.getAttribute('gradientTransform')),
      stops,
    });
  }

  private resolveClip(raw: string | null, abs: Matrix): ClipRef | null {
    if (!raw || raw === 'none') return null;
    const m = raw.match(/url\(\s*["']?#([^"')]+)["']?\s*\)/);
    if (!m) return null;
    const id = m[1];
    const cached = this.clipCache.get(id);
    if (cached) return cached;
    const clipEl = this.doc.querySelector(`[id="${id}"]`);
    if (!clipEl) {
      this.warnings.push(`找不到裁剪路径 #${id}`);
      return null;
    }
    const base = abs;
    const parts: string[] = [];
    let fillRule: 'nonzero' | 'evenodd' = 'nonzero';
    const walk = (child: Element, userMatrix: Matrix) => {
      const t = (child.localName ?? child.tagName).toLowerCase();
      const childMatrix = multiply(userMatrix, parseTransform(child.getAttribute('transform')));
      if (t === 'clippath' || t === 'g') {
        for (const c of Array.from(child.children)) walk(c, childMatrix);
        return;
      }
      if (!SHAPE_TAGS.has(t)) return;
      const rule = child.getAttribute('clip-rule');
      if (rule === 'evenodd') fillRule = 'evenodd';
      const d = this.shapeGeometry(child, t);
      if (!d) return;
      parts.push(transformPath(normalizePath(d), childMatrix));
    };
    walk(clipEl, base);
    const d = parts.join(' ');
    const ref: ClipRef = {
      id,
      label: clipEl.getAttribute('data-label') || clipEl.getAttribute('aria-label') || id,
      d,
      fillRule,
      bounds: pathBBox(d),
    };
    this.clipCache.set(id, ref);
    return ref;
  }

  private resolveFilter(raw: string | null, abs: Matrix): FilterInfo | null {
    if (!raw || raw === 'none') return null;
    const m = raw.match(/url\(\s*["']?#([^"')]+)["']?\s*\)/);
    if (!m) return null;
    const filterEl = this.doc.querySelector(`[id="${m[1]}"]`);
    const scale = Math.max(Math.hypot(abs[0], abs[1]), Math.hypot(abs[2], abs[3])) || 1;
    if (!filterEl) return { id: m[1], kind: 'other', stdDeviation: 0 };
    const primitives = Array.from(filterEl.children).filter((c) => /^fe[A-Z]/.test(c.localName ?? c.tagName));
    const blur = primitives.length === 1 && (primitives[0].localName ?? primitives[0].tagName) === 'feGaussianBlur' ? primitives[0] : null;
    if (blur) {
      const parts = (blur.getAttribute('stdDeviation') ?? '0').split(/[\s,]+/).map(Number).filter(Number.isFinite);
      const sd = Math.max(0, ...(parts.length ? parts : [0])) * scale;
      return { id: m[1], kind: 'blur', stdDeviation: sd };
    }
    return { id: m[1], kind: 'other', stdDeviation: 0 };
  }
}

function readStops(el: Element): { offset: number; color: Rgba }[] {
  const stops: { offset: number; color: Rgba }[] = [];
  for (const stop of Array.from(el.children)) {
    if ((stop.localName ?? stop.tagName).toLowerCase() !== 'stop') continue;
    const inline = parseDecls(stop.getAttribute('style') ?? '');
    const offsetRaw = inline['offset'] ?? stop.getAttribute('offset') ?? '0';
    const offset = offsetRaw.trim().endsWith('%') ? parseFloat(offsetRaw) / 100 : parseFloat(offsetRaw);
    const colorRaw = inline['stop-color'] ?? stop.getAttribute('stop-color') ?? '#000000';
    const color =
      parseColor(colorRaw, parseOpacity(inline['stop-opacity'] ?? stop.getAttribute('stop-opacity'), 1)) ??
      { r: 0, g: 0, b: 0, a: 1 };
    stops.push({ offset: Math.min(1, Math.max(0, Number.isFinite(offset) ? offset : 0)), color });
  }
  stops.sort((a, b) => a.offset - b.offset);
  return stops;
}

function withOpacity(gradient: LinearGradientPaint, opacity: number): LinearGradientPaint {
  if (opacity >= 0.999) return gradient;
  return { ...gradient, stops: gradient.stops.map((s) => ({ ...s, color: { ...s.color, a: s.color.a * opacity } })) };
}

export function gradientWorldPoints(
  paint: LinearGradientPaint,
  bbox: BBox,
  abs: Matrix,
): { x1: number; y1: number; x2: number; y2: number } {
  let basis: Matrix;
  if (paint.gradientUnits === 'userSpaceOnUse') {
    basis = multiply(abs, paint.gradientTransform);
  } else {
    basis = multiply(
      multiply(abs, [bbox.w, 0, 0, bbox.h, bbox.x, bbox.y]),
      paint.gradientTransform,
    );
  }
  const [x1, y1] = applyPoint(basis, paint.x1, paint.y1);
  const [x2, y2] = applyPoint(basis, paint.x2, paint.y2);
  return { x1, y1, x2, y2 };
}

export function anchorWorldPoint(node: SceneNode, x: number, y: number): [number, number] {
  return applyPoint(node.absTransform, x, y);
}

export { unionBBox };
