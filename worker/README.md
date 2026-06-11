# wassell-deck-worker

Always-on Node worker that drains the Postgres-backed `deck_jobs` queue
and runs Anthropic Skills + code_execution to build Wassel-branded
`.pptx` files. Replaces the Vercel Edge function whose 300s hard cap
was killing real generations.

**Also drains the image-generation queue (Image Chats v2, 2026-06-08).** The
same process runs a SECOND independent poll loop over `generation_jobs`
(`kind='image'`): claim → fal.ai (Nano Banana 2 / GPT Image 2) → re-host to
`marketing-assets` → fill the assistant message in `records.data.messages`. It's
the per-message twin of the deck pipeline (one job per chat message, concurrent,
non-blocking). Separate loop so 30s–5min image turns don't head-of-line-block
3–12min deck jobs. See `src/runImageJob.ts` and `src/index.ts` (`imagePollLoop`),
and CLAUDE.md → "Generation jobs pipeline (image chats)". **This adds one new
required secret: `FAL_KEY`** (see step 4). Image writes to the shared `messages`
array are safe at ANY machine count via optimistic concurrency (per-write version
check + retry — see the CLAUDE.md hard rules), so the app's existing multi-machine
setup (5 machines in `bom`) hosts image jobs without clobbering.

## What this fixes

The old flow: browser POSTs to `/api/generate-deck` (Vercel Edge),
which holds an SSE stream open for the entire Anthropic call. Edge has
a **300s hard timeout on Vercel Pro**, and any deck that took longer
got killed mid-flight with no chance to write a final state — UI was
stuck on a spinner indefinitely.

The new flow:

```
Browser ──POST /api/generate-deck──▶ Vercel Edge (≤1s)
                                       │
                                       └─ INSERT deck_jobs (status='pending')
                                       └─ POST  https://<worker>/wake  (fire-and-forget)
                                       └─ return 202 { job_id }

Fly.io worker (always-on, polls every 3s) ──claim via SKIP LOCKED──▶
   runs Anthropic Skills + code_execution (3-12 min, no timeout)
   writes status / phase updates to records.data
        ─────────────────▶ Supabase Realtime ─────────────────▶ Browser
   uploads .pptx to wassel-decks bucket
   writes status='ready', file_url, file_path, filename
```

