import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { DOMParser } from 'linkedom';
import type { Plugin } from 'vite';
import { parseSvg } from '../src/engine/parseSvg.js';
import { buildPlan } from '../src/engine/plan.js';
import { buildPdf, TRANSFORM_SPLIT_NOTES } from '../src/engine/pdfWriter.js';
import { rasterizeTile } from '../src/engine/rasterizeTile.js';
import { scaleOf } from '../src/engine/matrix.js';
import { decodeHref, type RasterImage } from '../src/engine/raster.js';
import { materializeOverrides, resvgPatternQuirkFix } from '../src/lib/svgEdits.js';
import type { ClipRef, ConversionPlan, Decision, Scene, SceneNode, TileRaster } from '../src/engine/types.js';

const ARTWORKS: Record<string, string> = {
  poster: 'src/artwork/poster.svg',
  duo: 'src/artwork/duo.svg',
};
const DEFAULT_ART = 'poster';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PatternOverride {
  dx: number;
  dy: number;
}

interface ConvertBody {
  profileId?: string;
  strict?: boolean;
  rasterScale?: number;
  svg?: string;
  art?: string;
  patternOverrides?: Record<string, PatternOverride>;
}

interface SourcePngBody {
  svg?: string;
  art?: string;
  width?: number;
  patternOverrides?: Record<string, PatternOverride>;
}

interface ReadbackGeometry {
  type: 'path';
  d: string;
  matrix: [number, number, number, number, number, number];
  fillRule: 'nonzero' | 'evenodd';
  fill: boolean;
  stroke: boolean;
  strokeWidth: number;
}

interface ReadbackObject {
  id: string;
  label: string;
  kind: SceneNode['kind'];
  decision: Decision;
  features: string[];
  depth: number;
  parent: string | null;
  reason: string;
  bounds: Box;
  clips: ClipRef[];
  geometry: ReadbackGeometry[];
  tile?: {
    strategy: string;
    paintBounds: Box;
    readBounds: Box;
    participationBounds: Box | null;
    backdropIds: string[];
    note: string;
    backgroundDependent: boolean;
    previewPng: string;
  };
}

interface ConvertResult {
  ok: boolean;
  status: number;
  art: string;
  profileId: string;
  profileName: string;
  strict: boolean;
  planStatus: 'ok' | 'refused';
  stats: ConversionPlan['stats'];
  notes: string[];
  entries: Array<{
    objectId: string;
    label: string;
    kind: string;
    decision: Decision;
    features: string[];
    unsupported: string[];
    reason: string;
    depth: number;
    bounds: Box;
    strategy?: string;
    paintBounds?: Box;
    readBounds?: Box;
  }>;
  tiles: Array<{
    objectId: string;
    label: string;
    strategy: string;
    feature: string;
    paintBounds: Box;
    readBounds: Box;
    participationBounds: Box | null;
    backgroundDependent: boolean;
    backdropIds: string[];
    note: string;
    previewPng?: string;
  }>;
  refusals: ConversionPlan['refusals'];
  objects: ReadbackObject[];
  page: { width: number; height: number };
  warnings: string[];
  resources?: {
    transformSplit: string[];
    shadings: unknown[];
    shadingPatterns: unknown[];
    tilingPatterns: unknown[];
    forms: unknown[];
    usage: unknown[];
  };
  pdfBase64?: string;
  mapJson?: string;
}

