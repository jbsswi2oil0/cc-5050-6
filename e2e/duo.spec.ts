import { test, expect, type Page } from '@playwright/test';

async function waitForConversion(page: Page) {
  await expect(page.getByTestId('marked-count')).toBeVisible({ timeout: 45_000 });
}

async function selectDuo(page: Page) {
  await page.goto('/');
  await waitForConversion(page);
  await page.getByTestId('art-duo').click();
  await expect(page.getByTestId('art-duo')).toHaveAttribute('aria-checked', 'true');
  // 等双实例画板转换完成：资源表出现
  await expect(page.getByTestId('resource-panel')).toBeVisible({ timeout: 45_000 });
}

test.describe('双实例 · 共享渐变与图案资源表', () => {
  test('资源表列出共享 Shading、平铺图案与 Form，并解释变换归属', async ({ page }) => {
    await selectDuo(page);

    // 变换归属说明：写进资源 vs 留在使用点
    const split = page.getByTestId('transform-split');
    await expect(split).toContainText('写进共享资源');
    await expect(split).toContainText('留在使用点');
    await expect(split).toContainText('镜像');

    // Shading 全文档唯一，3 个色标；两个实例共享同一份平铺字典（长条另有一份）
    await expect(page.getByTestId('resource-counts')).toContainText('Shading 1');
    const tilingRows = page.getByTestId('tiling-table').locator('tbody tr');
    await expect(tilingRows).toHaveCount(2);
    await expect(page.getByTestId('tiling-table')).toContainText('[80 80]');

    // Form 共 2 个：共享路径 + 图案单元
    const formRows = page.getByTestId('form-table').locator('tbody tr');
    await expect(formRows).toHaveCount(2);
    await expect(page.getByTestId('form-table')).toContainText('共享路径');
    await expect(page.getByTestId('form-table')).toContainText('图案单元');

    // 使用点解释重复单元从何处起算：A (150,120) 周期 80；B 半尺寸周期 40 恰好一个单元
    const usage = page.getByTestId('usage-table');
    const rowA = usage.locator('tr', { hasText: 'inst-a' });
    await expect(rowA).toContainText('[150 120]');
    await expect(rowA).toContainText('[80 80]');
    const rowB = usage.locator('tr', { hasText: 'inst-b' });
    await expect(rowB).toContainText('[296 176]');
    await expect(rowB).toContainText('[40 40]');
    // 两实例引用同一路径 Form 与同一平铺资源
    const cells = await rowA.locator('td').allTextContents();
    const cellsB = await rowB.locator('td').allTextContents();
    expect(cells[3]).toBe(cellsB[3]);
    expect(cells[2]).toBe(cellsB[2]);
  });

  test('零宽包围盒给出可读诊断，且零宽参考线只剩描边', async ({ page }) => {
    await selectDuo(page);
    const diag = page.getByTestId('diagnostics');
    await expect(diag).toBeVisible();
    await expect(diag).toContainText('包围盒宽 0');
    await expect(diag).toContainText('不渲染');
    await expect(page.getByTestId('object-list')).toContainText('零宽参考线');
  });

  test('双实例探针全部通过：色标、周期、透明交叠与镜像相位', async ({ page }) => {
    await selectDuo(page);
    await expect(page.getByTestId('probe-summary')).toContainText('11/11 通过', { timeout: 60_000 });
    for (const id of ['stop-0', 'stop-55', 'stop-1', 'shared-direct', 'shared-cell', 'period-a', 'period-b', 'overlap', 'inst-a-center', 'inst-b-center', 'hairline']) {
      await expect(page.getByTestId(`probe-${id}`)).toContainText('通过');
    }
  });

  test('在预览里拖动实例会写回源 SVG 并自动重转', async ({ page }) => {
    await selectDuo(page);
    const usage = page.getByTestId('usage-table');
    const rowA = usage.locator('tr', { hasText: 'inst-a' });
    await expect(rowA).toContainText('[150 120]');

    // 拖动实例 A：平移量换算成设计单位后写回 <use> 的 transform
    const inst = page.locator('.svg-stage use[data-obj="inst-a"]');
    const box = await inst.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 60, box!.y + box!.height / 2 + 30, { steps: 5 });
    await page.mouse.up();

    // 重转后实例 A 的重复单元起点随之移动（不再是原值），探针仍全部通过
    await expect(rowA).not.toContainText('[150 120]', { timeout: 45_000 });
    await expect(page.getByTestId('probe-summary')).toContainText('11/11 通过', { timeout: 60_000 });
  });

  test('编辑图案原点 · 更改公共定义：所有实例一起移动', async ({ page }) => {
    await selectDuo(page);
    const tiling = page.getByTestId('tiling-table');
    await expect(tiling).toContainText('[1 0 0 1 -40 -40]');

    await page.getByTestId('mode-shared-weave').check();
    await page.getByTestId('shared-x').fill('-30');
    await page.getByTestId('shared-y').fill('-40');
    await page.getByTestId('apply-shared').click();

    // 公共定义平移 +10：共享字典的 /Matrix 平移量随之更新，仍只有 2 份平铺字典
    await expect(tiling).toContainText('[1 0 0 1 -30 -40]', { timeout: 45_000 });
    await expect(tiling.locator('tbody tr')).toHaveCount(2);
    await expect(page.getByTestId('probe-summary')).toContainText('11/11 通过', { timeout: 60_000 });
  });

  test('编辑图案原点 · 仅覆盖某一实例：派生新字典但共享单元不变', async ({ page }) => {
    await selectDuo(page);
    await page.getByTestId('mode-instance-weave').check();
    await page.getByTestId('override-target').selectOption('inst-b');
    await page.getByTestId('override-dx').fill('12');
    await page.getByTestId('override-dy').fill('8');
    await page.getByTestId('apply-override').click();

    // 平铺字典 2 → 3（仅 inst-b 派生），单元 Form 仍共享 1 份
    const tiling = page.getByTestId('tiling-table');
    await expect(tiling.locator('tbody tr')).toHaveCount(3, { timeout: 45_000 });
    await expect(tiling).toContainText('覆盖 12,8');
    await expect(page.getByTestId('form-table').locator('tbody tr')).toHaveCount(2);

    // 实例 B 的重复单元起点在设计坐标里平移半个覆盖量（半尺寸实例）：(296,176) → (302,180)
    const rowB = page.getByTestId('usage-table').locator('tr', { hasText: 'inst-b' });
    await expect(rowB).toContainText('[302 180]');
    // 实例 A 不受影响
    await expect(page.getByTestId('usage-table').locator('tr', { hasText: 'inst-a' })).toContainText('[150 120]');

    await expect(page.getByTestId('probe-summary')).toContainText('11/11 通过', { timeout: 60_000 });

    // 清除覆盖后回到 2 份共享字典
    await page.getByTestId('clear-override').click();
    await expect(tiling.locator('tbody tr')).toHaveCount(2, { timeout: 45_000 });
  });

  test('受限档案把渐变与图案整体栅格化', async ({ page }) => {
    await selectDuo(page);
    await page.getByTestId('profile-reader-lite').click();
    await expect(page.getByTestId('profile-reader-lite')).toHaveAttribute('aria-checked', 'true');
    // 4 个渐变/图案对象（两实例、长条、色带）转为局部栅格
    await expect(page.getByTestId('plan-stats')).toContainText('4', { timeout: 45_000 });
    await expect(page.getByTestId('probe-summary')).toContainText('11/11 通过', { timeout: 60_000 });
  });
});