No HTTP request is held open. The browser observes the record via
Supabase Realtime (already wired in the SPA's appStore). A pg-side
watchdog (`public.deck_jobs_watchdog()`, called every 5 min by the
worker itself since pg_cron isn't enabled on this Supabase project)
flips any `running` job older than 20 min to `failed` so the UI never
gets stuck on a spinner even if the worker crashes.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Main entry. TWO concurrent poll loops (decks + images) + `/healthz` + `/wake` HTTP server + watchdog tickers + graceful shutdown. |
| `src/runDeckJob.ts` | The deck generation pipeline (ported from the old `api/generate-deck.ts` body). Anthropic call, base64 extraction, Supabase Storage upload, signed URL, record update. |
| `src/runImageJob.ts` | The per-message image pipeline (Image Chats v2). fal.ai call, output re-host to `marketing-assets`, per-message fill with optimistic concurrency. |
| `src/imageGen.ts` | **COPY of `api/_lib/imageGen.ts`** (the worker can't import from `api/`). fal.ai adapter — keep the chat functions in sync with the original. |
| `src/env.ts` | Strict env loader. Fails fast at startup if anything required is missing (now incl. `FAL_KEY`). |
| `Dockerfile` | Multi-stage Node 22 alpine. Builds TS in stage 1, ships JS-only image in stage 2. |
| `fly.toml` | Fly.io app config — Mumbai region (matches Supabase ap-south-1), always-on, single 512 MB VM. |

## One-time setup

### 1. Install the `fly` CLI

```powershell
# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex

# macOS / Linux
curl -L https://fly.io/install.sh | sh
```

Sign in: `fly auth login` (opens a browser).

### 2. Apply the migration

The `deck_jobs` table + RPCs + watchdog function. From the repo root:

```powershell
# Already applied to wassell-prod on 2026-05-17. For a fresh project,
# run via the Supabase CLI or the SQL editor in the dashboard:
psql "$env:DATABASE_URL" -f supabase/migrations/2026-05-17_deck_jobs_queue.sql
```

### 3. Launch the Fly app

From the `worker/` directory:

```powershell
cd worker
fly launch --no-deploy --copy-config --name wassel-deck-worker --region bom
```

The `--no-deploy` flag lets you set secrets *before* the first run so
the worker doesn't crash-loop on missing env vars.

### 4. Set secrets

These map 1:1 to what `src/env.ts` requires. Copy from your Vercel
project settings (the API keys are the same).

```powershell
fly secrets set `
  SUPABASE_URL=https://zhqqsxwealdwqzrbpwyv.supabase.co `
  SUPABASE_SERVICE_ROLE_KEY=eyJ... `
  ANTHROPIC_API_KEY=sk-ant-... `
  ANTHROPIC_WASSEL_SKILL_ID=sk_... `
  ANTHROPIC_WASSEL_REVIEW_SKILL_ID=sk_...   # optional but recommended
  FAL_KEY=...                               # NEW (Image Chats v2) — REQUIRED; use 'stub' for offline
  # Optional fal model overrides (defaults are fine):
  # FAL_CHAT_MODEL_ID=fal-ai/nano-banana-pro/edit `
  # FAL_CHAT_GPT_IMAGE_2_MODEL_ID=openai/gpt-image-2/edit
```

`FAL_KEY` is the **one new secret since the image queue was added** — the worker
now boots-fail if it's missing (the same fal key already lives in the Vercel
project). Use `FAL_KEY=stub` on a throwaway/CI worker to return canned picsum
URLs without calling fal.

**`SUPABASE_SERVICE_ROLE_KEY` is the one secret that DOESN'T already
exist in the Vercel project** (the existing API uses the anon key
+ user JWT). Grab it from the Supabase dashboard → Settings → API →
`service_role` (it's labeled "secret"). NEVER expose this in the
browser — it bypasses RLS.

### 5. Deploy

```powershell
fly deploy
```

First build takes ~2 min (downloads the Node 22 base image). Subsequent
deploys are ~30s with layer caching.

After deploy, check the worker is alive:

```powershell
fly status
curl https://wassel-deck-worker.fly.dev/healthz
# → {"ok":true,"busy":false,"worker_id":"<machine_id>","uptime_s":...}
fly logs   # tail logs
```

### 6. Tell the API endpoint where the worker lives

Add one more secret to **Vercel** (not Fly) so the slim `/api/generate-deck`
can send the wake ping. Without this the worker still picks up jobs
via its 3s poll loop — wake is purely a latency optimization.

```powershell
# In the repo root (Vercel CLI), or via the Vercel dashboard:
vercel env add WASSEL_DECK_WORKER_URL production
# value: https://wassel-deck-worker.fly.dev
```

Also add `SUPABASE_SERVICE_ROLE_KEY` to Vercel — the slim API endpoint
now uses service role to insert into `deck_jobs` (bypasses RLS so the
user's JWT doesn't need a deck_jobs INSERT policy):

```powershell
vercel env add SUPABASE_SERVICE_ROLE_KEY production
```

Redeploy Vercel after adding env vars (`vercel deploy --prod` or just
push to `main`).

## Day-to-day operations

| Need to... | Command |
|---|---|
| See live logs | `fly logs` |
| SSH into the machine | `fly ssh console` |
| Restart after secret change | `fly machine restart` (or just `fly secrets set …` which auto-restarts) |
| Scale up (more concurrency) | `fly scale count 2` — multiple workers share the queue via FOR UPDATE SKIP LOCKED, no extra coordination needed |
| Scale down to zero (pause) | `fly scale count 0` — jobs queue up; resume with `fly scale count 1` (watchdog will still mark them failed after 20 min, so don't pause for long) |
| Deploy after code change | `fly deploy` |

## Local development

```powershell
cd worker
# Create worker/.env with the same secrets you set on Fly.
npm install
npm run dev   # tsx watch mode
```

The local worker will pick up production jobs from `deck_jobs` if
`SUPABASE_URL` points at production. To avoid that, point at a Supabase
branch DB or set `POLL_INTERVAL_MS=600000` (10 min) to effectively
disable polling.

## Why Fly.io specifically

We picked Fly over Cloudflare Workers + Durable Objects, Vercel
Workflows, and Inngest after weighing: same JS/TS stack as the rest of
the codebase, no per-invocation CPU metering, trivial Dockerfile-based
deploy, the smallest VM tier is plenty for this workload (heavy work
runs in Anthropic's sandbox, not on the VM), and `bom` region matches
the Supabase ap-south-1 project so the per-record-update round-trip is
~5ms instead of ~150ms.

See the decision discussion preserved in CLAUDE.md → "Decks worker"
section.

Note: the worker also drains the `file_preview_jobs` queue (office→PDF previews; see docs/prd/files.md "Office document preview") and the `pdf_compress_jobs` queue (Ghostscript PDF compression; see docs/prd/files.md "PDF compression"). Each queue gets its own independent poll loop so short file jobs never wait behind multi-minute decks.
