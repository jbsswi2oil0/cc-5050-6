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

export interface ConvertResult {
  ok: boolean;
  status: number;
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
      '矢量路径、偶奇填充、两层裁剪、隔离透明组、轴向渐变，以及 PDF 原生 /BM 混合模式；高斯模糊等滤镜超出范围。',
    supports: ['path', 'evenodd', 'nested-clip', 'group-opacity', 'linear-gradient', 'blend-multiply', 'image'],
  },
  {
    id: 'reader-lite',
    name: '基础阅读器（受限）',
    description:
      '只使用最保守的矢量特性：路径、偶奇填充、裁剪与隔离透明组。混合模式与滤镜都超出范围，需要局部栅格化。',
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
  expect?: [number, number, number];
  tolerance?: number;
  radius?: number;
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