export function inkplateServerPlugin(): Plugin {
  return {
    name: 'inkplate-convert-server',
    configureServer(server) {
      server.middlewares.use('/api/poster', (req, res) => {
        const art = normalizeArt(new URL(req.url ?? '/', 'http://x').searchParams.get('art'));
        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
        res.end(readArtworkSvg(art));
      });
      server.middlewares.use('/api/convert', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        try {
          const body = JSON.parse(await readBody(req)) as ConvertBody;
          const result = await convert(body);
          res.statusCode = result.status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(result));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: String((err as Error)?.stack ?? err) }));
        }
      });
      server.middlewares.use('/api/source.png', async (req, res) => {
        try {
          let svg: string;
          let width: number;
          let overrides: Record<string, PatternOverride> | undefined;
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as SourcePngBody;
            svg = body.svg?.trim() ? body.svg : readArtworkSvg(normalizeArt(body.art ?? null));
            width = clamp(Number(body.width ?? 880), 220, 1760);
            overrides = sanitizeOverrides(body.patternOverrides);
          } else {
            const url = new URL(req.url ?? '/', 'http://x');
            svg = readArtworkSvg(normalizeArt(url.searchParams.get('art')));
            width = clamp(Number(url.searchParams.get('width') ?? 880), 220, 1760);
          }
          if (overrides && Object.keys(overrides).length) {
            svg = applyOverridesToSvg(svg, overrides);
          } else {
            svg = applyResvgQuirkFix(svg);
          }
          const { Resvg } = await import('@resvg/resvg-js');
          const r = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
          res.setHeader('Content-Type', 'image/png');
          res.end(Buffer.from(r.render().asPng()));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
  };
}

function normalizeArt(art: string | null | undefined): string {
  return art && art in ARTWORKS ? art : DEFAULT_ART;
}

function readArtworkSvg(art: string): string {
  return readFileSync(path.resolve(process.cwd(), ARTWORKS[art] ?? ARTWORKS[DEFAULT_ART]), 'utf8');
}

/** 把「仅实例」的图案原点覆盖物化进 SVG 文本，并套用 resvg 图案怪癖补丁，供独立渲染器复现引擎效果。 */
function applyOverridesToSvg(svg: string, overrides: Record<string, PatternOverride>): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  materializeOverrides(doc as never, overrides);
  resvgPatternQuirkFix(doc as never);
  return doc.toString();
}

/** resvg 把 userSpaceOnUse 图案内容总裁到 [0,w]×[0,h]（忽略 x/y），负原点画板需要内容平移补丁。 */
function applyResvgQuirkFix(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  resvgPatternQuirkFix(doc as never);
  return doc.toString();
}

function sanitizeOverrides(
  raw: Record<string, PatternOverride> | undefined,
): Record<string, PatternOverride> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, PatternOverride> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue;
    const dx = Number((v as PatternOverride).dx);
    const dy = Number((v as PatternOverride).dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) continue;
    out[k] = { dx, dy };
  }
  return Object.keys(out).length ? out : undefined;
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function convert(body: ConvertBody): Promise<ConvertResult> {
  const art = normalizeArt(body.art ?? null);
  const svg = body.svg?.trim() ? body.svg : readArtworkSvg(art);
  const patternOverrides = sanitizeOverrides(body.patternOverrides);
  const scene = parseSvg(svg, patternOverrides ? { patternOverrides } : undefined);
  const profileId = body.profileId ?? 'pdf17-native';
  const strict = !!body.strict;
  const rasterScale = clamp(body.rasterScale ?? 2, 1, 4);
  const plan = buildPlan(scene, { profileId, strict, rasterScale });

  const tiles: TileRaster[] = [];
  if (plan.status === 'ok') {
    for (const t of plan.tiles) tiles.push(await rasterizeTile(scene, t));
  }
  const tileById = new Map(tiles.map((t) => [t.objectId, t]));

  const base: ConvertResult = {
    ok: plan.status === 'ok',
    status: plan.status === 'ok' ? 200 : 422,
    art,
    profileId: plan.profileId,
    profileName: plan.profileName,
    strict: plan.strict,
    planStatus: plan.status,
    stats: plan.stats,
    notes: plan.notes,
    entries: plan.entries,
    tiles: plan.tiles.map((t) => ({
      objectId: t.objectId,
      label: t.label,
      strategy: t.strategy,
      feature: t.feature,
      paintBounds: t.paintBounds,
      readBounds: t.readBounds,
      participationBounds: t.participationBounds,
      backgroundDependent: t.backgroundDependent,
      backdropIds: t.backdropIds,
      note: t.note,
      previewPng: tileById.has(t.objectId) ? toPngDataUrl(tileById.get(t.objectId)!) : undefined,
    })),
    refusals: plan.refusals,
    objects: buildReadback(scene, plan, tileById),
    page: { width: scene.width, height: scene.height },
    warnings: scene.warnings,
  };

  if (plan.status !== 'ok') return base;

  const images = new Map<string, RasterImage>();
  for (const node of scene.nodes) {
    if (node.kind !== 'image') continue;
    const decoded = await decodeHref(node.href);
    if (decoded) images.set(node.id, decoded);
    else base.warnings.push(`位图 ${node.label} 的源文件无法读取（${node.href.slice(0, 48)}）`);
  }

  const pdf = buildPdf({ scene, plan, tiles, images });
  return {
    ...base,
    resources: { transformSplit: TRANSFORM_SPLIT_NOTES, ...pdf.resources },
    pdfBase64: Buffer.from(pdf.bytes).toString('base64'),
    mapJson: pdf.mapJson,
  };
}

