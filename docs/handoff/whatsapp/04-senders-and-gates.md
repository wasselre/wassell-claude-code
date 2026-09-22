# 04 — Who sends, to whom, through which gate

Every outbound WhatsApp message in this system belongs to exactly one of the rows below.
"Line" is the `whatsapp_numbers` role the message leaves on. "Path" is the code path.
"Gate" is what can stop it. "Audit" is where the fact that it happened is recorded.

| # | Sender | Recipient | Line | Path | Gate | Audit |
|---|---|---|---|---|---|---|
| 1 | A rep typing in the Chats inbox | A customer / contact / officer in a conversation they can see | last-seen device, else `is_default` | Composer → `POST /api/haberchat/messages` → `authorizeWhatsappSend` → gateway (immediate) or queue (`deliverAt`) | RLS on the conversation; `create` on chats for a new conversation; per-user window (60 / 5 min default) | `activity_log` (masked phone), `chat_messages` row written at send time |
| 2 | A rep sending a project package, gallery, brochure, units PDF, payment plans | Same as 1 | same | UI flows → `POST /api/whatsapp/send-media-batch` (+ `upload-url` for bytes) → `scheduled_whatsapp_jobs` | Same as 1 plus the per-number budget | Queue rows + `chat_messages` echoes |
| 3 | Basic first-touch bot (deterministic, Vercel) | A NEW inbound customer on the sales line | `is_default` | webhook → `POST /api/whatsapp/basic-reply` → `enqueueAiReply` / `sendProjectViaAiFlow` → queue | `whatsapp_ai_should_reply`: kill switch, schedule, human active, reply cap; deterministic project/unit hits bypass only hours + cap, never kill switch or human-active; never on the ops line | `whatsapp_ai_replies` (text), queue rows |
| 4 | Full AI agent (headless Claude Code on `wassel-wa-agent`) | A customer whose chat is `ai_managed` or when `responder_mode='agent'` | `is_default` | `whatsapp_ai_enqueue` → `claude_jobs` → runner → skill → `tools/send.mjs` / `project-flow.mjs` → `/api/whatsapp/ai-send*` → queue | Same gate re-checked immediately before each send; one machine + DB lease; 8-minute session timeout | `whatsapp_ai_replies`, `claude_jobs`, session transcript on the volume |
| 5 | Unit one-pager PDF (worker render machine) | Customer who sent a unit code | `is_default` | basic-reply → `unit_pdf_job_enqueue` → `runUnitPdfJob` → `scheduled_whatsapp_enqueue` (document) | Preceded by an audited intro text so the gate still recognises the bot | Queue rows |
| 6 | Notify officer (rep action in a chat) | A project officer / developer / marketer contact | **`is_operations`** | `NotifyOfficerModal` → `POST /api/whatsapp/notify-officer` → `resolveOperationsDeviceId` → gateway | JWT; 409 if no operations number is designated (no fallback to sales) | `activity_log`, `chat_messages` on the ops conversation |
| 7 | Cost / balance alerts | The owner's number in `ai_alert_settings.whatsapp_to` | `is_operations` (default `wassel_ops`) | `ai_balance_alerts_evaluate()` ← hourly cron `api/cron/ai-balance-probe.ts` and the worker probe tick → `scheduled_whatsapp_enqueue` | `ai_alert_settings.enabled`; one message per threshold crossing (row lock); state flips even with no recipient configured | `ai_balance_alert_state` (per provider), queue rows |
| 8 | Notifications platform (workflow steps, sweeps, mentions, digests) | Reps by role or user id | `is_default` (via the gateway layer's default resolver) | `notify_emit(..., channels)` → `notification_deliveries` → worker → `POST /api/internal/send-notification-wa` → gateway | Role × event × channel grid; per-step channel mask can only narrow; `mos_settings.external_effects` kill switch (skipped rows kept) | `notification_deliveries` status, `notifications` row |
| 9 | Claude in an interactive Claude Code session (drafting for the operator) | Business contacts, relationship managers, the owner | `is_operations` | Same `scheduled_whatsapp_enqueue` RPC (service role) on `wassel_ops` | **Human gate:** the operator must see the exact text, recipient and line, and say SEND / أرسل. No exceptions (`docs/ops-whatsapp-personal-style.md`) | Queue rows, `chat_messages` echo |
| 10 | Scheduled sends set by a rep (`SchedulePopover`) | Same as 1 | same | `maybeScheduleWaha` → queue with `deliver_at` | Same as 1 at enqueue time; the worker re-resolves a retired device to the active default | Queue rows, visible/cancellable in the chat's scheduled strip |

Things that look like senders but are NOT WhatsApp sends:

- **Owner alerts on inbound** (bell, toast, Web Push) — push, not WhatsApp (`push_outbox`).
- **`/api/whatsapp/ai-notify`** — writes `ai_notifications` for a human; sends nothing.
- **Lead-portal registration from a chat** — drives a browser to a developer's portal; no message.
- **Follow-up Queue suggestions** — drafts the rep can send; the send is row 1.

## The gates in one place

| Gate | Where | What it decides |
|---|---|---|
| RLS on the conversation | `authorizeWhatsappSend` with the caller's JWT | Can this user address this chat at all |
| `create` on the chats model | same | Can this user start a new conversation (cold outreach) |
| Per-user window | same, env `WHATSAPP_SEND_RATE_WINDOW_MIN` / `WHATSAPP_SEND_RATE_MAX` | Runaway/abuse ceiling, not pacing |
| Per-number budget | `whatsapp_send_budget` inside `scheduled_whatsapp_claim_due` | Pacing so the number is not flagged as spam |
| `is_active` on the number | `whatsapp_numbers` | Master off switch per number (queue + watchdog) |
| `whatsapp_ai_should_reply` | SQL, called by every bot send path | Whether a robot may talk to this customer right now |
| Global bot kill switch | `whatsapp_ai_settings.is_enabled` | Overrides even a per-chat takeover |
| Per-chat takeover | `records.data.ai_managed` via `/api/whatsapp/ai-handover` | Human assigned the bot; schedule ignored |
| `is_operations` routing | `resolveOperationsDeviceId`, webhook `isOperationsSession` | Keeps internal traffic off the sales number and out of the funnel |
| `external_effects` | `mos_settings` | Notifications platform push + WhatsApp on/off |
| `ai_alert_settings.enabled` | singleton row | Cost alerts on/off |
| The operator's SEND | Human, for row 9 | Nothing personal leaves the ops line unseen |
| WhatsApp itself | error 463 (cold contact time-lock), 405 (login refused), bans | Not under our control; the runbook says how to read each |
