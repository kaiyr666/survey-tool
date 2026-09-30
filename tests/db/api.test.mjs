// Integration tests for the database API (RPC functions + row level security).
// Requires a running Supabase (local: `npm run db:start`).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rpc, rest, admin, freshSession, pid, opt, PIN } from '../helpers.mjs';

let S;   // session
let Q;   // questions [q1, q2, q3]
const submit = (p, q, ids) => rpc('submit_answer', { p_pid: p, p_question: q.id, p_options: ids });
const results = () => rpc('get_results');
const qr = (r, ord) => r.questions.find((q) => q.ord === ord);
const votes = (q, optionId) => q.options.find((o) => o.id === optionId).votes;

before(async () => {
  ({ session: S, questions: Q } = await freshSession());
});

test('content comes from configuration: 3 questions with the translated texts', () => {
  assert.equal(Q.length, 3);
  assert.equal(Q[0].text, 'What slows down digitalization and automation in your company the most?');
  assert.equal(Q[0].options.length, 8);
  assert.equal(Q[1].type, 'single');
  const last = Q[2].options.at(-1);
  assert.equal(last.text, 'Not using it yet');
  assert.equal(last.exclusive, true);
  assert.equal(last.pinned_last, true);
});

test('joining registers the device as connected (idempotent)', async () => {
  const p = pid();
  const before = (await results()).connected;
  const a = await rpc('participant_sync', { p_pid: p });
  await rpc('participant_sync', { p_pid: p });
  assert.equal(a.session.id, S.id);
  assert.equal(a.questions.length, 3);
  assert.equal((await results()).connected, before + 1);
});

test('selection rules are enforced on the server', async () => {
  const p = pid();
  assert.equal((await submit(p, Q[0], [])).reason, 'invalid', 'min 1');
  assert.equal((await submit(p, Q[0], [opt(Q[0], 0), opt(Q[0], 1), opt(Q[0], 2)])).reason, 'invalid', 'max 2');
  assert.equal((await submit(p, Q[1], [opt(Q[1], 0), opt(Q[1], 1)])).reason, 'invalid', 'single = exactly 1');
  assert.equal((await submit(p, Q[0], [opt(Q[1], 0)])).reason, 'invalid', 'option from another question');
  assert.equal((await submit(p, Q[2], [opt(Q[2], 7), opt(Q[2], 0)])).reason, 'invalid', 'exclusive cannot be combined');
  assert.equal((await submit(p, Q[2], [opt(Q[2], 7)])).ok, true, 'exclusive alone is fine');
  assert.equal((await submit(p, Q[0], [opt(Q[0], 0), opt(Q[0], 0)])).ok, true, 'duplicates are collapsed');
});

test('changing an answer updates it instead of adding a duplicate', async () => {
  const p = pid();
  const a = opt(Q[1], 0), b = opt(Q[1], 1);
  const r0 = qr(await results(), 2);
  await submit(p, Q[1], [a]);
  await submit(p, Q[1], [a]); // double tap
  await submit(p, Q[1], [b]); // went back and changed
  const r1 = qr(await results(), 2);
  assert.equal(r1.answered, r0.answered + 1);
  assert.equal(votes(r1, a), votes(r0, a));
  assert.equal(votes(r1, b), votes(r0, b) + 1);
  const sync = await rpc('participant_sync', { p_pid: p });
  assert.deepEqual(sync.answers[String(Q[1].id)], [b], 'answers are returned for resume');
});

test('percentages: multi-choice sums above 100%, single choice sums to 100%', async () => {
  const { questions } = await freshSession();
  const [q1, q2] = questions;
  const people = [pid(), pid(), pid()];
  await submit(people[0], q1, [opt(q1, 0), opt(q1, 1)]);
  await submit(people[1], q1, [opt(q1, 0), opt(q1, 2)]);
  await submit(people[2], q1, [opt(q1, 0)]);
  for (const [i, p] of people.entries()) await submit(p, q2, [opt(q2, i % 2)]);
  const r = await results();
  const r1 = qr(r, 1), r2 = qr(r, 2);
  const pct = (q) => q.options.map((o) => Math.round((o.votes / q.answered) * 100));
  assert.equal(r1.answered, 3);
  assert.equal(votes(r1, opt(q1, 0)), 3);
  assert.ok(pct(r1).reduce((a, b) => a + b) > 100);
  assert.equal(r2.options.reduce((a, o) => a + o.votes, 0), r2.answered);
  ({ session: S, questions: Q } = await freshSession());
});

