# PRD: Image Chats

**Status:** Live
**Last updated:** 2026-05-23
**Related PRDs:** [marketing-operations.md](marketing-operations.md), [templates-library.md](templates-library.md), [navigation-layout.md](navigation-layout.md)

## What it is (in plain English)

A "mini Higgsfield" chat interface inside Wassell. The user picks a Wassel-branded conversation, types or attaches images, picks an aspect ratio + brand preset, and hits Send — Nano Banana 2 (Google's Gemini 3 Pro Image, via fal.ai) generates the image and posts it back into the conversation. Each new turn can iterate on the previous result, so the workflow feels like ChatGPT / Gemini's image-editing chat, but routed through our fal.ai integration and styled with our brand presets.

Two supporting libraries sit underneath:
- **Brand Presets** — named bundles of brand-language prompt text + reusable assets (logos, layout references). Picking one prepends the prompt to your message and auto-attaches its images.
- **Prompt Library** — named prompt snippets the user can recall instead of retyping common asks. Picking one fills the composer textarea + auto-attaches any images on the snippet.

## Why it exists

The team wants to design on-brand marketing imagery (Instagram posts, story panels, brochure heroes, photo cleanups) without leaving the CRM. Going to Higgsfield directly means re-uploading the logo every time, retyping the brand language every time, and bouncing files between tools. This bakes those reusable bits into the chat surface so producing one variation of a brand-compliant image is a one-line message.

## Key behaviors

- The whole feature is wired through a single new system model: `image_chats`. Each record = one conversation. Messages live inline in `record.data.messages` (JSONB array). The list / detail routes are overridden in `App.tsx` to render `ImageChatsPage` instead of the generic record table/form.
- The right-pane composer is **bottom-pinned** and persistently visible. Its controls (top to bottom):
  1. **Attachment row** — every image about to be sent this turn, removable individually. Preset / snippet auto-attaches get a small ✦ badge.
  2. **Textarea** + prompt-library button (📚).
  3. **Aspect-ratio chips** — 1:1, 9:16, 16:9, 4:3, 3:4. Active choice is sent to fal.ai as `aspect_ratio`. Choice is **remembered** on the record (`last_aspect_ratio`) so the next turn starts on the same setting.
  4. **Brand preset dropdown** — `[Brand: <name> ▼]`. "None" at the top means raw prompt, no brand language. "Manage presets…" at the bottom routes to `/model/image_presets`.
  5. **Variations toggle** — `[1 | 4]`. 1 = one image per turn (cheap, fast). 4 = generate four variations in a 2×2 grid (4× cost).
  6. **Paperclip** — uploads images to `marketing-assets/image-chats/uploads/`. Multi-select OK.
  7. **Send** — disabled while a turn is in flight. ⌘/Ctrl+Enter also sends.
- **Auto-chain.** Each new turn implicitly carries the **previous assistant message's primary image** as a reference (the `prev_image_url` field on the API). That's what makes it feel like a conversation — "make the sky more orange" iterates on what you just generated, without re-uploading.
- **Brand preset auto-attach.** Picking a preset adds its `images` array to the composer's attachment row (marked source: 'preset' with the ✦ badge). The user can remove any of them for a single turn — the preset's prompt text still applies; only the image is dropped for that send. Preset/snippet image fields are `multi_image` on the new Files System, so values are `files.id` UUIDs (not URLs); the composer signs a short-lived view URL for the chip thumbnail, and the raw ID is what gets sent to the server (which resolves it fresh — see "Persistent re-host" below).
- **Snippet auto-fill.** Picking a snippet from the 📚 popover fills the textarea (appending if the user already typed something) and adds the snippet's images to the attachment row (source: 'snippet').
- **Persistent re-host.** fal.ai's result URLs expire; the server re-uploads each output to `marketing-assets/image-chats/outputs/<user_id>/<record_id>/<uuid>.png` and stores the public URL on the assistant message. Downloads link to the persisted URL. Preset/snippet attachments arrive as `files.id` UUIDs (the new Files System bucket is private); the server permission-checks each ID via `wassell_can_access_file` under the caller's JWT, then service-role copies the bytes to `marketing-assets/image-chats/preset-copies/<user_id>/<record_id>/<uuid>.<ext>` so fal.ai has a stable public URL and the history persists with a non-expiring URL.
- **Status field** on the record (`status: 'idle' | 'generating' | 'failed'`) drives the right-pane spinner via Supabase Realtime. When the server flips status to 'generating' after appending the user message, the browser (any tab) sees the spinner; when it flips back to 'idle' the assistant message appears.
- **First-visit seeding.** On the first time a user opens Image Chats with empty libraries, the SPA auto-creates one "Wassel default" brand preset (with the documented Wassel brand prompt) plus five starter prompt snippets covering the four categories. Best-effort — failures are silent (the user can curate manually instead).

## User flows

1. **Main happy path — a one-shot generation:**
   1. Sidebar → Marketing → Image Chats (under the Designs group).
   2. "New chat" → empty thread with the bottom composer ready.
   3. User picks "Wassel default" from the Brand dropdown → logo and style refs auto-attach with ✦ badges.
   4. User types a prompt ("Create an Instagram launch post for Maqam 17"), optionally attaches a building photo via the paperclip.
   5. User picks aspect ratio (9:16 for story, 1:1 for feed), toggles variations to 4 if they want options, hits Send.
   6. Composer textarea resets (preset auto-attaches are preserved for the next turn). Spinner shows "Nano Banana is thinking…". Within ~30-90s the assistant message appears with the generated image(s).
   7. User clicks an image → full-size preview. Hover → Download button on each image.

2. **Iteration / auto-chain:**
   1. User picks one of the four variations as "the keeper" (just keeps typing — the most recent assistant image is the auto-chain target).
   2. User types "make the sky more golden, keep everything else the same" → Send.
   3. Server passes the previous assistant image as a reference along with the new prompt. Result preserves composition but tweaks lighting.

3. **Edit without branding:**
   1. User picks "None" from the Brand dropdown.
   2. User uploads a building photo, types "remove the cars and pedestrians", picks aspect ratio matching the source, Send.
   3. fal.ai receives the user's raw prompt with no Wassel prefix — pure cleanup.

4. **Managing libraries:**
   1. User opens the Brand dropdown → clicks "Manage presets…" → routes to `/model/image_presets`.
   2. Standard record table; user creates a new preset, fills name + description + prompt text + drag-drops a few logo assets into the multi-image `images` field.
   3. Returns to a chat; the new preset is in the dropdown immediately (Realtime hydrates the records cache).

5. **Failure flow:**
   1. fal.ai NSFW flag, timeout, or 5xx → server writes `status='failed'` + `error_message` to the record.
   2. Browser sees the status via Realtime → spinner exits, red error banner appears in the transcript with the upstream message.
   3. User edits the prompt or removes the offending attachment and tries again.

## Data touched

- **Reads:** `models` (resolves `image_chats`, `image_presets`, `prompt_snippets` ids), `records` (lists chats, presets, snippets via the SPA store).
- **Writes:** `records.data` (JSONB) for `image_chats` rows — appends to `messages`, updates `status` / `error_message` / `last_aspect_ratio` / `last_preset_id` / `message_count` / `last_message_at` / `title` (first-message-derived). Server writes via the `record_save` RPC; client writes via the standard store actions.
- **Storage:** `marketing-assets` bucket — `image-chats/uploads/<user_id>/<record_id>/...` for paperclip uploads in the composer, `image-chats/outputs/<user_id>/<record_id>/...` for persisted fal.ai outputs, `image-chats/preset-copies/<user_id>/<record_id>/...` for per-turn copies of preset/snippet attachments pulled out of the Files System. The preset/snippet `images` fields themselves live on the `wassel-files` private bucket via the Files System (`files` table) — the server resolves those IDs on send.
- **External:** fal.ai (`fal-ai/nano-banana-pro/edit`) queue API — POST → poll the status URL → fetch the response URL.

## Key files

| File | What it does |
|---|---|
| `src/pages/ImageChats/ImageChatsPage.tsx` | Top-level split-pane: conversation list + right-pane dispatcher. Owns first-visit library seeding. |
| `src/pages/ImageChats/components/ChatThread.tsx` | Right pane — header, transcript, composer mount. Calls the send API and surfaces realtime status. |
| `src/pages/ImageChats/components/Composer.tsx` | The Higgsfield-style bottom composer. Owns the per-turn state for prompt, attachments, aspect ratio, variations, preset id. |
| `src/pages/ImageChats/components/MessageBubble.tsx` | Single message rendering — user text + thumbnails / assistant image grid at the saved aspect ratio with download buttons. |
| `src/pages/ImageChats/components/BrandPresetDropdown.tsx` | `[Brand: …]` dropdown with None at the top, presets in the middle, "Manage" link at the bottom. |
| `src/pages/ImageChats/components/PromptLibraryButton.tsx` | 📚 popover trigger — filterable list of snippets, "Manage" link. |
| `src/pages/ImageChats/lib/seedDefaults.ts` | First-visit seed of the Wassel default preset + 5 starter prompt snippets. |
| `src/lib/imageChat/client.ts` | Browser-side `sendImageChatTurn()` — wraps `POST /api/image-chat/send`. |
| `src/data/seedModels.ts` | Defines the three system models: `image_chats`, `image_presets`, `prompt_snippets`. |
| `src/pages/Records/components/DynamicField.tsx` | Hosts the new `multi_image` field type (drag-drop thumbnail picker) used by the library models' `images` field. |
| `api/image-chat/send.ts` | The server orchestrator — auth → preset lookup → fal.ai → re-host → record update. |
| `api/_lib/imageGen.ts` | `imageGenChat()` helper that submits to fal.ai's `nano-banana-pro/edit` with the chat-flow parameters. |
| `src/App.tsx` | Routes `/model/image_chats` and `/model/image_chats/:recordId` to `ImageChatsPage`. |

## Open questions / known limitations

- **Single-tenant seed race.** First-visit auto-seeding doesn't lock — if two users open the page simultaneously on a fresh tenant they could each create a duplicate "Wassel default" preset. Acceptable for v1; the duplicates can be deleted manually.
- **No multi-model picker.** All turns go through Nano Banana 2 — fal.ai supports Seedream, Imagen 4, Flux Pro, Ideogram, etc., but exposing a model dropdown in the composer was deferred to v2. The env var `FAL_CHAT_MODEL_ID` lets ops swap globally without code changes.
- **No separate "style reference" slot.** Higgsfield distinguishes subject ref vs. style ref. We currently bundle everything into one attachment list — fal.ai's nano-banana-pro/edit figures roles out from the prompt. If users start wanting explicit slot semantics, that's v2.
- **No per-conversation preset override.** The Brand dropdown choice is per-turn (remembered on the record as `last_preset_id`), not "this whole chat always uses X". Could be added later as a chat-level setting.
- **Variations grid is fixed 2×2.** When the user picks 4 variations the four results render in a 2×2 grid. No drag-to-reorder or "lock this one as the next auto-chain target" yet — the most recent generation always becomes the next turn's reference.
- **No seed / negative prompt / output-format controls.** Deliberately kept out of v1 to preserve the conversational UX. Power users can express most of this in natural language.
