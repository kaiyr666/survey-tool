import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PORT || 5173);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,                // tests share one active poll session
  timeout: 45_000,
  expect: { timeout: 8_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.BASE_URL || `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.BASE_URL ? undefined : {
    command: 'node scripts/build-config.mjs && node scripts/serve.mjs',
    port,
    reuseExistingServer: true,
  },
});
