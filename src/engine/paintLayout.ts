/**
 * 渐变 / 图案的坐标映射规则——资源表的核心约定：
 *
 * 写进共享资源（每定义一份）：
 *   - 渐变色标与定义空间向量（Shading 字典 + Function）；
 *   - 图案单元的几何与单元内渐变（Form XObject 及其资源）；
 *   - 平铺周期 XStep/YStep 与单元 BBox。
 *
 * 留在使用点（每实例一份，或内容流里的 cm）：
 *   - 实例自身的镜像 / 缩放 / 平移（内容流 cm，作用于几何，不进任何资源）；
 *   - objectBoundingBox → 实例包围盒的映射与单实例图案原点覆盖
 *     （各使用点专属 Pattern 字典的 /Matrix）。
 *
 * 注意：PDF 图案的 /Matrix 映射到父内容流的默认坐标系，不随使用点的 cm
 * 变换；因此每个使用点的 Pattern /Matrix 由写出端组合完整链路
 * （页面翻转 · 实例变换 · 局部映射），cm 与 /Matrix 各司其职。
 */
import { IDENTITY, invert, multiply, type Matrix } from './matrix.js';
import type { BBox, LinearGradientPaint, PatternDef } from './types.js';

/** objectBoundingBox 单位空间 → 元素局部空间。 */
export function bboxMatrix(bbox: BBox): Matrix {
  return [bbox.w, 0, 0, bbox.h, bbox.x, bbox.y];
}

/** 渐变定义空间 → 元素局部空间（shading-pattern 的 /Matrix）。 */
export function gradientLocalMatrix(paint: LinearGradientPaint, bbox: BBox): Matrix {
  if (paint.gradientUnits === 'userSpaceOnUse') return paint.gradientTransform;
  return multiply(bboxMatrix(bbox), paint.gradientTransform);
}

export interface TileLayout {
  /** 单元（tile-local）→ 元素局部空间，即 tiling pattern 的 /Matrix。 */
  tileToLocal: Matrix;
  /** 图案内容空间 → 单元空间，即单元 Form XObject 的 /Matrix。 */
  contentToTile: Matrix;
  /** 单元周期（tile-local 单位）。 */
  step: [number, number];
  /** 重复单元在元素局部空间的原点（含覆盖）。 */
  originLocal: [number, number];
}

/**
 * 计算图案的布局矩阵。override 为单实例原点覆盖（编辑器覆盖层），
 * 只影响本实例的 tiling pattern /Matrix，不触碰共享的单元 Form。
 */
export function patternTileLayout(
  def: PatternDef,
  bbox: BBox,
  override: { dx: number; dy: number } | null,
): TileLayout {
  const unitsMap = def.patternUnits === 'objectBoundingBox' ? bboxMatrix(bbox) : IDENTITY;
  const contentMap = def.contentUnits === 'objectBoundingBox' ? bboxMatrix(bbox) : IDENTITY;
  const place: Matrix = [1, 0, 0, 1, def.x, def.y];
  // tile-local → 局部空间：D · P · U · T(x,y)；D 是单实例原点覆盖，只在最外层平移
  let tileToLocal = multiply(def.patternTransform, multiply(unitsMap, place));
  if (override) tileToLocal = multiply([1, 0, 0, 1, override.dx, override.dy], tileToLocal);
  // 内容 → tile-local：T(-x,-y) · U⁻¹ · Uc（与覆盖无关，单元内容保持共享）
  const contentToLocal = multiply(def.patternTransform, multiply(unitsMap, place));
  const contentToTile = multiply(invert(contentToLocal), multiply(def.patternTransform, contentMap));
  return {
    tileToLocal,
    contentToTile,
    step: [def.width, def.height],
    originLocal: [def.x + (override?.dx ?? 0), def.y + (override?.dy ?? 0)],
  };
}

/** 指纹：把矩阵压成可比较的字符串，用于资源去重。 */
export function matrixKey(m: Matrix): string {
  return m.map((v) => (Object.is(Math.round(v * 1e6) / 1e6, -0) ? 0 : Math.round(v * 1e6) / 1e6)).join(',');
}

/** 渐变内容指纹：同一共享定义（无论被多少实例引用）只写一份 Shading。 */
export function gradientKey(paint: LinearGradientPaint): string {
  const stops = paint.stops
    .map((s) => `${s.offset}:${s.color.r},${s.color.g},${s.color.b},${Math.round(s.color.a * 1000)}`)
    .join('|');
  return [
    paint.x1, paint.y1, paint.x2, paint.y2,
    paint.gradientUnits,
    matrixKey(paint.gradientTransform),
    stops,
  ].join(';');
}
