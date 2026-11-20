import { Resvg } from '@resvg/resvg-js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { RasterImage } from '../engine/raster.js';

/** 用 resvg 把 SVG 文本渲染成像素；仅用于局部栅格与对照渲染。 */
export async function renderSvgToImage(svg: string, width: number): Promise<RasterImage> {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.max(1, Math.round(width)) },
    font: { loadSystemFonts: true },
  });
  const png = resvg.render().asPng();
  const img = await loadImage(Buffer.from(png));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(data) };
}
