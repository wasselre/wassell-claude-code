# PRD: Calling (Hatif integration)

**Status:** Live
**Last updated:** 2026-04-25
**Related PRDs:** [record-management.md](record-management.md), [data-storage.md](data-storage.md)

## What it is (in plain English)
Every voice call that Hatif's platform sees on one of our channels — inbound from a customer, automated outbound (IVR) triggered by our app, or a live call an agent places from Hatif's own mobile/desktop app — lands as a logged row in the CRM. When a staff member opens a client record, they see every past call with that client: who placed it, when, how long, whether it was answered, an AI-generated summary, the sentiment, an audio player for the recording, and the full transcript. New calls stream in live — no refresh needed.

Each call also appears as a first-class record in the **المكالمات (Phone Calls)** model, so staff can browse all calls in the sidebar, build custom views, filter by direction/status/sentiment, and — most importantly — **workflows can trigger on calls** (e.g. "when a missed incoming call arrives, create a follow-up on the linked client"). The full transcription/recording data still lives in the dedicated `call_logs` table; the phone_calls record is a lightweight searchable index.

## Why it exists
Before this, the phone icon on a record was a plain `tel:` link: the agent's native dialer handled the call and nothing was recorded in the CRM. Follow-up quality suffered because every call was a black box. Logging through Hatif gives us searchable, accountable, AI-annotated call history attached to the customer record — the same way chat messages already are.

## Key behaviors
- Any call on a Hatif channel fires a post-call webhook → [api/webhook/hatif-call.ts](../../api/webhook/hatif-call.ts) → upserts into **two places**, both keyed by Hatif's `callId`:
  1. `call_logs` — rich data (word-level transcription, evaluation array, raw event JSON).
  2. `records` under the `phone_calls` model — lightweight header (direction, status, summary, sentiment, duration, DTMF, recording URL, auto-linked `client_link`).
