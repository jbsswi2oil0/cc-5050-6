/**
 * 命令行验收：不经过浏览器，直接跑 解析 → 计划 → PDF → 独立渲染对照。
 * 用法：npx tsx scripts/verify.ts [--art poster|duo] [--profile pdf17-native|reader-lite]
 *        [--strict] [--scale 2] [--override inst-b:12,8]（可重复）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Resvg } from '@resvg/resvg-js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { DOMParser } from 'linkedom';
import { parseSvg } from '../src/engine/parseSvg.js';
import { buildPlan } from '../src/engine/plan.js';
import { buildPdf } from '../src/engine/pdfWriter.js';
import { rasterizeTile } from '../src/engine/rasterizeTile.js';
import { PROBE_SETS, resolveProbe } from '../src/lib/types.js';
import { materializeOverrides, resvgPatternQuirkFix } from '../src/lib/svgEdits.js';
import { readPdfResources } from '../src/lib/pdfResources.js';

const ARTWORKS: Record<string, string> = {
  poster: 'src/artwork/poster.svg',
  duo: 'src/artwork/duo.svg',
};

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const art = flag('--art', 'poster') in ARTWORKS ? flag('--art', 'poster') : 'poster';
const profileId = flag('--profile', 'pdf17-native');
const strict = args.includes('--strict');
const rasterScale = Number(flag('--scale', '2'));
const outDir = '.verify';

const overrides: Record<string, { dx: number; dy: number }> = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--override' || !args[i + 1]) continue;
  const m = args[i + 1].match(/^([\w.-]+):(-?[\d.]+),(-?[\d.]+)$/);
  if (m) overrides[m[1]] = { dx: Number(m[2]), dy: Number(m[3]) };
}
const hasOverrides = Object.keys(overrides).length > 0;

const svgRaw = readFileSync(ARTWORKS[art], 'utf8');
const scene = parseSvg(svgRaw, hasOverrides ? { patternOverrides: overrides } : undefined);
const plan = buildPlan(scene, { profileId, strict, rasterScale });
console.log(`画板 ${art} · 档案 ${plan.profileName} · 严格 ${strict ? '开' : '关'}`);
if (hasOverrides) {
  console.log(`图案原点覆盖 ${JSON.stringify(overrides)}`);
}
console.log(`统计 矢量 ${plan.stats.vector} / 栅格 ${plan.stats.raster} / 拒绝 ${plan.stats.refused}`);
for (const w of scene.warnings) console.log(`诊断 ${w}`);

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

// 真源：覆盖量物化 + resvg 图案怪癖补丁后，交给 resvg 独立渲染
let truthSvg = svgRaw;
{
  const doc = new DOMParser().parseFromString(svgRaw, 'image/svg+xml');
  if (hasOverrides) materializeOverrides(doc as never, overrides);
  resvgPatternQuirkFix(doc as never);
  truthSvg = doc.toString();
}

const scale = 2;
const srcPng = new Resvg(truthSvg, { fitTo: { mode: 'width', value: scene.width * scale } }).render().asPng();
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

// 标记内容计数
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
const probes = PROBE_SETS[art] ?? PROBE_SETS.poster;
for (const p of probes) {
  const pos = resolveProbe(p, plan.entries);
  if (!pos) {
    failed++;
    console.log(`缺失 ${p.id}：找不到相对定位对象 ${p.at?.obj}`);
    continue;
  }
  const at = { ...p, ...pos };
  const sp = sample(a, src.width, at);
  const pp = sample(b, viewport.width, at);
  const delta = Math.round(((Math.abs(sp[0] - pp[0]) + Math.abs(sp[1] - pp[1]) + Math.abs(sp[2] - pp[2])) / 3) * 10) / 10;
  const tol = p.tolerance ?? 6;
  const pass = delta <= tol;
  if (!pass) failed++;
  console.log(
    `${pass ? '通过' : '偏差'} ${p.id.padEnd(14)} 源 ${hex(sp)} PDF ${hex(pp)} Δ ${delta}（容差 ${tol}）@ (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`,
  );
}
console.log(failed === 0 ? '全部探针通过' : `${failed} 个探针超出容差`);

// ---- 双实例画板的资源表断言 ----
let checkFails = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) checkFails++;
  console.log(`${ok ? '通过' : '失败'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const near = (a: number, b: number, tol = 0.75) => Math.abs(a - b) <= tol;
const nearArr = (actual: readonly number[] | undefined, expected: number[], tol = 0.75) =>
  !!actual && actual.length === expected.length && actual.every((v, i) => near(v, expected[i], tol));

if (art === 'duo') {
  const res = pdf.resources;
  const ovrB = overrides['inst-b'];

  check('零宽包围盒诊断', scene.warnings.some((w) => /包围盒宽 0/.test(w) && /不渲染/.test(w)), scene.warnings.join(' | '));

  if (profileId !== 'pdf17-native') {
    // 受限档案：渐变/图案整体栅格化，资源表断言不适用；改为确认栅格决策与渲染一致
    check('受限档案栅格化 4 个渐变/图案对象', plan.stats.raster === 4, `实际 ${plan.stats.raster}`);
  } else {
  check('Shading 全文档唯一', res.shadings.length === 1, `实际 ${res.shadings.length}`);
  check('色标 3 个', res.shadings[0]?.stops.length === 3);
  check('Shading 定义空间向量 [0 0 1 0]', nearArr(res.shadings[0]?.coords, [0, 0, 1, 0], 1e-6));
  check(
    '所有渐变图案共用同一 Shading',
    res.shadingPatterns.length >= 2 && new Set(res.shadingPatterns.map((p) => p.shading)).size === 1,
    `shadingPatterns ${res.shadingPatterns.length} 个`,
  );

  const tiling = res.tilingPatterns;
  // 实例变换留在 Do 点的 cm → 两个实例共享同一份平铺字典（长条另有一份）；
  // 仅当某实例覆盖图案原点时才派生新字典。单元 Form 始终共享。
  const expectTiling = (ovrB ? 3 : 2);
  check('平铺图案数量（实例共享 + 长条，覆盖才派生）', tiling.length === expectTiling, `实际 ${tiling.length}`);
  check('平铺周期 80×80', tiling.every((t) => nearArr(t.step, [80, 80], 1e-6)));
  check('共享平铺矩阵原点 (-40,-40)', tiling.some((t) => near(t.matrix[4], -40, 1e-6) && near(t.matrix[5], -40, 1e-6)));
  if (ovrB) {
    const ov = tiling.find((t) => t.override);
    check(
      '覆盖实例的平铺矩阵随覆盖量平移',
      !!ov && near(ov.matrix[4], -40 + ovrB.dx, 1e-6) && near(ov.matrix[5], -40 + ovrB.dy, 1e-6),
      ov ? `实际 (${ov.matrix[4]}, ${ov.matrix[5]})` : '未找到覆盖图案',
    );
  }
  check(
    '平铺图案共用同一单元 Form',
    new Set(tiling.map((t) => t.cellForm)).size === 1,
    tiling.map((t) => t.cellForm).join(','),
  );

  const pathForms = res.forms.filter((f) => f.kind === 'shared-path');
  const cellForms = res.forms.filter((f) => f.kind === 'pattern-cell');
  check('共享路径 Form 唯一', pathForms.length === 1, `实际 ${pathForms.length}`);
  check('图案单元 Form 唯一', cellForms.length === 1, `实际 ${cellForms.length}`);

  const usage = new Map(res.usage.map((u) => [u.object, u]));
  const ua = usage.get('inst-a');
  const ub = usage.get('inst-b');
  check('两实例引用同一路径 Form', !!ua?.pathForm && ua.pathForm === ub?.pathForm, `A=${ua?.pathForm} B=${ub?.pathForm}`);
  check('实例 A 重复单元起点 (150,120)', nearArr(ua?.tileOriginDesign, [150, 120]));
  const expectOriginB = ovrB ? [296 + ovrB.dx * 0.5, 176 + ovrB.dy * 0.5] : [296, 176];
  check(`实例 B 重复单元起点 (${expectOriginB[0]},${expectOriginB[1]})`, nearArr(ub?.tileOriginDesign, expectOriginB));
  check('实例 A 周期 (80,80)', nearArr(ua?.periodDesign, [80, 80]));
  check('实例 B 周期 (40,40)（半尺寸恰好一个单元）', nearArr(ub?.periodDesign, [40, 40]));
  check(
    '色带与图案单元共用渐变资源',
    (() => {
      const band = usage.get('sky-band')?.resource;
      if (!band) return false;
      const bandShading = res.shadingPatterns.find((p) => p.name === band)?.shading;
      return !!bandShading && bandShading === res.shadings[0]?.name;
    })(),
  );

  // 从导出的 PDF 字节回读资源引用（不经过内存场景图）
  const report = await readPdfResources(pdf.bytes, async (d) => new Uint8Array(inflateSync(d)));
  check('回读 Shading 唯一且 3 色标', report.shadings.length === 1 && report.shadings[0]?.stopCount === 3);
  check('回读 Shading 向量 [0 0 1 0]', nearArr(report.shadings[0]?.coords, [0, 0, 1, 0], 1e-6));
  const rTiling = report.patterns.filter((p) => p.type === 1);
  const rShading = report.patterns.filter((p) => p.type === 2);
  check('回读平铺图案数量', rTiling.length === expectTiling, `实际 ${rTiling.length}`);
  check(
    '回读平铺周期与单元引用',
    rTiling.every((p) => near(p.xstep ?? 0, 80, 1e-6) && near(p.ystep ?? 0, 80, 1e-6) && p.cellFormRef != null),
  );
  check(
    '回读渐变图案都指向同一 Shading',
    rShading.length >= 2 && rShading.every((p) => p.shadingRef === report.shadings[0]?.objectId),
    `共 ${rShading.length} 个`,
  );
  check('回读 Form 共 2 个（共享路径 + 图案单元）', report.forms.length === 2, `实际 ${report.forms.length}`);
  const ria = report.markedObjects.find((m) => m.id === 'inst-a');
  const rib = report.markedObjects.find((m) => m.id === 'inst-b');
  check(
    '回读两实例 Do 同一 Form',
    !!ria?.formsUsed.length && ria.formsUsed[0].objectId === rib?.formsUsed[0]?.objectId,
    `A=${ria?.formsUsed[0]?.objectId} B=${rib?.formsUsed[0]?.objectId}`,
  );
  check(
    '回读实例路径仍可编辑（局部坐标 + 使用点 cm）',
    !!ria?.paths.length && ria.paths[0].d.startsWith('M0 -40') && !near(ria.paths[0].ctm[0], 1, 1e-6),
    ria?.paths[0] ? `ctm[0]=${ria.paths[0].ctm[0]}` : '无路径',
  );
  const rHair = report.markedObjects.find((m) => m.id === 'hairline');
  check(
    '回读零宽参考线只剩描边',
    !!rHair && rHair.paths.length > 0 && rHair.paths.every((p) => p.paint === 'stroke'),
  );
  }
}

const ok = failed === 0 && checkFails === 0;
console.log(ok ? '验收通过' : `验收未通过（探针 ${failed}、资源断言 ${checkFails}）`);
process.exit(ok ? 0 : 1);
