import svgpath from 'svgpath';
import type { BBox } from './types.js';
import type { Matrix } from './matrix.js';
import { applyPoint, multiply, round } from './matrix.js';

type Pt = [number, number];

function num(v: number): string {
  return String(round(v, 3));
}

export function rectPath(x: number, y: number, w: number, h: number, rx = 0, ry = rx): string {
  if (w <= 0 || h <= 0) return '';
  rx = Math.min(Math.max(rx, 0), w / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);
  if (rx === 0 && ry === 0) {
    return `M${num(x)} ${num(y)} H${num(x + w)} V${num(y + h)} H${num(x)} Z`;
  }
  const k = 0.5522847498;
  const kx = rx * k;
  const ky = ry * k;
  return [
    `M${num(x + rx)} ${num(y)}`,
    `H${num(x + w - rx)}`,
    `C${num(x + w - rx + kx)} ${num(y)} ${num(x + w)} ${num(y + ry - ky)} ${num(x + w)} ${num(y + ry)}`,
    `V${num(y + h - ry)}`,
    `C${num(x + w)} ${num(y + h - ry + ky)} ${num(x + w - rx + kx)} ${num(y + h)} ${num(x + w - rx)} ${num(y + h)}`,
    `H${num(x + rx)}`,
    `C${num(x + rx - kx)} ${num(y + h)} ${num(x)} ${num(y + h - ry + ky)} ${num(x)} ${num(y + h - ry)}`,
    `V${num(y + ry)}`,
    `C${num(x)} ${num(y + ry - ky)} ${num(x + rx - kx)} ${num(y)} ${num(x + rx)} ${num(y)}`,
    'Z',
  ].join(' ');
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  if (rx <= 0 || ry <= 0) return '';
  const k = 0.5522847498;
  const kx = rx * k;
  const ky = ry * k;
  return [
    `M${num(cx - rx)} ${num(cy)}`,
    `C${num(cx - rx)} ${num(cy - ky)} ${num(cx - kx)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)}`,
    `C${num(cx + kx)} ${num(cy - ry)} ${num(cx + rx)} ${num(cy - ky)} ${num(cx + rx)} ${num(cy)}`,
    `C${num(cx + rx)} ${num(cy + ky)} ${num(cx + kx)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)}`,
    `C${num(cx - kx)} ${num(cy + ry)} ${num(cx - rx)} ${num(cy + ky)} ${num(cx - rx)} ${num(cy)}`,
    'Z',
  ].join(' ');
}

export function polygonPath(points: string, close: boolean): string {
  const nums = points.trim().split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v));
  if (nums.length < 4) return '';
  let d = `M${num(nums[0])} ${num(nums[1])}`;
  for (let i = 2; i + 1 < nums.length; i += 2) d += ` L${num(nums[i])} ${num(nums[i + 1])}`;
  return close ? `${d} Z` : d;
}

export function linePath(x1: number, y1: number, x2: number, y2: number): string {
  return `M${num(x1)} ${num(y1)} L${num(x2)} ${num(y2)}`;
}

