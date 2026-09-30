// Load test (spec §12): 200 participants answer all three questions within 60 seconds.
// Pass criteria: no lost answers, screen data lag ≤ 2 s, final numbers == export.
//
//   npm run test:load                     (local Supabase from .env.local)
//   PARTICIPANTS=200 DURATION=60 npm run test:load
import { createClient } from '@supabase/supabase-js';
import { rpc, admin, freshSession, pid, SUPABASE_URL, SUPABASE_KEY } from '../helpers.mjs';

const N = Number(process.env.PARTICIPANTS || 200);
const DURATION = Number(process.env.DURATION || 60) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr, k) => [...arr].sort(() => Math.random() - 0.5).slice(0, k);

async function withRetry(fn, attempts = 4) {
  // Mirrors the phone: retry after 2, 4, 8 s on network errors.
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= attempts - 1) throw e;
      await sleep([2000, 4000, 8000][i] || 8000);
    }
  }
}

const { session, questions } = await freshSession({ name: `Load test ${N}` });
console.log(`Session ${session.id} — ${N} participants over ${DURATION / 1000}s against ${SUPABASE_URL}`);

// Expected tallies, computed locally
const expected = new Map(questions.map((q) => [q.id, { answered: 0, votes: new Map(q.options.map((o) => [o.id, 0])) }]));
let acked = 0;
const ackLog = [];            // [time, totalAnswersAcked]
const errors = [];
const latencies = [];

// ---- Realtime observer (what the screen listens to) ----
const client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
let pulses = 0;
let rtReady = false;
const channel = client.channel('load-observer')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'session_pulse', filter: `session_id=eq.${session.id}` }, () => { pulses++; })
  .subscribe((s) => { if (s === 'SUBSCRIBED') rtReady = true; });
for (let i = 0; i < 50 && !rtReady; i++) await sleep(100);
console.log(`Realtime observer: ${rtReady ? 'subscribed' : 'NOT subscribed (polling fallback only)'}`);

// ---- Screen observer: polls aggregates like the screen does, records lag ----
let observing = true;
const lags = [];
(async () => {
  while (observing) {
    const t = Date.now();
    try {
      const r = await rpc('get_results');
      const seen = r.questions.reduce((a, q) => a + q.answered, 0);
      // lag = now - time when the (seen+1)-th answer was acknowledged (if not yet visible)
      const firstUnseen = ackLog.find(([, total]) => total > seen);
      if (firstUnseen) lags.push(Date.now() - firstUnseen[0]);
      else lags.push(0);
    } catch { /* ignore */ }
    await sleep(Math.max(0, 500 - (Date.now() - t)));
  }
})();

// ---- Participants ----
async function participant() {
  const id = pid();
  await sleep(Math.random() * (DURATION - 15000));
  await withRetry(() => rpc('participant_sync', { p_pid: id }));
  for (const q of questions) {
    await sleep(1500 + Math.random() * 3500); // reading + tapping
    const ids = q.type === 'single' ? pick(q.options.map((o) => o.id), 1)
      : Math.random() < 0.1 && q.options.some((o) => o.exclusive) ? [q.options.find((o) => o.exclusive).id]
        : pick(q.options.filter((o) => !o.exclusive).map((o) => o.id), 1 + Math.round(Math.random()));
    const t = Date.now();
    try {
      const r = await withRetry(() => rpc('submit_answer', { p_pid: id, p_question: q.id, p_options: ids }));
      latencies.push(Date.now() - t);
      if (!r.ok) { errors.push(`rejected: ${r.reason}`); continue; }
      const e = expected.get(q.id);
      e.answered++;
      for (const o of ids) e.votes.set(o, e.votes.get(o) + 1);
      acked++;
      ackLog.push([Date.now(), acked]);
    } catch (err) {
      errors.push(err.message);
    }
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: N }, participant));
const elapsed = (Date.now() - started) / 1000;
await sleep(2500);
observing = false;

// ---- Verify ----
const final = await rpc('get_results');
const exp = await admin('export_responses');
let mismatches = 0;
for (const q of final.questions) {
  const e = expected.get(q.id);
  if (q.answered !== e.answered) { mismatches++; console.log(`Q${q.ord} answered ${q.answered} ≠ expected ${e.answered}`); }
  for (const o of q.options) if (o.votes !== e.votes.get(o.id)) { mismatches++; console.log(`Q${q.ord} "${o.text}" ${o.votes} ≠ ${e.votes.get(o.id)}`); }
  const exported = exp.rows.filter((r) => r.question_ord === q.ord).length;
  if (exported !== q.answered) { mismatches++; console.log(`Q${q.ord} export rows ${exported} ≠ screen ${q.answered}`); }
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] || 0; };
const report = {
  participants: N,
  seconds: Number(elapsed.toFixed(1)),
  answersAcked: acked,
  answersExpected: N * questions.length,
  errors: errors.length,
  connected: final.connected,
  completed: final.completed,
  submitLatencyMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), max: Math.max(...latencies) },
  screenLagMs: { p50: pct(lags, 50), p95: pct(lags, 95), max: Math.max(0, ...lags) },
  realtimePulses: pulses,
  mismatches,
};
console.log(JSON.stringify(report, null, 2));
if (errors.length) console.log('First errors:', errors.slice(0, 5));

await channel.unsubscribe();
await client.removeAllChannels();

const pass = errors.length === 0 && acked === N * questions.length && mismatches === 0
  && final.completed === N && final.connected === N && report.screenLagMs.p95 <= 2000;
console.log(pass ? '\nLOAD TEST PASSED ✅' : '\nLOAD TEST FAILED ❌');
process.exit(pass ? 0 : 1);
