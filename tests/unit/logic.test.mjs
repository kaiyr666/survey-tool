import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toggleOption, isOptionMuted, canSubmit, hintText, participantOrder, percent, formatValue,
  desiredOrder, leaderIds, barWidth, MAX_BAR, timerRemaining, formatTimer, screenPages, stepPage,
  toCsv, summaryRows, uuid, shuffle,
} from '../../public/js/logic.js';

const opts = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: i + 1, ord: i + 1, text: `O${i + 1}`, votes: 0, ...(extra[i + 1] || {}) }));
const Q1 = { id: 1, type: 'multi', min: 1, max: 2, hint: 'Choose up to two options', shuffle: true, options: opts(8) };
const Q2 = { id: 2, type: 'single', min: 1, max: 1, hint: 'Choose one option', options: opts(4) };
const Q3 = { id: 3, type: 'multi', min: 1, max: 2, hint: 'Choose up to two options', shuffle: true, options: opts(8, { 8: { exclusive: true, pinned_last: true } }) };

test('multi choice: up to two, third tap ignored, re-tap deselects', () => {
  let s = [];
  s = toggleOption(Q1, s, 1);
  s = toggleOption(Q1, s, 2);
  assert.deepEqual(s, [1, 2]);
  assert.deepEqual(toggleOption(Q1, s, 3), [1, 2], 'third option cannot be selected');
  assert.deepEqual(toggleOption(Q1, s, 1), [2], 'tapping a selected card deselects it');
});

test('multi choice: other cards become muted when the limit is reached', () => {
  const s = [1, 2];
  assert.equal(isOptionMuted(Q1, s, Q1.options[2]), true);
  assert.equal(isOptionMuted(Q1, s, Q1.options[0]), false);
  assert.equal(isOptionMuted(Q1, [1], Q1.options[2]), false);
  assert.equal(hintText(Q1, s), 'Selected 2 of 2');
  assert.equal(hintText(Q1, [1]), 'Choose up to two options');
});

test('single choice: new selection replaces the previous one', () => {
  let s = toggleOption(Q2, [], 1);
  s = toggleOption(Q2, s, 3);
  assert.deepEqual(s, [3]);
  assert.equal(isOptionMuted(Q2, s, Q2.options[0]), false);
  assert.equal(hintText(Q2, s), 'Choose one option');
});

test('exclusive option clears others, and any other option clears it', () => {
  let s = toggleOption(Q3, [1, 2], 8);
  assert.deepEqual(s, [8]);
  assert.equal(isOptionMuted(Q3, s, Q3.options[0]), true, 'others look blocked');
  s = toggleOption(Q3, s, 3);
  assert.deepEqual(s, [3], 'selecting another option removes the exclusive one');
});

test('submit is enabled only with a valid number of options', () => {
  assert.equal(canSubmit(Q1, []), false);
  assert.equal(canSubmit(Q1, [1]), true);
  assert.equal(canSubmit(Q1, [1, 2]), true);
  assert.equal(canSubmit(Q1, [1, 2, 3]), false);
  assert.equal(canSubmit(Q2, [1]), true);
});

test('participant order: shuffled once, kept afterwards, pinned stays last, Q2 never shuffled', () => {
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const o1 = participantOrder(Q3, null, rng);
  assert.equal(o1.at(-1), 8);
  assert.deepEqual([...o1].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(participantOrder(Q3, o1, rng), o1, 'saved order is kept');
  assert.deepEqual(participantOrder(Q2, null, rng), [1, 2, 3, 4]);
  // An option added later is appended to the saved order.
  const q = { ...Q1, options: [...Q1.options, { id: 99, ord: 9, text: 'new' }] };
  assert.deepEqual(participantOrder(q, [8, 7, 6, 5, 4, 3, 2, 1]), [8, 7, 6, 5, 4, 3, 2, 1, 99]);
});

test('shuffle is a permutation', () => {
  const a = Array.from({ length: 50 }, (_, i) => i);
  assert.deepEqual([...shuffle(a)].sort((x, y) => x - y), a);
});

test('percent is relative to people who answered the question, rounded', () => {
  assert.equal(percent(42, 150), 28);
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(2, 3), 67);
  assert.equal(percent(0, 0), 0);
  assert.equal(formatValue(42, 150), '42 · 28%');
  // Multi-choice sums can exceed 100%
  const votes = [2, 2, 1];
  assert.ok(votes.map((v) => percent(v, 3)).reduce((a, b) => a + b) > 100);
});

