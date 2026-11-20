/**
 * 命令行验收：不经过浏览器，直接跑 解析 → 计划 → PDF → 独立渲染对照。
 * 用法：npx tsx scripts/verify.ts [--profile pdf17-native|reader-lite] [--strict] [--scale 2]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Resvg } from '@resvg/resvg-js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseSvg } from '../src/engine/parseSvg.js';
import { buildPlan } from '../src/engine/plan.js';
import { buildPdf } from '../src/engine/pdfWriter.js';
import { rasterizeTile } from '../src/engine/rasterizeTile.js';
import { PROBES } from '../src/lib/types.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const profileId = flag('--profile', 'pdf17-native');
const strict = args.includes('--strict');
const rasterScale = Number(flag('--scale', '2'));
const outDir = '.verify';

const svg = readFileSync('src/artwork/poster.svg', 'utf8');
const scene = parseSvg(svg);
const plan = buildPlan(scene, { profileId, strict, rasterScale });
console.log(`档案 ${plan.profileName} · 严格 ${strict ? '开' : '关'}`);
console.log(`统计 矢量 ${plan.stats.vector} / 栅格 ${plan.stats.raster} / 拒绝 ${plan.stats.refused}`);

if (plan.status !== 'ok') {
  for (const r of plan.refusals) console.log(`拒绝 ${r.objectId}（${r.label}）：${r.reason}`);
  process.exit(strict ? 0 : 1);
}

const tiles = [];
for (const t of plan.tiles) tiles.push(await rasterizeTile(scene, t));
const pdf = buildPdf({ scene, plan, tiles });
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/out.pdf`, pdf.bytes);
console.log(`PDF ${pdf.bytes.length} 字节 → ${outDir}/out.pdf`);

const scale = 2;
const srcPng = new Resvg(svg, { fitTo: { mode: 'width', value: scene.width * scale } }).render().asPng();
const src = await loadImage(srcPng);

const data = new Uint8Array(readFileSync(`${outDir}/out.pdf`));
const doc = await pdfjs.getDocument({ data, useSystemFonts: false }).promise;
const page = await doc.getPage(1);
const viewport = page.getViewport({ scale });
const pdfCanvas = createCanvas(viewport.width, viewport.height);
const ctx = pdfCanvas.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, viewport.width, viewport.height);
await page.render({ canvasContext: ctx as never, viewport }).promise;
writeFileSync(`${outDir}/pdf.png`, pdfCanvas.toBuffer('image/png'));
writeFileSync(`${outDir}/source.png`, srcPng);

// 逐像素对照（源图由 resvg 独立渲染）
const srcCanvas = createCanvas(src.width, src.height);
srcCanvas.getContext('2d').drawImage(src, 0, 0);
const a = srcCanvas.getContext('2d').getImageData(0, 0, src.width, src.height).data;
const b = ctx.getImageData(0, 0, viewport.width, viewport.height).data;
let sum = 0;
let big = 0;
for (let y = 0; y < viewport.height; y++) {
  for (let x = 0; x < viewport.width; x++) {
    const i = (y * src.width + x) * 4;
    const j = (y * viewport.width + x) * 4;
    const dr = Math.abs(a[i] - b[j]);
    const dg = Math.abs(a[i + 1] - b[j + 1]);
    const db = Math.abs(a[i + 2] - b[j + 2]);
    sum += dr + dg + db;
    if (Math.max(dr, dg, db) > 12) big++;
  }
}
const pixels = viewport.width * viewport.height;
console.log(
  `像素对照 均差 ${(sum / (pixels * 3)).toFixed(3)} / 超 12 级 ${big}（${((big / pixels) * 100).toFixed(2)}%）`,
);

// 固定探针
const ops = await page.getOperatorList();
const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k])) as Record<number, string>;
let marked = 0;
ops.fnArray.forEach((fn) => {
  if (names[fn] === 'beginMarkedContent') marked++;
});
console.log(`标记对象 ${marked} / 计划条目 ${plan.entries.length}`);

const sample = (data: Uint8ClampedArray, width: number, p: { x: number; y: number; radius?: number }) => {
  const r = Math.max(1, Math.round((p.radius ?? 2) * scale));
  const cx = Math.round(p.x * scale);
  const cy = Math.round(p.y * scale);
  let sr = 0,
    sg = 0,
    sb = 0,
    n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const i = (y * width + x) * 4;
      sr += data[i];
      sg += data[i + 1];
      sb += data[i + 2];
      n++;
    }
  }
  return [sr / n, sg / n, sb / n].map((v) => Math.round(v)) as [number, number, number];
};
const hex = (c: number[]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

let failed = 0;
for (const p of PROBES) {
  const sp = sample(a, src.width, p);
  const pp = sample(b, viewport.width, p);
  const delta = Math.round(((Math.abs(sp[0] - pp[0]) + Math.abs(sp[1] - pp[1]) + Math.abs(sp[2] - pp[2])) / 3) * 10) / 10;
  const tol = p.tolerance ?? 6;
  const pass = delta <= tol;
  if (!pass) failed++;
  console.log(`${pass ? '通过' : '偏差'} ${p.id.padEnd(10)} 源 ${hex(sp)} PDF ${hex(pp)} Δ ${delta}（容差 ${tol}）`);
}
console.log(failed === 0 ? '全部探针通过' : `${failed} 个探针超出容差`);
process.exit(failed === 0 ? 0 : 1);
