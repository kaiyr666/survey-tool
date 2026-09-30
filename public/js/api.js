// Thin data layer: RPC calls over plain fetch (tiny, works everywhere) and an optional
// Realtime subscription that lazy-loads supabase-js only when needed.

const CFG = window.LIVEPOLL_CONFIG || {};

export const config = {
  url: (CFG.supabaseUrl || '').replace(/\/$/, ''),
  key: CFG.supabaseKey || '',
  publicUrl: CFG.publicUrl || '',
};

export const isConfigured = () => Boolean(config.url && config.key);

export class NetworkError extends Error {}

export async function rpc(name, args = {}, { timeout = 8000 } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
  let res;
  try {
    res = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: config.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: ctrl?.signal,
      cache: 'no-store',
    });
  } catch (e) {
    throw new NetworkError(e?.message || 'network');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.status >= 500 || res.status === 429 || res.status === 408) throw new NetworkError(`HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
  return body;
}

// ---------------------------------------------------------------------------
// Realtime (optional — every page also polls, so this is a latency optimisation)
// ---------------------------------------------------------------------------

let clientPromise = null;

function loadClient() {
  if (clientPromise) return clientPromise;
  clientPromise = new Promise((resolve, reject) => {
    if (window.supabase?.createClient) return resolve(window.supabase);
    const s = document.createElement('script');
    s.src = '/vendor/supabase.js';
    s.async = true;
    s.onload = () => resolve(window.supabase);
    s.onerror = () => { clientPromise = null; reject(new Error('realtime unavailable')); };
    document.head.appendChild(s);
  }).then((lib) => lib.createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 20 } },
  }));
  return clientPromise;
}

/**
 * Subscribe to table changes. `specs` = [{ table, filter? }].
 * Returns an unsubscribe function. `onStatus(true|false)` reports connectivity.
 */
export function subscribe(name, specs, onChange, onStatus = () => {}) {
  let channel = null;
  let closed = false;
  loadClient()
    .then((client) => {
      if (closed) return;
      channel = client.channel(`${name}-${Math.random().toString(36).slice(2, 8)}`);
      for (const spec of specs) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table: spec.table, ...(spec.filter ? { filter: spec.filter } : {}) },
          (payload) => onChange(spec.table, payload));
      }
      channel.subscribe((status) => onStatus(status === 'SUBSCRIBED'));
    })
    .catch(() => onStatus(false));
  return () => {
    closed = true;
    if (channel) channel.unsubscribe();
  };
}

// ---------------------------------------------------------------------------
// Small helpers shared across pages
// ---------------------------------------------------------------------------

export const storage = (() => {
  const mem = {};
  let ls = null;
  try {
    ls = window.localStorage;
    ls.setItem('__t', '1');
    ls.removeItem('__t');
  } catch { ls = null; }
  return {
    get(k, fallback = null) {
      try {
        const v = ls ? ls.getItem(k) : mem[k];
        return v == null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(k, v) {
      const s = JSON.stringify(v);
      try { if (ls) ls.setItem(k, s); else mem[k] = s; } catch { mem[k] = s; }
    },
    remove(k) {
      try { if (ls) ls.removeItem(k); } catch { /* ignore */ }
      delete mem[k];
    },
  };
})();

/** Participant-facing link the QR code points to. */
export function participantUrl() {
  if (config.publicUrl) return /^https?:\/\//.test(config.publicUrl) ? config.publicUrl : `https://${config.publicUrl}`;
  return `${location.origin}/`;
}

/** Short, human-readable version of the participant link for under the QR code. */
export function shortUrl(override) {
  const u = override || config.publicUrl || participantUrl();
  return u.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
