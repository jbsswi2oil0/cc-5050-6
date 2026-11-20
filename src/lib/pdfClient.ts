import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDocument = pdfjs.PDFDocumentProxy;
export type PdfPage = pdfjs.PDFPageProxy;

export async function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  return pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
}

export async function renderPdfPage(
  page: PdfPage,
  target: HTMLCanvasElement,
  cssWidth: number,
  dpr = window.devicePixelRatio || 1,
): Promise<{ scale: number; pageWidth: number; pageHeight: number }> {
  const base = page.getViewport({ scale: 1 });
  const scale = (cssWidth / base.width) * dpr;
  const viewport = page.getViewport({ scale });
  target.width = Math.round(viewport.width);
  target.height = Math.round(viewport.height);
  target.style.width = `${cssWidth}px`;
  target.style.height = `${(cssWidth / base.width) * base.height}px`;
  const ctx = target.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#ffffff';  ctx.fillRect(0, 0, target.width, target.height);
  await page.render({ canvasContext: ctx, viewport } as never).promise;
  return { scale: viewport.scale, pageWidth: base.width, pageHeight: base.height };
}

/** 从 PDF 的标记内容中读出对象顺序；PDF.js 保留 BMC 的标签名。 */
export async function readMarkedObjects(page: PdfPage): Promise<string[]> {
  const ops = await page.getOperatorList();
  const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k])) as Record<number, string>;
  const ids: string[] = [];
  ops.fnArray.forEach((fn, i) => {
    if (names[fn] !== 'beginMarkedContent') return;
    const arg = ops.argsArray[i] as unknown;
    if (typeof arg === 'string') ids.push(arg);
    else if (arg && typeof arg === 'object' && typeof (arg as { name?: unknown }).name === 'string') {
      ids.push((arg as { name: string }).name);
    }
  });
  return ids;
}

/** 从标记内容读取对象顺序（浏览器端走 textContent，标签名会保留）。 */
export async function readMarkedOrder(page: PdfPage): Promise<string[]> {
  const content = await page.getTextContent({ includeMarkedContent: true } as never);
  const ids: string[] = [];
  for (const item of content.items as Array<{ type?: string; tag?: string | null }>) {
    if (item.type === 'beginMarkedContent' && item.tag) ids.push(item.tag);
    if (item.type === 'beginMarkedContentProps' && item.tag) ids.push(item.tag);
  }
  return ids;
}

/** 在指定画布上按设计坐标取平均色。 */
export function sampleAt(
  canvas: HTMLCanvasElement,
  pageWidth: number,
  point: { x: number; y: number; radius?: number },
): [number, number, number] {
  const ratio = canvas.width / pageWidth;
  const cx = Math.round(point.x * ratio);
  const cy = Math.round(point.y * ratio);
  const r = Math.max(0, Math.round((point.radius ?? 0) * ratio));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const w = Math.max(1, r * 2 + 1);
  const data = ctx.getImageData(Math.round(cx - r), Math.round(cy - r), w, w).data;
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    sr += data[i];
    sg += data[i + 1];
    sb += data[i + 2];
    n++;
  }
  return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
}

/** 用 PDF 自身的渲染结果采样探针点颜色（CSS 像素坐标）。 */
export function sampleCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  point: { x: number; y: number; radius?: number },
  pageWidth: number,
): [number, number, number] {
  void cssWidth;
  return sampleAt(canvas, pageWidth, point);
}

/** 计算两点平均绝对差（0..255）和最大通道差。 */
export function compareColors(
  a: [number, number, number],
  b: [number, number, number],
): { meanDelta: number; maxDelta: number } {
  const dr = Math.abs(a[0] - b[0]);
  const dg = Math.abs(a[1] - b[1]);
  const db = Math.abs(a[2] - b[2]);
  return { meanDelta: Math.round(((dr + dg + db) / 3) * 10) / 10, maxDelta: Math.max(dr, dg, db) };
}

export function hex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** 把源 PNG 与 PDF 画布按像素网格比较，返回局部区域的指标。 */
export function regionDiff(
  pdfCanvas: HTMLCanvasElement,
  source: HTMLImageElement,
  box: { x: number; y: number; w: number; h: number },
  pageWidth: number,
): { pixels: number; meanAbs: number; over4: number; maxDelta: number } {
  const scale = pdfCanvas.width / pageWidth;
  const sw = source.naturalWidth / pageWidth;
  const tmp = document.createElement('canvas');
  tmp.width = source.naturalWidth;
  tmp.height = source.naturalHeight;
  tmp.getContext('2d', { willReadFrequently: true })!.drawImage(source, 0, 0);
  const srcData = tmp.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, tmp.width, tmp.height).data;
  const x0 = Math.max(0, Math.round(box.x * scale));
  const y0 = Math.max(0, Math.round(box.y * scale));
  const w = Math.min(pdfCanvas.width - x0, Math.max(1, Math.round(box.w * scale)));
  const h = Math.min(pdfCanvas.height - y0, Math.max(1, Math.round(box.h * scale)));
  const pdfData = pdfCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(x0, y0, w, h).data;
  let sum = 0, over4 = 0, max = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = Math.min(source.naturalWidth - 1, Math.round((x0 + x) / scale * sw));
      const py = Math.min(source.naturalHeight - 1, Math.round((y0 + y) / scale * sw));
      const si = (py * source.naturalWidth + px) * 4;
      const pi = (y * w + x) * 4;
      const dr = Math.abs(srcData[si] - pdfData[pi]);
      const dg = Math.abs(srcData[si + 1] - pdfData[pi + 1]);
      const db = Math.abs(srcData[si + 2] - pdfData[pi + 2]);
      const m = Math.max(dr, dg, db);
      sum += (dr + dg + db) / 3;
      if (m > 4) over4++;
      if (m > max) max = m;
      n++;
    }
  }
  return { pixels: n, meanAbs: Math.round((sum / n) * 100) / 100, over4, maxDelta: max };
}
