# Deploy Live Poll for free (≈10 minutes)

The app has two parts:

| Part | What it is | Free host |
| --- | --- | --- |
| **Database + realtime** | Postgres tables, secure functions and live change feeds | **Supabase** (Free plan) |
| **Website** | Static HTML/CSS/JS (no server code) | **Vercel** (Hobby) *or* **Netlify** (Free) *or* Cloudflare Pages |

You need a GitHub account (the code is in `kaiyr666/survey-tool`), a Supabase account and a Vercel or Netlify account. You can sign up for both with GitHub, and neither asks for a credit card.

---

## Step 1: Create the Supabase project (database)

1. Go to <https://supabase.com/dashboard> → **New project**.
   - Name: `live-poll` · Region: pick the one closest to your audience (e.g. *Frankfurt* for Europe/Central Asia).
   - Set a database password (store it, you rarely need it).
2. Wait ~1 minute until the project is ready.
3. Open **SQL Editor** → **New query**. Paste the whole content of
   [`supabase/migrations/20260930000001_schema.sql`](../supabase/migrations/20260930000001_schema.sql) → **Run**.
4. New query again: paste [`supabase/migrations/20260930000002_config.sql`](../supabase/migrations/20260930000002_config.sql) → **Run**.
   This inserts the questions, the company list and a first *test* session.
5. **Change the operator PIN** (the default is `2468`). Run this in a new query:
   ```sql
   select set_admin_pin('choose-a-long-pin');
   ```
6. Open **Project Settings → API** (or **Connect → App frameworks**) and copy:
   - **Project URL**: `https://xxxx.supabase.co`
   - **anon / publishable key**. This key is designed to be public. Row-level security and the server functions protect the data.

> **CLI alternative:** `npx supabase login && npx supabase link --project-ref xxxx && npx supabase db push`

Realtime is enabled automatically by the migration (it adds the tables to the `supabase_realtime` publication).

---

## Step 2a: Deploy the website on Vercel (recommended)

1. <https://vercel.com/new> → **Import** the GitHub repository `survey-tool`.
2. Framework preset: **Other**. The repo's `vercel.json` already sets the build command and output folder.
3. **Environment Variables:**
   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | `https://xxxx.supabase.co` |
   | `SUPABASE_ANON_KEY` | your anon / publishable key |
   | `DEMO_PIN` | *(optional)* shows the operator PIN on `/demo`, for public test rounds only |
   | `PUBLIC_URL` | *(optional)* short link printed under the QR code, e.g. `poll.example.com` |
4. **Deploy**. After about 30 seconds you get `https://survey-tool-xxxx.vercel.app`.

Every `git push` to `main` redeploys automatically.

## Step 2b: Or deploy on Netlify

1. <https://app.netlify.com/start> → **Import from Git** → pick `survey-tool`.
2. Build settings are read from `netlify.toml` (build: `node scripts/build-config.mjs`, publish: `public`).
3. **Site configuration → Environment variables:** add the same variables as above.
4. **Deploy site** → `https://your-name.netlify.app`. You can rename it under *Site configuration → Change site name*.

## Step 2c: Or Cloudflare Pages

**Workers & Pages → Create → Pages → Connect to Git.** Build command `node scripts/build-config.mjs`, output directory `public`, then add the same environment variables. Pretty URLs (`/screen`) work out of the box.

---

## Step 3: Try it

| Page | URL | Who |
| --- | --- | --- |
| Participant (QR target) | `https://…/` | phones |
| Presentation screen | `https://…/screen` | laptop connected to the projector |
| Operator panel | `https://…/admin` | operator (PIN) |
| Demo / landing page | `https://…/demo` | share this with public testers |

1. Open `/admin` → enter the PIN → set the poll to **Open**.
2. Open `/screen` on a laptop and press **F** for full screen. Use **→ / ←**, **Space**, **Page Up/Down** or a presentation clicker; **0–3** jump directly to a page.
3. Scan the QR code with a phone and answer. The bars move within a second.

### Custom short domain (optional)

- **Vercel:** *Project → Settings → Domains → Add* (e.g. `poll.yourdomain.com`), then add the CNAME record it shows at your DNS provider.
- **Netlify:** *Domain management → Add a domain*.
- Set `PUBLIC_URL=poll.yourdomain.com` so the screen prints the short link, then redeploy.

---

## Free-tier limits worth knowing

| Service | Limit | Impact on this app |
| --- | --- | --- |
| Supabase Free | 500 MB database, 200 concurrent realtime connections, 2 M realtime messages/month, **project pauses after 7 days without activity** | A 200-person session uses < 1 MB. Phones fall back to polling when realtime is full. **Open the admin panel the day before an event** so the project is awake, or restore it from the dashboard. |
| Vercel Hobby | 100 GB bandwidth/month, personal/non-commercial use | The phone page is ~60 KB compressed, so 200 people use about 12 MB. For commercial use, prefer Netlify/Cloudflare or Vercel Pro. |
| Netlify Free | 100 GB bandwidth, 300 build minutes | More than enough. |
| Cloudflare Pages | Unlimited bandwidth | More than enough. |

## Before a real event

- [ ] Change the operator PIN (`select set_admin_pin('…')`) and **do not** set `DEMO_PIN`.
- [ ] Rehearse in a **test** session, then click **New live session** in the admin panel before the event.
- [ ] Check the projector (light vs dark theme) and the clicker.
- [ ] Keep a PDF of the QR page as plan B (browser → Print → Save as PDF on `/screen`).

## Editing questions without redeploying

- Current session: Supabase → **Table Editor** → `questions` / `options` (edit text). Phones and screens pick up the change on their next refresh.
- Future sessions: edit `app_config.template` (JSON). **New test/live session** in the admin panel copies it.
- Company tag list: `app_config.companies`.
- Extra question later (e.g. a 4th question in Act 3): add it to the current session with `status = 'hidden'` (and `counts_for_completion = false` if "Completed" should keep meaning the first three questions), then click **Open** next to it in the admin panel when it's time. Phones that already finished get taken to it automatically.
