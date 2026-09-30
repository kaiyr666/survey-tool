// Operator panel.
import { formatTimer, timerRemaining, leaderIds, percent, toCsv, summaryRows, screenPages } from './logic.js';
import { rpc, subscribe, storage, isConfigured } from './api.js';
import { renderResultsPng, download } from './png.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let pin = storage.get('livepoll:pin');
let state = null;     // { companies, sessions, results }
let offset = 0;
let unsubscribe = null;
let subscribedTo = null;

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function call(action, args = {}) {
  let r;
  try {
    r = await rpc('admin', { p_pin: pin, p_action: action, p_args: args });
  } catch (e) {
    toast('No connection — try again', true);
    throw e;
  }
  if (!r?.ok) {
    if (r?.error === 'bad_pin' || r?.error === 'locked') {
      logout(r.error === 'locked' ? `Too many attempts. Try again in ${r.retry_after}s.` : 'Wrong PIN.');
    } else {
      toast(({ confirm_required: 'Type RESET to confirm', pin_too_short: 'PIN is too short', invalid: 'Invalid value' })[r?.error] || 'Action failed', true);
    }
    throw new Error(r?.error || 'failed');
  }
  state = { companies: r.companies, sessions: r.sessions, results: r.results };
  syncClock(r.results);
  render();
  return r;
}

function syncClock(results) {
  if (results?.server_time) offset = Date.parse(results.server_time) - Date.now();
}

async function refreshResults() {
  if (!state) return;
  try {
    const r = await rpc('get_results', {});
    syncClock(r);
    state.results = r;
    render();
  } catch { /* ignore, keep last */ }
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshResults, 400);
}

function ensureSubscription() {
  const sid = state?.results?.session?.id;
  if (!sid || sid === subscribedTo) return;
  subscribedTo = sid;
  if (unsubscribe) unsubscribe();
  unsubscribe = subscribe('admin', [
    { table: 'sessions' },
    { table: 'questions', filter: `session_id=eq.${sid}` },
    { table: 'presenter_state', filter: `session_id=eq.${sid}` },
    { table: 'annotations', filter: `session_id=eq.${sid}` },
    { table: 'session_pulse', filter: `session_id=eq.${sid}` },
  ], refreshSoon);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function showLogin(msg = '') {
  $('#dash').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = msg;
  $('#pin').value = '';
  $('#pin').focus();
}

function logout(msg) {
  pin = null;
  storage.remove('livepoll:pin');
  state = null;
  showLogin(msg);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  pin = $('#pin').value.trim();
  $('#login-error').textContent = '';
  try {
    await call('login');
    storage.set('livepoll:pin', pin);
    $('#login').hidden = true;
    $('#dash').hidden = false;
  } catch { /* message already shown */ }
});
$('#logout').addEventListener('click', () => logout(''));

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const setSeg = (root, value) => root.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(value)));

function render() {
  if (!state) return;
  const R = state.results;
  ensureSubscription();
  if (!R?.session) return;
  const P = R.presenter || {};
  const qs = R.questions || [];

  // Nav
  const live = R.session.mode === 'live';
  $('#mode-badge').textContent = live ? 'LIVE' : 'TEST';
  $('#mode-badge').classList.toggle('live', live);
  $('#session-name').textContent = R.session.name;

  // Stats
  const stat = (k, v, accent) => `<div class="stat ${accent ? 'accent' : ''}"><div class="k">${k}</div><div class="v num">${v}</div></div>`;
  $('#stats').innerHTML = [
    stat('Joined', R.connected),
    stat('Started', R.started),
    ...qs.filter((q) => q.status !== 'hidden').map((q) => stat(`Answered Q${q.ord}`, q.answered)),
    stat('Completed', R.completed, true),
  ].join('');

  // Poll status
  setSeg($('#poll-status'), R.session.status);

  // Questions
  const hiddenIds = P.hidden_question_ids || [];
  const qSig = JSON.stringify(qs.map((q) => [q.id, q.status, q.text, q.answered, hiddenIds.includes(q.id)]));
  if ($('#questions').dataset.sig !== qSig) {
    $('#questions').dataset.sig = qSig;
    $('#questions').innerHTML = qs.map((q) => `
      <div class="q-item">
        <div class="q-num">${q.ord}</div>
        <div>
          <div class="q-text">${esc(q.text)}</div>
          <div class="q-meta">${q.type === 'single' ? 'Single choice' : `Up to ${q.max} options`} · ${q.answered} answered</div>
        </div>
        <div class="q-controls">
          <div class="seg" data-q="${q.id}" data-kind="status">
            <button data-v="open">Open</button><button data-v="closed">Closed</button><button data-v="hidden">Hidden</button>
          </div>
          <button class="btn ${hiddenIds.includes(q.id) ? 'btn-primary' : ''}" data-q="${q.id}" data-kind="reveal">
            ${hiddenIds.includes(q.id) ? 'Show results' : 'Hide results'}</button>
          <button class="btn btn-quiet" data-q="${q.id}" data-kind="png" title="Download PNG of this results page">PNG</button>
        </div>
      </div>`).join('');
    for (const q of qs) setSeg($(`.seg[data-q="${q.id}"]`), q.status);
  }

  // Screen page
  const pages = screenPages(qs);
  const pSig = pages.join(',') + '#' + P.current_page;
  if ($('#screen-page').dataset.sig !== pSig) {
    $('#screen-page').dataset.sig = pSig;
    $('#screen-page').innerHTML = pages.map((p) => `<button data-v="${p}">${p === 0 ? 'QR' : `Q${p}`}</button>`).join('');
    setSeg($('#screen-page'), P.current_page);
  }
  $('#t-smallqr').checked = Boolean(P.small_qr);
  $('#t-freeze').checked = Boolean(P.sort_frozen);
  $('#t-dark').checked = P.theme === 'dark';

  // Timer
  if (document.activeElement !== $('#timer-duration')) $('#timer-duration').value = P.timer_duration;
  tickTimer();

  // Tags
  renderTags(R);

  // Sessions
  $('#sessions').innerHTML = (state.sessions || []).map((s) => `
    <li class="${s.active ? 'active' : ''}">
      <span class="badge ${s.mode === 'live' ? 'live' : ''}">${s.mode.toUpperCase()}</span>
      <span class="name">${esc(s.name)}</span>
      <span class="when">${new Date(s.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
      ${s.active ? '<span class="small muted">Active</span>' : `<button class="btn btn-quiet" data-activate="${s.id}">Activate</button>`}
    </li>`).join('');

  renderMini(R);
}

