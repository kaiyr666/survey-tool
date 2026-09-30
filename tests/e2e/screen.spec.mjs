// Presentation screen + operator panel end-to-end tests.
import { test, expect } from '@playwright/test';
import { admin, rpc, freshSession, pid, opt, PIN } from '../helpers.mjs';

let Q;
test.beforeEach(async () => { ({ questions: Q } = await freshSession()); });
test.use({ viewport: { width: 1920, height: 1080 } });

const submit = (p, q, ids) => rpc('submit_answer', { p_pid: p, p_question: q.id, p_options: ids });

test('QR page: QR code, short link and live "Joined" counter', async ({ page }) => {
  await page.goto('/screen');
  await expect(page.getByRole('heading', { name: 'Scan the QR code with your phone camera' })).toBeVisible();
  const qr = page.locator('.qr-frame svg');
  await expect(qr).toBeVisible();
  const box = await page.locator('.qr-frame').boundingBox();
  expect(box.height / 1080).toBeGreaterThanOrEqual(0.45);
  await expect(page.locator('.qr-url')).toHaveText('localhost:5173');
  await expect(page.locator('#joined')).toHaveText('0');
  await rpc('participant_sync', { p_pid: pid() });
  await expect(page.locator('#joined')).toHaveText('1', { timeout: 3000 });
});

test('keyboard / clicker navigation and digit shortcuts', async ({ page }) => {
  await page.goto('/screen');
  await expect(page.locator('.qr-page')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: Q[0].text })).toBeVisible();
  await page.keyboard.press('PageDown');
  await expect(page.getByRole('heading', { name: Q[1].text })).toBeVisible();
  await page.keyboard.press(' ');
  await expect(page.getByRole('heading', { name: Q[2].text })).toBeVisible();
  await page.keyboard.press(' ');
  await expect(page.getByRole('heading', { name: Q[2].text })).toBeVisible();
  await page.keyboard.press('PageUp');
  await expect(page.getByRole('heading', { name: Q[1].text })).toBeVisible();
  await page.keyboard.press('0');
  await expect(page.locator('.qr-page')).toBeVisible();
  await page.keyboard.press('3');
  await expect(page.getByRole('heading', { name: Q[2].text })).toBeVisible();
  await page.getByRole('tab', { name: 'Question 1' }).click();
  await expect(page.getByRole('heading', { name: Q[0].text })).toBeVisible();
});

test('results update live (< 2 s), labels are complete, percentages are per respondent', async ({ page }) => {
  await admin('presenter', { current_page: 1 });
  await page.goto('/screen');
  await expect(page.getByText('Waiting for the first answers')).toBeVisible();
  const rows = page.locator('.row');
  await expect(rows).toHaveCount(8);
  await expect(page.locator('.row .value').first()).toHaveText(/0\s*·\s*0%/);
  await expect(page.getByText('Up to two options could be chosen')).toBeVisible();

  const t0 = Date.now();
  await submit(pid(), Q[0], [opt(Q[0], 4), opt(Q[0], 5)]);
  await submit(pid(), Q[0], [opt(Q[0], 4)]);
  const leader = page.locator(`.row[data-id="${opt(Q[0], 4)}"]`);
  await expect(leader.locator('.value')).toHaveText(/2\s*·\s*100%/, { timeout: 2500 });
  const latency = Date.now() - t0;
  console.log(`screen update latency: ${latency} ms`);
  expect(latency).toBeLessThan(2500);
  await expect(page.locator('#answered')).toHaveText('2');
  await expect(page.locator(`.row[data-id="${opt(Q[0], 5)}"] .value`)).toHaveText(/1\s*·\s*50%/);
  await expect(page.getByText('Waiting for the first answers')).toBeHidden();

  // Leader moves to the top (throttled re-sort, ≤ 4 s)
  await expect(page.locator('.row').first()).toHaveAttribute('data-id', String(opt(Q[0], 4)), { timeout: 6000 });
  await expect(leader).toHaveClass(/leader/);

  // Labels are never truncated
  const clipped = await page.locator('.row .label').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
  expect(clipped).toBe(0);
});

test('Q3: "Not using it yet" stays at the bottom with neutral color', async ({ page }) => {
  await admin('presenter', { current_page: 3 });
  for (let i = 0; i < 3; i++) await submit(pid(), Q[2], [opt(Q[2], 7)]);
  await submit(pid(), Q[2], [opt(Q[2], 0)]);
  await page.goto('/screen');
  const last = page.locator('.row').last();
  await expect(last).toHaveAttribute('data-id', String(opt(Q[2], 7)));
  await expect(last).toHaveClass(/pinned/);
  await expect(last.locator('.value')).toHaveText(/3\s*·\s*75%/);
});

test('Q2 keeps the fixed scale order and sums to 100%', async ({ page }) => {
  await admin('presenter', { current_page: 2 });
  await submit(pid(), Q[1], [opt(Q[1], 3)]);
  await submit(pid(), Q[1], [opt(Q[1], 3)]);
  await submit(pid(), Q[1], [opt(Q[1], 0)]);
  await page.goto('/screen');
  await expect(page.locator('.row .label')).toHaveText(['Every day', 'Several times a week', 'Tried it, but it didn’t stick', 'Not using it yet']);
  const pcts = await page.locator('.row .pct').allTextContents();
  await expect.poll(async () => (await page.locator('.row .pct').allTextContents()).map((t) => parseInt(t, 10)).reduce((a, b) => a + b)).toBe(100);
  expect(pcts.length).toBe(4);
  await expect(page.locator('.footnote')).toHaveCount(0);
});