function buildReadback(scene: Scene, plan: ConversionPlan, tileById: Map<string, TileRaster>): ReadbackObject[] {
  const decisionById = new Map(plan.entries.map((e) => [e.objectId, e.decision]));
  const reasonById = new Map(plan.entries.map((e) => [e.objectId, e.reason]));
  const tilePlanById = new Map(plan.tiles.map((t) => [t.objectId, t]));
  const out: ReadbackObject[] = [];
  for (const node of scene.paintOrder) {
    const clips: ClipRef[] = [];
    let cursor: SceneNode | undefined = node;
    while (cursor) {
      if (cursor.clip) clips.unshift(cursor.clip);
      cursor = cursor.parentId ? scene.byId.get(cursor.parentId) : undefined;
    }
    const tilePlan = tilePlanById.get(node.id);
    const raster = tileById.get(node.id);
    const item: ReadbackObject = {
      id: node.id,
      label: node.label,
      kind: node.kind,
      decision: decisionById.get(node.id) ?? 'vector-path',
      features: node.features,
      depth: node.depth,
      parent: node.parentId,
      reason: reasonById.get(node.id) ?? '',
      bounds: roundBox(node.worldBounds),
      clips,
      geometry: geometryOf(node),
    };
    if (tilePlan && raster) {
      item.tile = {
        strategy: tilePlan.strategy,
        paintBounds: roundBox(tilePlan.paintBounds),
        readBounds: roundBox(tilePlan.readBounds),
        participationBounds: tilePlan.participationBounds ? roundBox(tilePlan.participationBounds) : null,
        backdropIds: tilePlan.backdropIds,
        note: tilePlan.note,
        backgroundDependent: tilePlan.backgroundDependent,
        previewPng: toPngDataUrl(raster),
      };
    }
    out.push(item);
  }
  return out;
}

function geometryOf(node: SceneNode): ReadbackGeometry[] {
  if (node.kind === 'path') {
    return [
      {
        type: 'path',
        d: node.d,
        matrix: node.absTransform,
        fillRule: node.fillRule,
        fill: !!node.fill,
        stroke: !!node.stroke,
        strokeWidth: node.strokeWidth * scaleOf(node.absTransform),
      },
    ];
  }
  if (node.kind === 'image') {
    return [];
  }
  return [];
}

function roundBox(b: Box): Box {
  const r = (v: number) => Math.round(v * 100) / 100;
  return { x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h) };
}

function toPngDataUrl(tile: TileRaster): string {
  const canvas = createCanvas(tile.width, tile.height);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(tile.width, tile.height);
  img.data.set(tile.rgba);
  ctx.putImageData(img, 0, 0);
  return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
}
