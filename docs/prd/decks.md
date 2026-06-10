# PRD: Decks (AI-generated PowerPoints)

**Status:** Live (v2 — queue-based, refactored off Vercel Edge 2026-05-17)
**Last updated:** 2026-06-10
**Related PRDs:** [navigation-layout.md](navigation-layout.md), [data-storage.md](data-storage.md), [record-management.md](record-management.md), [ai-agent.md](ai-agent.md), [logs.md](logs.md)

## What it is (in plain English)
A page inside the Wassell app where any user can describe a presentation in plain Arabic or English ("a 6-slide capability deck for a partner meeting in Riyadh, brand-compliant, mostly visual"), click Generate, and a few minutes later download a finished, brand-compliant `.pptx` file. The deck is created by Claude in Anthropic's cloud — the user's machine doesn't need to be running. Past decks are listed on the left pane; the right pane shows the current generation's progress or the finished file.

Behind the scenes, the browser POSTs the brief to `/api/generate-deck` (Vercel Edge), which inserts a row into a `deck_jobs` queue and returns immediately. An always-on **Fly.io worker** (Node, in the Mumbai region next to the Supabase project) polls the queue, claims pending rows atomically (Postgres `FOR UPDATE SKIP LOCKED`), and runs the long generation: calls Claude with the **wassel-general-ppt** skill (and optionally **wassel-deck-review**) plus the **code_execution** tool, extracts the `.pptx` via a base64-stdout sentinel channel, uploads to private Supabase Storage, signs a 7-day URL, and writes the result back to the deck record. Status updates flow to the browser via **Supabase Realtime** on the record itself — no SSE, no held HTTP request. A `deck_jobs_watchdog()` SQL function (invoked every 5 min by the worker) sweeps any `running` job older than 20 min so the UI never gets stuck on a spinner if the worker crashes mid-job.

## Why it exists
The Wassel design system (palette, Amiri font, Arabic typography rules, wording rules) is non-trivial to apply correctly, and not every staff member can run the local Claude Code skill that does it. Hosting the skill behind an API endpoint lifts that constraint: anyone with an account can generate a brand-compliant deck from anywhere, and we keep one source of truth for the brand engine instead of letting hand-built decks drift.