function renderTags(R) {
  const qs = (R.questions || []).filter((q) => q.status !== 'hidden');
  const sel = $('#tag-option');
  const optSig = JSON.stringify(qs.map((q) => [q.id, q.options.map((o) => o.id + o.text)]));
  if (sel.dataset.sig !== optSig) {
    const prev = sel.value;
    sel.dataset.sig = optSig;
    sel.innerHTML = qs.map((q) => `<optgroup label="Q${q.ord}. ${esc(q.text)}">${
      q.options.map((o) => `<option value="${o.id}">${esc(o.text)}</option>`).join('')}</optgroup>`).join('');
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  const compSig = JSON.stringify(state.companies);
  if ($('#tag-companies').dataset.sig !== compSig) {
    $('#tag-companies').dataset.sig = compSig;
    $('#tag-companies').innerHTML = (state.companies || []).map((c) => `<button class="chip" data-company="${esc(c)}">+ ${esc(c)}</button>`).join('');
  }
  const optText = new Map();
  for (const q of R.questions || []) for (const o of q.options) optText.set(o.id, `Q${q.ord} · ${o.text}`);
  const byOpt = new Map();
  for (const a of R.annotations || []) {
    if (!byOpt.has(a.option_id)) byOpt.set(a.option_id, []);
    byOpt.get(a.option_id).push(a);
  }
  $('#tag-list').innerHTML = byOpt.size
    ? [...byOpt].map(([oid, list]) => `<div class="tag-row"><span class="opt">${esc(optText.get(oid) || '')}</span>${
      list.map((a) => `<span class="pill">${esc(a.label)}<button data-remove-tag="${a.id}" aria-label="Remove ${esc(a.label)}">×</button></span>`).join('')}</div>`).join('')
    : '<span class="muted small">No tags yet.</span>';
}

function renderMini(R) {
  $('#mini-results').innerHTML = (R.questions || []).map((q) => {
    const leaders = leaderIds(q);
    const max = Math.max(1, ...q.options.map((o) => o.votes));
    return `<div class="mini-q">
      <h3>Q${q.ord}. ${esc(q.text)}</h3>
      <div class="sub"><span>Answered: ${q.answered}</span><span>${q.status}</span></div>
      ${q.options.map((o) => `
        <div class="mini-row ${leaders.has(o.id) && !o.pinned_last ? 'lead' : ''}">
          <div><div class="lbl" title="${esc(o.text)}">${esc(o.text)}</div><div class="bar"><i style="width:${(o.votes / max) * 100}%"></i></div></div>
          <div class="val">${o.votes} · ${percent(o.votes, q.answered)}%</div>
        </div>`).join('')}
    </div>`;
  }).join('');
}

function tickTimer() {
  const P = state?.results?.presenter;
  if (!P) return;
  const rem = timerRemaining(P, offset);
  $('#timer-display').textContent = formatTimer(rem);
  $('#timer-display').classList.toggle('warn', rem <= 15);
  $('#timer-state').textContent = !P.timer_visible ? 'Hidden on screen' : P.timer_started_at ? 'Running' : 'Paused';
}
setInterval(tickTimer, 250);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
const guard = (fn) => async (...a) => { try { await fn(...a); } catch { /* toast shown */ } };

$('#poll-status').addEventListener('click', guard(async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.v === 'closed' && !confirm('Close the whole poll? Phones will show “The poll has ended”.')) return;
  await call('poll_status', { status: b.dataset.v });
  toast(`Poll: ${b.textContent}`);
}));

