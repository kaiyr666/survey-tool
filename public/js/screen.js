// Presentation screen: QR page + live results pages, remote-controlled by the operator.
import {
  desiredOrder, leaderIds, barWidth, formatTimer, timerRemaining, screenPages, stepPage, percent,
} from './logic.js';
import { rpc, subscribe, storage, participantUrl, shortUrl, isConfigured } from './api.js';
import { qrSvg } from './qr.js';

const stage = document.getElementById('stage');
const timerEl = document.getElementById('timer');
const tabsList = document.getElementById('tabs-list');
const offlineEl = document.getElementById('offline');
const fsBtn = document.getElementById('fs');

const SORT_INTERVAL = 4000;   // re-sort at most once per 4 s
const FETCH_THROTTLE = 500;   // aggregates at most every 500 ms

const T = {
  scan: 'Scan the QR code with your phone camera',
  joined: 'Joined',
  completed: 'Completed',
  answered: 'Answered',
  smallQr: 'Haven’t answered yet? Scan',
  multiNote: 'Up to two options could be chosen, so the percentages add up to more than 100%',
  waiting: 'Waiting for the first answers',
  hidden: 'Results will be revealed shortly',
  noSession: 'No active session',
  noSessionSub: 'Create a session in the operator panel.',
  notConfigured: 'Not configured',
};

const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 5.1A9.9 9.9 0 0112 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.6 6.6C4.3 8 2.7 10.2 2 12c1 2.5 5 7 10 7 1.8 0 3.5-.6 4.9-1.4M9.9 9.9a3 3 0 004.2 4.2"/></svg>';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let results = null;
let page = null;
let lastServerPage = null;
let offset = 0;             // server clock - local clock (ms)
let lastOk = 0;
let rtConnected = false;
let sessionId = null;
let unsubscribe = null;
let built = { key: null };
const orders = {};          // qid -> current display order
const lastSortAt = {};      // qid -> ms
let sortTimer = null;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

let inflight = false;
let queued = false;
let lastFetchAt = 0;
let pulseTimer = null;

async function refresh() {
  if (inflight) { queued = true; return; }
  inflight = true;
  const t0 = Date.now();
  try {
    const d = await rpc('get_results', {}, { timeout: 6000 });
    const t1 = Date.now();
    if (d?.server_time) offset = Date.parse(d.server_time) - (t0 + t1) / 2;
    lastOk = t1;
    apply(d);
  } catch { /* keep last known state; the offline badge will show */ }
  finally {
    inflight = false;
    lastFetchAt = Date.now();
    updateOffline();
    if (queued) { queued = false; setTimeout(refresh, FETCH_THROTTLE); }
  }
}

function refreshSoon() {
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(refresh, Math.max(0, FETCH_THROTTLE - (Date.now() - lastFetchAt)));
}

function pollLoop() {
  setTimeout(async () => { await refresh(); pollLoop(); }, rtConnected ? 2500 : 1000);
}

function resubscribe(sid) {
  if (unsubscribe) unsubscribe();
  unsubscribe = subscribe('screen', [
    { table: 'sessions' },
    { table: 'questions', filter: `session_id=eq.${sid}` },
    { table: 'presenter_state', filter: `session_id=eq.${sid}` },
    { table: 'annotations', filter: `session_id=eq.${sid}` },
    { table: 'session_pulse', filter: `session_id=eq.${sid}` },
  ], refreshSoon, (ok) => { rtConnected = ok; });
}

function apply(d) {
  results = d;
  if (!d?.session) { renderMessage(T.noSession, T.noSessionSub); return; }

  if (d.session.id !== sessionId) {
    sessionId = d.session.id;
    resubscribe(sessionId);
    lastServerPage = null;
    built = { key: null };
  }

  const p = d.presenter || {};
  document.documentElement.dataset.theme = p.theme === 'dark' ? 'dark' : 'light';

  if (p.current_page !== lastServerPage) {
    lastServerPage = p.current_page;
    page = p.current_page;
  }
  const pages = screenPages(d.questions);
  if (!pages.includes(page)) page = 0;
  render();
}

// ---------------------------------------------------------------------------
// Navigation (keyboard, presentation clicker, tabs, operator)
// ---------------------------------------------------------------------------

function navigate(p) {
  if (!results?.session || p === page) return;
  page = p;
  render();
  // If this browser is logged in as operator, keep every screen in sync.
  const pin = storage.get('livepoll:pin');
  if (pin) {
    lastServerPage = p;
    rpc('admin', { p_pin: pin, p_action: 'presenter', p_args: { current_page: p } }).catch(() => {});
  }
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const pages = screenPages(results?.questions);
  if (['ArrowRight', 'PageDown', ' ', 'Spacebar', 'ArrowDown'].includes(e.key)) {
    e.preventDefault(); navigate(stepPage(pages, page, +1));
  } else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(e.key)) {
    e.preventDefault(); navigate(stepPage(pages, page, -1));
  } else if (/^[0-9]$/.test(e.key)) {
    const n = Number(e.key);
    if (pages.includes(n)) navigate(n);
  } else if (e.key === 'f' || e.key === 'F') {
    toggleFullscreen();
  }
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
fsBtn.addEventListener('click', toggleFullscreen);

