# PRD: Decks (AI-generated PowerPoints)

**Status:** Live (v1)
**Last updated:** 2026-05-09
**Related PRDs:** [navigation-layout.md](navigation-layout.md), [data-storage.md](data-storage.md), [record-management.md](record-management.md), [ai-agent.md](ai-agent.md), [logs.md](logs.md)

## What it is (in plain English)
A page inside the Wassell app where any user can describe a presentation in plain Arabic or English ("a 6-slide capability deck for a partner meeting in Riyadh, brand-compliant, mostly visual"), click Generate, and a few minutes later download a finished, brand-compliant `.pptx` file. The deck is created by Claude in Anthropic's cloud — the user's machine doesn't need to be running. Past decks are listed on the left pane; the right pane shows the current generation's progress or the finished file.

Behind the scenes, every generation posts the brief to a Vercel function (`/api/generate-deck`), which calls Claude with the **wassel-general-ppt** skill (uploaded once to Anthropic's Skills API) plus the **code_execution** tool. Claude writes a Python build script using the skill's primitives, runs it in Anthropic's sandbox, produces a `.pptx`, and the endpoint downloads it via the Files API and uploads to a private Supabase Storage bucket. Status updates stream back to the browser as Server-Sent Events.

## Why it exists
The Wassel design system (palette, Amiri font, Arabic typography rules, wording rules) is non-trivial to apply correctly, and not every staff member can run the local Claude Code skill that does it. Hosting the skill behind an API endpoint lifts that constraint: anyone with an account can generate a brand-compliant deck from anywhere, and we keep one source of truth for the brand engine instead of letting hand-built decks drift.

## Key behaviors
- **Sidebar entry** `العروض التقديمية / Decks` is a top-level item (no group), driven by a system model `name: 'decks'`. The record-list and record-detail dispatchers in `App.tsx` swap the generic views for a purpose-built split-pane page.
- **Split layout.** Left pane (~320px) = list of past decks sorted by `created_at` desc, each row showing the title + a status pill. Right pane = the active deck — either a brief form (when status is `queued`), a progress view (`generating`), a download card (`ready`), or an error view with retry (`failed`).
- **Decks as records.** Each generation is one `decks` record. The brief, status, filename, signed URL, storage path, Anthropic file id, language, and chosen model are all fields on the record (so they show up in admin views and Activity Log dumps without anything custom).
- **Skill on the cloud.** The `wassel-general-ppt` skill folder (SKILL.md + `wassel_chrome.py` + the white logo PNG) is uploaded once to the Anthropic Skills API and referenced by `skill_id` (env var `ANTHROPIC_WASSEL_SKILL_ID`). Re-uploading bumps the version; client always references `version: "latest"`.
- **Server-side generation.**
  1. Client POSTs `{record_id, brief, language, model}` to `/api/generate-deck` (the `decks` record was created with status `queued` first, so we have a row to update progressively).
  2. Endpoint sets status → `generating`, then calls `client.beta.messages.create` with `container.skills` referencing the skill, `tools: [code_execution]`, and a system prompt instructing Claude to save the output to `/mnt/user-data/outputs/<slug>.pptx`.
  3. Endpoint walks the response for a `code_execution_result` block carrying a `file_id`, downloads it via `client.beta.files.download(file_id)`, and uploads the bytes to the `wassel-decks` Supabase bucket at `{auth.uid()}/{record_id}/{filename}`.
  4. Endpoint creates a 7-day signed URL, updates the record (status → `ready`, `file_url`, `file_path`, `filename`, `anthropic_file_id`), and emits a `done` SSE event.
- **Streaming progress.** The endpoint emits SSE events as it moves through phases: `status` (with `phase` ∈ `calling-claude` / `downloading` / `uploading`), `done` (with the signed URL), and `error` (with a message). Front-end renders each phase with a copper-bronze progress bar and a one-line description.
- **Storage layout.** Bucket is private. Path scheme `{auth.uid()}/{record_id}/{filename}` ensures Supabase RLS (path-prefix scoped to `auth.uid()`) gives each user access only to their own files. Signed URLs sidestep RLS for downloads but expire in 7 days.
- **Re-sign on demand.** If the user opens an old deck whose `file_url` is past its expiry, the page reads `file_path` from the record and asks the backend to mint a fresh signed URL. The original `file_path` never expires.
- **Model choice.** Brief form has a model dropdown (Opus 4.7 / Sonnet 4.6). Default is Opus 4.7 for variety/quality; Sonnet is offered for cost-sensitive runs. The chosen model is saved on the record for reproducibility.
- **Language tag.** Optional `ar` / `en` / `mixed` field on the record — passed into the system prompt so Claude favors the right language defaults. Doesn't restrict what Claude outputs; it's a hint.
- **Auth.** Every `/api/generate-deck` request must carry the caller's Supabase JWT. The endpoint creates a Supabase client scoped to that JWT so the storage upload + record write happen as the user (not the service role) and respect RLS.
- **Env vars.** `ANTHROPIC_API_KEY` and `ANTHROPIC_WASSEL_SKILL_ID` must be set on Vercel (production + preview). Missing key → endpoint returns `500 "ANTHROPIC_API_KEY is not configured"`. Missing skill id → `500 "ANTHROPIC_WASSEL_SKILL_ID is not configured"`.
- **Long-running.** Generation typically takes 60–180 seconds depending on deck complexity and model. The endpoint runs Node runtime with `maxDuration: 300` (Vercel Pro plan limit). Anything that takes longer fails with `error` event "generation timed out — try a shorter brief or fewer slides".

## User flows
1. **Generate a deck (happy path):**
   1. Click `العروض التقديمية` in the sidebar.
   2. Click "عرض جديد / New deck" — a new `decks` record is created with status `queued`, URL flips to `/model/decks/:newId`, and the brief form loads on the right.
   3. Fill in title (e.g. "Capability deck for AlMutlaq partner meeting"), brief (free-form description, AR or EN), pick language, pick model. Submit.
   4. Right pane swaps to a progress view. Status pill animates: "Calling Claude…" → "Downloading file…" → "Uploading to storage…" → ready.
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
  - `models` (looks up the decks system model by name in the page).
- **Writes:**
  - `records` — upserts the active `decks` row through the lifecycle: initial `queued` insert from the front-end on "New deck"; `generating` / `ready` / `failed` updates from the backend on each phase.
  - `storage.objects` (bucket `wassel-decks`) — one `.pptx` per successful generation at `{auth.uid()}/{record_id}/{filename}`.

## Key files
| File | What it does |
|---|---|
| `src/data/seedModels.ts` | Defines the `decks` system model (registered in `SEED_MODELS`). |
| `src/App.tsx` | Dispatchers: `modelName === 'decks'` in both list + detail routes → render `DecksPage`. |
| `src/pages/Decks/DecksPage.tsx` | Split-pane layout, deck list, new-deck button. |
| `src/pages/Decks/components/DeckBriefForm.tsx` | Right-pane brief form (title / brief / language / model / submit). |
| `src/pages/Decks/components/DeckProgress.tsx` | Right-pane progress view during generation. |
| `src/pages/Decks/components/DeckReady.tsx` | Right-pane download card; re-signs URL on demand. |
| `src/lib/decks/client.ts` | Browser-side SSE pump for `/api/generate-deck` + helper for re-signing URLs. |
| `api/generate-deck.ts` | Vercel Node function — calls Anthropic Skills + code_execution, downloads via Files API, uploads to Storage, streams SSE. |
| `scripts/upload-wassel-skill.mjs` | One-time / re-runnable uploader that pushes the `wassel-general-ppt` folder to the Anthropic Skills API. Run when the local skill changes. |
| `supabase/migrations/2026-05-09_l_decks_storage.sql` | Creates the `wassel-decks` bucket + path-prefix RLS policies. |
| `C:\Users\rayan\.claude\skills\wassel-general-ppt` | The local skill folder — source of truth for the brand engine. Edit here, then re-run `scripts/upload-wassel-skill.mjs --version-of <skill_id>` to ship a new version to Anthropic. |

## Open questions / known limitations
- **Anthropic outputs only.** v1 only supports decks Claude generates from scratch; there's no "edit this existing pptx" path. Adding it is a separate feature (would need to upload the existing .pptx as an input file to the Files API and tell the skill to modify rather than create).
- **No regeneration with edited brief.** "Try again" re-submits the original brief. To change the brief you create a new deck. Could add an in-place "edit brief and regenerate" later — kept out of v1 to avoid history loss.
- **Skill versioning is manual.** When `wassel_chrome.py` changes locally, the user has to re-run the upload script with `--version-of <skill_id>`. No automation. This is fine because the brand engine changes slowly; if it grows, wire into a build step.
- **Single skill only.** The `wassel-presentation` (مقام-17 fixed structure) skill isn't surfaced on this page — that's a separate, structurally-different deck and would need its own form. v1 is general-decks only.
- **Cost.** Each generation costs Anthropic tokens (rough order $0.10–$0.50 per deck on Opus, ~5× cheaper on Sonnet) plus sandbox time. No rate limiting yet — at scale, add per-user quotas via the activity log.
- **No preview thumbnail.** Right pane shows a download button, not a slide preview. Could add by exporting first slide to PNG via LibreOffice in a follow-up worker; out of v1 scope.
- **Activity Log integration.** Each generation should log a `category='deck_generation'` row into `public.activity_log` for audit/cost tracking. Pending — endpoint shipped without it; see `docs/prd/logs.md` to extend.
