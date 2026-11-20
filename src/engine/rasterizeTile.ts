import type { RasterTilePlan, Scene, SceneNode, TileRaster } from './types.js';
import { buildBackdropSvg, buildIsolatedSvg } from './sceneToSvg.js';
import { renderSvgToImage } from '../server/renderSvg.js';
import { emptyImage, type RasterImage } from './raster.js';

/** 依据计划为每个栅格瓦片生成像素；背景依赖型只回读实际参与区域。 */
export async function rasterizeTile(scene: Scene, tile: RasterTilePlan): Promise<TileRaster> {
  const node = scene.byId.get(tile.objectId);
  if (!node) throw new Error(`找不到对象 ${tile.objectId}`);
  const region = tile.readBounds;
  const pixelWidth = Math.max(1, Math.round(region.w * tile.scale));
  const scale = pixelWidth / Math.max(1e-6, region.w);

  if (tile.strategy === 'backdrop-blend') {
    const backdropResult = buildBackdropSvg(scene, node, { region, pixelWidth });
    const backdrop = await renderSvgToImage(backdropResult.svg, backdropResult.width);
    const foregroundResult = buildIsolatedSvg(scene, node, {
      region,
      pixelWidth,
      effects: true,
    });
    // 前景不能带自己的混合模式，否则会先在透明底上与自身混合
    const fgSvg = foregroundResult.svg.replace(/style="mix-blend-mode:[^"]*"/g, '');
    const foreground = await renderSvgToImage(fgSvg, foregroundResult.width);
    const composed = blendCompose(backdrop, foreground, node.blend);
    const cropped = cropToPaint(composed, region, tile.paintBounds, scale);
    return {
      objectId: tile.objectId,
      strategy: tile.strategy,
      paintBounds: tile.paintBounds,
      readBounds: tile.readBounds,
      width: cropped.width,
      height: cropped.height,
      rgba: cropped.data,
      participationBounds: tile.participationBounds,
    };
  }

  const isolated = buildIsolatedSvg(scene, node, { region, pixelWidth, effects: true });
  const image = await renderSvgToImage(isolated.svg, isolated.width);
  const cropped = cropToPaint(image, region, tile.paintBounds, scale);
  return {
    objectId: tile.objectId,
    strategy: tile.strategy,
    paintBounds: tile.paintBounds,
    readBounds: tile.readBounds,
    width: cropped.width,
    height: cropped.height,
    rgba: cropped.data,
    participationBounds: tile.participationBounds,
  };
}

function cropToPaint(image: RasterImage, region: BBox, paint: BBox, scale: number): RasterImage {
  const x0 = Math.round((paint.x - region.x) * scale);
  const y0 = Math.round((paint.y - region.y) * scale);
  const w = Math.max(1, Math.round(paint.w * scale));
  const h = Math.max(1, Math.round(paint.h * scale));
  const out: RasterImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, x0 + x));
      const sy = Math.min(image.height - 1, Math.max(0, y0 + y));
      const s = (sy * image.width + sx) * 4;
      const d = (y * w + x) * 4;
      out.data[d] = image.data[s];
      out.data[d + 1] = image.data[s + 1];
      out.data[d + 2] = image.data[s + 2];
      out.data[d + 3] = image.data[s + 3];
    }
  }
  return out;
}

interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const BLEND_FNS: Record<string, (b: number, s: number) => number> = {
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'hard-light': (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  'soft-light': (b, s) =>
    s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b),
};

/**
 * 把前景按 W3C 混合公式叠加到背景上。
 * 关键点：只在背景已有内容的像素上强制不透明；
 * 背景为空的位置保留前景自身的透明度，避免把整块底色重新刷成不透明。
 */
function blendCompose(backdrop: RasterImage, foreground: RasterImage, blend: string): RasterImage {
  const fn = BLEND_FNS[blend] ?? BLEND_FNS.multiply;
  const w = foreground.width;
  const h = foreground.height;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    const aB = backdrop.data[i + 3] / 255;
    const aF = foreground.data[i + 3] / 255;
    if (aB <= 0.002) {
      data[i] = foreground.data[i];
      data[i + 1] = foreground.data[i + 1];
      data[i + 2] = foreground.data[i + 2];
      data[i + 3] = foreground.data[i + 3];
      continue;
    }
    const br = backdrop.data[i] / 255;
    const bg = backdrop.data[i + 1] / 255;
    const bb = backdrop.data[i + 2] / 255;
    const fr = foreground.data[i] / 255;
    const fg = foreground.data[i + 1] / 255;
    const fb = foreground.data[i + 2] / 255;
    // 源色按 alpha 与背景混合；W3C: Cr = (1 - αb) * Cs + αb * B(Cb, Cs)
    const sr = (1 - aB) * fr + aB * fn(br, fr);
    const sg = (1 - aB) * fg + aB * fn(bg, fg);
    const sb = (1 - aB) * fb + aB * fn(bb, fb);
    // 前景覆盖度作用于结果
    const outR = br * (1 - aF) + sr * aF;
    const outG = bg * (1 - aF) + sg * aF;
    const outB = bb * (1 - aF) + sb * aF;
    const aOut = aF + aB * (1 - aF);
    const forceOpaque = aB >= 0.999 && aF > 0.002;
    const a = forceOpaque ? 1 : Math.min(1, aOut);
    if (a <= 0.001) continue;
    data[i] = Math.round((outR / a) * 255);
    data[i + 1] = Math.round((outG / a) * 255);
    data[i + 2] = Math.round((outB / a) * 255);
    data[i + 3] = Math.round(a * 255);
  }
  return { width: w, height: h, data };
}

export { emptyImage };
export type { SceneNode };