let idleTimer = null;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
}
['mousemove', 'mousedown', 'touchstart'].forEach((ev) => document.addEventListener(ev, wake, { passive: true }));
wake();

function renderTabs() {
  const qs = (results?.questions || []).filter((q) => q.status !== 'hidden');
  const items = [{ p: 0, label: 'QR' }, ...qs.map((q) => ({ p: q.ord, label: `Question ${q.ord}` }))];
  const sig = items.map((i) => `${i.p}:${i.label}`).join('|') + `#${page}`;
  if (tabsList.dataset.sig === sig) return;
  tabsList.dataset.sig = sig;
  tabsList.innerHTML = items.map((i) => `<button class="tab" role="tab" aria-selected="${i.p === page}" data-p="${i.p}">${i.label}</button>`).join('');
}
tabsList.addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (b) navigate(Number(b.dataset.p));
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderMessage(title, sub) {
  const key = `msg|${title}`;
  if (built.key === key) return;
  built = { key };
  stage.innerHTML = `<section class="page message-page"><h1>${esc(title)}</h1><p>${esc(sub || '')}</p></section>`;
}

function render() {
  renderTabs();
  if (page === 0) renderQr();
  else {
    const q = results.questions.find((x) => x.ord === page);
    if (q) renderResults(q);
    else { page = 0; renderQr(); }
  }
  tickTimer();
}

function renderQr() {
  const url = participantUrl();
  const key = `qr|${url}|${results.session.title}`;
  if (built.key !== key) {
    built = { key };
    stage.innerHTML = `
      <section class="page qr-page">
        <div class="eyebrow">${esc(results.session.title)}</div>
        <h1>${T.scan}</h1>
        <div class="qr-frame">${qrSvg(url)}</div>
        <div class="qr-url">${esc(shortUrl(results.public_url))}</div>
        <div class="qr-joined">${T.joined}: <span class="num" id="joined">0</span></div>
      </section>`;
    built.joined = stage.querySelector('#joined');
    built.joined.dataset.v = '0';
  }
  animateNumber(built.joined, results.connected);
}

function renderResults(q) {
  const p = results.presenter || {};
  const hidden = (p.hidden_question_ids || []).includes(q.id);
  const optSig = q.options.map((o) => `${o.id}:${o.text}`).join('¦');
  const key = `q|${q.id}|${hidden}|${q.text}|${optSig}|${p.small_qr}|${results.session.title}`;
  const multi = q.type === 'multi' && q.max > 1;

  if (built.key !== key) {
    built = { key, qid: q.id, rows: new Map() };
    stage.innerHTML = `
      <section class="page results-page">
        <header class="topbar">
          <div>
            <div class="session-title">${esc(results.session.title)}</div>
            <div class="counters">
              <span class="counter-main">${T.completed}:<span class="num" id="completed">0</span></span>
              <span class="counter-sub">${T.joined}:<span class="num" id="joined">0</span></span>
            </div>
          </div>
          <div class="mini-qr" ${p.small_qr ? '' : 'hidden'}>
            <div class="cap">${T.smallQr}</div>
            <div class="code">${p.small_qr ? qrSvg(participantUrl()) : ''}</div>
          </div>
        </header>
        <div class="qhead">
          <h1>${esc(q.text)}</h1>
          <div class="answered">${T.answered}: <span class="num" id="answered">0</span></div>
        </div>
        ${hidden
          ? `<div class="hidden-panel">${ICON_EYE_OFF}<span>${T.hidden}</span></div>`
          : `<div class="chart" id="chart"></div>${multi ? `<div class="footnote">${T.multiNote}</div>` : ''}`}
      </section>`;
    built.completed = stage.querySelector('#completed');
    built.joinedEl = stage.querySelector('#joined');
    built.answered = stage.querySelector('#answered');
    for (const el of [built.completed, built.joinedEl, built.answered]) el.dataset.v = '0';
    built.chart = stage.querySelector('#chart');

    if (built.chart) {
      // First paint of this question: sort immediately, no animation.
      if (!orders[q.id] || !p.sort_frozen) orders[q.id] = desiredOrder(q);
      lastSortAt[q.id] = Date.now();
      for (const id of orders[q.id]) {
        const o = q.options.find((x) => x.id === id);
        if (!o) continue;
        const row = document.createElement('div');
        row.className = `row${o.pinned_last ? ' pinned' : ''}`;
        row.dataset.id = o.id;
        row.innerHTML = `
          <div class="label">${esc(o.text)}</div>
          <div class="track">
            <div class="bar" style="width:0"></div>
            <div class="meta"><span class="value num"><span class="v">0</span><span class="dot">·</span><span class="pct">0%</span></span></div>
          </div>`;
        built.chart.appendChild(row);
        built.rows.set(o.id, {
          row, bar: row.querySelector('.bar'), v: row.querySelector('.v'), pct: row.querySelector('.pct'),
          meta: row.querySelector('.meta'), tags: new Map(),
        });
        row.querySelector('.v').dataset.v = '0';
        row.querySelector('.pct').dataset.v = '0';
      }
    }
  }

  animateNumber(built.completed, results.completed);
  animateNumber(built.joinedEl, results.connected);
  animateNumber(built.answered, q.answered);
  if (!built.chart) return;

  // Bars, values and tags
  const maxVotes = Math.max(0, ...q.options.map((o) => o.votes));
  const leaders = leaderIds(q);
  for (const o of q.options) {
    const r = built.rows.get(o.id);
    if (!r) continue;
    const w = barWidth(o.votes, maxVotes);
    r.bar.style.width = w > 0 ? `${w}%` : '0.5rem';
    r.row.classList.toggle('leader', leaders.has(o.id) && !o.pinned_last);
    animateNumber(r.v, o.votes);
    animateNumber(r.pct, percent(o.votes, q.answered), (n) => `${n}%`);
    syncTags(r, (results.annotations || []).filter((a) => a.option_id === o.id));
  }

  // Empty state
  let note = built.chart.querySelector('.empty-note');
  if (q.answered === 0 && !note) {
    note = document.createElement('div');
    note.className = 'empty-note';
    note.innerHTML = `<span>${T.waiting}</span><span class="dots"><i></i><i></i><i></i></span>`;
    built.chart.appendChild(note);
  } else if (q.answered > 0 && note) note.remove();

  // Sorting (throttled, animated, can be frozen by the operator)
  const want = desiredOrder(q);
  const have = orders[q.id] || want;
  if (p.sort_frozen || want.join() === have.join()) return;
  const wait = SORT_INTERVAL - (Date.now() - (lastSortAt[q.id] || 0));
  if (wait <= 0) reorder(q.id, want);
  else if (!sortTimer) sortTimer = setTimeout(() => { sortTimer = null; if (results) render(); }, wait + 20);
}