test('completed = answered every visible question; partial answers still count', async () => {
  const p = pid();
  const r0 = await results();
  await submit(p, Q[0], [opt(Q[0], 3)]);
  let r = await results();
  assert.equal(qr(r, 1).answered, qr(r0, 1).answered + 1, 'Q1 counted immediately');
  assert.equal(r.completed, r0.completed);
  await submit(p, Q[1], [opt(Q[1], 0)]);
  await submit(p, Q[2], [opt(Q[2], 1)]);
  r = await results();
  assert.equal(r.completed, r0.completed + 1);
  assert.equal(r.started, r0.started + 1);
});

test('closed question rejects answers; reopened accepts again', async () => {
  const p = pid();
  await admin('question_status', { question_id: Q[1].id, status: 'closed' });
  assert.equal((await submit(p, Q[1], [opt(Q[1], 0)])).reason, 'question_closed');
  await admin('question_status', { question_id: Q[1].id, status: 'open' });
  assert.equal((await submit(p, Q[1], [opt(Q[1], 0)])).ok, true);
});

test('poll status: not started / closed reject answers', async () => {
  const p = pid();
  await admin('poll_status', { status: 'not_started' });
  assert.equal((await submit(p, Q[0], [opt(Q[0], 0)])).reason, 'poll_not_started');
  await admin('poll_status', { status: 'closed' });
  assert.equal((await submit(p, Q[0], [opt(Q[0], 0)])).reason, 'poll_closed');
  const sync = await rpc('participant_sync', { p_pid: pid() });
  assert.equal(sync.session.status, 'closed');
  await admin('poll_status', { status: 'open' });
});

test('a hidden (future) question is invisible until opened, then appears', async () => {
  const p = pid();
  await admin('question_status', { question_id: Q[2].id, status: 'hidden' });
  let sync = await rpc('participant_sync', { p_pid: p });
  assert.equal(sync.questions.length, 2);
  assert.equal((await submit(p, Q[2], [opt(Q[2], 0)])).reason, 'question_hidden');
  // Answering the two visible questions completes the poll while Q3 is hidden.
  await submit(p, Q[0], [opt(Q[0], 0)]);
  await submit(p, Q[1], [opt(Q[1], 0)]);
  const completedHidden = (await results()).completed;
  await admin('question_status', { question_id: Q[2].id, status: 'open' });
  sync = await rpc('participant_sync', { p_pid: p });
  assert.equal(sync.questions.length, 3);
  assert.equal((await results()).completed, completedHidden - 1, 'completion recalculated when a question appears');
});

test('stale session: answers to a previous session are rejected', async () => {
  const old = Q[0];
  ({ session: S, questions: Q } = await freshSession());
  assert.equal((await submit(pid(), old, [opt(old, 0)])).reason, 'stale_session');
});

test('privacy: raw responses, participants and config are not readable', async () => {
  await submit(pid(), Q[0], [opt(Q[0], 0)]);
  for (const t of ['responses', 'participants', 'app_config']) {
    const r = await rest(`${t}?select=*`);
    assert.ok(r.status === 401 || r.status === 403 || (Array.isArray(r.body) && r.body.length === 0), `${t} must not be readable`);
  }
  const pub = await rest('questions?select=id,text&limit=1');
  assert.equal(pub.status, 200, 'question content is public');
});

