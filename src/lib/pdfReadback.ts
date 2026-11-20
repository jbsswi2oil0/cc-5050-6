/**
 * 从「回读后的 PDF」本身建立命中索引：
 * 遍历标记内容 + 当前变换 + 路径构造操作符，重建每个对象的可见几何。
 * 这样点击检查的不是源 SVG，而是 PDF 实际写出的内容。
 */
import * as pdfjs from 'pdfjs-dist';

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export interface PdfPathShape {
  /** 扁平化后的 DrawOPS 流。 */
  segments: Float64Array;
  /** 画到页面空间（y-down 设计坐标）的完整变换。 */
  transform: Matrix;
  evenOdd: boolean;
}

export interface PdfClipShape {
  segments: Float64Array;
  transform: Matrix;
  evenOdd: boolean;
}

export interface PdfObjectGeometry {
  id: string;
  paths: PdfPathShape[];
  clips: PdfClipShape[];
  /** 该对象写入的图像/栅格块范围（设计坐标）。 */
  images: Array<{ x: number; y: number; w: number; h: number }>;
}

export interface PdfReadResult {
  /** 标记内容出现的先后顺序（即绘制顺序）。 */
  order: string[];
  objects: Map<string, PdfObjectGeometry>;
  opsSeen: Record<string, number>;
}

/** DrawOPS: moveTo=0 lineTo=1 curveTo=2 closePath=3 */
function flattenDrawOps(data: ArrayLike<number>): Float64Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    const op = data[i++];
    if (op === 0) {
      out.push(0, data[i++], data[i++]);
    } else if (op === 1) {
      out.push(1, data[i++], data[i++]);
    } else if (op === 2) {
      out.push(2, data[i++], data[i++], data[i++], data[i++], data[i++], data[i++]);
    } else if (op === 3) {
      out.push(3);
    } else {
      break;
    }
  }
  return new Float64Array(out);
}

export async function readPdfGeometry(page: import('pdfjs-dist').PDFPageProxy): Promise<PdfReadResult> {
  const ops = await page.getOperatorList();
  const OPS = pdfjs.OPS as unknown as Record<string, number>;
  const nameOf = new Map<number, string>();
  for (const [k, v] of Object.entries(OPS)) nameOf.set(v as number, k);

  const order: string[] = [];
  const objects = new Map<string, PdfObjectGeometry>();
  const opsSeen: Record<string, number> = {};

  interface State {
    ctm: Matrix;
    clip: PdfClipShape[];
  }
  const stack: State[] = [{ ctm: IDENTITY, clip: [] }];
  const marked: string[] = [];
  let pendingClip: PdfClipShape | null = null;
  let current: PdfObjectGeometry | null = null;
  let pendingImage: { x: number; y: number; w: number; h: number } | null = null;

  const ensure = (): PdfObjectGeometry => {
    const id = marked[marked.length - 1] ?? '__page__';
    let obj = objects.get(id);
    if (!obj) {
      obj = { id, paths: [], clips: [], images: [] };
      objects.set(id, obj);
      order.push(id);
    }
    return obj;
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const name = nameOf.get(fn) ?? String(fn);
    opsSeen[name] = (opsSeen[name] ?? 0) + 1;
    const args = ops.argsArray[i] as unknown;

    switch (name) {
      case 'save':
        stack.push({
          ctm: stack[stack.length - 1].ctm,
          clip: stack[stack.length - 1].clip.slice(),
        });
        break;
      case 'restore':
        if (stack.length > 1) stack.pop();
        pendingClip = null;
        break;
      case 'transform': {
        const m = args as Matrix;
        const top = stack[stack.length - 1];
        top.ctm = mul(top.ctm, m);
        break;
      }
      case 'beginMarkedContent': {
        const tag = markedTag(args);
        if (tag) marked.push(tag);
        current = ensure();
        break;
      }
      case 'endMarkedContent':
        marked.pop();
        current = marked.length ? ensure() : null;
        break;
      case 'constructPath': {
        // args 结构：[op, [Float32Array], minMax]——路径数据本身又包了一层数组
        const [opId, data] = args as [number, unknown];
        const top = stack[stack.length - 1];
        const raw = unwrapDrawData(data);
        const segments = flattenDrawOps(raw);
        if (opId === OPS.endPath) {
          pendingClip = { segments, transform: top.ctm, evenOdd: false };
        } else {
          const target = current ?? ensure();
          target.paths.push({
            segments,
            transform: top.ctm,
            evenOdd: opId === OPS.eoFill || opId === OPS.eoFillStroke || opId === OPS.closeEOFillStroke,
          });
        }
        break;
      }
      case 'clip':
      case 'eoClip':
        if (pendingClip) {
          pendingClip = { ...pendingClip, evenOdd: name === 'eoClip' };
          stack[stack.length - 1].clip.push(pendingClip);
          pendingClip = null;
        }
        break;
      case 'paintImageXObject': {
        // 图像 XObject 画在单位正方形上，由当前 CTM（PDF 用户空间）决定范围
        const c = stack[stack.length - 1].ctm;
        const corners: Array<[number, number]> = [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ].map(([u, v]) => [c[0] * u + c[2] * v + c[4], c[1] * u + c[3] * v + c[5]]);
        const xs = corners.map((p) => p[0]);
        const ys = corners.map((p) => p[1]);
        pendingImage = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys),
        };
        break;
      }
      case 'fill':
      case 'eoFill':
      case 'fillStroke':
      case 'eoFillStroke':
      case 'closeFillStroke':
      case 'closeEOFillStroke': {
        const target = current ?? ensure();
        if (pendingImage) {
          target.images.push(pendingImage);
          pendingImage = null;
        }
        target.clips.push(...stack[stack.length - 1].clip);
        break;
      }
      case 'stroke':
      case 'closeStroke': {
        const target = current ?? ensure();
        target.clips.push(...stack[stack.length - 1].clip);
        break;
      }
      default:
        break;
    }
  }

  // 每个对象只保留自己的裁剪集合（去重）
  for (const obj of objects.values()) {
    obj.clips = dedupeClips(obj.clips);
  }
  return { order, objects, opsSeen };
}