## Why the v2 rewrite (2026-05-17)
v1 used a Vercel Edge function that held an SSE stream open for the entire Anthropic call. Vercel Edge has a **300s hard cap on Pro** (`maxDuration: 300` is the maximum allowed value — can't go higher). Any deck that took longer than 5 min got killed mid-flight with no chance to write a final state — the record was stuck on `status='generating'` and the UI showed a spinner forever. Hit production on record `867a049b-...` twice (2026-05-14 and 2026-05-17). v2 decouples the long-running work from the HTTP request: the API endpoint just enqueues, an always-on Fly.io worker drains the queue with no per-job timeout. From the user's perspective generation is now effectively unlimited — they see Realtime updates flow in until the deck is ready.

## Key behaviors
- **Sidebar entry** `العروض التقديمية / Decks` is a top-level item (no group), driven by a system model `name: 'decks'`. The record-list and record-detail dispatchers in `App.tsx` swap the generic views for a purpose-built split-pane page.
- **Split layout.** Left pane (~320px) = list of past decks sorted by `created_at` desc, each row showing the title + a status pill. Right pane = the active deck — either a brief form (when status is `queued`), a progress view (`generating`), a download card (`ready`), or an error view with retry (`failed`).
- **Decks as records.** Each generation is one `decks` record. The brief, status, filename, signed URL, storage path, Anthropic file id, language, and chosen model are all fields on the record (so they show up in admin views and Activity Log dumps without anything custom).
- **Skills on the cloud.** Two skill folders are uploaded once to the Anthropic Skills API and loaded together in every generation call:
  1. **`wassel-general-ppt`** (env: `ANTHROPIC_WASSEL_SKILL_ID`) — the composition primitives (palette, Amiri font, RTL helpers, logo, drawing utilities).
  2. **`wassel-deck-review`** (env: `ANTHROPIC_WASSEL_REVIEW_SKILL_ID`, optional but recommended) — the auto-patch QA gate. Mirrors the local `/wassel-general-ppt` workflow where the review is the mandatory final step before delivery. The endpoint instructs Claude to: save the raw build → call `review_deck(input, output, fix=True)` from the review skill → base64-stdout the **reviewed** file. The review fixes mechanical bugs Claude's first pass tends to leave behind: tables with broken RTL ordering, missing complex-script font slots (which silently makes Arabic fall back to theme default), blue hyperlink color/underline, double-spaced separators, missing LRM marks around numbers inside Arabic paragraphs, parens-in-body, etc.
  Re-uploading any skill bumps the version; the client always references `version: "latest"`. The review skill is optional — when its env var is unset, the endpoint falls back to single-pass composition and returns the raw build (with a no-op cost).
- **Queue-based generation (v2).**
  1. Client POSTs `{record_id, brief, language, model, size, attachments}` to `/api/generate-deck` (a thin Vercel Edge function that uses service role).
  2. The endpoint validates auth + body, inserts ONE row into `public.deck_jobs` with `status='pending'`, and fires a best-effort `POST <worker>/wake` ping to nudge the Fly.io worker out of its 3s poll wait. Returns `202 { job_id }` in <1s. NO Anthropic call. NO SSE. Returns immediately even if the wake ping times out.
  3. The Fly.io worker (`worker/src/index.ts`) polls `public.deck_job_claim_next(worker_id)` every 3s, which uses `FOR UPDATE SKIP LOCKED` to atomically grab the oldest pending row and flip it to `running`. Multiple workers can run safely.
  4. The worker (`worker/src/runDeckJob.ts`) executes the long generation: downloads each attachment from Supabase Storage with the service-role key, forwards each to the Anthropic Files API, calls `client.beta.messages.stream` with `container.skills` + the user message blocks (`container_upload` per attachment + optional `image` / `document` for vision/native-PDF), and writes phase updates (`calling-claude` → `downloading` → `uploading` → `finalizing`) to the deck record as it goes.
  5. Worker extracts the .pptx bytes via the base64-stdout sentinel channel (primary) or the Anthropic Files API list scan (fallback), uploads to `wassel-decks/{auth.uid()}/{record_id}/{filename}`, signs a 7-day URL, and writes `status='ready' + file_url + file_path + filename + anthropic_file_id` to the record. On any error, writes `status='failed' + error_message` instead.
  6. On success/failure, the worker calls `public.deck_job_complete(job_id)` / `public.deck_job_fail(job_id, error)` to update the queue row. Both RPCs are guarded by `status='running'` so the worker can't overwrite the watchdog if it raced.
  7. A `deck_jobs_watchdog()` SQL function (called by the worker every 5 min — `pg_cron` isn't enabled on wassell-prod so no in-DB cron) flips any `running` job older than 20 min to `failed` AND writes the same to the deck record (only when record is still `'generating'`, so it doesn't overwrite a worker that raced ahead). 20 min is comfortably above any realistic Opus+skills generation (typical 3-7 min).
- **Progress updates via Supabase Realtime.** The deck record's `data.phase` field is the source of truth for the GeneratingView spinner. The appStore's existing Realtime subscription on `records` pushes every worker update to the browser within ~200ms. No SSE, no held HTTP request, no polling from the browser.
- **Stuck detector.** [DeckRightPane.tsx](../../src/pages/Decks/components/DeckRightPane.tsx) tracks `record.updated_at` and a 15-second `nowTick` heartbeat. If `status='generating'` and the record hasn't been touched in 6+ minutes, it renders the FailedView with "looks stuck — press Try again" instead of the spinner. The DB-side watchdog catches it at 20 min for real; this is the user-facing escape hatch that doesn't make them wait that long.
- **Storage layout.** Bucket is private. Path scheme is `{auth.uid()}/{record_id}/<file>` for outputs and `{auth.uid()}/{record_id}/uploads/<timestamp>_<file>` for user attachments. Path-prefix RLS keys off the first segment (`auth.uid()`), so a user can only read/write files they own. Signed URLs sidestep RLS for downloads but expire in 7 days. Bucket file size limit is 100 MB; per-attachment cap is enforced client-side at 32 MB to match the Anthropic Files API limit.
- **Re-sign on demand.** If the user opens an old deck whose `file_url` is past its expiry, the page reads `file_path` from the record and asks the backend to mint a fresh signed URL. The original `file_path` never expires.
- **Model choice.** Brief form has a model dropdown (Opus 4.7 / Sonnet 4.6). Default is Opus 4.7 for variety/quality; Sonnet is offered for cost-sensitive runs. The chosen model is saved on the record for reproducibility.
- **Language tag.** Optional `ar` / `en` / `mixed` field on the record — passed into the system prompt so Claude favors the right language defaults. Doesn't restrict what Claude outputs; it's a hint.
- **Slide size.** Brief form has a 4-segment size selector (16:9 widescreen / 9:16 vertical / 4:3 standard / 1:1 square) with mini aspect-ratio thumbnails. The chosen ratio maps to python-pptx `slide_width` / `slide_height` in inches via the system prompt:
  - `16:9` → 13.333" × 7.5" (default)
  - `9:16` → 7.5" × 13.333"
  - `4:3`  → 10" × 7.5"
  - `1:1`  → 7.5" × 7.5"
  Saved on the record as `size`. Older records read as undefined → endpoint coerces to `16:9`.
- **Attachments (Excel, PDF, PowerPoint, Word, images).** The brief form has a drop-zone / file-picker that uploads files immediately to `wassel-decks/{auth.uid()}/{record_id}/uploads/<timestamp>_<filename>` with the user's JWT (RLS scoped to the user's path prefix). The endpoint downloads each file, forwards it to the Anthropic Files API, and:
  1. Adds every uploaded file_id to `container.file_ids` so it appears in the sandbox at `/mnt/user-data/uploads/<filename>` for the skill code to read with pandas / openpyxl / pypdf / python-pptx / python-docx / PIL.
  2. For up to 3 small images (≤ 5 MB each), additionally embeds them as `image` content blocks so Claude can reason about them visually.
  3. For up to 1 PDF, additionally embeds it as a `document` content block for native PDF reading.
  Per-file cap is 32 MB (matches Anthropic Files API limit). Accepted mime types are governed by the bucket's `allowed_mime_types`: pptx, xlsx, xls, docx, doc, pdf, png, jpg, webp, gif, heic, heif, csv, txt. Attachments persist on the record so a "Try again" reuses them without re-uploading.