$('#questions').addEventListener('click', guard(async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const holder = b.closest('[data-q]');
  const qid = Number(holder.dataset.q);
  const kind = holder.dataset.kind;
  if (kind === 'status') {
    await call('question_status', { question_id: qid, status: b.dataset.v });
  } else if (kind === 'reveal') {
    const hidden = (state.results.presenter.hidden_question_ids || []).includes(qid);
    await call('results_visibility', { question_id: qid, hidden: !hidden });
  } else if (kind === 'png') {
    const q = state.results.questions.find((x) => x.id === qid);
    const blob = await renderResultsPng(state.results, q, state.results.presenter.theme);
    download(blob, `results-q${q.ord}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`);
  }
}));

$('#screen-page').addEventListener('click', guard(async (e) => {
  const b = e.target.closest('button');
  if (b) await call('presenter', { current_page: Number(b.dataset.v) });
}));
$('#t-smallqr').addEventListener('change', guard(async (e) => call('presenter', { small_qr: e.target.checked })));
$('#t-freeze').addEventListener('change', guard(async (e) => call('presenter', { sort_frozen: e.target.checked })));
$('#t-dark').addEventListener('change', guard(async (e) => call('presenter', { theme: e.target.checked ? 'dark' : 'light' })));

$('#timer-start').addEventListener('click', guard(() => call('timer', { op: 'start' })));
$('#timer-pause').addEventListener('click', guard(() => call('timer', { op: 'pause' })));
$('#timer-reset').addEventListener('click', guard(() => call('timer', { op: 'reset' })));
$('#timer-hide').addEventListener('click', guard(() => call('timer', { op: 'hide' })));
$('#timer-duration-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  await call('timer', { op: 'duration', seconds: Number($('#timer-duration').value) || 90 });
  toast('Timer duration updated');
}));

$('#tag-companies').addEventListener('click', guard(async (e) => {
  const b = e.target.closest('[data-company]');
  if (!b) return;
  await call('annotation_add', { option_id: Number($('#tag-option').value), label: b.dataset.company });
}));
$('#tag-list').addEventListener('click', guard(async (e) => {
  const b = e.target.closest('[data-remove-tag]');
  if (b) await call('annotation_remove', { id: Number(b.dataset.removeTag) });
}));
$('#tags-clear').addEventListener('click', guard(async () => {
  if (confirm('Remove all company tags?')) await call('annotation_clear');
}));

$('#new-test').addEventListener('click', guard(async () => {
  const name = prompt('Name of the new TEST session:', `Rehearsal ${new Date().toLocaleDateString()}`);
  if (name === null) return;
  await call('new_session', { mode: 'test', name });
  toast('New test session is active');
}));
$('#new-live').addEventListener('click', guard(async () => {
  const name = prompt('Name of the new LIVE session (data will start from zero):', 'Live session');
  if (name === null) return;
  await call('new_session', { mode: 'live', name });
  toast('New LIVE session is active');
}));
$('#sessions').addEventListener('click', guard(async (e) => {
  const b = e.target.closest('[data-activate]');
  if (b && confirm('Make this session active? Phones and screens will switch to it.')) {
    await call('activate_session', { session_id: b.dataset.activate });
  }
}));

$('#reset-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  await call('reset', { confirm: $('#reset-confirm').value.trim() });
  $('#reset-confirm').value = '';
  toast('Session data has been reset');
}));

$('#pin-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const np = $('#new-pin').value;
  await call('change_pin', { new_pin: np });
  pin = np;
  storage.set('livepoll:pin', pin);
  $('#new-pin').value = '';
  toast('PIN changed');
}));

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
function saveCsv(rows, name) {
  download(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), name);
}
$('#export-summary').addEventListener('click', guard(async () => {
  await refreshResults();
  saveCsv(summaryRows(state.results), `summary-${stamp()}.csv`);
}));
$('#export-responses').addEventListener('click', guard(async () => {
  const r = await rpc('admin', { p_pin: pin, p_action: 'export_responses', p_args: {} });
  if (!r?.ok) { toast('Export failed', true); return; }
  const rows = [['Anonymous ID', 'Question #', 'Question', 'Selected options', 'Answered at', 'Updated at']];
  for (const x of r.rows) rows.push([x.participant_id, x.question_ord, x.question, (x.options || []).join(' | '), x.created_at, x.updated_at]);
  saveCsv(rows, `responses-${stamp()}.csv`);
}));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  if (!isConfigured()) { showLogin('Not configured: set SUPABASE_URL and SUPABASE_ANON_KEY.'); return; }
  if (!pin) { showLogin(); return; }
  try {
    await call('state');
    $('#login').hidden = true;
    $('#dash').hidden = false;
  } catch {
    if (!state) showLogin();
  }
}
boot();

// Safety net polling (realtime is the fast path)
setInterval(() => { if (state && document.visibilityState === 'visible') refreshResults(); }, 3000);
setInterval(() => { if (state && pin && document.visibilityState === 'visible') call('state').catch(() => {}); }, 30000);