/** PDF.js 的路径数据可能被单层数组包裹；两类构建都要兼容。 */
function unwrapDrawData(data: unknown): ArrayLike<number> {
  if (Array.isArray(data)) {
    const first = data[0];
    if (first == null || typeof first === 'number') return data as number[];
    if (typeof first === 'object' && typeof (first as ArrayLike<number>).length === 'number') {
      return first as ArrayLike<number>;
    }
    return [];
  }
  if (data && typeof data === 'object') return data as ArrayLike<number>;
  return [];
}

function markedTag(args: unknown): string | null {
  // 不同构建里 BMC 参数可能是字符串、{name} 或 [name] / [{name}]
  const first = Array.isArray(args) ? args[0] : args;
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const rec = first as { name?: unknown; tag?: unknown };
    if (typeof rec.name === 'string') return rec.name;
    if (typeof rec.tag === 'string') return rec.tag;
  }
  return null;
}

function dedupeClips(clips: PdfClipShape[]): PdfClipShape[] {
  const seen = new Set<string>();
  const out: PdfClipShape[] = [];
  for (const c of clips) {
    const key = `${c.transform.join(',')}|${c.segments.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

const hitCanvas: { el: HTMLCanvasElement | null } = { el: null };
function hitCtx(): CanvasRenderingContext2D {
  if (!hitCanvas.el) {
    hitCanvas.el = document.createElement('canvas');
    hitCanvas.el.width = 8;
    hitCanvas.el.height = 8;
  }
  return hitCanvas.el.getContext('2d')!;
}

function segmentsToPath2D(segments: Float64Array): Path2D {
  const path = new Path2D();
  for (let i = 0; i < segments.length; ) {
    const op = segments[i++];
    if (op === 0) {
      path.moveTo(segments[i++], segments[i++]);
    } else if (op === 1) {
      path.lineTo(segments[i++], segments[i++]);
    } else if (op === 2) {
      path.bezierCurveTo(
        segments[i++], segments[i++],
        segments[i++], segments[i++],
        segments[i++], segments[i++],
      );
    } else if (op === 3) {
      path.closePath();
    } else {
      break;
    }
  }
  return path;
}

/** 点击位置（设计坐标，y-down）命中的 PDF 对象，自顶向下。 */
export function hitPdfObjects(
  read: PdfReadResult,
  x: number,
  y: number,
  pageHeight: number,
  tolerance = 2.5,
): PdfObjectGeometry[] {
  const ctx = hitCtx();
  const hits: PdfObjectGeometry[] = [];
  // 操作符里的坐标是 PDF 用户空间（y-up）：把点击点翻转过来再测
  const py = pageHeight - y;
  // 后绘制在前：倒序遍历
  for (let i = read.order.length - 1; i >= 0; i--) {
    const obj = read.objects.get(read.order[i]);
    if (!obj) continue;
    let hit = false;
    for (const img of obj.images) {
      if (x >= img.x - tolerance && py >= img.y - tolerance && x <= img.x + img.w + tolerance && py <= img.y + img.h + tolerance) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      for (const path of obj.paths) {
        if (pathHit(ctx, path, x, py, tolerance)) {
          hit = true;
          break;
        }
      }
    }
    if (hit && obj.clips.length && !obj.clips.every((c) => clipHit(ctx, c, x, py))) {
      hit = false;
    }
    if (hit) hits.push(obj);
  }
  return hits;
}

function pathHit(
  ctx: CanvasRenderingContext2D,
  shape: PdfPathShape,
  x: number,
  y: number,
  tolerance: number,
): boolean {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.setTransform(...shape.transform);
  const path = segmentsToPath2D(shape.segments);
  if (ctx.isPointInPath(path, x, y, shape.evenOdd ? 'evenodd' : 'nonzero')) return true;
  // 细线在低倍率下很难点中，给一点容差
  ctx.lineWidth = tolerance * 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  return ctx.isPointInStroke(path, x, y);
}

function clipHit(ctx: CanvasRenderingContext2D, clip: PdfClipShape, x: number, y: number): boolean {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.setTransform(...clip.transform);
  const path = segmentsToPath2D(clip.segments);
  return ctx.isPointInPath(path, x, y, clip.evenOdd ? 'evenodd' : 'nonzero');
}

export { IDENTITY as PDF_IDENTITY };
