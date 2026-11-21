export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Decision = 'vector-path' | 'vector-group' | 'vector-image' | 'raster' | 'reject';

export interface ClipInfo {
  id: string;
  label: string;
  d: string;
  fillRule: 'nonzero' | 'evenodd';
  bounds: Box;
}

export interface PlanEntry {
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
}

export interface TileInfo {
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
}

export interface RefusalInfo {
  objectId: string;
  label: string;
  feature: string;
  reason: string;
}

export interface ReadbackGeometry {
  type: 'path';
  d: string;
  matrix: [number, number, number, number, number, number];
  fillRule: 'nonzero' | 'evenodd';
  fill: boolean;
  stroke: boolean;
  strokeWidth: number;
}

export interface ReadbackObject {
  id: string;
  label: string;
  kind: 'path' | 'group' | 'image';
  decision: Decision;
  features: string[];
  depth: number;
  parent: string | null;
  reason: string;
  bounds: Box;
  clips: ClipInfo[];
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

export interface ResourceUsageInfo {
  object: string;
  fillKind: 'solid' | 'gradient' | 'pattern' | 'none';
  resource?: string;
  pathForm?: string;
  tileOriginLocal?: [number, number];
  tileOriginDesign?: [number, number];
  periodLocal?: [number, number];
  periodDesign?: [number, number];
}

/** 跨实例共享资源表：与导出的 mapJson.resources 同构。 */
export interface ResourceTable {
  transformSplit: string[];
  shadings: Array<{
    name: string;
    objectId: number;
    gradientId: string | null;
    coords: number[];
    stops: { offset: number; color: string }[];
  }>;
  shadingPatterns: Array<{
    name: string;
    objectId: number;
    shading: string;
    matrix: number[];
    usedBy: string[];
  }>;
  tilingPatterns: Array<{
    name: string;
    objectId: number;
    patternId: string;
    matrix: number[];
    step: [number, number];
    bbox: number[];
    cellForm: string;
    override: { dx: number; dy: number } | null;
    usedBy: string[];
  }>;
  forms: Array<{
    name: string;
    objectId: number;
    kind: 'shared-path' | 'pattern-cell';
    sourceId: string;
    bbox: number[];
    usedBy: string[];
  }>;
  usage: ResourceUsageInfo[];
}

export interface ConvertResult {
  ok: boolean;
  status: number;
  art: string;
  profileId: string;
  profileName: string;
  strict: boolean;
  planStatus: 'ok' | 'refused';
  stats: { vector: number; raster: number; refused: number };
  notes: string[];
  entries: PlanEntry[];
  tiles: TileInfo[];
  refusals: RefusalInfo[];
  objects: ReadbackObject[];
  page: { width: number; height: number };
  warnings: string[];
  resources?: ResourceTable;
  pdfBase64?: string;
  mapJson?: string;
}

export interface ProfileInfo {
  id: string;
  name: string;
  description: string;
  supports: string[];
}

export const PROFILES: ProfileInfo[] = [
  {
    id: 'pdf17-native',
    name: 'PDF 1.7 原生能力',
    description:
      '矢量路径、偶奇填充、两层裁剪、隔离透明组、轴向渐变、平铺图案，以及 PDF 原生 /BM 混合模式；高斯模糊等滤镜超出范围。',
    supports: ['path', 'evenodd', 'nested-clip', 'group-opacity', 'linear-gradient', 'pattern', 'blend-multiply', 'image'],
  },
  {
    id: 'reader-lite',
    name: '基础阅读器（受限）',
    description:
      '只使用最保守的矢量特性：路径、偶奇填充、裁剪与隔离透明组。混合模式、图案与滤镜都超出范围，需要局部栅格化。',
    supports: ['path', 'evenodd', 'nested-clip', 'group-opacity', 'image'],
  },
];

export const FEATURE_LABELS: Record<string, string> = {
  path: '矢量路径',
  evenodd: '偶奇填充',
  'nested-clip': '多层裁剪',
  'group-opacity': '半透明组',
  'linear-gradient': '线性渐变',
  'gradient-alpha': '带透明渐变色标',
  pattern: '平铺图案',
  'use-instance': '共享实例',
  blur: '高斯模糊',
  'filter-other': 'SVG 滤镜',
  'blend-multiply': '正片叠底',
  'blend-other': '其它混合模式',
  mask: '蒙版',
  image: '位图图像',
  text: '文本',
};

export const DECISION_LABELS: Record<Decision, string> = {
  'vector-path': '矢量路径',
  'vector-group': '矢量组',
  'vector-image': '位图 XObject',
  raster: '局部栅格',
  reject: '拒绝',
};

/** 点击探针：固定覆盖孔内、重叠、细线、混合与模糊区域。 */
export interface ProbePoint {
  id: string;
  label: string;
  x: number;
  y: number;
  note: string;
  /** 相对定位：取某对象包围盒的 (fx, fy) 处，此时 x/y 仅作回退。 */
  at?: { obj: string; fx: number; fy: number };
  expect?: [number, number, number];
  tolerance?: number;
  radius?: number;
}

/** 把相对探针解析成设计坐标（需要转换结果里的对象包围盒）。 */
export function resolveProbe(p: ProbePoint, entries: PlanEntry[]): { x: number; y: number } | null {
  if (!p.at) return { x: p.x, y: p.y };
  const entry = entries.find((e) => e.objectId === p.at!.obj);
  if (!entry) return null;
  return { x: entry.bounds.x + p.at.fx * entry.bounds.w, y: entry.bounds.y + p.at.fy * entry.bounds.h };
}

export const PROBES: ProbePoint[] = [
  {
    id: 'hole-a',
    label: '叶 A 孔内',
    x: 200,
    y: 315,
    note: '偶奇填充的孔必须透出下方圆内横带，而不是叶色',
    expect: [0xe0, 0xa8, 0x4a],
    radius: 3,
  },
  {
    id: 'hole-b',
    label: '叶 B 孔内',
    x: 261.5,
    y: 339,
    note: '第二片叶的孔同样保持透明，验证 even-odd 未被普通填充覆盖',
    expect: [0xe0, 0xa8, 0x4a],
    radius: 3,
  },
  {
    id: 'overlap',
    label: '叶片重叠区',
    x: 233,
    y: 345,
    note: '两片叶子先成组、组透明度 0.72：重叠区颜色应是混合后的单一结果',
    expect: [0xa6, 0xac, 0x5c],
    tolerance: 10,
    radius: 3,
  },
  {
    id: 'fine-line',
    label: '细线接合点',
    x: 208,
    y: 398,
    note: '0.9 宽的细藤在尖角处的 miter 接合，翻转后仍应落在同一设计坐标',
    expect: [0x22, 0x38, 0x2f],
    tolerance: 60,
    radius: 2,
  },
  {
    id: 'blend',
    label: '混合块（依赖背景）',
    x: 400,
    y: 270,
    note: '正片叠底必须与下方圆窗的真实像素计算，而不是与白底或重绘底色',
    expect: [0x1a, 0x7d, 0x63],
    tolerance: 10,
    radius: 4,
  },
  {
    id: 'glow',
    label: '柔光模糊中心',
    x: 322,
    y: 512,
    note: '局部栅格化的模糊圆，中心颜色与原色一致，边缘平滑扩散',
    expect: [0xff, 0x5f, 0x8a],
    tolerance: 8,
    radius: 3,
  },
  {
    id: 'cross',
    label: '角标（翻转校验）',
    x: 24,
    y: 22,
    note: '左上角十字标记，检验 PDF 的 y 轴翻转是否把内容放回了正确位置',
    expect: [0x8d, 0x85, 0x74],
    tolerance: 60,
    radius: 2,
  },
];

/**
 * 双实例画板的探针。设计坐标 = 用户坐标 + (220, 180)（viewBox 左上角为负）。
 * 渐变 #sky：色标 (44,111,187)@0 → (127,179,224)@0.55 → (232,242,251)@1。
 */
export const DUO_PROBES: ProbePoint[] = [
  {
    id: 'stop-0',
    label: '色带 · 色标 0% 附近',
    at: { obj: 'sky-band', fx: 0.02, fy: 0.5 },
    x: 8.8,
    y: 334,
    note: '直接引用渐变的色带起点，色标位置必须与资源表里的 Shading 一致',
    expect: [47, 114, 188],
    tolerance: 8,
    radius: 2,
  },
  {
    id: 'stop-55',
    label: '色带 · 中间色标 55%',
    at: { obj: 'sky-band', fx: 0.55, fy: 0.5 },
    x: 242,
    y: 334,
    note: '中间色标恰好落在 0.55 处，验证色标 offset 没有被平移/缩放',
    expect: [127, 179, 224],
    tolerance: 6,
    radius: 2,
  },
  {
    id: 'stop-1',
    label: '色带 · 色标 100% 附近',
    at: { obj: 'sky-band', fx: 0.98, fy: 0.5 },
    x: 431.2,
    y: 334,
    note: '色带末端接近最后一个色标',
    expect: [227, 239, 250],
    tolerance: 6,
    radius: 2,
  },
  {
    id: 'shared-direct',
    label: '共享渐变 · 直接引用',
    at: { obj: 'sky-band', fx: 0.5, fy: 0.5 },
    x: 220,
    y: 334,
    note: '与图案单元内同一个 Shading：两处颜色必须一致，色标没有被局部覆盖重复变换',
    expect: [120, 173, 221],
    tolerance: 6,
    radius: 2,
  },
  {
    id: 'shared-cell',
    label: '共享渐变 · 图案单元内',
    x: 220,
    y: 280,
    note: '织纹长条上避开圆点的纯渐变点，与 shared-direct 读数应相同',
    expect: [120, 173, 221],
    tolerance: 6,
    radius: 2,
  },
  {
    id: 'period-a',
    label: '织纹周期 · 基准点',
    x: 116,
    y: 244,
    note: '落在红色半透明圆内；与 period-b 相差恰好一个周期（80 单位）',
    expect: [144, 103, 135],
    tolerance: 6,
    radius: 2,
  },
  {
    id: 'period-b',
    label: '织纹周期 · 平移一周期',
    x: 196,
    y: 244,
    note: '与 period-a 颜色一致即证明 XStep 周期与重复单元起算点正确',
    expect: [144, 103, 135],
    tolerance: 6,
    radius: 2,
  },
  {
    id: 'overlap',
    label: '织纹 · 透明交叠',
    x: 136,
    y: 244,
    note: '红蓝两个半透明圆的重叠透镜区：0.5·蓝 + 0.25·红 + 0.25·渐变底色',
    expect: [104, 123, 164],
    tolerance: 8,
    radius: 2,
  },
  {
    id: 'inst-a-center',
    label: '实例 A 中心（镜像）',
    at: { obj: 'inst-a', fx: 0.5, fy: 0.75 },
    x: 110,
    y: 180,
    note: '镜像实例的图案相位：镜像只在使用点 cm 里，共享单元几何不变；取纯渐变区避开圆边抗锯齿',
    expect: [120, 173, 221],
    tolerance: 8,
    radius: 2,
  },
  {
    id: 'inst-b-center',
    label: '实例 B 中心（半尺寸）',
    at: { obj: 'inst-b', fx: 0.5, fy: 0.75 },
    x: 316,
    y: 206,
    note: '缩小一半的实例恰好被一个平铺单元盖满；取纯渐变区避开圆边抗锯齿',
    expect: [120, 173, 221],
    tolerance: 8,
    radius: 2,
  },
  {
    id: 'hairline',
    label: '零宽参考线',
    x: 410,
    y: 70,
    note: '零宽包围盒：objectBoundingBox 渐变按规范不渲染，只剩深色描边',
    expect: [34, 56, 47],
    tolerance: 80,
    radius: 1,
  },
];

export const PROBE_SETS: Record<string, ProbePoint[]> = {
  poster: PROBES,
  duo: DUO_PROBES,
};