- Retries are idempotent on both tables (`onConflict: id`).
- Auth on the webhook is **either** an `X-Voxa-Signature` HMAC-SHA256 header **or** a `?secret=` URL param (fallback for initial setup before Hatif's team enables signing).
- The customer's phone is normalized to canonical E.164 and stored as `contact_phone`. The UI queries by `contact_phone = <record's phone field>`, so the match is done at read time, not write time. A call still appears on a client who was created *after* the call happened.
- `CallHistoryPanel` renders below the form on any record whose model has one or more `phone` fields — we pass every non-empty phone value on the record to the panel and dedupe by call id.
- Realtime is enabled on `call_logs`, so the panel refreshes the moment a new webhook lands while the page is open.
- Integer codes from Hatif (`status`, `type`, `sentiment`) are mapped to readable string enums (`completed`, `missed`, `positive`, …) in [api/_lib/hatif.ts](../../api/_lib/hatif.ts); the SPA only sees strings.
- **Client auto-link:** when the webhook writes a `phone_calls` record, it looks up a client record whose `phone_number` matches the normalized `contact_phone` and sets `client_link` to that record id. Best-effort — if no match, `client_link` stays empty and the call is still logged.
- **Workflow triggers on calls:** any `create_record` trigger on `phone_calls` fires when the webhook upserts. Combined with conditions (`direction`, `status`, `sentiment`, `duration_seconds`, `dtmf_digit`), this covers every "trigger on call X" scenario without a dedicated trigger type. Example: a missed-incoming-call workflow is `trigger: create on phone_calls, conditions: direction = incoming AND status IN (missed, no_answer)`.
- Call duration is parsed from Hatif's `HH:MM:SS` string into an integer seconds column for easy filtering/sorting.
- The raw webhook JSON is kept in `raw_event` for forensics / schema drift / replay.
- Webhook URL configuration is **self-service** in Hatif's admin dashboard — each channel has a "رابط Webhook ما بعد المكالمة" (post-call webhook) field admins can edit directly. No Hatif-team involvement needed.

## User flows
1. **Main happy path (customer receives or places a call on our channel):**
   a. Call ends → Hatif POSTs the event to `/api/webhook/hatif-call?secret=…` (or with HMAC header).
   b. Handler verifies auth → normalizes fields → upserts into `call_logs`.
   c. Realtime fires → any open `CallHistoryPanel` subscribed to that phone re-fetches → new row appears at the top of the list.
   d. Staff opens the client's record → sees the call with summary, sentiment badge, audio player, transcript, agent name.
2. **Retry flow:** Hatif retries a failed webhook up to 5 times (2/4/8/16/32 min backoff). The `onConflict: id` upsert makes the retried write a no-op when the earlier one succeeded.
3. **Phone not yet on any client:** the call row is still written (`contact_phone` stored, no joined record). When a staff member later creates a client with that phone, the panel on the new record will show the historical call automatically.
4. **Empty state:** a record with zero phone fields → the panel doesn't render. A record with phone fields but no calls → panel shows "No calls logged for this client yet."

## Data touched
- **Writes (webhook handler, service-role key):**
  - `call_logs` (one row per call — rich audio/AI data).
  - `records` (one row per call under the `phone_calls` model — lightweight header + client link). Same id as `call_logs.id` so they can be cross-referenced.
- **Reads for client match (webhook, service-role):** `records` filtered by `model_id = clients AND data->>phone_number = <contact_phone>`.
- **Reads (SPA, authenticated JWT):** `call_logs` filtered by `contact_phone` for the Call History panel, and standard record queries against `phone_calls` for the sidebar list / workflows.

## Key files
| File | What it does |
|---|---|
| [supabase/schema.sql](../../supabase/schema.sql) | `call_logs` table + indexes + RLS + Realtime publication |
| [api/_lib/hatif.ts](../../api/_lib/hatif.ts) | OAuth2 token cache, enum mappers, E.164 normalizer, HMAC verify |
| [api/webhook/hatif-call.ts](../../api/webhook/hatif-call.ts) | Webhook entry point — auth → normalize → upsert |
| [api/_lib/supabaseServer.ts](../../api/_lib/supabaseServer.ts) | Service-role client used by the webhook (bypasses RLS) |
| [src/lib/hatif/client.ts](../../src/lib/hatif/client.ts) | Browser read helpers + Realtime subscription |
| [src/pages/Records/components/CallHistoryPanel.tsx](../../src/pages/Records/components/CallHistoryPanel.tsx) | UI on client records |
| [src/pages/Records/RecordFormPage.tsx](../../src/pages/Records/RecordFormPage.tsx) | Hosts the panel below the form |
| [src/types/index.ts](../../src/types/index.ts) | `CallLog`, `CallStatus`, `CallSentiment`, `CallTranscription`, `WorkflowActionOutboundIvr`, `OutboundIvrDestination` |
| [src/data/seedModels.ts](../../src/data/seedModels.ts) | `phoneCallsModel` — the system-level `phone_calls` model wired into `SEED_MODELS` |
| [api/hatif/outbound-ivr.ts](../../api/hatif/outbound-ivr.ts) | Proxy that triggers a Hatif outbound IVR call |
| [api/hatif/upload-audio.ts](../../api/hatif/upload-audio.ts) | Proxy that uploads an audio file to Hatif |
| [src/pages/Workflow/components/ActionList.tsx](../../src/pages/Workflow/components/ActionList.tsx) | `OutboundIvrConfig` editor for the `outbound_ivr` workflow action |
| [src/lib/workflowEngine.ts](../../src/lib/workflowEngine.ts) | `case 'outbound_ivr'` — resolves templates + calls the proxy |

## Environment variables
| Name | Purpose |
|---|---|
| `HATIF_CLIENT_ID` / `HATIF_CLIENT_SECRET` | OAuth2 credentials for `POST /connect/token` (scope `VoxaAPI`) |
| `HATIF_DEFAULT_CHANNEL_ID` | Optional default channel id for future outbound endpoints |
| `HATIF_WEBHOOK_SECRET` | Shared secret — used for HMAC verify and the `?secret=` fallback |

## Outbound automated calls (IVR via workflow action)
The `outbound_ivr` workflow action (see [workflow-automation.md](workflow-automation.md)) fires a Hatif IVR call at a phone on the trigger record. The workflow engine resolves `{field_slug}` tokens in the TTS text, picks the channel (falling back to `HATIF_DEFAULT_CHANNEL_ID`), attaches the current user's Supabase JWT, and POSTs to `/api/hatif/outbound-ivr`. The proxy fills in the webhook URL (always our `/api/webhook/hatif-call`), obtains a server-side OAuth token, and forwards to Hatif. When the customer picks a digit, Hatif fires the post-call webhook with `selectedDigit`/`selectedOption` fields; the handler stores them in `call_logs.dtmf_digit` + `call_logs.dtmf_label`, which the Call History panel renders as a badge next to the call row.

Audio source on the action is either **TTS** (with `{field_slug}` tokens + Male/Female voice + ar/en language hint) or a **pre-uploaded audio file**. Uploading happens inline from the action editor — the file goes through `/api/hatif/upload-audio` to Hatif's `POST /v1/support/upload-audio`, and the returned URL is stored on the action config. Hatif auto-converts any format up to 10 MB into WAV 8 kHz mono.

## Open questions / known limitations
- **No live-call initiation in v1.** Hatif's documented API does not expose a "ring agent + bridge customer" endpoint or a WebRTC/SIP browser SDK. The only programmatic outbound call is `POST /v1/outbound-ivr` (automated recording/TTS + DTMF) — available via the `outbound_ivr` workflow action. The "Call" button on records remains a plain `tel:` link until Hatif confirms a click-to-call-bridge exists.
- **Webhook registration is per-channel.** Admins must set the post-call webhook URL on every new channel in Hatif's dashboard. No automation yet — a workflow that enumerates channels + pushes a known URL could close this gap.
- **Client-matching is phone-exact.** Two clients with the same phone both see the call. Format drift (spaces, country-code variants) is handled by normalizing to E.164 on both sides.
- **No retention policy.** Rows accumulate forever; when volume warrants, add a cron that archives rows older than N months to cold storage.
- **Agent identity is Hatif's `userId`.** We don't yet map Hatif users to CRM users, so `agent_name` is shown verbatim from the payload. A future mapping table would enable per-agent dashboards inside the CRM.