/** 规范化为绝对 M/L/C/Z 路径（弧线/二次线展开），可直接写入 PDF。 */
export function normalizePath(d: string): string {
  if (!d) return '';
  let normalized: string;
  try {
    normalized = svgpath(d).abs().unshort().unarc().round(4).toString();
  } catch {
    return '';
  }
  const segs: string[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  try {
    svgpath(normalized).iterate((seg) => {
      const cmd = seg[0];
      if (cmd === 'M') {
        cx = seg[1];
        cy = seg[2];
        sx = cx;
        sy = cy;
        segs.push(`M${num(cx)} ${num(cy)}`);
      } else if (cmd === 'L' || cmd === 'H' || cmd === 'V') {
        const nx = cmd === 'V' ? cx : seg[1];
        const ny = cmd === 'H' ? cy : cmd === 'V' ? seg[1] : seg[2];
        cx = nx;
        cy = ny;
        segs.push(`L${num(cx)} ${num(cy)}`);
      } else if (cmd === 'C') {
        segs.push(`C${num(seg[1])} ${num(seg[2])} ${num(seg[3])} ${num(seg[4])} ${num(seg[5])} ${num(seg[6])}`);
        cx = seg[5];
        cy = seg[6];
      } else if (cmd === 'Q') {
        const qx = seg[1];
        const qy = seg[2];
        const ex = seg[3];
        const ey = seg[4];
        segs.push(
          `C${num(cx + (2 / 3) * (qx - cx))} ${num(cy + (2 / 3) * (qy - cy))} ${num(ex + (2 / 3) * (qx - ex))} ${num(ey + (2 / 3) * (qy - ey))} ${num(ex)} ${num(ey)}`,
        );
        cx = ex;
        cy = ey;
      } else if (cmd === 'Z' || cmd === 'z') {
        segs.push('Z');
        cx = sx;
        cy = sy;
      }
    });
  } catch {
    return normalized;
  }
  return segs.join(' ');
}

export function transformPath(d: string, m: Matrix): string {
  const segs: string[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  try {
    svgpath(d).iterate((seg) => {
      const cmd = seg[0];
      if (cmd === 'M') {
        [cx, cy] = applyPoint(m, seg[1], seg[2]);
        sx = cx;
        sy = cy;
        segs.push(`M${num(cx)} ${num(cy)}`);
      } else if (cmd === 'L') {
        [cx, cy] = applyPoint(m, seg[1], seg[2]);
        segs.push(`L${num(cx)} ${num(cy)}`);
      } else if (cmd === 'H') {
        [cx, cy] = applyPoint(m, seg[1], cy);
        segs.push(`L${num(cx)} ${num(cy)}`);
      } else if (cmd === 'V') {
        [cx, cy] = applyPoint(m, cx, seg[1]);
        segs.push(`L${num(cx)} ${num(cy)}`);
      } else if (cmd === 'C') {
        const [c1x, c1y] = applyPoint(m, seg[1], seg[2]);
        const [c2x, c2y] = applyPoint(m, seg[3], seg[4]);
        [cx, cy] = applyPoint(m, seg[5], seg[6]);
        segs.push(`C${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(cx)} ${num(cy)}`);
      } else if (cmd === 'Q') {
        const [qx, qy] = applyPoint(m, seg[1], seg[2]);
        const [ex, ey] = applyPoint(m, seg[3], seg[4]);
        segs.push(
          `C${num(cx + (2 / 3) * (qx - cx))} ${num(cy + (2 / 3) * (qy - cy))} ${num(ex + (2 / 3) * (qx - ex))} ${num(ey + (2 / 3) * (qy - ey))} ${num(ex)} ${num(ey)}`,
        );
        cx = ex;
        cy = ey;
      } else if (cmd === 'Z' || cmd === 'z') {
        segs.push('Z');
        cx = sx;
        cy = sy;
      }
    });
  } catch {
    return d;
  }
  return segs.join(' ');
}

interface DrawSeg {
  cmd: 'M' | 'L' | 'C' | 'Z';
  p: number[];
}

function toSegments(d: string): DrawSeg[] {
  let normalized: string;
  try {
    normalized = svgpath(d).abs().unshort().unarc().toString();
  } catch {
    return [];
  }
  const out: DrawSeg[] = [];
  try {
    svgpath(normalized).iterate((seg) => {
      const cmd = seg[0];
      if (cmd === 'M') out.push({ cmd: 'M', p: [seg[1], seg[2]] });
      else if (cmd === 'L') out.push({ cmd: 'L', p: [seg[1], seg[2]] });
      else if (cmd === 'H') out.push({ cmd: 'L', p: [seg[1], out.length ? out[out.length - 1].p[1] : 0] });
      else if (cmd === 'V') out.push({ cmd: 'L', p: [out.length ? out[out.length - 1].p[0] : 0, seg[1]] });
      else if (cmd === 'C') out.push({ cmd: 'C', p: [seg[1], seg[2], seg[3], seg[4], seg[5], seg[6]] });
      else if (cmd === 'Z' || cmd === 'z') out.push({ cmd: 'Z', p: [] });
    });
  } catch {
    return [];
  }
  return out;
}

export function pathBBox(d: string): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  for (const seg of toSegments(d)) {
    if (seg.cmd === 'M') {
      [cx, cy] = seg.p;
      sx = cx;
      sy = cy;
      add(cx, cy);
    } else if (seg.cmd === 'L') {
      [cx, cy] = seg.p;
      add(cx, cy);
    } else if (seg.cmd === 'C') {
      const p0: Pt = [cx, cy];
      const p1: Pt = [seg.p[0], seg.p[1]];
      const p2: Pt = [seg.p[2], seg.p[3]];
      const p3: Pt = [seg.p[4], seg.p[5]];
      for (const t of cubicExtrema(p0, p1, p2, p3)) {
        const [x, y] = cubicAt(p0, p1, p2, p3, t);
        add(x, y);
      }
      cx = p3[0];
      cy = p3[1];
      add(cx, cy);
    } else if (seg.cmd === 'Z') {
      cx = sx;
      cy = sy;
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function cubicExtrema(p0: Pt, p1: Pt, p2: Pt, p3: Pt): number[] {
  const ts = [0, 1];
  for (const axis of [0, 1] as const) {
    const a = -p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis];
    const b = 2 * (p0[axis] - 2 * p1[axis] + p2[axis]);
    const c = -p0[axis] + p1[axis];
    if (Math.abs(a) < 1e-9) {
      if (Math.abs(b) > 1e-9) {
        const t = -c / b;
        if (t > 0 && t < 1) ts.push(t);
      }
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        for (const t of [(-b + sq) / (2 * a), (-b - sq) / (2 * a)]) {
          if (t > 0 && t < 1) ts.push(t);
        }
      }
    }
  }
  return ts;
}

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const mt = 1 - t;
  return [
    mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0],
    mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1],
  ];
}

