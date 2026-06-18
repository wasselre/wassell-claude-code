# PRD: Image Chats → Creative Studio

**Status:** Live
**Last updated:** 2026-06-18 (composer prompt-length guard: 4,000-char cap enforced client-side BEFORE the optimistic textarea reset — over-long prompts now toast + keep the text instead of clearing it, plus a live character counter; v3 — rebuilt as a Creative **Workspace** (Higgsfield-style), not a chat: Generations + a first-class media-asset library; v3.2 — full-screen viewer redesigned: covers the app sidebar, LEFT = collapsible Branding/Design prompt sections, RIGHT = actions; the Media Library opens the same viewer)
**Related PRDs:** [files.md](files.md), [record-management.md](record-management.md), [marketing-operations.md](marketing-operations.md), [templates-library.md](templates-library.md), [navigation-layout.md](navigation-layout.md)

## What it is (in plain English) — v3 (Creative Workspace)

Image Chats is now a **Creative Studio workspace**, not a chat. The primary object is a **Creative Session → Generations → Assets**, shown as a Higgsfield-style workspace, NOT a conversation thread:

- **Left** — Creative Sessions (thumbnail, title, generation count; New / Rename / Duplicate / Delete).
- **Center (dominant)** — the **canvas**: the selected generation's outputs (large single image or grid; queued/generating placeholder; failed → Retry). Click an output to open a **full-screen viewer** that covers the app sidebar, laid out in three physical columns: **LEFT** = collapsible sections — **Branding prompt** (the brand-preset's text, resolved from the generation's `preset_id`), **Design prompt** (your composer instruction), and — when the generation used reference images to create/edit — **Attached images** (thumbnails of the inputs from `reference_urls`; click to open full-size); **CENTER** = the image at full size with prev/next + a thumbnail filmstrip across the generation's outputs (← → / Esc / backdrop close); **RIGHT** = the asset actions. Closing leaves that output selected in the right rail.
- **Bottom** — the **Composer** (prompt • reference images • brand preset • prompt snippet • model • aspect • variations • **Send/Generate**); stays live while generations run (3-in-flight soft cap).
- **Timeline** — a secondary strip of generation thumbnails; click to load one into the canvas.
- **Right** — the **Selected Asset panel**: preview (click → the same full-screen viewer) + provenance (prompt/model/settings/time) + actions (Download, Copy URL, Add to Files, Add to Record, Create Variation, Use as Reference, Regenerate). The action list is one shared `AssetActions` component (panel + viewer + Media Library never drift); the viewer's creative actions are hidden where there's no active session (the Media Library shows Download / Copy URL / Add to Files / Add to Record / **Open source session** instead).
- **Media Library** — the "Media library" button opens a cross-session gallery over all of the user's `media_assets`; clicking an asset opens the **same full-screen viewer** (Branding/Design prompts resolved from the asset's source generation — falling back to the asset's stored prompt as Design when unresolvable).

**Generations, not messages.** Each `Generation` (`record.data.generations[]`) captures `{ prompt, reference images, model, aspect, variations, based_on (lineage), status, output_asset_ids }`. Generations run concurrently in the background (the `generation_jobs` queue + Fly worker, unchanged) and fill in via Realtime.

**Every output is a first-class asset.** Each generated image is a row in the new **`media_assets`** table (kind=image now; video/audio/document reserved) with provenance + stable identity — reusable across sessions, Files, records, and brand presets. "The image doesn't belong to the chat; the session references assets." Bytes stay in the public marketing-assets bucket (cheap canvas render); **Add to Files** copies into `wassel-files` once.

**Migration.** Existing sessions were reshaped `messages → generations` (old outputs kept as inline `output_urls`; originals stashed under `_legacy_messages`). The brand-preset + prompt-snippet libraries, Files/record integrations, and the fal.ai models are all unchanged from v2.

Key v3 files: `StudioWorkspace.tsx`, `SelectedAssetPanel.tsx`, `AssetLightbox.tsx` (full-screen viewer — left prompts / center image / right actions), `AssetActions.tsx` (shared action list), `MediaLibraryModal.tsx` (cross-session gallery → same viewer), `lib/generations.ts`, `api/image-chat/generate.ts`, `worker/src/runImageJob.ts` (dual-path), `supabase/migrations/2026-06-09_media_assets.sql` + `2026-06-09_sessions_to_generations.sql`. See CLAUDE.md → "Image Chats v3 — Creative Workspace".

---

## (v2 reference — the chat era, superseded by v3 above)