- **Attach from the Files library (added 2026-06-10).** Besides uploading from the local disk, the brief form has a **"Choose from Files / اختر من الملفات"** button that opens a browser over the in-app Files library ([PickFromFilesModal.tsx](../../src/pages/Decks/components/PickFromFilesModal.tsx)). The user navigates their folders, picks one deck-readable file (unsupported types are shown but disabled), and its bytes are **copied verbatim** into the deck's own uploads area (`wassel-decks/{auth.uid()}/{record_id}/uploads/...`) via a permission-checked signed download (`/api/files/sign-download-url`) + re-upload — so from the worker's perspective it is indistinguishable from a local upload (same path shape, same scope check, no worker change). This is the intended way to reuse a previously-generated deck as a **template**: save the `.pptx` to Files, then attach it on a new deck and ask Claude to match its design. Storage never transcodes, so the `.pptx` stays byte-for-byte identical (no corruption). Same 32 MB cap and accepted-type set as local upload (single source of truth: `DECK_ATTACHABLE_EXTS` in `src/lib/decks/client.ts`).
- **Auth.** Every `/api/generate-deck` request must carry the caller's Supabase JWT. The endpoint creates a Supabase client scoped to that JWT so the storage upload + record write happen as the user (not the service role) and respect RLS.
- **Env vars (Vercel).** `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (new in v2 — used by the API endpoint to insert into `deck_jobs` via service role), and optional `WASSEL_DECK_WORKER_URL` (e.g. `https://wassel-deck-worker.fly.dev`, used for the fire-and-forget `/wake` ping; absent → worker still polls and picks up jobs within ~3s).
- **Env vars (Fly.io worker).** Set via `fly secrets set`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_WASSEL_SKILL_ID`, optional `ANTHROPIC_WASSEL_REVIEW_SKILL_ID`. See `worker/README.md` for full deploy steps.
- **Generation duration.** Typical deck takes 60–180s on Sonnet, 90–420s on Opus (Opus's adaptive thinking + skills + code_execution + review pass). The Fly.io worker has no per-job timeout — the only ceiling is the watchdog at 20 min, which is well above any realistic deck. The previous Vercel Edge 300s hard cap is gone.

## User flows
1. **Generate a deck (happy path):**
   1. Click `العروض التقديمية` in the sidebar.
   2. Click "عرض جديد / New deck" — a new `decks` record is created with status `queued`, URL flips to `/model/decks/:newId`, and the brief form loads on the right.
   3. Fill in title (e.g. "Capability deck for AlMutlaq partner meeting"), brief (free-form description, AR or EN), pick language, pick model, pick size. Optionally drop in attachments (Excel sheets with property data, PDF brochures, reference PowerPoints, photos) from your local disk **or click "اختر من الملفات / Choose from Files"** to attach a file already in the Files library (e.g. a saved deck to reuse as a template). Submit. Submit is blocked while any attachment is still uploading.
   4. Right pane swaps to a progress view. Status pill animates: "Calling Claude…" (which now also includes "uploading N attachments…" when files are being forwarded to the Anthropic Files API) → ready.
   5. Download card appears with the filename and a primary download button. The same row updates on the left pane.
2. **Reopen an old deck:**
   1. Click a row in the left pane.
   2. Right pane loads the download card. If the signed URL has expired (older than 7 days), the page silently re-signs from `file_path` before rendering the button.
3. **Failed generation:**
   1. Status moves to `failed`; right pane shows the error message and a "Try again" button.
   2. Try again re-submits the brief unchanged. (User can also edit and resubmit — that creates a new deck record.)
4. **Empty state:** no decks yet → left pane reads "لا توجد عروض بعد"; right pane shows a welcome card with the `Presentation` icon, the rules of the brand engine in one paragraph, and a "New deck" button.

## Data touched
- **Reads:**
  - `records` (decks records, the active deck's row).
  - `models` (looks up the decks system model by name).
  - `deck_jobs` (the worker's poll loop reads pending rows; the SPA can also read its own jobs via the RLS-gated `deck_jobs_owner_select` policy — currently unused but available for a future admin "my jobs" view).
- **Writes:**
  - `deck_jobs` — `/api/generate-deck` inserts one row per Generate click (status='pending'); the worker updates it to 'running' / 'done' / 'failed' via the `deck_job_claim_next` / `deck_job_complete` / `deck_job_fail` RPCs.
  - `records` — the worker updates the deck row through the lifecycle: `status='generating'` at job start, `phase` + `phase_detail` updates as it moves through phases, `status='ready'` + `file_url` + `file_path` + `filename` on success, `status='failed'` + `error_message` on failure. Realtime fans every update out to the SPA.
  - `storage.objects` (bucket `wassel-decks`) — one `.pptx` per successful generation at `{auth.uid()}/{record_id}/{filename}`.

## Key files
| File | What it does |
|---|---|
| `src/data/seedModels.ts` | Defines the `decks` system model. Includes `size` field added 2026-05-10. The `phase` / `phase_detail` / `error_message` fields are written by the worker and read by the SPA but aren't declared in the seed schema — they live on `record.data` as ad-hoc string fields. |
| `src/lib/schemaMigrations.ts` | `healDecksSchema` appends any missing-by-name fields from the seed shape on existing installs. |
| `src/App.tsx` | Dispatchers: `modelName === 'decks'` in both list + detail routes → render `DecksPage`. |
| `src/pages/Decks/DecksPage.tsx` | Split-pane layout, deck list, new-deck button. |
| `src/pages/Decks/components/DeckRightPane.tsx` | Toggles between BriefForm / GeneratingView / ReadyView / FailedView based on `record.data.status` (no SSE — Realtime drives all updates). Includes a 6-min "looks stuck → Try again" detector keyed off `record.updated_at` + a 15s heartbeat. BriefForm hosts the title/brief/language/model/size selectors, the attachment drop-zone, AND the "Choose from Files" button → `PickFromFilesModal` (`addFromLibrary` mirrors the local-upload `addFiles` flow). |
| `src/pages/Decks/components/PickFromFilesModal.tsx` | Folder-navigating browser over the Files library for picking ONE deck-readable file to attach. Reads via the RLS-gated `listFolders`/`listFiles`; greys out unsupported types via `isDeckAttachableName`. Returns the chosen `FileRow` to the parent, which copies it into the deck. |
| `src/lib/decks/client.ts` | `enqueueGenerateDeck` (POST to the slim API, returns `{ jobId }`), `signDeckUrl`, `uploadDeckAttachment`, `attachDeckAttachmentFromLibrary` (signed-download + re-upload copy from `wassel-files` → the deck's uploads area), `deleteDeckAttachment`, and `DECK_ATTACHABLE_EXTS` / `isDeckAttachableName` (single source of truth for accepted types). Defines wire types `DeckSize` and `DeckAttachment`. The old `streamGenerateDeck` SSE pump was removed in v2. |
| `api/generate-deck.ts` | Slim Vercel Edge function (maxDuration: 30s). Validates auth + body, inserts a `deck_jobs` row via service role, fires a best-effort `POST /wake` ping to the Fly.io worker, returns 202 with `{ job_id }`. No Anthropic call. No SSE. |
| `api/sign-deck-url.ts` | Edge function that mints a fresh 7-day signed URL for an existing record's `file_path`. Called when the user reopens an old deck. Unchanged in v2. |
| `worker/src/index.ts` | The Fly.io worker entry. Poll loop (3s default) using `deck_job_claim_next`, watchdog ticker (5 min default), HTTP server (`/healthz`, `/wake`), graceful shutdown (SIGTERM). |
| `worker/src/runDeckJob.ts` | The actual generation pipeline — ported from the old `api/generate-deck.ts` body. Anthropic Skills + code_execution call, base64-stdout extraction (primary) / Files API fallback, Storage upload, signed URL, record update. Writes `phase` to the record at each step so the SPA's GeneratingView updates via Realtime. |
| `worker/src/env.ts` | Strict env loader. Fails fast at startup if anything required is missing. |
| `worker/Dockerfile` / `worker/fly.toml` | Multi-stage Node 22 build; Mumbai region; always-on; 512 MB VM. |
| `worker/README.md` | Step-by-step deploy guide (Fly CLI install, secrets, deploy, ops). |
| `scripts/upload-wassel-skill.mjs` | One-time / re-runnable uploader that pushes the `wassel-general-ppt` folder to the Anthropic Skills API. Run when the local skill changes. |
| `scripts/upload-wassel-review-skill.mjs` | Same shape but for the `wassel-deck-review` skill (QA gate). |
| `supabase/migrations/2026-05-09_l_decks_storage.sql` | Creates the `wassel-decks` bucket + path-prefix RLS policies. |
| `supabase/migrations/2026-05-10_decks_bucket_allow_attachments.sql` | Expands the bucket's `allowed_mime_types` to cover Excel / PDF / PowerPoint / Word / images / CSV / text in addition to the generated .pptx output. |
| `supabase/migrations/2026-05-17_deck_jobs_queue.sql` | v2 architecture: creates `deck_jobs` table + indexes + RLS + the four RPCs (`deck_job_claim_next` / `_complete` / `_fail` / `deck_jobs_watchdog`) + best-effort `pg_cron` schedule (no-op on wassell-prod since the extension isn't enabled — worker runs the watchdog itself). |
| `C:\Users\rayan\.claude\skills\wassel-general-ppt` | The local skill folder — source of truth for the brand engine. Edit here, then re-run `scripts/upload-wassel-skill.mjs --version-of <skill_id>` to ship a new version to Anthropic. |

## Open questions / known limitations
- **Anthropic outputs only.** Only supports decks Claude generates from scratch; there's no "edit this existing pptx" path. Adding it is a separate feature (would need to upload the existing .pptx as an input file to the Files API and tell the skill to modify rather than create).
- **No regeneration with edited brief.** "Try again" re-submits the original brief. To change the brief you create a new deck. Could add an in-place "edit brief and regenerate" later — kept out to avoid history loss.
- **Skill versioning is manual.** When the local skill changes, the user has to re-run the upload script with `--version-of <skill_id>`. No automation. This is fine because the brand engine changes slowly; if it grows, wire into a build step.
- **Single skill only.** The `wassel-presentation` (مقام-17 fixed structure) skill isn't surfaced on this page — that's a separate, structurally-different deck and would need its own form. General-decks only.
- **Cost.** Each generation costs Anthropic tokens (rough order $0.10–$0.50 per deck on Opus, ~5× cheaper on Sonnet) plus sandbox time. Plus Fly.io: a single shared-cpu-1x / 512 MB VM is $0–5/mo. No rate limiting yet — at scale, add per-user quotas via the activity log.
- **No preview thumbnail.** Right pane shows a download button, not a slide preview. Could add by exporting first slide to PNG via LibreOffice in a follow-up worker; out of scope.
- **Activity Log integration.** Each generation should log a `category='deck_generation'` row into `public.activity_log` for audit/cost tracking. Pending — see `docs/prd/logs.md` to extend.
- **Per-attempt cap is still ~implicit.** Although the worker has no per-job timeout, the watchdog flips any `running` job older than 20 min to `failed`. Real-world decks fit well within this, but if you ever want literally unlimited per attempt (multi-step builds, very long sandbox runs), raise `WATCHDOG_INTERVAL_MS` and the 20-min check inside `deck_jobs_watchdog()` together.
- **Single worker instance.** `fly.toml` ships with `min_machines_running = 1`. To scale concurrency (e.g. 5 users generating in parallel), `fly scale count 3` — multiple workers share the queue via `FOR UPDATE SKIP LOCKED`, no extra coordination needed.