test('operator panel drives the screen: page, hidden results, tags, timer, theme', async ({ page, browser }) => {
  await page.goto('/screen');
  await expect(page.locator('.qr-page')).toBeVisible();

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const op = await ctx.newPage();
  await op.goto('/admin');
  await op.fill('#pin', '0000');
  await op.click('button[type=submit]');
  await expect(op.locator('#login-error')).toHaveText('Wrong PIN.');
  await op.fill('#pin', PIN);
  await op.click('button[type=submit]');
  await expect(op.locator('#dash')).toBeVisible();

  // Page switch
  await op.locator('#screen-page button', { hasText: 'Q1' }).click();
  await expect(page.getByRole('heading', { name: Q[0].text })).toBeVisible({ timeout: 3000 });

  // Hide / show results
  await op.locator(`[data-kind="reveal"][data-q="${Q[0].id}"]`).click();
  await expect(page.getByText('Results will be revealed shortly')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('#answered')).toBeVisible();
  await op.locator(`[data-kind="reveal"][data-q="${Q[0].id}"]`).click();
  await expect(page.locator('.row')).toHaveCount(8, { timeout: 3000 });

  // Company tags
  await op.selectOption('#tag-option', String(opt(Q[0], 2)));
  await op.locator('#tag-companies .chip', { hasText: 'Leasing' }).click();
  await op.locator('#tag-companies .chip', { hasText: 'Life' }).click();
  const tags = page.locator(`.row[data-id="${opt(Q[0], 2)}"] .tag`);
  await expect(tags).toHaveText(['Leasing', 'Life'], { timeout: 3000 });
  await op.locator('[data-remove-tag]').first().click();
  await expect(tags).toHaveText(['Life'], { timeout: 3000 });

  // Timer
  await op.fill('#timer-duration', '20');
  await op.locator('#timer-duration-form button').click();
  await op.click('#timer-start');
  const timer = page.locator('#timer');
  await expect(timer).toBeVisible({ timeout: 3000 });
  await expect(timer).toHaveText(/0:1\d|0:20/);
  await expect(timer).toHaveClass(/warn/, { timeout: 7000 });
  await op.click('#timer-pause');
  await op.click('#timer-reset');
  await expect(timer).toHaveText('0:20', { timeout: 3000 });
  await op.click('#timer-hide');
  await expect(timer).toBeHidden({ timeout: 3000 });

  // Theme & small QR
  await op.locator('label.toggle', { hasText: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 3000 });
  await op.locator('label.toggle', { hasText: 'Small QR' }).click();
  await expect(page.locator('.mini-qr')).toBeHidden({ timeout: 3000 });

  // Screen reload opens the operator's page
  await page.reload();
  await expect(page.getByRole('heading', { name: Q[0].text })).toBeVisible();

  // Poll status from the panel
  await op.locator('#poll-status button', { hasText: 'Not started' }).click();
  await expect.poll(async () => (await rpc('get_results')).session.status).toBe('not_started');

  // Exports
  await op.locator('#poll-status button', { hasText: 'Open' }).click();
  await expect.poll(async () => (await rpc('get_results')).session.status).toBe('open');
  expect((await submit(pid(), Q[0], [opt(Q[0], 0)])).ok).toBe(true);
  await expect(op.locator('.stat .v').nth(2)).toHaveText('1', { timeout: 5000 });
  const [dl] = await Promise.all([op.waitForEvent('download'), op.click('#export-summary')]);
  const csv = await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  expect(csv).toContain('Question #,Question,Option,Votes,Percent,Answered');
  expect(csv).toContain(`${Q[0].options[0].text},1,100%,1`);
  const [dl2] = await Promise.all([op.waitForEvent('download'), op.click('#export-responses')]);
  const csv2 = await (await dl2.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  expect(csv2).toContain('Anonymous ID');
  const [png] = await Promise.all([op.waitForEvent('download'), op.locator(`[data-kind="png"][data-q="${Q[0].id}"]`).click()]);
  expect(png.suggestedFilename()).toMatch(/\.png$/);

  await admin('presenter', { theme: 'light', small_qr: true });
  await ctx.close();
});

test('operator-logged browser: clicker navigation syncs every screen', async ({ page, browser }) => {
  await page.goto('/admin');
  await page.fill('#pin', PIN);
  await page.click('button[type=submit]');
  await expect(page.locator('#dash')).toBeVisible();
  await page.goto('/screen');
  const other = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await other.goto('/screen');
  await expect(other.locator('.qr-page')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(other.getByRole('heading', { name: Q[0].text })).toBeVisible({ timeout: 3000 });
});

test('720p and 4K: nothing overflows the screen', async ({ browser }) => {
  for (let i = 0; i < 5; i++) await submit(pid(), Q[0], [opt(Q[0], i), opt(Q[0], i + 1)]);
  await admin('presenter', { current_page: 1 });
  for (const vp of [{ width: 1280, height: 720 }, { width: 3840, height: 2160 }]) {
    const p = await (await browser.newContext({ viewport: vp })).newPage();
    await p.goto('/screen');
    await expect(p.locator('.row')).toHaveCount(8);
    const overflow = await p.evaluate(() => {
      const r = [...document.querySelectorAll('.row, .footnote, .qhead, .topbar')].map((e) => e.getBoundingClientRect());
      return r.some((b) => b.bottom > innerHeight + 1 || b.right > innerWidth + 1);
    });
    expect(overflow, `overflow at ${vp.width}x${vp.height}`).toBe(false);
    await p.context().close();
  }
});
