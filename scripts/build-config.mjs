// Writes public/config.js from environment variables (used by Vercel/Netlify builds and locally).
//   SUPABASE_URL       https://xxxx.supabase.co
//   SUPABASE_ANON_KEY  the project's anon / publishable key (safe to expose; RLS protects data)
//   PUBLIC_URL         optional short link printed under the QR code (e.g. poll.example.com)
//   DEMO_PIN           optional operator PIN to show on /demo for public tests
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency) for local development.
for (const f of ['.env.local', '.env']) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const env = process.env;
const cfg = {
  supabaseUrl: env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '',
  supabaseKey: env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
  publicUrl: env.PUBLIC_URL || '',
  demoPin: env.DEMO_PIN || '',   // optional: shown on /demo so public testers can try the operator panel
};

if (!cfg.supabaseUrl || !cfg.supabaseKey) {
  console.warn('[build-config] SUPABASE_URL / SUPABASE_ANON_KEY are not set — the app will show "not configured".');
}

writeFileSync(join(root, 'public', 'config.js'), `window.LIVEPOLL_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);
console.log(`[build-config] wrote public/config.js (${cfg.supabaseUrl || 'no url'})`);
