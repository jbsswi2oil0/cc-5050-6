/**
 * 同构 SVG 编辑助手：结构化修改画板文本。
 * 浏览器端用原生 DOMParser/XMLSerializer，Node 端用 linkedom；
 * 这里只依赖两侧共有的 DOM 子集，调用方负责 parse/serialize。
 */

export interface ElLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): ElLike | null;
  cloneNode(deep: boolean): ElLike;
  parentNode: ElLike | null;
  appendChild(node: ElLike): unknown;
  firstChild: ElLike | null;
}

export interface DocLike {
  querySelector(selector: string): ElLike | null;
  querySelectorAll(selector: string): ArrayLike<ElLike>;
  createElementNS(ns: string, tag: string): ElLike;
  documentElement: ElLike;
}

export interface UseDragEdit {
  dx: number;
  dy: number;
}

/** 拖动 <use> 实例：平移量加在变换列表最前面的 translate 上（没有则前置一个）。 */
export function applyUseDrag(doc: DocLike, edits: Record<string, UseDragEdit>): void {
  for (const [id, { dx, dy }] of Object.entries(edits)) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) continue;
    const el = doc.querySelector(`[data-obj="${id}"]`) ?? doc.querySelector(`[id="${id}"]`);
    if (!el) continue;
    const raw = (el.getAttribute('transform') ?? '').trim();
    const m = raw.match(/^translate\(\s*(-?[\d.e+]+)(?:[\s,]+(-?[\d.e+]+))?\s*\)/);
    if (m) {
      const tx = Number(m[1]) + dx;
      const ty = Number(m[2] ?? 0) + dy;
      el.setAttribute('transform', `translate(${round4(tx)} ${round4(ty)})${raw.slice(m[0].length)}`);
    } else {
      el.setAttribute('transform', `translate(${round4(dx)} ${round4(dy)})${raw ? ` ${raw}` : ''}`);
    }
  }
}

/** 更改图案的公共定义原点：所有引用该图案的实例一起移动。 */
export function applyPatternOrigin(doc: DocLike, patternId: string, x: number, y: number): void {
  const pattern = doc.querySelector(`pattern[id="${patternId}"]`);
  if (!pattern) return;
  pattern.setAttribute('x', String(round4(x)));
  pattern.setAttribute('y', String(round4(y)));
}

/**
 * 把「仅实例」的图案原点覆盖物化进 SVG：复制一份图案定义、平移其内容并改指。
 * 仅用于给独立渲染器（resvg）生成与引擎覆盖层等效的真源；
 * 引擎自身通过 patternOverrides 在使用点的 Pattern /Matrix 里实现同一效果。
 * 注意：SVG 图案的 x/y 只决定重复单元的裁剪窗口，内容格点并不随之平移，
 * 所以「移动图案原点」必须平移内容本身（与引擎 tileToLocal 平移等效）。
 * 等价关系只对 patternUnits="userSpaceOnUse" 成立（覆盖平移不被包围盒缩放）。
 */
export function materializeOverrides(doc: DocLike, overrides: Record<string, UseDragEdit>): void {
  for (const [nodeId, { dx, dy }] of Object.entries(overrides)) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) continue;
    const el = doc.querySelector(`[data-obj="${nodeId}"]`) ?? doc.querySelector(`[id="${nodeId}"]`);
    if (!el) continue;
    const fill = el.getAttribute('fill') ?? '';
    const m = fill.match(/^url\(\s*["']?#([^"')]+)["']?\s*\)$/);
    if (!m) continue;
    const pattern = doc.querySelector(`pattern[id="${m[1]}"]`);
    if (!pattern || !pattern.parentNode) continue;
    const clone = pattern.cloneNode(true);
    const newId = `${m[1]}--ovr-${nodeId}`;
    clone.setAttribute('id', newId);
    const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${round4(dx)} ${round4(dy)})`);
    let child = clone.firstChild;
    while (child) {
      const next: ElLike | null = (child as unknown as { nextSibling: ElLike | null }).nextSibling;
      g.appendChild(child);
      child = next;
    }
    clone.appendChild(g);
    pattern.parentNode.appendChild(clone);
    el.setAttribute('fill', `url(#${newId})`);
  }
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * resvg/usvg 怪癖补丁：userSpaceOnUse 图案的 x/y 在 resvg 里只影响平铺偏移，
 * 内容始终被裁剪到 [0,0,w,h]（SVG 规范应为 [x,x+w]×[y,y+h]）。
 * 把内容平移 (-x,-y) 后两种模型的渲染结果一致——只用于给独立渲染器生成真源，
 * 引擎写出的 SVG/PDF 不受影响。
 */
export function resvgPatternQuirkFix(doc: DocLike): void {
  const patterns = doc.querySelectorAll('pattern');
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i] as unknown as ElLike;
    const units = (p.getAttribute('patternUnits') ?? 'objectBoundingBox').trim();
    if (units !== 'userSpaceOnUse') continue;
    const x = Number(p.getAttribute('x') ?? 0);
    const y = Number(p.getAttribute('y') ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) continue;
    const g = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${round4(-x)} ${round4(-y)})`);
    let child = p.firstChild;
    while (child) {
      const next: ElLike | null = (child as unknown as { nextSibling: ElLike | null }).nextSibling;
      g.appendChild(child);
      child = next;
    }
    p.appendChild(g);
  }
}
