import type { Matrix } from './matrix.js';
import type { Rgba } from './color.js';

export interface CapabilityProfile {
  id: string;
  name: string;
  description: string;
  supports: Feature[];
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Feature =
  | 'path'
  | 'evenodd'
  | 'nested-clip'
  | 'group-opacity'
  | 'linear-gradient'
  | 'gradient-alpha'
  | 'pattern'
  | 'use-instance'
  | 'blur'
  | 'filter-other'
  | 'blend-multiply'
  | 'blend-other'
  | 'mask'
  | 'image'
  | 'text';

export interface GradientStop {
  offset: number;
  color: Rgba;
}

export interface LinearGradientPaint {
  type: 'linear';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  gradientUnits: 'objectBoundingBox' | 'userSpaceOnUse';
  gradientTransform: Matrix;
  stops: GradientStop[];
}

export interface PatternPaint {
  type: 'pattern';
  /** PatternDef 的 id，定义见 scene.patterns。 */
  id: string;
}

export type Paint = { type: 'solid'; color: Rgba } | LinearGradientPaint | PatternPaint;

/** 图案单元内的一条形状（坐标位于图案内容空间）。 */
export interface PatternShape {
  d: string;
  fill: Paint | null;
  fillRule: 'nonzero' | 'evenodd';
  opacity: number;
}

export interface PatternDef {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  patternUnits: 'objectBoundingBox' | 'userSpaceOnUse';
  contentUnits: 'objectBoundingBox' | 'userSpaceOnUse';
  patternTransform: Matrix;
  shapes: PatternShape[];
}

export interface ClipRef {
  id: string;
  label: string;
  d: string;
  fillRule: 'nonzero' | 'evenodd';
  /** 裁剪路径在所处用户空间中的包围盒。 */
  bounds: BBox;
}

export interface FilterInfo {
  id: string;
  kind: 'blur' | 'other';
  stdDeviation: number;
}

interface NodeBase {
  id: string;
  label: string;
  /** 元素自身的 transform（局部坐标系）。 */
  transform: Matrix;
  /** 元素自身 opacity，0..1；不向后代继承。 */
  opacity: number;
  blend: string;
  clip: ClipRef | null;
  clipChain: ClipRef[];
  /** 自身几何包围盒（局部坐标）。 */
  localBounds: BBox;
  /** 连同子代、应用自身 transform 后在父坐标系中的包围盒。 */
  ownBounds: BBox;
  /** 设计坐标 = 根 viewBox 映射后的坐标。 */
  absTransform: Matrix;
  worldBounds: BBox;
  features: Feature[];
  sourceTag: string;
  depth: number;
  /** 父节点 id，根为 null。 */
  parentId: string | null;
}

export interface ScenePath extends NodeBase {
  kind: 'path';
  d: string;
  fill: Paint | null;
  fillRule: 'nonzero' | 'evenodd';
  stroke: Rgba | null;
  strokeWidth: number;
  lineCap: 'butt' | 'round' | 'square';
  lineJoin: 'miter' | 'round' | 'bevel';
  miterLimit: number;
  dash: number[];
  filter: FilterInfo | null;
  mask: boolean;
  /** <use> 实例：被引用定义的 id；几何按 def 局部坐标保存，可写入共享 Form XObject。 */
  resourceId: string | null;
  /** 仅覆盖本实例的图案原点偏移（编辑器覆盖层，不改动公共定义）。 */
  patternOriginOverride: { dx: number; dy: number } | null;
}

export interface SceneGroup extends NodeBase {
  kind: 'group';
  children: SceneNode[];
  filter: FilterInfo | null;
  mask: boolean;
  isolated: boolean;
}

export interface SceneImage extends NodeBase {
  kind: 'image';
  href: string;
  width: number;
  height: number;
  filter: FilterInfo | null;
  mask: boolean;
}

export type SceneNode = ScenePath | SceneGroup | SceneImage;

export interface Scene {
  width: number;
  height: number;
  viewBox: BBox;
  root: SceneGroup;
  nodes: SceneNode[];
  byId: Map<string, SceneNode>;
  gradients: Map<string, LinearGradientPaint>;
  patterns: Map<string, PatternDef>;
  sourceSvg: string;
  warnings: string[];
  /** 文档绘制顺序（只含真正产生绘制的节点）。 */
  paintOrder: SceneNode[];
}

export type Decision = 'vector-path' | 'vector-group' | 'vector-image' | 'raster' | 'reject';

export type RasterStrategy = 'alpha-effect' | 'backdrop-blend';

export interface PlanEntry {
  objectId: string;
  label: string;
  kind: SceneNode['kind'];
  decision: Decision;
  features: Feature[];
  unsupported: Feature[];
  reason: string;
  bounds: BBox;
  depth: number;
  strategy?: RasterStrategy;
  /** 栅格化时真正写入 PDF 的紧包围盒。 */
  paintBounds?: BBox;
  /** 需要回读源图的范围（模糊扩散等）。 */
  readBounds?: BBox;
}

export interface RasterTilePlan {
  objectId: string;
  label: string;
  strategy: RasterStrategy;
  feature: Feature;
  reason: string;
  paintBounds: BBox;
  readBounds: BBox;
  /** 背景真正参与计算的边界；纯效果为 null。 */
  participationBounds: BBox | null;
  scale: number;
  backgroundDependent: boolean;
  backdropIds: string[];
  note: string;
}

export interface Refusal {
  objectId: string;
  label: string;
  feature: Feature;
  reason: string;
}

export interface ConversionPlan {
  profileId: string;
  profileName: string;
  strict: boolean;
  status: 'ok' | 'refused';
  entries: PlanEntry[];
  tiles: RasterTilePlan[];
  refusals: Refusal[];
  stats: { vector: number; raster: number; refused: number };
  notes: string[];
}

export interface ConversionState {
  builder: import('./pdfBuilder.js').PdfBuilder;
  scene: Scene;
  /** 页面级 y 翻转矩阵：设计坐标 → PDF 页面默认坐标系。 */
  pageFlip: import('./matrix.js').Matrix;
  /** 已解码的位图源对象，按对象 id 索引。 */
  sourceImages: Map<string, import('./raster.js').RasterImage>;
  content: string[];
  gStates: Map<string, unknown>;
  gStateRefs: Map<string, { id: number }>;
  /** 共享 Shading 对象（色标 + 定义空间向量），key 为渐变内容指纹。 */
  shadingDefs: Map<string, { name: string; ref: { id: number } }>;
  /** 每使用点的 shading-pattern 包装（Matrix 因实例而异），key 为 shading+矩阵指纹。 */
  shadingPatterns: Map<string, { name: string; ref: { id: number } }>;
  /** 平铺图案字典（可含单实例原点覆盖），key 为图案 id+覆盖+单位映射指纹。 */
  tilingPatterns: Map<string, { name: string; ref: { id: number } }>;
  /** 图案单元内容 Form XObject，key 为图案 id+内容矩阵指纹。 */
  cellForms: Map<string, { name: string; ref: { id: number } }>;
  /** <use> 共享路径几何 Form XObject，key 为 def id+绘制签名。 */
  pathForms: Map<string, { name: string; ref: { id: number } }>;
  /** 页级 /Pattern 资源条目。 */
  patternRefs: Map<string, { name: string; ref: { id: number } }>;
  images: { name: string; ref: { id: number } }[];
  usedImageNames: Set<string>;
  formXObjects: Map<string, unknown>;
  planDecision?: Map<string, Decision>;
  planTiles?: Map<string, TileRaster>;
  /** 资源表收集器：写入 PDF 时同步记录，供 mapJson 与界面展示。 */
  resourceLog: ResourceLog;
}

/** 资源表收集器：记录每个共享对象与每个使用点的引用关系。 */
export interface ResourceLog {
  shadings: ShadingResourceInfo[];
  shadingPatterns: ShadingPatternInfo[];
  tilingPatterns: TilingPatternInfo[];
  forms: FormResourceInfo[];
  usage: ResourceUsage[];
}

export interface ShadingResourceInfo {
  name: string;
  objectId: number;
  gradientId: string | null;
  coords: [number, number, number, number];
  stops: { offset: number; color: string }[];
}

export interface ShadingPatternInfo {
  name: string;
  objectId: number;
  shading: string;
  matrix: number[];
  usedBy: string[];
}

export interface TilingPatternInfo {
  name: string;
  objectId: number;
  patternId: string;
  matrix: number[];
  step: [number, number];
  bbox: [number, number, number, number];
  cellForm: string;
  override: { dx: number; dy: number } | null;
  usedBy: string[];
}

export interface FormResourceInfo {
  name: string;
  objectId: number;
  kind: 'shared-path' | 'pattern-cell';
  sourceId: string;
  bbox: [number, number, number, number];
  usedBy: string[];
}

export interface ResourceUsage {
  object: string;
  fillKind: 'solid' | 'gradient' | 'pattern' | 'none';
  /** 使用点引用的资源名（shading-pattern 或 tiling pattern）。 */
  resource?: string;
  /** 共享路径 Form（<use> 实例）。 */
  pathForm?: string;
  /** 图案填充：重复单元在该实例局部空间的原点与周期。 */
  tileOriginLocal?: [number, number];
  tileOriginDesign?: [number, number];
  periodLocal?: [number, number];
  periodDesign?: [number, number];
}

export interface TileRaster {
  objectId: string;
  strategy: RasterStrategy;
  /** 写入 PDF 的像素范围。 */
  paintBounds: BBox;
  readBounds: BBox;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  participationBounds: BBox | null;
}


