# PRD: Calling (Hatif integration)

**Status:** Live
**Last updated:** 2026-04-23
**Related PRDs:** [record-management.md](record-management.md), [data-storage.md](data-storage.md)

## What it is (in plain English)
Every voice call that Hatif's platform sees on one of our channels — inbound from a customer, automated outbound (IVR) triggered by our app, or a live call an agent places from Hatif's own mobile/desktop app — lands as a logged row in the CRM. When a staff member opens a client record, they see every past call with that client: who placed it, when, how long, whether it was answered, an AI-generated summary, the sentiment, an audio player for the recording, and the full transcript. New calls stream in live — no refresh needed.

## Why it exists
Before this, the phone icon on a record was a plain `tel:` link: the agent's native dialer handled the call and nothing was recorded in the CRM. Follow-up quality suffered because every call was a black box. Logging through Hatif gives us searchable, accountable, AI-annotated call history attached to the customer record — the same way chat messages already are.

## Key behaviors
- Any call on a Hatif channel fires a post-call webhook → [api/webhook/hatif-call.ts](../../api/webhook/hatif-call.ts) → upsert into `call_logs` keyed by Hatif's `callId` (retries are idempotent).
- Auth on the webhook is **either** an `X-Voxa-Signature` HMAC-SHA256 header **or** a `?secret=` URL param (fallback for initial setup before Hatif's team enables signing).
- The customer's phone is normalized to canonical E.164 and stored as `contact_phone`. The UI queries by `contact_phone = <record's phone field>`, so the match is done at read time, not write time. A call still appears on a client who was created *after* the call happened.
- `CallHistoryPanel` renders below the form on any record whose model has one or more `phone` fields — we pass every non-empty phone value on the record to the panel and dedupe by call id.
- Realtime is enabled on `call_logs`, so the panel refreshes the moment a new webhook lands while the page is open.
- Integer codes from Hatif (`status`, `type`, `sentiment`) are mapped to readable string enums (`completed`, `missed`, `positive`, …) in [api/_lib/hatif.ts](../../api/_lib/hatif.ts); the SPA only sees strings.
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
- **Writes (webhook handler, service-role key):** `call_logs` (one row per call).
- **Reads (SPA, authenticated JWT):** `call_logs` filtered by `contact_phone`, with Realtime subscription.
- **Not touched:** the no-code `records` / `models` tables — calling does not surface in the model builder; it's a dedicated table like `chat_messages`.

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
| [src/types/index.ts](../../src/types/index.ts) | `CallLog`, `CallStatus`, `CallSentiment`, `CallTranscription` |

## Environment variables
| Name | Purpose |
|---|---|
| `HATIF_CLIENT_ID` / `HATIF_CLIENT_SECRET` | OAuth2 credentials for `POST /connect/token` (scope `VoxaAPI`) |
| `HATIF_DEFAULT_CHANNEL_ID` | Optional default channel id for future outbound endpoints |
| `HATIF_WEBHOOK_SECRET` | Shared secret — used for HMAC verify and the `?secret=` fallback |

## Open questions / known limitations
- **No live-call initiation in v1.** Hatif's documented API does not expose a "ring agent + bridge customer" endpoint or a WebRTC/SIP browser SDK. The only programmatic outbound call is `POST /v1/outbound-ivr` (automated recording/TTS + DTMF) — not a human-to-human call. The "Call" button on records remains a plain `tel:` link until Hatif confirms a click-to-call-bridge exists or we integrate IVR as a separate action.
- **Webhook registration is per-channel.** Admins must set the post-call webhook URL on every new channel in Hatif's dashboard. No automation yet — a workflow that enumerates channels + pushes a known URL could close this gap.
- **Client-matching is phone-exact.** Two clients with the same phone both see the call. Format drift (spaces, country-code variants) is handled by normalizing to E.164 on both sides.
- **No retention policy.** Rows accumulate forever; when volume warrants, add a cron that archives rows older than N months to cold storage.
- **Agent identity is Hatif's `userId`.** We don't yet map Hatif users to CRM users, so `agent_name` is shown verbatim from the payload. A future mapping table would enable per-agent dashboards inside the CRM.
