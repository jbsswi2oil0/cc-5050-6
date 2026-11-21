import type { CapabilityProfile, Feature } from './types.js';

export const PROFILES: CapabilityProfile[] = [
  {
    id: 'pdf17-native',
    name: 'PDF 1.7 原生能力',
    description:
      '矢量路径、偶奇填充、两层裁剪、隔离透明组、轴向渐变、平铺图案与实例共享 Form XObject，以及 PDF 原生 /BM 混合模式；不支持高斯模糊等滤镜。',
    supports: [
      'path',
      'evenodd',
      'nested-clip',
      'group-opacity',
      'linear-gradient',
      'pattern',
      'blend-multiply',
      'image',
    ],
  },
  {
    id: 'reader-lite',
    name: '基础阅读器 (受限)',
    description:
      '只使用最保守的矢量特性：路径、偶奇填充、裁剪与隔离透明组。混合模式、图案与滤镜都超出范围，需要局部栅格化。',
    supports: ['path', 'evenodd', 'nested-clip', 'group-opacity', 'image'],
  },
];

export function getProfile(id: string): CapabilityProfile {
  const found = PROFILES.find((p) => p.id === id);
  if (!found) throw new Error(`未知能力档案: ${id}`);
  return found;
}

export function isSupported(profile: CapabilityProfile, feature: Feature): boolean {
  if (
    feature === 'path' ||
    feature === 'evenodd' ||
    feature === 'nested-clip' ||
    feature === 'group-opacity' ||
    feature === 'use-instance'
  ) {
    return true;
  }
  return profile.supports.includes(feature);
}

export const FEATURE_LABELS: Record<Feature, string> = {
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
