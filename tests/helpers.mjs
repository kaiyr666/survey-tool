// Shared helpers for DB, E2E and load tests (talks to Supabase over plain HTTP).
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

for (const f of ['.env.test', '.env.local']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

export const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
export const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
export const PIN = process.env.ADMIN_PIN || '2468';
export const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

export async function rpc(name, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_KEY } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function admin(action, args = {}, pin = PIN) {
  return rpc('admin', { p_pin: pin, p_action: action, p_args: args });
}

/** Creates a fresh active test session (isolates each test file) and opens it. */
export async function freshSession({ open = true, name = 'automated test' } = {}) {
  const r = await admin('new_session', { mode: 'test', name });
  if (!r.ok) throw new Error(`new_session failed: ${JSON.stringify(r)}`);
  if (open) await admin('poll_status', { status: 'open' });
  const results = await rpc('get_results');
  return { session: results.session, questions: results.questions, results };
}

export const pid = () => randomUUID();

export const opt = (q, i) => q.options[i].id;