A "mini Higgsfield" chat interface inside Wassell. The user picks a Wassel-branded conversation, types or attaches images, picks an aspect ratio + brand preset + image model, and hits Send — fal.ai generates the image and posts it back into the conversation. Two models are exposed in the composer: **Nano Banana 2** (Google's Gemini 3 Pro Image, default — fast, multi-image, strong with Arabic) and **GPT Image 2** (OpenAI — best in-image text rendering, photorealism-first). Each new turn can iterate on the previous result, so the workflow feels like ChatGPT / Gemini's image-editing chat, but routed through our fal.ai integration and styled with our brand presets.


A "mini Higgsfield" chat interface inside Wassell. The user picks a Wassel-branded conversation, types or attaches images, picks an aspect ratio + brand preset + image model, and hits Send — fal.ai generates the image and posts it back into the conversation. Two models are exposed in the composer: **Nano Banana 2** (Google's Gemini 3 Pro Image, default — fast, multi-image, strong with Arabic) and **GPT Image 2** (OpenAI — best in-image text rendering, photorealism-first). Each new turn can iterate on the previous result, so the workflow feels like ChatGPT / Gemini's image-editing chat, but routed through our fal.ai integration and styled with our brand presets.

**v2 (2026-06-08) made it a real creative workspace:**
- **Generation is concurrent and non-blocking.** Each message starts its own generation job. The composer never locks — the user can fire several turns in a row and keep chatting while images render in parallel. Each assistant message shows its own status (queued → generating → completed / failed / cancelled).
- **Generated images become reusable platform assets.** Click an image → an actions menu: Open, Download, Copy URL, **Add to Files**, **Add to Record**, Create Variation, Use as Next Reference. An image generated in a chat can be saved into the Files System or attached to any record's image/file field anywhere in the CRM.

Two supporting libraries sit underneath:
- **Brand Presets** — named bundles of brand-language prompt text + reusable assets (logos, layout references). Picking one prepends the prompt to your message and auto-attaches its images.
- **Prompt Library** — named prompt snippets the user can recall instead of retyping common asks. Picking one fills the composer textarea + auto-attaches any images on the snippet.

## Why it exists

The team wants to design on-brand marketing imagery (Instagram posts, story panels, brochure heroes, photo cleanups) without leaving the CRM. Going to Higgsfield directly means re-uploading the logo every time, retyping the brand language every time, and bouncing files between tools. This bakes those reusable bits into the chat surface so producing one variation of a brand-compliant image is a one-line message — and v2 closes the loop by letting those generated images flow into projects, units, marketing operations, brand presets, and the Files library without leaving Wassell or re-uploading.

## Concurrent generation architecture (v2)

The old flow was synchronous and blocking: `POST /api/image-chat/send` awaited the full fal.ai call (up to 300s), a single conversation-level `status` flipped to `'generating'`, and the whole composer was disabled until one image returned. v2 replaces that with the **decks-style job queue** (see [data-storage.md] "Decks generation pipeline" for the sibling pattern):

```
Composer (never locked) ──enqueueImageChatTurn──▶ POST /api/image-chat/send (slim, ≤60s)
   │                                                 ├─ resolve attachments (caller JWT, perm-checked)
   │                                                 ├─ record_save: append user msg + assistant
   │                                                 │   PLACEHOLDER (status:'queued')  ← server-side
   │                                                 ├─ INSERT generation_jobs (service-role)
   │                                                 └─ best-effort POST /wake → 202 {job_id, message_id}
   ▼
Fly.io worker (NEW independent image poll loop) ──claim(kind='image')──▶ runImageJob:
   stamp message status:'generating' → fal.ai → re-host outputs to marketing-assets
   → patch THAT message {status:'completed', images} → generation_job_complete
        │
        └─ Supabase Realtime ──▶ SPA reconciles the record; the placeholder fills in place.
                                  Many placeholders in flight → each fills independently.
```

- **Per-message status** lives on the assistant message (`status: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled'`, plus `job_id` and `error`). The legacy conversation-level `record.data.status` is kept for back-compat but is now a lossy rollup — the UI derives "generating" from the messages, not from it.
- **Soft cap:** a conversation allows up to **3** generations in flight at once. Beyond that, Send is gated with a hint (the textarea + attach controls stay live).
- **Cancel:** a queued/generating bubble has an X → `generation_job_cancel` (owner-gated) flips the job + patches the message to `cancelled`. A queued job is never claimed; a running job is honored by the worker's pre-/post-fal re-reads. If the worker already completed it, the user keeps the image (the complete RPC only touches `running` rows).
- **Retry:** a failed/cancelled bubble has a Retry button → re-enqueues the preceding user turn.
- **Watchdog:** `generation_jobs_watchdog()` (run by the worker, since pg_cron isn't enabled) sweeps jobs stuck in `running` >15 min and patches ONLY their message to `failed` — the rest of the conversation and the composer are untouched.
- **Concurrency safety:** image turns append to a SHARED `messages` array, and rapid sends + the worker's fill-in are concurrent writers. Every write uses optimistic concurrency (`record_save` `p_expected_version` + retry on the 40001 version-mismatch; the `records_bump_version` trigger increments `version` on each UPDATE), so the loser of a race re-applies onto the latest array instead of clobbering. That makes ANY worker count safe — the deck worker app runs **5 machines** and image jobs ride on them. See CLAUDE.md "Generation jobs pipeline" hard rules.

## Generation history becomes assets (v2)

Clicking a completed image opens a per-image actions menu (`AssetActionsMenu`):

| Action | What it does |
|---|---|
| **Open** | Full-size preview (existing `ImagePreview`). |
| **Download** | Downloads the persisted PNG. |
| **Copy URL** | Copies the public marketing-assets URL to the clipboard. |
| **Add to Files** | Opens the Drive folder picker (`DriveBrowserModal`, `pick-folder`); copies the image into the chosen folder as a `files` row. |
| **Add to Record** | A 4-step picker (model → record → field → collision) that attaches the image to any record's image/file/attachment field. |
| **Create Variation** | Pins the image as the primary reference + seeds a "create a variation" prompt in the composer. |
| **Use as Next Reference** | Pins the image as the reference for the next composed turn. |

**Asset identity = promote-on-add.** A generated image lives as a public `marketing-assets` URL. The FIRST time it's added to Files or a record, `/api/image-chat/promote-asset` creates ONE `files` row for it (server-side byte copy → the private `wassel-files` bucket) and caches the resulting `files.id` back onto the message image (`MessageImage.file_id`, server-side, first-promote-wins). Every later **Add to Record** reuses that SAME id — true dedup (one files row, one storage object, many references). The chat's original marketing-assets object is never touched, so the chat copy stays intact. (Add to Files always makes a folder copy, per "copy, don't move".)

**Collision handling** (Add to Record), per target field type:

| Field type | Existing value | Prompt → result |
|---|---|---|
| `image` / `file` (single) | empty | Add → set the id |
| `image` / `file` | already set | **Replace** / Cancel |
| `multi_image` / `multi_file` (array) | any | **Add** (append, deduped) / **Replace existing** ([id]) / Cancel |
| `attachment` (AttachmentRef[]) | any | **Add** (append `{type:'file', id}`, deduped) |

Only `image`, `multi_image`, `file`, `multi_file`, `attachment` are valid targets — they store a Files-System `files.id`. (`generations_gallery` / `templates_picker` / `template_variables` are NOT targets; they're marketing-operations fields that store template ids / status maps / variable maps.)

## Key behaviors

- The whole feature is wired through a single system model: `image_chats`. Each record = one conversation. Messages live inline in `record.data.messages` (JSONB array). The list / detail routes are overridden in `App.tsx` to render `ImageChatsPage` instead of the generic record table/form.
- The right-pane composer is **bottom-pinned** and persistently visible. Its controls:
  1. **Attachment row** — every image about to be sent this turn, removable individually. Preset / snippet auto-attaches get a small ✦ badge.
  2. **Textarea** + prompt-library button (📚). Prompts are capped at **4,000 characters** (mirrors the server guard). As the user nears the cap a live `current / 4,000` counter appears (red once over); Send disables and a Send attempt is **blocked with a non-destructive toast that preserves the typed text** — the textarea is never auto-cleared on a too-long prompt.
  3. **Aspect-ratio chips** — 1:1, 9:16, 16:9, 4:3, 3:4. Remembered on the record (`last_aspect_ratio`).
  4. **Brand preset dropdown** — `[Brand: <name> ▼]`. "None" = raw prompt. "Manage presets…" routes to `/model/image_presets`.
  5. **Model dropdown** — Nano Banana 2 (default) vs GPT Image 2. Per-user-global preference in `localStorage` (`wassell_image_chat_model`).
  6. **Variations toggle** — `[1 | 4]`.
  7. **Paperclip** + **From Files** — upload images, or pick existing Drive images.
  8. **Send** — **never disabled by generation** (v2); only gated when the conversation is at its 3-in-flight cap, or briefly while an attachment uploads. ⌘/Ctrl+Enter sends.
- **Auto-chain.** Each new turn implicitly carries the most recent **completed** assistant image as a reference (`prev_image_url`). A queued/generating/failed placeholder is never used as the chain target.
- **Brand preset auto-attach** + **Snippet auto-fill** — unchanged from v1 (see the library flows below).
- **Persistent re-host.** fal.ai's result URLs expire; the worker re-uploads each output to `marketing-assets/image-chats/outputs/<user_id>/<record_id>/<uuid>.png` and stores the public URL on the assistant message. Preset/snippet attachments arrive as `files.id` UUIDs; the send endpoint permission-checks each ID via `wassell_can_access_file` under the caller's JWT, then service-role copies the bytes to `marketing-assets/image-chats/preset-copies/...` so fal.ai has a stable public URL.
- **First-visit seeding.** On first open with empty libraries, the SPA auto-creates one "Wassel default" brand preset + five starter prompt snippets. Best-effort.

## User flows

1. **Concurrent generation (the v2 headline):**
   1. Sidebar → Marketing → Image Chats → "New chat".
   2. User types "Create a luxury townhouse hero" → Send. An assistant placeholder appears immediately showing "Generating…". The composer stays live.
   3. Without waiting, the user types "Make the lighting warmer" → Send. A second placeholder appears. Then "Add Arabic typography" → Send. Three jobs run in parallel.
   4. Each placeholder fills in independently as its job completes (via Realtime) — even if the user has navigated to another conversation.
   5. At three in flight, Send is gated with a hint until one finishes.

2. **Iteration / auto-chain** — pick the keeper (most recent completed image is the auto-chain target), type "make the sky more golden", Send. Or use the menu's **Use as Next Reference** to pin a specific older image instead.

3. **Save a generation to Files:**
   1. Hover an image → ⋮ menu → **Add to Files**.
   2. Pick a folder (or create one inline) → Save. The image is copied into Files; the chat copy stays intact.

4. **Attach a generation to a record:**
   1. ⋮ menu → **Add to Record**.
   2. Pick a model (only models with an image/file/attachment field show), search for the record (search spans all fields, like Table View), pick the target field.
   3. If the field already has content, resolve the collision (Replace / Add / Replace existing). Confirm → the image is promoted to a `files.id` and set on the field; a later "saved offline / reload" toast covers the queued/conflict cases.

5. **Managing libraries** — Brand dropdown → "Manage presets…" → `/model/image_presets`; create presets with name + prompt text + multi-image assets. Same for snippets via 📚.

6. **Failure / cancel:**
   1. fal.ai NSFW flag, timeout, or 5xx → the worker writes `status='failed'` + `error` onto THAT message → a red box + Retry appear on that bubble only; siblings + the composer are unaffected.
   2. A queued/generating bubble's X cancels its job.

## Data touched

- **Reads:** `models` (resolves `image_chats`, `image_presets`, `prompt_snippets`, and any Add-to-Record target model), `records` (chats, presets, snippets, and target records), `files` (signed-URL resolution of attached images).
- **Writes:**
  - `records.data` (JSONB) for `image_chats` rows — appends user + assistant-placeholder messages, fills the placeholder, updates rollups. Server writes via `record_save` (slim endpoint + worker), with optimistic concurrency. The `file_id` dedup cache is also written server-side by the promote endpoint.
  - `generation_jobs` — one row per turn (the queue). Inserted by the slim endpoint (service-role), claimed/updated by the worker via RPCs.
  - `files` — one row per promoted image (Add to Files / first Add to Record), inserted by the promote endpoint under the caller's JWT.
  - Target `records.data` — the chosen image/file/attachment field is set by Add-to-Record via the store's `saveRecord`.
- **Storage:** `marketing-assets` bucket — `image-chats/{uploads,outputs,preset-copies}/...`. `wassel-files` private bucket — the promoted `files` rows + preset/snippet library images.
- **localStorage:** `wassell_image_chat_model` — preferred image model id.
- **External:** fal.ai queue API (`fal-ai/nano-banana-pro/edit` or `openai/gpt-image-2/edit`), called by the **worker**, not the endpoint.

## Key files

| File | What it does |
|---|---|
| `src/pages/ImageChats/ImageChatsPage.tsx` | Split-pane: conversation list (dot derives from per-message status) + right pane. First-visit seeding. |
| `src/pages/ImageChats/components/ChatThread.tsx` | Right pane. Fire-and-forget enqueue (never awaits generation), in-flight soft cap, retry/cancel, the Create-Variation / Use-as-Reference seed channel. |
| `src/pages/ImageChats/components/Composer.tsx` | Bottom composer. `atCapacity` gates only Send (never the textarea); consumes a one-shot reference/variation `seed`. Enforces the 4,000-char prompt cap before the optimistic reset (toast + keep text), with a live counter. |
| `src/pages/ImageChats/components/MessageBubble.tsx` | Per-message rendering driven by `status` (queued/generating/completed/failed/cancelled) + the per-image `AssetActionsMenu`. |
| `src/pages/ImageChats/components/AssetActionsMenu.tsx` | The click-image actions menu (Open/Download/Copy URL/Add to Files/Add to Record/Create Variation/Use as Next Reference). Portaled dropdown. |
| `src/pages/ImageChats/components/AddImageToFilesModal.tsx` | Drive folder picker → promote into folder. |
| `src/pages/ImageChats/components/AddImageToRecordModal.tsx` | 4-step model→record→field→collision picker → promote + `saveRecord`. |
| `src/lib/imageChat/client.ts` | `enqueueImageChatTurn()` (replaces the blocking `sendImageChatTurn`), `cancelImageJob()`, the `StoredMessage` / `MessageImage` types (incl. per-message status + `file_id`). |
| `src/lib/assets/promote.ts` | `promoteChatImage()` — the single client entry to `/api/image-chat/promote-asset`. |
| `src/lib/assets/recordTargets.ts` | `modelsWithImageTargets` / `compatibleTargetFields` introspection for Add-to-Record. |
| `api/image-chat/send.ts` | Slim enqueue — auth → attachment resolve → append user + placeholder → INSERT generation_jobs → /wake → 202. |
| `api/image-chat/promote-asset.ts` | Copies a chat image into `wassel-files` as a `files` row; caches `file_id` on the chat message (server-side). |
| `api/_lib/imageGen.ts` | fal.ai adapter (`imageGenChat` / `pollImageGen` / `resolveChatModelSlug`). **Copied** into `worker/src/imageGen.ts`. |
| `worker/src/runImageJob.ts` | The per-message generation pipeline on the Fly.io worker (claim → fal.ai → re-host → fill message). |
| `worker/src/index.ts` | Independent image poll loop alongside the deck loop; image watchdog tick. |
| `supabase/migrations/2026-06-08_generation_jobs_queue.sql` | The `generation_jobs` table + claim/complete/fail/cancel RPCs + watchdog. |
| `src/data/seedModels.ts` | Defines `image_chats`, `image_presets`, `prompt_snippets`. |

## Future foundation (Part 6 — documented, not built)

The promote layer is intentionally funneled through one client helper + one endpoint so it can evolve without touching callers. The end-state: a `media_assets` table (one row per logical asset, content-hash dedupe) + a `file_placements` junction (asset↔folder, asset↔record many-to-many) so one asset can live in many folders/records with **zero** byte copies; `MessageImage.file_id` becomes `media_asset_id`; the promote endpoint inserts a placement instead of copying. `generation_jobs.kind` already reserves `'video'` / `'audio'` so the same queue + worker host future generators. Not built in this pass.

## Open questions / known limitations

- **Concurrent workers are safe via optimistic concurrency** (verified live 2026-06-08; the deck app runs 5 machines). The protection is per-write version checks + retry, not a single-worker constraint. It depends on the `records_bump_version` trigger continuing to increment `version` on every `records` UPDATE — if that ever stops, concurrent writers could clobber. Documented in CLAUDE.md "Generation jobs pipeline".
- **Add-to-Record mirrored fields are out of scope.** Only local image/file/attachment fields are selectable; writing back through a `section_mirror` container isn't supported in v1.
- **No second-folder dedup.** Add-to-Files always copies into the chosen folder (single `folder_id` per file). True multi-home placement waits on the `media_assets` + `file_placements` model above.
- **Single-tenant seed race.** First-visit auto-seeding doesn't lock — two simultaneous first-opens on a fresh tenant could duplicate the "Wassel default" preset.
- **Two-model picker only.** Adding more fal models is a one-line change in `CHAT_MODELS` + a `resolveChatModelSlug` case.
- **No separate "style reference" slot / seed / negative-prompt controls** — deliberately kept out to preserve the conversational UX.
