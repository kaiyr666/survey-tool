// Participant page (phone). One question per screen, each answer is sent on "Next".
import {
  toggleOption, isOptionMuted, canSubmit, hintText, participantOrder, uuid, RETRY_DELAYS,
} from './logic.js';
import { rpc, subscribe, storage, NetworkError, isConfigured } from './api.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

const T = {
  waiting: 'The poll will start soon',
  waitingSub: 'Please keep this page open — it will continue automatically.',
  startText: 'Three quick questions, about a minute. Answers are completely anonymous: no one, including the moderator and speakers, can see who chose what.',
  start: 'Start',
  progress: (n, m) => `Question ${n} of ${m}`,
  back: 'Back',
  next: 'Next',
  submit: 'Submit',
  offline: 'No connection — your answer will be sent automatically',
  questionClosed: 'Voting on this question has closed',
  questionClosedSaved: 'Your answer was saved.',
  continue: 'Next',
  pollClosed: 'The poll has ended. Thank you!',
  done: 'Thank you!',
  doneSub: 'Results are on the big screen.',
  connecting: 'Connecting…',
  notConfigured: 'This poll is not configured yet.',
};

const ICON = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  bigCheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  chevronL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  chevronR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  bars: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 18V11M12 18V6M19 18v-4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => b.includes(x));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pid = storage.get('livepoll:pid');
if (!pid) { pid = uuid(); storage.set('livepoll:pid', pid); }

let server = null;      // last payload from participant_sync
let local = null;       // per-session progress, persisted
let signature = '';     // what is currently rendered
let busy = false;
let rtConnected = false;
let unsubscribe = null;

const sessionKey = (sid) => `livepoll:s:${sid}`;
const save = () => local && storage.set(sessionKey(local.sessionId), local);

function loadLocal(sid) {
  const saved = storage.get(sessionKey(sid));
  return {
    sessionId: sid,
    started: false,
    current: null,       // question id | 'done'
    selections: {},      // qid -> [optionId]
    sent: {},            // qid -> [optionId] confirmed by the server
    pending: {},         // qid -> [optionId] waiting for a retry
    skipped: [],         // closed questions the participant moved past
    orders: {},          // qid -> [optionId] (shuffled once)
    ...(saved || {}),
  };
}

const visibleQuestions = () => (server?.questions || []);
const questionById = (id) => visibleQuestions().find((q) => q.id === id);

// ---------------------------------------------------------------------------
// Sync with the server
// ---------------------------------------------------------------------------

let syncing = null;
let syncAgain = false;
async function sync() {
  if (syncing) { syncAgain = true; return syncing; }
  syncing = (async () => {
    try {
      apply(await rpc('participant_sync', { p_pid: pid }));
    } catch (e) {
      if (!server) renderConnecting();
    } finally {
      syncing = null;
      if (syncAgain) { syncAgain = false; sync(); }
    }
  })();
  return syncing;
}

let jitterTimer = null;
function syncSoon() {
  // Spread the load when an operator action wakes up every phone at once.
  clearTimeout(jitterTimer);
  jitterTimer = setTimeout(sync, 150 + Math.random() * 1200);
}

function apply(data) {
  server = data;
  const s = data.session;
  if (!s) { render(); return; }

  if (!local || local.sessionId !== s.id) {
    local = loadLocal(s.id);
    resubscribe(s.id);
  }

  for (const [qid, ids] of Object.entries(data.answers || {})) {
    local.sent[qid] = ids;
    if (!local.selections[qid]) local.selections[qid] = ids;
  }
  if (Object.keys(data.answers || {}).length) local.started = true;

  for (const q of visibleQuestions()) {
    local.orders[q.id] = participantOrder(q, local.orders[q.id]);
  }
  save();
  if (Object.keys(local.pending).length) scheduleFlush();
  render();
}

function resubscribe(sid) {
  if (unsubscribe) unsubscribe();
  const start = () => {
    unsubscribe = subscribe('participant', [
      { table: 'sessions' },
      { table: 'questions', filter: `session_id=eq.${sid}` },
    ], syncSoon, (ok) => { rtConnected = ok; });
  };
  // Load the realtime client after first paint to keep the first load tiny.
  setTimeout(start, 1200);
}

function pollLoop() {
  const base = rtConnected ? 20000 : 6000;
  setTimeout(async () => {
    if (document.visibilityState !== 'hidden') await sync();
    pollLoop();
  }, base + Math.random() * 2000);
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });

// ---------------------------------------------------------------------------
// Sending answers (with offline retries)
// ---------------------------------------------------------------------------

let retryTimer = null;
let attempt = 0;

function scheduleFlush() {
  if (retryTimer) return;
  const delay = attempt < RETRY_DELAYS.length ? RETRY_DELAYS[attempt] : 20000;
  retryTimer = setTimeout(flush, delay);
}

