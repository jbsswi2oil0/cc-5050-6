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

export type Paint = { type: 'solid'; color: Rgba } | LinearGradientPaint;

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
  /** 已解码的位图源对象，按对象 id 索引。 */
  sourceImages: Map<string, import('./raster.js').RasterImage>;
  content: string[];
  gStates: Map<string, unknown>;
  gStateRefs: Map<string, { id: number }>;
  shadings: Map<string, unknown>;
  shadingRefs: Map<string, { name: string; ref: { id: number } }>;
  images: { name: string; ref: { id: number } }[];
  usedImageNames: Set<string>;
  formXObjects: Map<string, unknown>;
  planDecision?: Map<string, Decision>;
  planTiles?: Map<string, TileRaster>;
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