test('privacy: tables cannot be written directly and internal functions are not exposed', async () => {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/sessions`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', title: 'x', mode: 'test' }),
  });
  assert.ok(res.status >= 400);
  for (const fn of ['set_admin_pin', '_create_session', '_refresh_completion']) {
    await assert.rejects(rpc(fn, {}), (e) => e.status >= 400, fn);
  }
});

test('operator: wrong PIN is rejected, correct PIN works', async () => {
  const bad = await admin('state', {}, '0000');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'bad_pin');
  const good = await admin('state');
  assert.equal(good.ok, true);
  assert.ok(Array.isArray(good.sessions));
  assert.ok(good.companies.includes('Leasing'));
  assert.ok(!JSON.stringify(good.companies).includes('BCC'));
});

test('operator: presenter controls, tags, timer', async () => {
  let r = await admin('presenter', { current_page: 2, sort_frozen: true, small_qr: false, theme: 'dark' });
  let p = r.results.presenter;
  assert.deepEqual([p.current_page, p.sort_frozen, p.small_qr, p.theme], [2, true, false, 'dark']);
  r = await admin('results_visibility', { question_id: Q[0].id, hidden: true });
  assert.deepEqual(r.results.presenter.hidden_question_ids, [Q[0].id]);
  r = await admin('results_visibility', { question_id: Q[0].id, hidden: false });
  assert.deepEqual(r.results.presenter.hidden_question_ids, []);

  r = await admin('annotation_add', { option_id: opt(Q[0], 1), label: 'Leasing' });
  r = await admin('annotation_add', { option_id: opt(Q[0], 1), label: 'Life' });
  assert.equal(r.results.annotations.length, 2);
  r = await admin('annotation_remove', { id: r.results.annotations[0].id });
  assert.equal(r.results.annotations.length, 1);
  assert.equal((await admin('annotation_add', { option_id: 999999, label: 'x' })).ok, false);
  r = await admin('annotation_clear');
  assert.equal(r.results.annotations.length, 0);

  r = await admin('timer', { op: 'duration', seconds: 60 });
  assert.equal(r.results.presenter.timer_remaining, 60);
  r = await admin('timer', { op: 'start' });
  assert.ok(r.results.presenter.timer_started_at);
  assert.equal(r.results.presenter.timer_visible, true);
  await new Promise((res) => setTimeout(res, 1100));
  r = await admin('timer', { op: 'pause' });
  assert.equal(r.results.presenter.timer_started_at, null);
  assert.ok(r.results.presenter.timer_remaining < 60 && r.results.presenter.timer_remaining > 57);
  r = await admin('timer', { op: 'reset' });
  assert.equal(Number(r.results.presenter.timer_remaining), 60);
  r = await admin('timer', { op: 'hide' });
  assert.equal(r.results.presenter.timer_visible, false);
  await admin('presenter', { current_page: 0, sort_frozen: false, small_qr: true, theme: 'light' });
});

test('operator: reset requires the RESET word and clears only this session', async () => {
  await submit(pid(), Q[0], [opt(Q[0], 0)]);
  assert.equal((await admin('reset', { confirm: 'reset' })).error, 'confirm_required');
  const r = await admin('reset', { confirm: 'RESET' });
  assert.equal(r.ok, true);
  assert.equal(r.results.connected, 0);
  assert.equal(qr(r.results, 1).answered, 0);
});

test('operator: anonymous export contains ids, questions, options and times — nothing else', async () => {
  const p = pid();
  await submit(p, Q[0], [opt(Q[0], 0), opt(Q[0], 1)]);
  const r = await admin('export_responses');
  const row = r.rows.find((x) => x.participant_id === p);
  assert.deepEqual(Object.keys(row).sort(), ['created_at', 'options', 'participant_id', 'question', 'question_ord', 'updated_at']);
  assert.equal(row.options.length, 2);
});

test('operator: live/test sessions are separate', async () => {
  await submit(pid(), Q[0], [opt(Q[0], 0)]);
  const testSession = S.id;
  const testAnswered = qr(await results(), 1).answered;
  assert.ok(testAnswered > 0);
  const live = await admin('new_session', { mode: 'live', name: 'Live (automated test)' });
  assert.equal(live.results.session.mode, 'live');
  assert.equal(qr(live.results, 1).answered, 0, 'live session starts from zero');
  const back = await admin('activate_session', { session_id: testSession });
  assert.equal(back.results.session.id, testSession);
  assert.equal(qr(back.results, 1).answered, testAnswered, 'test data untouched');
});

test('operator: PIN lockout after repeated failures', { skip: !process.env.DB_URL && 'DB_URL not set' }, async () => {
  for (let i = 0; i < 5; i++) await admin('state', {}, `wrong${i}`);
  const locked = await admin('state', {}, PIN);
  assert.equal(locked.error, 'locked', 'even the right PIN waits during lockout');
  execFileSync('psql', [process.env.DB_URL, '-qc', `select set_admin_pin('${PIN}')`]);
  assert.equal((await admin('state')).ok, true);
});