async function flush() {
  retryTimer = null;
  const entries = Object.entries(local?.pending || {});
  if (!entries.length) { attempt = 0; showToast(false); return; }
  for (const [qid, ids] of entries) {
    try {
      const r = await rpc('submit_answer', { p_pid: pid, p_question: Number(qid), p_options: ids }, { timeout: 6000 });
      if (r?.ok) local.sent[qid] = ids;
      delete local.pending[qid]; // accepted, or rejected for good (e.g. question closed)
      save();
    } catch (e) {
      if (!(e instanceof NetworkError)) { delete local.pending[qid]; save(); continue; }
      attempt += 1;
      scheduleFlush();
      return;
    }
  }
  attempt = 0;
  showToast(false);
  sync();
}

window.addEventListener('online', () => {
  if (!local || !Object.keys(local.pending).length) return;
  clearTimeout(retryTimer); retryTimer = null; attempt = 0; flush();
});

function showToast(on) {
  if (on) {
    toastEl.innerHTML = `<span class="dot"></span><span>${esc(T.offline)}</span>`;
    toastEl.hidden = false;
  } else {
    toastEl.hidden = true;
  }
}

async function submitCurrent(btn) {
  if (busy) return;
  const q = questionById(local.current);
  if (!q) return;
  const sel = local.selections[q.id] || [];
  if (!canSubmit(q, sel)) return;

  if (sameSet(sel, local.sent[q.id]) && !local.pending[q.id]) { advance(); return; }

  busy = true;
  btn.classList.add('busy');
  btn.disabled = true;
  try {
    const r = await rpc('submit_answer', { p_pid: pid, p_question: q.id, p_options: sel }, { timeout: 6000 });
    if (r?.ok) {
      local.sent[q.id] = sel;
      delete local.pending[q.id];
      save();
      advance();
    } else if (r?.reason === 'question_closed') {
      q.status = 'closed';
      signature = '';
      render();
      sync();
    } else {
      signature = '';
      await sync();
    }
  } catch (e) {
    if (e instanceof NetworkError) {
      local.pending[q.id] = sel;
      save();
      showToast(true);
      scheduleFlush();
      advance();
    } else {
      signature = '';
      await sync();
    }
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const answered = (qid) => Boolean(local.sent[qid] || local.pending[qid]);

function advance() {
  const list = visibleQuestions();
  const i = list.findIndex((q) => q.id === local.current);
  const cur = list[i];
  if (cur && cur.status === 'closed' && !answered(cur.id) && !local.skipped.includes(cur.id)) local.skipped.push(cur.id);
  const next = list[i + 1];
  local.current = next ? next.id : 'done';
  save();
  render('forward');
}

function goBack() {
  const list = visibleQuestions();
  const i = list.findIndex((q) => q.id === local.current);
  if (i > 0) {
    local.current = list[i - 1].id;
    save();
    render('back');
  }
}

/** Decide which question to show (resume, new questions opened later, hidden ones removed). */
function resolveCurrent() {
  const list = visibleQuestions();
  if (!list.length) return 'done';
  if (local.current === 'done') {
    // A question opened later (e.g. an extra question in Act 3) brings the participant back.
    const fresh = list.find((q) => q.status === 'open' && !answered(q.id));
    return fresh ? fresh.id : 'done';
  }
  if (local.current && questionById(local.current)) return local.current;
  const firstOpen = list.find((q) => !answered(q.id) && !local.skipped.includes(q.id));
  return firstOpen ? firstOpen.id : 'done';
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function mount(html, direction, sig) {
  if (sig === signature) return false;
  signature = sig;
  app.innerHTML = `<div class="view ${direction === 'back' ? 'back' : ''} ${html.center ? 'view-center' : ''}">${html.body}</div>${html.actions || ''}`;
  window.scrollTo(0, 0);
  return true;
}

function renderConnecting() {
  mount({ center: true, body: `<div class="spinner" aria-hidden="true"></div><p class="small" style="margin-top:16px">${T.connecting}</p>` }, null, 'connecting');
}

function render(direction) {
  if (!server) return renderConnecting();
  const s = server.session;

  if (!s || s.status === 'not_started') {
    return mount({
      center: true,
      body: `
        <div class="status-icon pulse">${ICON.clock}</div>
        <h1 class="title">${T.waiting}</h1>
        <p class="lead">${T.waitingSub}</p>`,
    }, direction, 'waiting');
  }

  if (s.status === 'closed') {
    return mount({
      center: true,
      body: `
        <div class="status-icon">${ICON.flag}</div>
        <h1 class="title">${T.pollClosed}</h1>`,
    }, direction, 'closed');
  }

  if (!local.started) {
    const count = visibleQuestions().length;
    const sig = `start|${s.title}|${count}`;
    if (mount({
      body: `
        <div class="hero-mark">${ICON.bars}</div>
        <p class="eyebrow">Live poll</p>
        <h1 class="title">${esc(s.title)}</h1>
        <p class="lead">${esc(T.startText)}</p>
        <ul class="facts">
          <li>${ICON.clock}<span>~1 minute</span></li>
          <li>${ICON.lock}<span>Anonymous</span></li>
        </ul>`,
      actions: `<div class="actions"><div class="actions-inner"><button class="btn btn-primary" id="start"><span class="btn-text">${T.start}</span>${ICON.chevronR}</button></div></div>`,
    }, direction, sig)) {
      app.querySelector('#start').addEventListener('click', () => {
        local.started = true;
        local.current = null;
        local.current = resolveCurrent();
        save();
        render('forward');
      });
    }
    return;
  }

  local.current = resolveCurrent();
  save();

  if (local.current === 'done') {
    return mount({
      center: true,
      body: `
        <div class="status-icon done">${ICON.bigCheck}</div>
        <h1 class="title">${T.done}</h1>
        <p class="lead">${T.doneSub}</p>`,
    }, direction, 'done');
  }

  renderQuestion(questionById(local.current), direction);
}

function renderQuestion(q, direction) {
  const list = visibleQuestions();
  const idx = list.findIndex((x) => x.id === q.id);
  const total = list.length;
  const isLast = idx === total - 1;
  const closed = q.status === 'closed';
  const sig = `q|${q.id}|${q.status}|${q.text}|${q.options.map((o) => o.text).join('¦')}|${total}`;

  const progress = `
    <div class="progress">
      <div class="progress-label"><span>${T.progress(idx + 1, total)}</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${((idx + (closed ? 1 : 0.5)) / total) * 100}%"></div></div>
    </div>`;

  const backBtn = idx > 0 ? `<button class="btn btn-ghost" id="back" aria-label="${T.back}">${ICON.chevronL}<span>${T.back}</span></button>` : '';

  if (closed) {
    const saved = answered(q.id);
    if (mount({
      body: `${progress}
        <h1 class="question">${esc(q.text)}</h1>
        <div class="closed-card">
          <div class="status-icon" style="width:64px;height:64px;margin-bottom:16px">${ICON.lock}</div>
          <p>${T.questionClosed}</p>
          ${saved ? `<span class="small">${T.questionClosedSaved}</span>` : ''}
        </div>`,
      actions: `<div class="actions"><div class="actions-inner">${backBtn}<button class="btn btn-primary" id="next"><span class="btn-text">${T.continue}</span>${ICON.chevronR}</button></div></div>`,
    }, direction, sig)) {
      app.querySelector('#next').addEventListener('click', advance);
      app.querySelector('#back')?.addEventListener('click', goBack);
    }
    return;
  }

  const order = local.orders[q.id] || q.options.map((o) => o.id);
  const byId = new Map(q.options.map((o) => [o.id, o]));
  const multi = q.type === 'multi' && q.max > 1;
  const items = order.map((id) => byId.get(id)).filter(Boolean).map((o) => `
      <li><button type="button" class="option ${multi ? 'square' : ''} ${o.pinned_last ? 'pinned' : ''}" data-id="${o.id}"
        role="${multi ? 'checkbox' : 'radio'}" aria-checked="false">
        <span class="label">${esc(o.text)}</span>
        <span class="check">${ICON.check}</span>
      </button></li>`).join('');

  if (mount({
    body: `${progress}
      <h1 class="question" id="qtext">${esc(q.text)}</h1>
      <p class="hint" id="hint"></p>
      <ul class="options" role="${multi ? 'group' : 'radiogroup'}" aria-labelledby="qtext">${items}</ul>`,
    actions: `<div class="actions"><div class="actions-inner">${backBtn}<button class="btn btn-primary" id="next" disabled><span class="btn-text">${isLast ? T.submit : T.next}</span>${ICON.chevronR}</button></div></div>`,
  }, direction, sig)) {
    const nextBtn = app.querySelector('#next');
    app.querySelector('.options').addEventListener('click', (ev) => {
      const btn = ev.target.closest('.option');
      if (!btn || busy) return;
      const id = Number(btn.dataset.id);
      local.selections[q.id] = toggleOption(q, local.selections[q.id] || [], id);
      save();
      updateSelection(q);
    });
    nextBtn.addEventListener('click', () => submitCurrent(nextBtn));
    app.querySelector('#back')?.addEventListener('click', goBack);
  }
  updateSelection(q);
}

function updateSelection(q) {
  const sel = local.selections[q.id] || [];
  for (const btn of app.querySelectorAll('.option')) {
    const o = q.options.find((x) => x.id === Number(btn.dataset.id));
    if (!o) continue;
    const on = sel.includes(o.id);
    btn.classList.toggle('selected', on);
    btn.classList.toggle('muted', isOptionMuted(q, sel, o));
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  const hint = app.querySelector('#hint');
  if (hint) {
    hint.textContent = hintText(q, sel);
    hint.classList.toggle('full', q.type === 'multi' && q.max > 1 && sel.length >= q.max);
  }
  const next = app.querySelector('#next');
  if (next && !busy) next.disabled = !canSubmit(q, sel);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (!isConfigured()) {
  mount({ center: true, body: `<h1 class="title">${T.notConfigured}</h1>` }, null, 'unconfigured');
} else {
  sync();
  pollLoop();
}
