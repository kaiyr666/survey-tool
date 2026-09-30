// Captures design screenshots of every interface (used for visual review).
import { chromium, devices } from '@playwright/test';
const BASE = process.env.BASE_URL || 'http://localhost:5173';
const OUT = process.env.OUT || 'tests/.artifacts/shots';
const PIN = process.env.PIN || '2468';
const browser = await chromium.launch();
const shot = async (page, name) => { await page.waitForTimeout(900); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('saved', name); };

const phone = await browser.newContext({ ...devices['iPhone 13'] });
const p = await phone.newPage();
await p.goto(BASE + '/');
await shot(p, 'phone-1-start');
await p.getByRole('button', { name: 'Start' }).click();
await shot(p, 'phone-2-q1-empty');
const opts = p.locator('.option');
await opts.nth(0).click(); await opts.nth(2).click();
await shot(p, 'phone-3-q1-two-selected');
await p.getByRole('button', { name: 'Next' }).click();
await p.locator('.option').nth(1).click();
await shot(p, 'phone-4-q2');
await p.getByRole('button', { name: 'Next' }).click();
await p.locator('.option').last().click();
await shot(p, 'phone-5-q3-exclusive');
await p.getByRole('button', { name: 'Submit' }).click();
await shot(p, 'phone-6-done');

for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const s = await ctx.newPage();
  await s.goto(BASE + '/screen');
  await s.evaluate(async ([pin, theme]) => {
    const { rpc } = await import('/js/api.js');
    await rpc('admin', { p_pin: pin, p_action: 'presenter', p_args: { theme, current_page: 0 } });
  }, [PIN, theme]);
  await s.waitForTimeout(1500);
  await shot(s, `screen-${theme}-qr`);
  for (const k of ['1', '2', '3']) { await s.keyboard.press(k); await shot(s, `screen-${theme}-q${k}`); }
  await ctx.close();
}

const a = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
await a.goto(BASE + '/admin');
await shot(a, 'admin-login');
await a.fill('#pin', PIN); await a.click('button[type=submit]');
await a.waitForSelector('#dash:not([hidden])');
await shot(a, 'admin-dashboard');
await a.screenshot({ path: `${OUT}/admin-full.png`, fullPage: true });
await browser.close();
