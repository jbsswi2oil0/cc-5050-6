# Inkplate · SVG → PDF 转换窗口

把一张带「细曲线 / 偶奇孔 / 两层裁剪 / 半透明组 / 依赖背景的混合 / 局部模糊」的海报
转换成 PDF，并且做到三件事：

1. **保留可继续选择的矢量路径**——凡当前目标能力能表达的图元都写成真实路径，而不是整页位图；
2. **按目标能力决定转换计划**——超出能力边界的一小块才局部栅格化，严格模式下直接拒绝；
3. **回读 PDF 本身来验收**——点击检查的对象类型、几何与裁剪都从导出后的 PDF 里重新读出，
   再用 resvg（源）与 PDF.js（导出）两套独立渲染做像素对照。

海报本身就是一组反例：两片叶子先叠进一个组，透明度加在这个组上；窗景背景穿过两层裁剪边；
正片叠底块压在圆窗上，必须拿到它下面真实的像素；柔光圆只有模糊这一项超纲。

## 快速开始

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

- 顶部切换 **目标能力档案**；**严格模式** 打开后会明确拒绝并有横幅说明，不产出任何降级 PDF。
- 左栏是源 SVG 与对象清单；中栏是转换计划（统计、逐对象决策、局部栅格块与参与边界）；
  右栏是回读后的 PDF，点击任意位置可列出该处命中的对象类型、决策、裁剪与栅格信息。
- 底部 **独立渲染对照 · 像素校验** 在孔内、叶片重叠、细线接合、依赖背景的混合、模糊中心
  与角标处同时取样，逐条给出 Δ 与区域均差。

## 验证

```bash
npm run build                              # tsc --noEmit + vite build
npx playwright test                        # 8 个端到端用例
npx tsx scripts/verify.ts                  # 命令行全链路验收（默认 PDF 1.7 原生能力）
npx tsx scripts/verify.ts --profile reader-lite
npx tsx scripts/verify.ts --profile reader-lite --strict   # 期望以「明确拒绝」结束
```

`scripts/verify.ts` 不经过浏览器：解析 → 场景 IR → 能力计划 → PDF 写入 → PDF.js 渲染，
把渲染结果与 resvg 独立渲染的源图逐像素比较，并复用界面里的 7 个固定探针。

当前结果：像素均差 **0.033**，超过 12 级的像素占 **0.13%**（基本只在抗锯齿边缘），
7/7 探针通过；两种档案 × 严格开关共 4 种组合行为符合预期。

## 转换计划怎么决策

| 特性 | PDF 1.7 原生能力 | 基础阅读器（受限） |
| --- | --- | --- |
| 矢量路径 / 偶奇填充 / 两层裁剪 / 隔离透明组 | 保留矢量 | 保留矢量 |
| 轴向线性渐变 | 写成 Shading | 局部栅格 |
| 正片叠底等混合模式 | PDF `/BM` 原生 | 局部栅格（依赖背景） |
| 高斯模糊 | 局部栅格（自身效果） | 局部栅格（自身效果） |
| 严格模式下的任何超纲项 | 拒绝并中止 | 拒绝并中止 |

局部栅格有两种策略：

- **alpha-effect**：效果只取决于对象自身（如模糊），只回读 `paintBounds`，并留出 σ×3+2 的扩散余量。
- **backdrop-blend**：结果依赖下方像素（如正片叠底）。先计算**实际需要参与的边界**
  `participationBounds` = 绘制顺序在前、且与 `paintBounds` 相交的可见元素边界之并集（再与
  `paintBounds` 求交），只在这块范围内回读背景。这样既拿到真实背景，又不会重绘一块不透明底色、
  破坏相邻内容。

## 代码结构

```
src/engine/       解析 → 场景 IR → 能力计划 → PDF 写入器 → 局部栅格
src/server/       resvg 渲染辅助
src/lib/          PDF.js 回读（标记内容 / 路径几何 / 命中测试）与像素采样
src/components/   源面板、计划面板、PDF 检查器、像素探针
server/           Vite 中间件：/api/poster、/api/convert、/api/source.png
scripts/verify.ts 命令行验收
e2e/              Playwright 用例
```

PDF 里每个对象都用 `/<id> BMC … EMC` 标记内容包起来，同时附一份
`inkplate-object-map.json`（EmbeddedFile）记录计划；点击检查读取的是**导出后 PDF** 的
`constructPath` 操作符与当前变换矩阵，不依赖内存里的场景图。

## 环境注意事项（本仓库已处理）

- **中文显示**：容器里只有 DejaVu 字体，界面和栅格块里的中文会变豆腐块。
  安装任意 CJK 字体（本项目用 `wqy-zenhei.ttc` 到 `~/.local/share/fonts/` 后 `fc-cache -f`）即可；
  resvg 需要 `loadSystemFonts`，PDF.js 由浏览器自带字体渲染界面文本。该字体是本机依赖，
  不随仓库分发。
- **Chromium 依赖**：沙箱缺 `libnspr4` 等库。`.vendor/getlibs.sh` 会从 Debian arm64 仓库解包到
  `.vendor/chromium-libs`，`playwright.config.ts` 检测到该目录就自动拼进 `LD_LIBRARY_PATH`；
  在依赖齐全的机器上这步会跳过。`.vendor/` 已忽略，需要时重新运行脚本即可。
- **PDF 写入器易错点**：`cm` 必须是六个裸操作数而不是数组；路径操作符要写在参数之后
  （`0 0 m`）；填充前必须显式写 `rg`；只描边的路径不能先 `n` 再 `S`；ExtGState 的资源名
  与流里 `/GS<n> gs` 必须一致。
- **PDF.js 两种构建的差异**：浏览器构建的 `beginMarkedContent` 参数会多包一层数组，
  `constructPath` 的绘制数据也是 `[opId, [Float32Array], minMax]`，回读代码对两者都做了兼容。