function syncTags(r, list) {
  const ids = new Set(list.map((a) => a.id));
  for (const [id, el] of r.tags) if (!ids.has(id)) { el.remove(); r.tags.delete(id); }
  for (const a of list) {
    if (r.tags.has(a.id)) continue;
    const el = document.createElement('span');
    el.className = 'tag';
    el.textContent = a.label;
    r.meta.appendChild(el);
    r.tags.set(a.id, el);
  }
}

/** FLIP animation: rows glide to their new positions. */
function reorder(qid, order) {
  orders[qid] = order;
  lastSortAt[qid] = Date.now();
  const els = order.map((id) => built.rows.get(id)?.row).filter(Boolean);
  const before = new Map(els.map((el) => [el, el.getBoundingClientRect().top]));
  const note = built.chart.querySelector('.empty-note');
  for (const el of els) built.chart.appendChild(el);
  if (note) built.chart.appendChild(note);
  for (const el of els) {
    const dy = before.get(el) - el.getBoundingClientRect().top;
    if (!dy) continue;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const el of els) {
      el.style.transition = 'transform 0.65s cubic-bezier(0.2, 0.8, 0.2, 1)';
      el.style.transform = '';
    }
  }));
}

/** Smoothly count from the displayed value to the new one (0.4 s). */
function animateNumber(el, to, fmt = (n) => String(n)) {
  if (!el) return;
  const from = Number(el.dataset.v || 0);
  to = Number(to || 0);
  if (from === to && el.textContent !== '') { el.textContent = fmt(to); return; }
  el.dataset.v = String(to);
  cancelAnimationFrame(el._raf);
  const start = performance.now();
  const dur = 420;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(Math.round(from + (to - from) * e));
    if (t < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// Timer overlay
// ---------------------------------------------------------------------------

let prevRemaining = null;
let blinkUntil = 0;

function tickTimer() {
  const p = results?.presenter;
  if (!p || !p.timer_visible || page === 0 || !results?.session) {
    timerEl.hidden = true;
    prevRemaining = null;
    return;
  }
  const rem = timerRemaining(p, offset);
  timerEl.hidden = false;
  timerEl.textContent = formatTimer(rem);
  timerEl.classList.toggle('warn', rem <= 15);
  timerEl.classList.toggle('paused', !p.timer_started_at && rem > 0 && rem < p.timer_duration);
  if (prevRemaining !== null && prevRemaining > 0 && rem <= 0) {
    blinkUntil = Date.now() + 3000;
    timerEl.classList.remove('blink');
    void timerEl.offsetWidth;
    timerEl.classList.add('blink');
  }
  if (Date.now() > blinkUntil) timerEl.classList.remove('blink');
  prevRemaining = rem;
}
setInterval(tickTimer, 200);

function updateOffline() {
  const off = !navigator.onLine || (lastOk && Date.now() - lastOk > 5000) || (!lastOk && results === null && Date.now() - bootAt > 5000);
  offlineEl.hidden = !off;
}
const bootAt = Date.now();
setInterval(updateOffline, 1000);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (!isConfigured()) {
  renderMessage(T.notConfigured, 'Set SUPABASE_URL and SUPABASE_ANON_KEY.');
} else {
  refresh();
  pollLoop();
}