test('display order: multi by votes desc with stable ties, pinned last; single keeps scale order', () => {
  const q = { type: 'multi', options: [
    { id: 1, ord: 1, votes: 3 }, { id: 2, ord: 2, votes: 5 }, { id: 3, ord: 3, votes: 3 },
    { id: 4, ord: 4, votes: 9, pinned_last: true },
  ] };
  assert.deepEqual(desiredOrder(q), [2, 1, 3, 4]);
  const s = { type: 'single', options: [{ id: 1, ord: 1, votes: 1 }, { id: 2, ord: 2, votes: 9 }] };
  assert.deepEqual(desiredOrder(s), [1, 2]);
});

test('leader highlighting excludes pinned options and zero votes', () => {
  const q = { options: [{ id: 1, votes: 4 }, { id: 2, votes: 4 }, { id: 3, votes: 1 }, { id: 4, votes: 10, pinned_last: true }] };
  assert.deepEqual([...leaderIds(q)].sort(), [1, 2]);
  assert.equal(leaderIds({ options: [{ id: 1, votes: 0 }] }).size, 0);
});

test('bar width: longest bar at most 85% of the track', () => {
  assert.ok(MAX_BAR <= 85);
  assert.equal(barWidth(10, 10), MAX_BAR);
  assert.equal(barWidth(5, 10), MAX_BAR / 2);
  assert.equal(barWidth(0, 10), 0);
  assert.equal(barWidth(0, 0), 0);
});

test('timer: running, paused and clock offset', () => {
  const now = Date.parse('2026-01-01T10:00:30Z');
  const running = { timer_duration: 90, timer_remaining: 90, timer_started_at: '2026-01-01T10:00:00Z' };
  assert.equal(timerRemaining(running, 0, now), 60);
  assert.equal(timerRemaining(running, 5000, now), 55, 'server clock ahead by 5s');
  assert.equal(timerRemaining({ ...running, timer_started_at: null, timer_remaining: 42 }, 0, now), 42);
  assert.equal(timerRemaining({ ...running, timer_started_at: '2026-01-01T09:00:00Z' }, 0, now), 0);
  assert.equal(formatTimer(90), '1:30');
  assert.equal(formatTimer(59.2), '1:00');
  assert.equal(formatTimer(5), '0:05');
  assert.equal(formatTimer(0), '0:00');
});

test('screen pages and navigation clamp at the ends', () => {
  const pages = screenPages([{ ord: 1, status: 'open' }, { ord: 2, status: 'closed' }, { ord: 3, status: 'open' }, { ord: 4, status: 'hidden' }]);
  assert.deepEqual(pages, [0, 1, 2, 3]);
  assert.equal(stepPage(pages, 0, -1), 0);
  assert.equal(stepPage(pages, 3, +1), 3);
  assert.equal(stepPage(pages, 1, +1), 2);
  assert.equal(stepPage(pages, 42, +1), 0);
});

test('CSV: escaping and BOM', () => {
  const csv = toCsv([['a', 'b'], ['x, y', 'say "hi"'], ['line\nbreak', 3]]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('"x, y","say ""hi"""'));
  assert.ok(csv.includes('"line\nbreak",3'));
});

test('summary rows use the same math as the screen', () => {
  const rows = summaryRows({ questions: [{ ord: 1, text: 'Q', answered: 3, options: [{ ord: 1, text: 'A', votes: 2 }, { ord: 2, text: 'B', votes: 1 }] }] });
  assert.deepEqual(rows[1], [1, 'Q', 'A', 2, '67%', 3]);
  assert.deepEqual(rows[2], [1, 'Q', 'B', 1, '33%', 3]);
});

test('uuid v4 format with and without crypto.randomUUID', () => {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(uuid(), re);
  assert.match(uuid({ getRandomValues: (b) => globalThis.crypto.getRandomValues(b) }), re);
});
