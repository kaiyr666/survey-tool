// Participant (phone) end-to-end tests.
import { test, expect, devices } from '@playwright/test';
import { admin, rpc, freshSession } from '../helpers.mjs';

test.use({ ...devices['iPhone 13'], browserName: 'chromium' });

let Q;
test.beforeEach(async () => { ({ questions: Q } = await freshSession()); });

const results = () => rpc('get_results');
const optionByText = (page, text) => page.locator('.option', { hasText: text });

test('full journey with all selection rules, back navigation and no duplicates', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Business challenges/ })).toBeVisible();
  await expect(page.getByText('Answers are completely anonymous')).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).click();

  // Q1 — up to two
  await expect(page.getByText('Question 1 of 3')).toBeVisible();
  const next = page.locator('#next');
  await expect(next).toBeDisabled();
  await optionByText(page, 'Lack of IT resources').click();
  await expect(next).toBeEnabled();
  await optionByText(page, 'Legacy systems and integrations').click();
  await expect(page.locator('#hint')).toHaveText('Selected 2 of 2');
  const third = optionByText(page, 'Translation').or(optionByText(page, 'No priority or budget'));
  await expect(third.first()).toHaveClass(/muted/);
  await third.first().click();
  await expect(page.locator('.option.selected')).toHaveCount(2);
  // re-tap deselects
  await optionByText(page, 'Legacy systems and integrations').click();
  await expect(page.locator('.option.selected')).toHaveCount(1);
  await optionByText(page, 'Data: quality and access').click();
  await next.click();

  // The Q1 answer is on the server before the participant finishes.
  await expect.poll(async () => (await results()).questions[0].answered).toBe(1);

  // Q2 — single choice, fixed scale order
  await expect(page.getByText('Question 2 of 3')).toBeVisible();
  const labels = await page.locator('.option .label').allTextContents();
  expect(labels).toEqual(['Every day', 'Several times a week', 'Tried it, but it didn’t stick', 'Not using it yet']);
  await optionByText(page, 'Every day').click();
  await optionByText(page, 'Several times a week').click();
  await expect(page.locator('.option.selected')).toHaveCount(1);

  // Back keeps the Q1 selection; changing it updates (not duplicates) the answer
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByText('Question 1 of 3')).toBeVisible();
  await expect(page.locator('.option.selected')).toHaveCount(2);
  await optionByText(page, 'Data: quality and access').click();
  await optionByText(page, 'Manual, undocumented processes').click();
  await next.click();
  await expect(page.getByText('Question 2 of 3')).toBeVisible();
  await expect(optionByText(page, 'Several times a week')).toHaveClass(/selected/);
  await page.locator('#next').click();

  // Q3 — exclusive option, always last
  await expect(page.getByText('Question 3 of 3')).toBeVisible();
  await expect(page.locator('.option .label').last()).toHaveText('Not using it yet');
  await optionByText(page, 'Translation').click();
  await optionByText(page, 'Not using it yet').click();
  await expect(page.locator('.option.selected')).toHaveCount(1);
  await expect(optionByText(page, 'Translation')).toHaveClass(/muted/);
  await optionByText(page, 'Code and task automation').click();
  await expect(optionByText(page, 'Not using it yet')).not.toHaveClass(/selected/);
  await expect(page.locator('#next')).toHaveText(/Submit/);
  await page.locator('#next').dblclick(); // double tap protection
  await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  await expect(page.getByText('Results are on the big screen.')).toBeVisible();

  const r = await results();
  expect(r.completed).toBe(1);
  expect(r.questions.map((q) => q.answered)).toEqual([1, 1, 1]);
  const q1 = r.questions[0].options;
  const v = (t) => q1.find((o) => o.text === t).votes;
  expect(v('Lack of IT resources')).toBe(1);
  expect(v('Manual, undocumented processes')).toBe(1);
  expect(v('Data: quality and access')).toBe(0);
});

test('resume: reload continues where the participant stopped; shuffled order is kept', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  const order1 = await page.locator('.option .label').allTextContents();
  await page.reload();
  await expect(page.getByText('Question 1 of 3')).toBeVisible();
  expect(await page.locator('.option .label').allTextContents()).toEqual(order1);
  await page.locator('.option').first().click();
  await page.locator('#next').click();
  await expect(page.getByText('Question 2 of 3')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Question 2 of 3')).toBeVisible();
  await page.locator('.option').first().click();
  await page.locator('#next').click();
  await page.locator('.option').first().click();
  await page.locator('#next').click();
  await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  expect((await results()).completed).toBe(1);
});

test('waiting screen before the poll opens, then continues automatically', async ({ page }) => {
  await admin('poll_status', { status: 'not_started' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'The poll will start soon' })).toBeVisible();
  expect((await results()).connected).toBe(1);
  await admin('poll_status', { status: 'open' });
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 12_000 });
});

test('operator closes a question, then the whole poll', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.locator('.option').first().click();
  await page.locator('#next').click();
  await expect(page.getByText('Question 2 of 3')).toBeVisible();

  await admin('question_status', { question_id: Q[1].id, status: 'closed' });
  await expect(page.getByText('Voting on this question has closed')).toBeVisible({ timeout: 12_000 });
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Question 3 of 3')).toBeVisible();

  await admin('poll_status', { status: 'closed' });
  await expect(page.getByRole('heading', { name: 'The poll has ended. Thank you!' })).toBeVisible({ timeout: 12_000 });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'The poll has ended. Thank you!' })).toBeVisible();
});

test('lost connection: answer is queued, participant continues, retry delivers it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  let blocked = true;
  await page.route('**/rest/v1/rpc/submit_answer', (route) => (blocked ? route.abort('internetdisconnected') : route.continue()));
  await page.locator('.option').first().click();
  await page.locator('#next').click();
  await expect(page.getByText('No connection — your answer will be sent automatically')).toBeVisible();
  await expect(page.getByText('Question 2 of 3')).toBeVisible();
  expect((await results()).questions[0].answered).toBe(0);
  blocked = false;
  await expect.poll(async () => (await results()).questions[0].answered, { timeout: 15_000 }).toBe(1);
  await expect(page.locator('#toast')).toBeHidden();
});

test('a question opened later (hidden → open) is shown even after finishing', async ({ page }) => {
  await admin('question_status', { question_id: Q[2].id, status: 'hidden' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Question 1 of 2')).toBeVisible();
  await page.locator('.option').first().click();
  await page.locator('#next').click();
  await page.locator('.option').first().click();
  await page.locator('#next').click();
  await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
  await admin('question_status', { question_id: Q[2].id, status: 'open' });
  await expect(page.getByText('Question 3 of 3')).toBeVisible({ timeout: 12_000 });
});

test('page weight stays small (first load < 300 KB)', async ({ page }) => {
  let bytes = 0;
  page.on('response', async (res) => {
    if (!res.url().startsWith('http://localhost')) return;
    try { bytes += (await res.body()).length; } catch { /* ignore */ }
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await page.waitForTimeout(2500); // includes the lazily-loaded realtime client
  // Uncompressed bytes; hosting serves these gzipped/brotli (~3-4× smaller).
  expect(bytes).toBeLessThan(300 * 1024);
});
