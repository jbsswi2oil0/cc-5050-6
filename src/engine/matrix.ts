export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return IDENTITY;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  const e = (m[2] * m[5] - m[3] * m[4]) / det;
  const f = (m[1] * m[4] - m[0] * m[5]) / det;
  return [a, b, c, d, e, f];
}

export function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

/** 将 x 轴方向映射到单位向量，用于计算描边在设备空间中的实际粗细。 */
export function maxScaleOf(m: Matrix): number {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  return Math.max(sx, sy);
}

export function formatMatrix(m: Matrix): string {
  return m.map((v) => round(v, 5)).join(' ');
}

export function round(v: number, digits = 4): number {
  if (!Number.isFinite(v)) return 0;
  const p = 10 ** digits;
  const r = Math.round(v * p) / p;
  return Object.is(r, -0) ? 0 : r;
}
