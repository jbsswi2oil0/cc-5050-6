/** 读取 canvaskit-lite（resvg）与 PNG 编解码所需的最小工具。 */
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BBox } from './types.js';

export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** 解码 `<image href>`：支持 data URL 与本地绝对路径，其它形式返回 null。 */
export async function decodeHref(href: string, baseDir = process.cwd()): Promise<RasterImage | null> {
  let bytes: Buffer;
  const dataMatch = href.match(/^data:image\/[^;,]+;base64,(.*)$/s);
  if (dataMatch) {
    bytes = Buffer.from(dataMatch[1], 'base64');
  } else if (/^https?:/i.test(href)) {
    return null;
  } else {
    try {
      bytes = await readFile(path.isAbsolute(href) ? href : path.resolve(baseDir, href));
    } catch {
      return null;
    }
  }
  const img = await loadImage(bytes);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(data) };
}

export function decodePng(bytes: Uint8Array): Promise<RasterImage> {
  return loadImage(Buffer.from(bytes)).then((img) => {
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    return { width: img.width, height: img.height, data: new Uint8ClampedArray(data) };
  });
}

export function cropImage(img: RasterImage, b: BBox): RasterImage {
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  const w = Math.max(1, Math.min(img.width - x, Math.ceil(b.w)));
  const h = Math.max(1, Math.min(img.height - y, Math.ceil(b.h)));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * img.width + x) * 4;
    data.set(img.data.subarray(src, src + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}

export function compositeOver(
  fg: RasterImage,
  bg: RasterImage | null,
  bgOffset: { x: number; y: number },
): RasterImage {
  if (!bg) return { ...fg, data: new Uint8ClampedArray(fg.data) };
  const data = new Uint8ClampedArray(fg.width * fg.height * 4);
  for (let y = 0; y < fg.height; y++) {
    for (let x = 0; x < fg.width; x++) {
      const i = (y * fg.width + x) * 4;
      const bx = x - bgOffset.x;
      const by = y - bgOffset.y;
      const aF = fg.data[i + 3] / 255;
      let br = 255, bgc = 255, bb = 255, ba = 1;
      if (bx >= 0 && by >= 0 && bx < bg.width && by < bg.height) {
        const j = (by * bg.width + bx) * 4;
        br = bg.data[j];
        bgc = bg.data[j + 1];
        bb = bg.data[j + 2];
        ba = bg.data[j + 3] / 255;
      }
      const aOut = aF + ba * (1 - aF);
      if (aOut <= 0) continue;
      data[i] = (fg.data[i] * aF + br * ba * (1 - aF)) / aOut;
      data[i + 1] = (fg.data[i + 1] * aF + bgc * ba * (1 - aF)) / aOut;
      data[i + 2] = (fg.data[i + 2] * aF + bb * ba * (1 - aF)) / aOut;
      data[i + 3] = aOut * 255;
    }
  }
  return { width: fg.width, height: fg.height, data };
}

export function isMostlyOpaque(img: RasterImage, threshold = 0.985): boolean {
  let opaque = 0;
  const total = img.width * img.height;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] >= 250) opaque++;
  return opaque / total >= threshold;
}

export function countPartiallyTransparent(img: RasterImage): { transparent: number; partial: number; opaque: number } {
  let transparent = 0;
  let partial = 0;
  let opaque = 0;
  for (let i = 3; i < img.data.length; i += 4) {
    const a = img.data[i];
    if (a <= 2) transparent++;
    else if (a >= 250) opaque++;
    else partial++;
  }
  return { transparent, partial, opaque };
}

export function encodePng(img: RasterImage): Buffer {
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  const data = ctx.createImageData(img.width, img.height);
  data.data.set(img.data);
  ctx.putImageData(data, 0, 0);
  return canvas.toBuffer('image/png');
}

export function emptyImage(w: number, h: number): RasterImage {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

export function fillImage(w: number, h: number, rgba: [number, number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width: w, height: h, data };
}

export function withAlphaMap(img: RasterImage, alpha: (x: number, y: number) => number): RasterImage {
  const data = new Uint8ClampedArray(img.data);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      data[i + 3] = Math.max(0, Math.min(255, data[i + 3] * alpha(x, y)));
    }
  }
  return { width: img.width, height: img.height, data };
}

export { createCanvas, ImageData, loadImage };
