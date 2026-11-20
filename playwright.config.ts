import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * 沙箱里没有系统级的 Chromium 依赖；库是从 Debian arm64 包里解出来的。
 * 如果存在就加入加载路径，否则退回系统默认（有完整依赖的机器无需这一步）。
 */
const libCandidates = [
  path.resolve(process.cwd(), '.vendor/chromium-libs/usr/lib/aarch64-linux-gnu'),
  path.resolve(process.cwd(), '.vendor/chromium-libs/lib/aarch64-linux-gnu'),
].filter((p) => existsSync(p));
if (libCandidates.length) {
  process.env.LD_LIBRARY_PATH = [...libCandidates, process.env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(':');
}

const bundledChromium = '/home/node/.cache/ms-playwright/chromium-1181/chrome-linux/chrome';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    viewport: { width: 1600, height: 1200 },
    launchOptions: {
      ...(existsSync(bundledChromium) ? { executablePath: bundledChromium } : {}),
      args: ['--no-sandbox', '--font-render-hinting=none'],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
