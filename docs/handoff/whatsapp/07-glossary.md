# 07 — Glossary

| Term | Meaning here |
|---|---|
| **WAHA** | "WhatsApp HTTP API" (devlike.pro): an open-source server that logs a phone number in as a linked device and exposes REST + webhooks. Unofficial client. |
| **Engine** | WAHA's underlying WhatsApp client library. `GOWS` (Go/whatsmeow, current), `NOWEB` (Baileys, refused by WhatsApp since 2026-07-29), `WEBJS` (Chromium, QR-only). Session registries are per engine. |
| **Session** | One WAHA login = one phone number. Named `sales`, `wassel_ops`, … The CRM stores the session name in `device_id` columns. |
| **device_id** | Historical column name from the previous vendor; for WAHA it holds the session name. Opaque string everywhere. |
| **Linked device / companion** | WhatsApp's term for a secondary login (web, desktop, or WAHA). One number can have a few; a forgotten one keeps receiving events. |
| **Pairing code** | 8-character code from `POST /api/{session}/auth/request-code`, typed under Linked Devices → Link with phone number. Expires in ~2 minutes. |
| **wid** | WhatsApp id. A chat wid is `<digits>@c.us` (phone) or `<n>@lid`; groups are `@g.us`; status/broadcast are excluded. |
| **LID** | "Linked identity": an opaque per-account identifier WhatsApp now uses instead of the phone in many payloads. Resolved to a phone via `SenderAlt`/`RecipientAlt` or `GET /api/{session}/lids/{lid}`. |
| **Message id / hash** | Serialized id `<fromMe>_<chatId>_<HASH>`. The HASH is WhatsApp's own message id and the only stable identity (`message_hash`). |
| **CHATS_NAMESPACE** | The uuidv5 namespace that turns a chat wid into the conversation record id. Duplicated in three files; never change. |
| **Conversation record** | A row of the `chats` model in `records` (JSONB). Created by the webhook on first contact. |
| **ack** | Delivery state of a message WE sent: pending → sent → delivered → read/played, or failed. Meaningless on inbound (stored null). |
| **flow** | `in` (customer → us) / `out` (us → customer). |
| **Echo** | The `message.any` event with `fromMe=true` that the gateway emits for our own outbound message. Merged by hash into the row written at send time. |
| **`wt_` / `wf_` / `wm_`** | Media ref prefixes: temp outbound object in our bucket; file on the gateway's disk; mirrored copy in our bucket. |
| **Relay / proxy** | `/waha/*` on the Fly worker (fallback: the agent app) that forwards app calls to the gateway with the real API key. Exists because WAHA 403s Vercel's egress. |
| **`WHATSAPP_AI_SECRET`** | Shared secret used both by the relay (`x-wassel-proxy-secret`) and by headless bot endpoints (`x-wassel-ai-secret`). |
| **HMAC webhook** | Gateway signs each delivery: `X-Webhook-Hmac` = HMAC-SHA512 hex over the raw body with `WAHA_WEBHOOK_SECRET`. |
| **Scheduled send / queue** | `scheduled_whatsapp_jobs`: our own delivery-time queue drained by the worker, because WAHA has none. Also carries bot, gallery, alert, and PDF sends. |
| **Budget** | `whatsapp_send_budget`: per-number max sends per minute/hour, enforced at claim time. |
| **Unknown send** | Queue status when the outcome could not be determined; must be reconciled against the gateway store before any resend. |
| **463** | WhatsApp server error on send: cold-outreach time-lock for contacts we hold no token for. Do not retry; message once from the phone. |
| **405** | WhatsApp login refusal for the stored companion credentials or the engine. Not credentials, not IP, if a credential-free session is refused too. |
| **401 / 515 / 440** | Logged out (re-pair) / restart required / connection replaced. |
| **Watchdog (session)** | Worker loop that restarts a non-WORKING session behind a fleet-wide lock, verifies, stops it if still broken, with backoff. |
| **Watchdog (queue)** | `scheduled_whatsapp_watchdog`: sweeps jobs stuck in `running`. |
| **Sales line / operations line** | `is_default` number (customers, funnel, bot) vs `is_operations` number (officers, contacts, owner alerts). |
| **Gate** | `whatsapp_ai_should_reply(chat_wid)`: the SQL policy check every bot send passes. |
| **Takeover / ai_managed** | Per-chat flag (via `/api/whatsapp/ai-handover`) that lets the bot own a conversation regardless of schedule. |
| **Basic responder** | Deterministic first-touch bot on Vercel (`basic-reply.ts`). |
| **Agent / runner** | `wassel-wa-agent`: one machine that runs a real headless Claude Code session per conversation for replies. |
| **Lease** | `claude_runner_lease`: DB singleton lock so only one agent process drains jobs. |
| **Activity bridge** | `reconcile_inbound_whatsapp` / `reconcile_outbound_whatsapp`: keeps sales follow-up tasks in step with WhatsApp traffic. |
| **Owner / client_owner** | The rep responsible for a client; mirrored onto the chat record; target of inbound push alerts. |
| **Notify officer** | Rep action that messages a project's officer from the operations line. |
| **Push** | Web Push to a rep's browser/phone (`push_outbox`), used for owner alerts. Not WhatsApp. |
| **DLQ** | `haberchat_webhook_dlq`: webhook events whose handler threw, kept for replay. |
| **Haberchat** | The retired hosted gateway (Wassenger white-label). Its name survives in routes and types. |
| **Realtime echo-dedup** | `src/lib/realtime/dedup.ts`: suppresses the browser's own writes coming back over Realtime; the reason servers, not browsers, write chat rows. |
