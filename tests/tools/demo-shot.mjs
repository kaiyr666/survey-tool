import { chromium, devices } from '@playwright/test';
const b = await chromium.launch();
for (const [name, opts] of [['demo-desktop', { viewport: { width: 1440, height: 900 } }], ['demo-mobile', devices['iPhone 13']]]) {
  const p = await (await b.newContext(opts)).newPage();
  await p.goto('http://localhost:5173/demo');
  for (let y = 0; y < 5000; y += 400) { await p.mouse.wheel(0, 400); await p.waitForTimeout(120); }
  await p.waitForTimeout(3500);
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(600);
  await p.screenshot({ path: `tests/.artifacts/shots/${name}.png`, fullPage: true });
}
await b.close();
