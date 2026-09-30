// Pure, framework-free logic shared by the participant page, the presentation
// screen and the operator panel. No DOM access here — everything is unit-tested.

/** Toggle an option according to the question's selection rules. Returns a new array. */
export function toggleOption(question, selected, optionId) {
  const opts = question.options || [];
  const option = opts.find((o) => o.id === optionId);
  if (!option) return selected.slice();

  if (question.type === 'single' || question.max === 1) return [optionId];

  if (selected.includes(optionId)) return selected.filter((id) => id !== optionId);

  // Exclusive option ("Not using it yet"): selecting it clears everything else.
  if (option.exclusive) return [optionId];

  // Selecting a regular option clears any exclusive option.
  const exclusiveIds = new Set(opts.filter((o) => o.exclusive).map((o) => o.id));
  const next = selected.filter((id) => !exclusiveIds.has(id));
  if (next.length >= question.max) return next; // limit reached: the tap is ignored
  return [...next, optionId];
}

/** An option card is inactive when the max is reached and it is not one of the selected. */
export function isOptionMuted(question, selected, option) {
  if (question.type === 'single' || question.max === 1) return false;
  if (selected.includes(option.id)) return false;
  const opts = question.options || [];
  const exclusiveSelected = selected.some((id) => opts.find((o) => o.id === id)?.exclusive);
  if (exclusiveSelected) return true; // visually blocked; tapping still switches (clears exclusive)
  return selected.length >= question.max;
}

/** Whether tapping a muted option is allowed to change the selection. */
export function isOptionLocked(question, selected, option) {
  if (!isOptionMuted(question, selected, option)) return false;
  const opts = question.options || [];
  const exclusiveSelected = selected.some((id) => opts.find((o) => o.id === id)?.exclusive);
  return !exclusiveSelected;
}

export function canSubmit(question, selected) {
  return selected.length >= (question.min || 1) && selected.length <= (question.max || 1);
}

export function hintText(question, selected) {
  if (question.type === 'multi' && question.max > 1 && selected.length >= question.max) {
    return `Selected ${question.max} of ${question.max}`;
  }
  return question.hint || (question.type === 'single' ? 'Choose one option' : `Choose up to ${question.max} options`);
}

/** Fisher–Yates shuffle with an injectable RNG (for deterministic tests). */
export function shuffle(list, rng = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Per-participant option order. Shuffled once (if the question allows it), then kept.
 * `saved` is a previously stored order (array of ids) — kept as long as it is still valid.
 * Pinned options always go last.
 */
export function participantOrder(question, saved, rng = Math.random) {
  const opts = (question.options || []).slice().sort((a, b) => a.ord - b.ord);
  const pinned = opts.filter((o) => o.pinned_last).map((o) => o.id);
  const regular = opts.filter((o) => !o.pinned_last).map((o) => o.id);
  let order;
  if (Array.isArray(saved) && saved.length) {
    const known = saved.filter((id) => regular.includes(id));
    const added = regular.filter((id) => !known.includes(id));
    order = [...known, ...added];
  } else {
    order = question.shuffle ? shuffle(regular, rng) : regular;
  }
  return [...order, ...pinned];
}

export function percent(votes, answered) {
  if (!answered) return 0;
  return Math.round((votes / answered) * 100);
}

export function formatValue(votes, answered) {
  return `${votes} · ${percent(votes, answered)}%`;
}

/**
 * Desired display order for the results chart:
 *  - single choice: fixed scale order
 *  - multi choice: by votes desc, ties keep configured order, pinned option always last
 */
export function desiredOrder(question) {
  const opts = (question.options || []).slice().sort((a, b) => a.ord - b.ord);
  if (question.type === 'single') return opts.map((o) => o.id);
  const pinned = opts.filter((o) => o.pinned_last);
  const regular = opts.filter((o) => !o.pinned_last);
  regular.sort((a, b) => (b.votes || 0) - (a.votes || 0) || a.ord - b.ord);
  return [...regular, ...pinned].map((o) => o.id);
}

/** Id of the leading option (highlighted) or null if there are no votes / a pinned-only lead. */
export function leaderIds(question) {
  const regular = (question.options || []).filter((o) => !o.pinned_last);
  const max = Math.max(0, ...regular.map((o) => o.votes || 0));
  if (max === 0) return new Set();
  return new Set(regular.filter((o) => (o.votes || 0) === max).map((o) => o.id));
}

/**
 * Bar width as a % of the track. The longest bar takes MAX_BAR of the track so the value
 * label always fits next to it. Zero votes still render as a thin sliver.
 */
export const MAX_BAR = 72;
export function barWidth(votes, maxVotes) {
  if (!maxVotes || !votes) return 0;
  return (votes / maxVotes) * MAX_BAR;
}

/** Seconds left on the operator timer, using the server clock offset (serverNow - localNow). */
export function timerRemaining(presenter, offsetMs = 0, nowMs = Date.now()) {
  if (!presenter) return 0;
  const base = Number(presenter.timer_remaining ?? presenter.timer_duration ?? 0);
  if (!presenter.timer_started_at) return Math.max(0, base);
  const elapsed = (nowMs + offsetMs - Date.parse(presenter.timer_started_at)) / 1000;
  return Math.max(0, base - elapsed);
}

export function formatTimer(seconds) {
  const s = Math.max(0, Math.ceil(seconds - 1e-9));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Pages of the presentation screen: 0 = QR, then one per visible question (by ord). */
export function screenPages(questions) {
  return [0, ...(questions || []).filter((q) => q.status !== 'hidden').map((q) => q.ord)];
}

export function stepPage(pages, current, delta) {
  const i = pages.indexOf(current);
  if (i === -1) return pages[0];
  return pages[Math.min(pages.length - 1, Math.max(0, i + delta))];
}

/** RFC-4180 CSV with a UTF-8 BOM so Excel opens it correctly. */
export function toCsv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

/** Summary table rows for CSV export — identical math to the screen. */
export function summaryRows(results) {
  const rows = [['Question #', 'Question', 'Option', 'Votes', 'Percent', 'Answered']];
  for (const q of results?.questions || []) {
    for (const o of (q.options || []).slice().sort((a, b) => a.ord - b.ord)) {
      rows.push([q.ord, q.text, o.text, o.votes, `${percent(o.votes, q.answered)}%`, q.answered]);
    }
  }
  return rows;
}

/** RFC 4122 v4 UUID; crypto.randomUUID is missing on iOS < 15.4. */
export function uuid(cryptoObj = globalThis.crypto) {
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  const b = new Uint8Array(16);
  cryptoObj.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Retry delays for failed submissions (spec: 3 attempts at 2, 4 and 8 seconds). */
export const RETRY_DELAYS = [2000, 4000, 8000];
