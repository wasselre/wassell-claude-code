# 01 — Architecture: how a message travels

All paths are relative to the repository root. Function names are the exported names in those
files. "Gateway" means the WAHA instance; "worker" means the Fly app `wassel-deck-worker`;
"agent" means the Fly app `wassel-wa-agent`.

---

## 1. The gateway and its sessions

- **What:** [WAHA](https://waha.devlike.pro) (WhatsApp HTTP API), Docker image `devlikeapro/waha`,
  engine **GOWS** (switched from NOWEB on 2026-07-29 after WhatsApp began refusing NOWEB logins
  with reason 405). Runs on a GCP VM in Doha (`me-central1-a`), container `wassel-waha`,
  `--restart always`, credentials on a Docker volume so a container rebuild keeps the pairing.
- **Why Doha:** WhatsApp geolocates a linked device by the IP block's registered owner. Linking
  a Saudi number from a US-registered IP (the first host, on Fly) tripped its account-takeover
  heuristics: "this device might be a scammer", refused links, aggressive drops, 429 on pairing
  requests. A Gulf IP removed the mismatch (proven 2026-07-23, cut over 2026-07-24).
- **Sessions:** one WAHA session per phone number. A session name is what the rest of the CRM
  stores in `device_id` columns (an opaque string inherited from the previous vendor). Live rows
  in `whatsapp_numbers` on 2026-09-22:

  | session (`device_id`) | phone | role | active |
  |---|---|---|---|
  | `sales` | +966556546238 | `is_default` — customers, the sales funnel | yes |
  | `wassel_ops` | +966554620315 | `is_operations` — officers, business contacts, alerts | yes |
  | `bridge` | +966533716189 | none (kept for history) | no |
  | `wassel_main` | +966556546238 | superseded first pairing (kept for history) | no |

- **Pairing:** `POST /api/{session}/auth/request-code {phoneNumber}` returns an 8-character code
  the operator types under WhatsApp → Linked Devices → Link with phone number. Codes expire in
  about two minutes; the working recipe is delete session → recreate → wait for `SCAN_QR_CODE`
  → request code → type it at once. QR pairing also works. After a re-pair, unlink the old device
  on the phone, or it keeps reporting every message a second time.
- **Webhook registration is per session** and is done by the CRM itself when it creates a
  session (`api/_lib/waha.ts#createSession`): URL `https://app.wassel.re/api/webhook/waha`,
  the event list, `hmac.key = WAHA_WEBHOOK_SECRET`, retries ×6. Recreating a session on the
  gateway by hand without the full webhook config makes the CRM deaf.
- **HTTPS:** Caddy on the VM terminates TLS at `https://34-18-15-250.sslip.io` (Let's Encrypt).
  Vercel's edge runtime refuses plain-HTTP fetches to a bare IP and reports it as a confusing
  403, so HTTPS is required, not cosmetic. Port 3000 is still reachable in plain HTTP behind
  the API key; the runbook lists closing it as an open item.

## 2. Reaching the gateway from the app: the relay

- WAHA refuses Vercel's egress with 403 (verified 2026-07-26: same key, 200 from Fly, 403 from a
  Vercel function). So every call from the app goes through a reverse proxy on the worker:
  `GET/POST https://<WAHA_PROXY_URL>/waha/<waha path>` with header
  `x-wassel-proxy-secret: <WHATSAPP_AI_SECRET>`. The worker forwards it to `WAHA_URL` with the
  real `X-Api-Key`. Code: `worker/src/index.ts#handleWahaProxy`.
- The app-side adapter `api/_lib/waha.ts` swaps its base URL to the proxy whenever
  `WAHA_PROXY_URL` is set (`wahaUrl()`), so no caller knows the relay exists.
- The proxy lives on the five-machine worker for availability. It used to live on the agent,
  which runs exactly one machine on purpose, so every agent deploy took WhatsApp down. The
  agent still serves `/waha/*` as a fallback (`wa-agent/runner.mjs`).
- `api/_lib/whatsappGateway.ts` is the shared surface every sender calls: `sendMessage`,
  `listChats`, `listMessages`, `uploadFile`, `downloadFile`, `patchChat`, plus the two device
  resolvers `resolveDefaultDeviceId()` (the `is_default` active row) and
  `resolveOperationsDeviceId()` (the `is_operations` active row; returns `null` rather than
  falling back to sales). The `api/haberchat/*` route names are historical; they are the live
  WhatsApp proxies for the browser.

## 3. Inbound: gateway → database → browser

Handler: `api/webhook/waha.ts` (Vercel edge). Shared ingest helpers: `api/_lib/chatIngest.ts`.

1. **Verify.** Read the raw body once; check `X-Webhook-Hmac` = hex HMAC-SHA512 of the raw bytes
   with `WAHA_WEBHOOK_SECRET`. Bad signature → 401.
2. **Dedupe in-instance** on `<event type>:<event id>`. The type must be part of the key:
   WhatsApp emits an inbound message as both `message` and `message.any` with one envelope id;
   keying on the id alone once made inbound messages vanish while outbound worked.
3. **Route by event.** Only `message.any` writes messages (it is the superset, including our own
   outbound echoes). `message.ack` updates delivery state. `message.reaction`, `message.revoked`,
   `message.edited` patch the row. `message` and `session.status` are no-ops.
   A session name with no active `whatsapp_numbers` row is logged as
   `events from UNREGISTERED session` (a stray old companion device).
4. **Identify the counterparty** (`handleMessage`). Skip status posts and broadcasts. Decide if
   the session is the operations line (`isOperationsSession`). Resolve the phone with the ladder:
   chat id embedded in the message id (`<fromMe>_<chatId>_<HASH>`) → `_data.Info.SenderAlt` or
   `RecipientAlt` → `GET /api/{session}/lids/{lid}` (cached, `resolveLidToPhone`). GOWS often
   reports the sender as an opaque LID (`<n>@lid`), and the CRM's client matching is by phone.
   If the phone cannot be resolved, key the conversation by LID rather than dropping the message.
5. **Canonical ids.** `chat_wid = <digits>@c.us`; conversation record id =
   `uuidv5(chat_wid, CHATS_NAMESPACE)`. The namespace constant is duplicated in three files
   (`chatIngest.ts`, the legacy `api/webhook/haberchat.ts`, `src/lib/haberchat/normalize.ts`)
   and must never change.
6. **Media.** Inbound media hosted on the gateway disk is mirrored at webhook time into the
   `wassel-files` bucket under `whatsapp-media/<session>/<file>` (`mirrorWahaHostedMedia`,
   with retry so voice notes are not lost). The stored ref becomes `wm_…`.
7. **Write.** `upsertChatMessage` inserts the row or merges a differently-addressed copy of the
   same message (hash match, same direction). `bumpConversationRecord` creates the chats record
   on first contact, updates preview/recency/unread, resolves `client_link` by phone, refreshes
   the name from the push name, and reopens a closed chat only on a customer message.
8. **Sales-funnel hooks** (skipped when the session is the operations line):
   - Click-to-WhatsApp ad referral → `attachAdResolution` → `chat_messages.meta.ad`; an
     ad-resolved opening message calls `mos_capture_ad_acquisition` (find-or-create the client).
   - Activity bridge: `reconcile_inbound_whatsapp` / `reconcile_outbound_whatsapp` keep the
     client's follow-up tasks in step with the conversation (see `04-senders-and-gates.md`).
   - First-touch bot: on a new inbound message with a resolved phone, fire-and-forget
     `POST /api/whatsapp/basic-reply` (shared secret). A webhook retry sees `isNew=false` and
     skips, so retries cannot double-reply.
9. **Receipt and failure.** Every event is logged to `activity_log` (category `webhook`,
   status success/error). A handler exception writes the event to `haberchat_webhook_dlq` and
   still returns 200, so the gateway does not retry a poison event forever.
10. **Fan-out by database triggers.** `chat_messages_enqueue_push` (AFTER INSERT, flow=`in`)
    resolves the client's owner and enqueues a `push_outbox` row; `tg_records_fill_chat_client_owner`
    mirrors the linked client's owner onto the chats record for per-rep visibility.
11. **Browser.** Supabase Realtime pushes the `records` and `chat_messages` changes; the SPA's
    `RealtimeOrchestrator` merges them into the store. `src/lib/realtime/dedup.ts` suppresses
    echoes of the browser's own writes, which is why servers, not browsers, must write chat rows.

## 4. Outbound from a human in the browser

1. `src/pages/Chats/components/Composer.tsx` → store action → `src/lib/haberchat/client.ts`
   attaches the Supabase JWT and calls `POST /api/haberchat/messages`.
2. `api/haberchat/messages.ts` resolves the device (`sendDeviceId`: the device the chat was last
   seen on, or the active default if that session was retired), then
   `api/_lib/whatsappSendAuth.ts#authorizeWhatsappSend`:
   - the conversation is looked up with the **caller's own JWT**, so RLS decides;
   - no conversation yet → needs `create` on the chats model (cold outreach is a privilege);
   - per-user window (default 60 sends per 5 minutes, env-tunable) as an abuse ceiling;
   - `findPriorSendByReference` makes the client's idempotency key safe to retry.
3. Immediate send → `whatsappGateway.sendMessage` → adapter → proxy → gateway.
   Then `recordOutboundMessage` writes the `chat_messages` row at once (a sent message is a fact
   the database knows before the echo arrives; the echo merges by hash). `logSendAttempt`
   records who sent to which client with the phone masked, whatever the outcome.
4. With `deliverAt` → `maybeScheduleWaha` → `scheduled_whatsapp_enqueue` (section 5).
5. **Attachments** never pass through Vercel: `POST /api/whatsapp/upload-url` mints a signed
   upload URL into `wassel-files/waha-outbound/<uuid>.<ext>` (ref `wt_<path>`); the send resolves
   the ref to a short-lived signed download URL that WAHA fetches server-side. Galleries and
   brochures go through `POST /api/whatsapp/send-media-batch`, which enqueues ordered queue rows
   so a browser refresh mid-gallery cannot lose the rest. Outbound media is mirrored at send time.
6. The UI keeps typing unblocked: progress is per optimistic bubble, a failed send stays in the
   thread outlined red with Retry, and later sends in the same conversation wait behind an
   in-flight gallery (per-conversation send lane).

## 5. The send queue and the worker

- Table `scheduled_whatsapp_jobs`; RPCs `scheduled_whatsapp_enqueue / _claim_due / _complete /
  _fail / _requeue / _cancel / _list_for_chat / _watchdog` (`supabase/migrations/2026-07-18_scheduled_whatsapp_jobs_queue.sql`
  and later).
- Worker loop `scheduledWhatsappPollLoop` in `worker/src/index.ts`: `_claim_due` returns only
  rows whose `deliver_at` has passed, `FOR UPDATE SKIP LOCKED` so five machines never double-claim,
  and it honours the per-number budget in `whatsapp_send_budget` (defaults 40/minute, 600/hour,
  derived from this account's own measured peak). `runScheduledWhatsappJob`
  (`worker/src/runScheduledWhatsappJob.ts`) sends the text then each media item via the
  send-only client `worker/src/waha.ts` (a copy of the send half of `api/_lib/waha.ts`).
- Failure semantics: a failure after any part was delivered is **not retryable**; transient
  errors requeue; WhatsApp error 463 (cold-outreach lock) fails once with a clear reason and
  surfaces a failed bubble; a job whose outcome cannot be known lands in `status='unknown'` so
  nobody resends blindly; `scheduled_whatsapp_watchdog` sweeps stuck rows.
- Session watchdog (`runWahaSessionWatchdog`): every active WAHA number is probed; a session not
  `WORKING` is restarted behind a fleet-wide lock (`waha_try_remediation_lock`), verified after
  30 s, **stopped if it did not recover**, with exponential backoff (10 min → 6 h) and one
  `session_unrecoverable` alert per outage in `activity_log`. Before this, a refused login was
  restarted every 10 minutes forever and looked healthy for 13 hours.

## 6. Bots and the AI agent (customers only, sales line only)

- **Basic first-touch responder** `api/whatsapp/basic-reply.ts` (Vercel, deterministic, DeepSeek/Kimi
  fallback for free text): classifies the message (pure greeting, named project, unit code
  `U-####`, vague request, out of scope) and replies in the customer's language. A named project
  gets the full rep package (message + brochure + top photos) via `api/_lib/aiSendProject.ts`;
  a unit code gets the exact one-page PDF rendered by the worker's dedicated render machine
  (`unit_pdf_jobs`, `worker/src/unitPdf.ts`). It asks the qualifying questions once, then hands off.
- **Full agent** (`responder_mode='agent'`): `whatsapp_ai_enqueue` → `claude_jobs` kind
  `whatsapp_reply` → `wa-agent/runner.mjs` spawns a **headless Claude Code session** per
  conversation (resumed across turns; the whole `$HOME` is on a volume so memory survives
  deploys), running the skill `.claude/skills/whatsapp-basic-reply/SKILL.md` with tools in
  `wa-agent/tools/` (`send`, `project-flow`, `project`, `notify`, read-only `db`, `save`).
  Exactly one machine plus a database lease (`claude_runner_lease`) guarantee one session per
  customer. Authentication is `CLAUDE_CODE_OAUTH_TOKEN`, not an API key.
- **Every bot send goes through one path:** `api/_lib/aiSend.ts#enqueueAiReply` re-checks the
  gate `whatsapp_ai_should_reply(chat_wid)` right before sending, resolves an active device,
  enqueues to `scheduled_whatsapp_jobs`, and writes the audit row `whatsapp_ai_replies`.
- **The gate** (policy in `whatsapp_ai_settings`, editable at Settings → WhatsApp AI agent):
  kill switch, schedule mode (outside hours / inside hours / always), working hours and days in
  Riyadh time, per-chat reply cap, "a human replied recently" quiet window, optional permanent
  stop once a human replies. Per-chat takeover (`POST /api/whatsapp/ai-handover`) marks a chat
  `ai_managed`, which outranks the schedule but never the global kill switch.
- The agent can raise a human's attention with `POST /api/whatsapp/ai-notify` → `ai_notifications`
  (Tasks page tab). It never sends from the operations line.

## 7. The operations line

- Designated by `whatsapp_numbers.is_operations` (`supabase/migrations/2026-08-31_ops_number_designation.sql`).
- **Notify officer** (`api/whatsapp/notify-officer.ts`, UI `NotifyOfficerModal.tsx`): finds the
  project's covering officers (explicit project list, whole-developer coverage, or marketer) and
  sends the rep's message from the operations number. If no operations number is designated it
  returns 409 instead of using the sales number.
- **Cost alerts to the owner:** `ai_balance_alerts_evaluate()` (SQL) sends one WhatsApp per
  threshold crossing from `ai_alert_settings.whatsapp_device` (default `wassel_ops`) to
  `ai_alert_settings.whatsapp_to`, a number that exists only in the live database. Called by the
  hourly cron `api/cron/ai-balance-probe.ts` and by the worker's balance-probe tick; a row lock
  keeps it to one message even when both fire in the same minute.
- **Human-sounding messages drafted by Claude** (to developers' relationship managers, etc.)
  follow `docs/ops-whatsapp-personal-style.md`: sender identity is fixed, introduce yourself
  once, greet by time of day, and **never send without the operator's explicit SEND after seeing
  the exact text**. Mechanically they use the same `scheduled_whatsapp_enqueue` RPC on
  `wassel_ops`.
- Inbound on this line is stored and shown in its own inbox but never enters the sales funnel
  (webhook `isOps` gating in section 3).

## 8. Notifications that ride on WhatsApp

- **Notifications platform** (`supabase/migrations/2026-08-01_04_notifications_platform.sql`):
  `notify_emit(workspace, event, roles, users, titles, bodies, url, channels?)` writes the in-app
  row, fans out push into `push_outbox`, and fans out WhatsApp into `notification_deliveries`,
  each channel ANDed with the recipient role's grid (Settings → Notifications) and gated by the
  `mos_settings.external_effects` kill switch (suppressed deliveries are kept as `skipped` rows).
  The worker claims deliveries (`notification_delivery_claim_next`) and POSTs each to
  `api/internal/send-notification-wa.ts`, which sends through the gateway layer; it never talks
  to WAHA itself. Five attempts, then `failed`.
- **Owner alerts on inbound** are push, not WhatsApp: trigger → `push_outbox` →
  `worker/src/runPushJob.ts` → Web Push, plus the in-app watchers
  `src/components/WhatsAppOwnerAlerts.tsx` and `WhatsAppOwnerBell.tsx`.

## 9. Permissions and visibility

- `src/pages/Settings/WhatsAppPermissionsPage.tsx` collapses chat visibility into one choice per
  profile (full / client-linked only / own clients only / none) and writes the ordinary
  `profiles.model_permissions[chats].view_scope`.
- `chat_messages` RLS defers to the chats view-scope class (`wassell_chat_scope_class`,
  `supabase/migrations/2026-07-28_whatsapp_scope_message_visibility.sql`), so restricting the
  list restricts the thread and the live feed too. The `client_owner` mirror on chats records
  (`2026-08-14_chat_client_owner_mirror.sql`) is what makes "own clients only" cheap.
- Session lifecycle and pairing (`api/whatsapp/session.ts`) is admin-only (`wassell_is_admin`).
  Bot endpoints authenticate with the shared secret because a headless session has no user JWT.
