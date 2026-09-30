# Live Poll

Anonymous live audience polling for conferences and panel sessions, in the spirit of Mentimeter, fully under your control.

- **Phones** scan a QR code and answer three quick questions, one per screen. No app, no sign-up, no cookies banner.
- **The big screen** shows the QR code, live counters and fully labelled horizontal bar charts that update in under a second.
- **The operator** opens and closes questions, drives the screen remotely, reveals results, adds company tags, runs a speaker timer, and exports CSV/PNG.

Stack: **Supabase** (Postgres, row-level security, Realtime) and a **static site** (vanilla JS, no framework, no build step) that can be hosted free on Vercel, Netlify or Cloudflare Pages.

👉 **Deploying:** see [docs/DEPLOY.md](docs/DEPLOY.md) (about 10 minutes, free tier).

---

## Pages

| URL | Purpose |
| --- | --- |
| `/` | Participant page (QR target), phone-first, < 300 KB |
| `/screen` | Presentation screen (1920×1080; scales to 720p and 4K) |
| `/admin` | Operator panel (PIN-protected) |
| `/demo` | Landing page for public testers |

### Presentation screen shortcuts

| Key | Action |
| --- | --- |
| `→` `Page Down` `Space` | next page |
| `←` `Page Up` | previous page |
| `0`–`3` | QR / question 1–3 |
| `F` | full screen (cursor hides when idle) |

If this browser is logged in to `/admin`, clicker navigation is synced to every connected screen. Reloading the screen opens the page the operator selected.

## How it works

```
 phone ──fetch──► submit_answer()  ─┐             ┌─► get_results()  ◄── screen / admin (throttled ≤ 2/s)
                  participant_sync()│  Postgres   │
                                    ├─ triggers ──┤
 admin ──fetch──► admin(pin, …)   ──┘             └─► Realtime: session_pulse, presenter_state,
                                                      questions, annotations  ──► screen, phones
```

- All writes go through `SECURITY DEFINER` functions that validate every rule on the server: min/max choices, the exclusive option, open/closed states, and one answer per device per question (upsert, never a duplicate).
- Raw responses and participants are **not readable** through the public API. Only aggregates are exposed.
- Operator actions require the PIN (bcrypt hash, with a 30-second lockout after 5 wrong attempts).
- No personal data and no IP addresses are stored. The device ID is a random UUID kept in the browser.
- Every page also polls as a safety net, so the app keeps working if WebSockets are blocked.

### Spec coverage

| Requirement | Where |
| --- | --- |
| Up to 2 choices, single choice, exclusive "Not using it yet" pinned last | `public/js/logic.js`, `submit_answer()` |
| Per-participant shuffle (Q1, Q3), fixed scale order (Q2) | `participantOrder()` |
| Answer sent on every "Next"; changes update instead of duplicating | `participant.js`, `unique(participant_id, question_id)` |
| Offline: saved on device, retried after 2 / 4 / 8 s | `participant.js` (`RETRY_DELAYS`) |
| Resume where you left off; finished → thank-you page | localStorage + `participant_sync()` |
| Waiting screen, question closed, poll closed | `participant.js` |
| Screen: QR ≥ 45% height (level H), live "Joined" / "Completed" / "Answered" | `screen.js` |
| Bars: full labels, "42 · 28%", % of respondents, zero bars shown, leader highlighted, ≤ 85% width | `screen.js`, `logic.js` |
| Re-sort at most every 4 s with animated movement; freeze option | `screen.js` (`reorder`) |
| Company tags, timer (red at 15 s, blinks at 0:00), hide/show results, dark theme, small QR | `screen.js`, `admin.js` |
| Test/live sessions, reset with "RESET", CSV exports, PNG snapshot | `admin.js`, `png.js` |
| Hidden 4th question that appears later, even for people who finished | `questions.status = 'hidden'` |
| Content stored in the database, not in page code | `app_config.template`, `questions`, `options` |

## Local development

Requirements: Node 20+, Docker (for the local Supabase).

```bash
npm install
npm run db:start                    # local Supabase on :54321 (applies migrations)
cp .env.example .env.local          # set SUPABASE_ANON_KEY (see `npx supabase status`)
npm run dev                         # http://localhost:5173  (/screen, /admin, /demo)
```

Default operator PIN: **2468**.

## Tests

| Command | What |
| --- | --- |
| `npm test` | Unit tests: selection rules, percentages, ordering, timer, CSV (16 tests) |
| `npm run test:db` | API/security integration tests against Supabase: validation, dedupe, privacy, operator actions, lockout (18 tests) |
| `npm run test:e2e` | Playwright end-to-end: full phone journey, resume, offline retry, waiting/closed states, screen keyboard nav, live latency, operator panel, 720p/4K layout (15 tests) |
| `npm run test:load` | 200 participants answering all questions within 60 s; checks no lost answers, screen lag ≤ 2 s, screen == export |

Latest local run: all suites green. The load test ran 200 participants and 600 answers with 0 errors; submit latency was 11 ms at p95, and the screen matched the export exactly. In the E2E test, the time from tap to screen was 885 ms.

CI (`.github/workflows/ci.yml`) runs every suite on each push, using a throwaway local Supabase.

## Project layout

```
public/              static site (deployed as-is)
  index.html         participant page       js/participant.js  css/participant.css
  screen.html        presentation screen    js/screen.js       css/screen.css
  admin.html         operator panel         js/admin.js        css/admin.css
  demo.html          landing page           js/demo.js         css/demo.css
  js/logic.js        pure, unit-tested rules shared by all pages
  js/api.js          fetch-based RPC + lazy Realtime client
  vendor/            supabase-js (UMD), qrcode-generator
supabase/migrations  schema, RLS, functions, seed content
scripts/             build-config (env → public/config.js), dev server
tests/               unit, db, e2e, load
```

## License

MIT
