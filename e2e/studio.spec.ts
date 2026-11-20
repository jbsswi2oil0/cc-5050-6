import { test, expect, type Page } from '@playwright/test';

async function waitForConversion(page: Page) {
  // 首次转换会在挂载后自动开始；等计划面板出现统计数字
  await expect(page.getByTestId('marked-count')).toBeVisible({ timeout: 45_000 });
}

async function selectProfile(page: Page, id: string) {
  await page.getByTestId(`profile-${id}`).click();
  await expect(page.getByTestId(`profile-${id}`)).toHaveAttribute('aria-checked', 'true');
}

test.describe('SVG → PDF 转换窗口', () => {
  test('默认档案保留矢量路径，回读 PDF 得到 21 个可点名对象', async ({ page }) => {
    await page.goto('/');
    await waitForConversion(page);

    await expect(page.getByTestId('marked-count')).toContainText('21');
    await expect(page.getByTestId('pixel-probes')).toBeVisible();

    // 对象顺序与计划条目一致：源侧 21 项，其中叶片组是矢量组、柔光是唯一栅格块
    const rows = page.locator('[data-testid="object-list"] li');
    await expect(rows).toHaveCount(21);

    const leafPair = page.locator('[data-testid="obj-leaf-pair"]');
    await expect(leafPair).toContainText('矢量组');
    await expect(leafPair).toContainText('半透明组');

    const glow = page.locator('[data-testid="obj-glow"]');
    await expect(glow).toContainText('局部栅格');

    const leafA = page.locator('[data-testid="obj-leaf-a"]');
    await expect(leafA).toContainText('偶奇填充');
  });

  test('严格模式在能力不足时明确拒绝，不生成降级 PDF', async ({ page }) => {
    await page.goto('/');
    await waitForConversion(page);

    await selectProfile(page, 'reader-lite');
    await page.getByTestId('strict-toggle').click();
    await expect(page.getByTestId('strict-toggle')).toHaveAttribute('aria-checked', 'true');

    const banner = page.getByTestId('strict-refusal');
    await expect(banner).toBeVisible({ timeout: 45_000 });
    await expect(banner).toContainText('2 个对象');
    await expect(banner).toContainText('叠加块');
    await expect(banner).toContainText('柔光');

    await expect(page.getByTestId('download-pdf')).toHaveCount(0);
    await expect(page.getByTestId('pdf-empty')).toBeVisible();
    await expect(page.getByTestId('pixel-probes')).toHaveCount(0);
  });

  test('受限档案把依赖背景的混合局部栅格化，参与边界限定在 72×72 内', async ({ page }) => {
    await page.goto('/');
    await waitForConversion(page);

    await selectProfile(page, 'reader-lite');
    await expect(page.getByTestId('plan-stats')).toContainText('2', { timeout: 45_000 });

    const blend = page.getByTestId('tile-blend-zone');
    await expect(blend).toContainText('背景依赖混合');
    await expect(blend).toContainText('72');

    // 参与边界不应扩张到整页或其它区域：x/y 仍落在 360..432 / 250..322
    const bounds = await page.getByTestId('tile-bounds-blend-zone').textContent();
    expect(bounds).toMatch(/x 360[–-]432/);
    expect(bounds).toMatch(/y 250[–-]322/);

    await expect(page.getByTestId('marked-count')).toContainText('21');
  });

  test('点击回读 PDF 能读出该位置的对象类型', async ({ page }) => {
    await page.goto('/');
    await waitForConversion(page);

    const stage = page.getByTestId('pdf-stage');
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();

    // 设计坐标 (233, 345)：叶片重叠区，位于设计尺寸 440×620 内
    await stage.click({
      position: {
        x: (233 / 440) * box!.width,
        y: (345 / 620) * box!.height,
      },
    });

    const pick = page.getByTestId('pick-result');
    await expect(pick).toBeVisible();
    await expect(pick).toContainText('点击位置');
    // 预览宽度是可调的，点击映射到设计坐标后允许 ±2 的取整误差
    const at = await pick.locator('h3 code').textContent();
    const [px, py] = (at ?? '').split(',').map(Number);
    expect(Math.abs(px - 233)).toBeLessThanOrEqual(2);
    expect(Math.abs(py - 345)).toBeLessThanOrEqual(2);

    const rows = pick.locator('.pick-list > li');
    expect(await rows.count()).toBeGreaterThanOrEqual(3);

    // 最上层应是叶片（偶奇孔洞路径），而不是背景
    await expect(rows.first()).toContainText('叶');
    await expect(rows.first()).toContainText('矢量路径');

    const ids = await pick.locator('.pick-row code').allTextContents();
    expect(ids[0]).toMatch(/leaf/);
    expect(ids).toEqual(expect.arrayContaining(['disc-band', 'disc-fill']));
  });

  test('点击海报底色区域只命中背景，不误报为叶片或圆窗', async ({ page }) => {
    await page.goto('/');
    await waitForConversion(page);

    const stage = page.getByTestId('pdf-stage');
    const box = await stage.boundingBox();
    // 设计坐标 (14, 600)：海报的纸质底色，远离所有图形
    await stage.click({
      position: {
        x: (14 / 440) * box!.width,
        y: (600 / 620) * box!.height,
      },
    });

    const pick = page.getByTestId('pick-result');
    await expect(pick).toBeVisible();
    const ids = await pick.locator('.pick-row code').allTextContents();
    expect(ids).toEqual(['bg']);
  });

  test('回读对象顺序覆盖全部 21 个标记内容', async ({ page }) => {
    await page.goto('/');
    await waitForConversion(page);

    await page.getByTestId('marked-order').locator('summary').click();
    const items = page.getByTestId('marked-order').locator('ol > li');
    await expect(items).toHaveCount(21);
    await expect(items.first()).toContainText('bg');
    await expect(items.last()).toContainText('path-4');
  });

  test('独立渲染像素对照：7 个探针全部通过', async ({ page }) => {
    await page.goto('/');
    await waitForConversion(page);

    const summary = page.getByTestId('probe-summary');
    await expect(summary).toContainText('7/7 通过', { timeout: 60_000 });

    for (const id of ['hole-a', 'hole-b', 'overlap', 'fine-line', 'blend', 'glow', 'cross']) {
      await expect(page.getByTestId(`probe-${id}`)).toContainText('通过');
    }

    // 孔内探针的 PDF 实测色应与源图几乎一致（暖黄 #e0a84a，允许 1 级舍入差）
    const hole = page.getByTestId('probe-hole-a');
    const pdfSwatch = (await hole.locator('code').nth(1).textContent()) ?? '';
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(pdfSwatch.slice(i, i + 2), 16));
    expect(Math.abs(r - 0xe0)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - 0xa8)).toBeLessThanOrEqual(2);
    expect(Math.abs(b - 0x4a)).toBeLessThanOrEqual(2);
  });

  test('源侧选择会联动到计划面板与 PDF 画布', async ({ page }) => {
    await page.goto('/');
    await waitForConversion(page);

    await page.getByTestId('obj-glow').click();
    await expect(page.getByTestId('source-panel')).toContainText('柔光');
    await expect(page.getByTestId('selection-detail')).toContainText('模糊');
    await expect(page.locator('.selected-outline')).toBeVisible();
  });

  test('位图对象写成图像 XObject 并落在自己的 x/y 上', async ({ page, request }) => {
    const png = await request.get('/api/source.png?width=20');
    const href = `data:image/png;base64,${(await png.body()).toString('base64')}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">
      <rect width="200" height="120" fill="#ffffff"/>
      <image data-obj="pic" data-label="测试位图" x="20" y="20" width="160" height="80" href="${href}"/>
    </svg>`;

    const res = await request.post('/api/convert', {
      data: { profileId: 'pdf17-native', strict: false, rasterScale: 2, svg },
    });
    expect(res.status()).toBe(200);
    const data = (await res.json()) as { objects: Array<{ id: string; decision: string; bounds: { x: number; y: number } }> };
    const pic = data.objects.find((o) => o.id === 'pic');
    expect(pic?.decision).toBe('vector-image');
    expect(pic?.bounds.x).toBe(20);
    expect(pic?.bounds.y).toBe(20);
  });
});