export function unionBBox(a: BBox | null, b: BBox | null): BBox | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.w, b.x + b.w);
  const bt = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: r - x, h: bt - y };
}

export function unionAll(list: (BBox | null)[]): BBox | null {
  let out: BBox | null = null;
  for (const b of list) out = unionBBox(out, b);
  return out;
}

export function transformBBox(b: BBox, m: Matrix): BBox {
  const pts = [
    applyPoint(m, b.x, b.y),
    applyPoint(m, b.x + b.w, b.y),
    applyPoint(m, b.x, b.y + b.h),
    applyPoint(m, b.x + b.w, b.y + b.h),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function expandBBox(b: BBox, by: number): BBox {
  return { x: b.x - by, y: b.y - by, w: b.w + by * 2, h: b.h + by * 2 };
}

export function intersectBBox(a: BBox, b: BBox): BBox {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || bt <= y) return { x, y, w: 0, h: 0 };
  return { x, y, w: r - x, h: bt - y };
}

export function bboxArea(b: BBox | null): number {
  return b ? Math.max(0, b.w) * Math.max(0, b.h) : 0;
}

export function bboxContains(a: BBox, b: BBox): boolean {
  return b.x >= a.x - 1e-6 && b.y >= a.y - 1e-6 && b.x + b.w <= a.x + a.w + 1e-6 && b.y + b.h <= a.y + a.h + 1e-6;
}

export function pointInBBox(b: BBox, x: number, y: number): boolean {
  return x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h;
}

export function snapBBox(b: BBox, scale: number): BBox {
  const x = Math.floor(b.x * scale) / scale;
  const y = Math.floor(b.y * scale) / scale;
  const r = Math.ceil((b.x + b.w) * scale) / scale;
  const bt = Math.ceil((b.y + b.h) * scale) / scale;
  return { x, y, w: r - x, h: bt - y };
}

export function parseTransform(value: string | null | undefined): Matrix {
  if (!value) return [1, 0, 0, 1, 0, 0];
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value))) {
    const args = match[2].split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v));
    let t: Matrix = [1, 0, 0, 1, 0, 0];
    if (match[1] === 'matrix' && args.length === 6) t = args as Matrix;
    else if (match[1] === 'translate' && args.length >= 1) t = [1, 0, 0, 1, args[0], args[1] ?? 0];
    else if (match[1] === 'scale' && args.length >= 1) t = [args[0], 0, 0, args[1] ?? args[0], 0, 0];
    else if (match[1] === 'rotate' && args.length >= 1) {
      const a = (args[0] * Math.PI) / 180;
      const rot: Matrix = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
      t =
        args.length >= 3
          ? multiply(multiply([1, 0, 0, 1, args[1], args[2]], rot), [1, 0, 0, 1, -args[1], -args[2]])
          : rot;
    } else if (match[1] === 'skewX' && args.length === 1) t = [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0];
    else if (match[1] === 'skewY' && args.length === 1) t = [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0];
    m = multiply(m, t);
  }
  return m;
}
