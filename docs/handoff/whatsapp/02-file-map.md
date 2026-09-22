# 02 — File map

Paths relative to the repository root. "Runtime" says where the code executes.
The `api/haberchat/*` names are historical (the previous vendor); they are the live WhatsApp routes.

## Gateway adapter, relay, and shared send layer (runtime: Vercel edge)

| File | Role |
|---|---|
| `api/_lib/waha.ts` | Typed adapter for the WAHA REST API. Session lifecycle (`createSession` registers the per-session webhook + HMAC), `listChats`, `listMessages`, `sendMessage`, media upload/download with the `wt_`/`wf_`/`wm_` ref scheme, LID→phone resolution (`resolveLidToPhone`, `resolveWahaCounterpartyPhone`), ad-referral extraction, `mirrorWahaHostedMedia`. Base URL flips to the proxy when `WAHA_PROXY_URL` is set. |
| `api/_lib/whatsappGateway.ts` | The one send/read surface every server sender uses. Device resolution: `resolveDefaultDeviceId`, `resolveOperationsDeviceId`, `sendDeviceId`. Scheduling: `maybeScheduleWaha`, `listScheduled`, `cancelScheduled`. Maps `WahaError` → `HaberchatError` so proxies keep their HTTP mapping. |
| `api/_lib/whatsappSendAuth.ts` | Who may send, to whom, how often: `authorizeWhatsappSend` (RLS-scoped conversation, `create` needed for a new one, per-user window), `findPriorSendByReference` (idempotency), `recordOutboundMessage` (row written at send time), `logSendAttempt` (masked-phone audit), `maskPhone`. |
| `api/_lib/whatsappTypes.ts` | Shared DTOs (`HaberchatDevice`, `HaberchatChat`, `HaberchatMessage`, `HaberchatError`). |
| `api/_lib/chatIngest.ts` | Provider-neutral ingest: `CHATS_NAMESPACE`, `messageIdHash`, `upsertChatMessage` (hash merge), `bumpConversationRecord`, `applyAck`, `attachAdResolution`, `uuidV5FromWidSync`, `findChatsModelId`. |
| `api/_lib/serviceClient.ts`, `api/_lib/supabaseServer.ts`, `api/_lib/auth.ts` | Service-role client, JWT verification (`withAuth`). |
| `api/_lib/activityLogger.ts` | `logWebhookReceipt`, `logServerActivity` (audit rows in `activity_log`). |

## Webhook (runtime: Vercel edge)

| File | Role |
|---|---|
| `api/webhook/waha.ts` | The inbound entry point. HMAC verify, dedupe, event routing, phone/LID ladder, ops-line gating, media mirror, DB write, funnel hooks (ad capture, activity bridge, basic-reply trigger), DLQ, receipt log. |
| `api/webhook/haberchat.ts` | Legacy vendor webhook. Retired 2026-07-28; refuses traffic. Kept because `CHATS_NAMESPACE` history lives there. |

## Browser-facing proxies (runtime: Vercel edge, caller JWT)

| File | Role |
|---|---|
| `api/haberchat/devices.ts` | List connected numbers (live gateway status merged with `whatsapp_numbers`). |
| `api/haberchat/chats.ts` | List conversations for one device (used as a read/refresh; the DB is authoritative). |
| `api/haberchat/chats/[wid].ts` | Patch one conversation's status/labels. |
| `api/haberchat/messages.ts` | **Send one message** (text or media ref, optional `deliverAt`, quoted reply, idempotency `reference`). |
| `api/haberchat/files.ts`, `api/haberchat/files/[id].ts` | Upload (legacy path) and stream media back to the browser (`wt_`/`wf_`/`wm_` refs). |
| `api/haberchat/scheduled.ts` | List/cancel a chat's scheduled sends (reads `scheduled_whatsapp_jobs` via the gateway layer). |

## Bot, admin, and internal endpoints (runtime: Vercel edge)

| File | Auth | Role |
|---|---|---|
| `api/whatsapp/session.ts` | admin JWT | Create/start/restart a WAHA session, read status, fetch the pairing QR. Registers the webhook with the HMAC key. |
| `api/whatsapp/upload-url.ts` | JWT | Signed direct-to-storage upload for outbound attachments (bypasses Vercel's body limit). |
| `api/whatsapp/send-media-batch.ts` | JWT | Ordered gallery/brochure fan-out into the queue. |
| `api/whatsapp/notify-officer.ts` | JWT | Officer lookup + send from the **operations** line. |
| `api/whatsapp/basic-reply.ts` | shared secret | Deterministic first-touch responder (greeting, named project, unit code, qualify, no-service), language detection, soft-gate bypass for deterministic project hits. |
| `api/whatsapp/ai-send.ts` | shared secret | Thin wrapper over `enqueueAiReply` (gate → queue → audit). |
| `api/whatsapp/ai-send-project.ts` | shared secret | Full rep package (message + brochure + photos) for the bot. |
| `api/whatsapp/ai-handover.ts` | JWT | Per-chat AI takeover on/off (`ai_managed`). |
| `api/whatsapp/ai-settings.ts` | JWT (RLS admin) | Read/update the bot policy + live "would it reply now?" probe. |
| `api/whatsapp/ai-notify.ts` | shared secret | Agent → operator notification (`ai_notifications`). |
| `api/_lib/aiSend.ts` | — | `enqueueAiReply`: gate re-check, active device, `scheduled_whatsapp_enqueue`, `whatsapp_ai_replies` audit (job id only if a real uuid). |
| `api/_lib/aiSendProject.ts` | — | `sendProjectViaAiFlow`: message resolution (saved → fact-checked → AI → deterministic sheet) + files. |
| `api/templates/project-message.ts` | secret or JWT | Deterministic project sheet (available-only prices). |
| `api/internal/send-notification-wa.ts` | worker | Sends a `notification_deliveries` row through the gateway layer. |
| `api/cron/ai-balance-probe.ts` | cron | Hourly balance probes + `ai_balance_alerts_evaluate()` (WhatsApp alerts to the owner). |

## Fly worker `wassel-deck-worker` (runtime: Node, service role, holds the WAHA key)

| File | Role |
|---|---|
| `worker/src/index.ts` | Poll loops: `scheduledWhatsappPollLoop` (queue drain + `runScheduledWhatsappWatchdog` + `runWahaSessionWatchdog` with `maybeRestartWahaSessionAfterSendFailure`), notification-delivery lane, push lane, unit-PDF lane (render process group), balance-probe tick, and `handleWahaProxy` (`/waha/*` relay authenticated by `x-wassel-proxy-secret`). Search for "WAHA" and "scheduled_whatsapp". |
| `worker/src/runScheduledWhatsappJob.ts` | Fire one due job: device fallback to the active default, text then media, partial-send-not-retryable. |
| `worker/src/waha.ts` | Send-only WAHA client (copy of the send half of `api/_lib/waha.ts`; keep in sync). |
| `worker/src/runNotificationDelivery.ts` | POSTs a claimed delivery to `api/internal/send-notification-wa`. |
| `worker/src/runPushJob.ts` | Web Push delivery for `push_outbox` (inbound-WhatsApp owner alerts among others). |
| `worker/src/runUnitPdfJob.ts`, `worker/src/unitPdf.ts` | Render the unit one-pager with headless Chromium and enqueue it as a WhatsApp document. |
| `worker/fly.toml` | Process groups: `app` (all lanes) and `render` (PDF only). |

## Fly app `wassel-wa-agent` (runtime: Node + Claude Code CLI, ONE machine)

| File | Role |
|---|---|
| `wa-agent/runner.mjs` | Drains `claude_jobs` kind `whatsapp_reply`; holds the `claude_runner_lease`; spawns/resumes a headless Claude Code session per conversation with the skill; fallback `/waha/*` proxy; `recoverOwnStaleJobs` at boot. |
| `wa-agent/tools/send.mjs` | Send one text as the agent (→ `/api/whatsapp/ai-send`). |
| `wa-agent/tools/project-flow.mjs` | Send a full project package (→ `/api/whatsapp/ai-send-project`). |
| `wa-agent/tools/project.mjs` | Fetch the deterministic project sheet. |
| `wa-agent/tools/notify.mjs` | Post an operator notification (→ `/api/whatsapp/ai-notify`). |
| `wa-agent/tools/db.mjs`, `wa-agent/tools/save.mjs` | Read-only SQL for the session; persist session notes. |
| `wa-agent/skill-basic/SKILL.md` | Build-context copy of the reply skill (keep in sync with `.claude/skills/whatsapp-basic-reply/SKILL.md`). |
| `wa-agent/Dockerfile`, `wa-agent/entrypoint.sh`, `wa-agent/fly.toml` | Image with the Claude CLI; volume `/home/agent` (transcripts + `~/.claude.json`); `min_machines_running = 1`. |
| `.claude/skills/whatsapp-basic-reply/SKILL.md` | The reply skill: persona, allowed moves, hand-off rules. |
| `.claude/skills/wassel-whatsapp-voice/SKILL.md` | How rep-sounding WhatsApp text should read (load before drafting customer text). |

## Browser (runtime: React SPA)

| File | Role |
|---|---|
| `src/lib/haberchat/client.ts` | Wrapper over the proxies; attaches the Supabase JWT. |
| `src/lib/haberchat/normalize.ts` | `CHATS_NAMESPACE`, wid/device normalisation, `deviceIdString`. |
| `src/lib/haberchat/clientHistory.ts` | Per-client message history helpers. |
| `src/stores/appStore.ts` | Store actions for chats (send, retry, start new chat, read refresh, scheduled strip, numbers overlay). Search for "chat" / "whatsapp". |
| `src/lib/realtime/RealtimeOrchestrator.ts`, `src/lib/realtime/dedup.ts` | Realtime merge of `records` / `chat_messages`; echo-dedup (why browsers must not write chat rows). |
| `src/pages/Chats/ChatsSplitPage.tsx` | The two-pane inbox. |
| `src/pages/Chats/components/*` | `ChatList`, `ChatDetail`, `MessageThread`, `MessageBubble`, `AckIndicator`, `Composer`, `SchedulePopover`, `StartChatModal`, `NotifyOfficerModal`, `ProjectMessageGeneratorModal`, `BulkProjectSendFlow`, `SendUnitsPdfModal`, `SendPaymentPlansModal`, `LeadIntakeModal`, `LogInteractionModal`, `RegisterLeadPortalModal`, … |
| `src/pages/Settings/WhatsAppNumbersPage.tsx` | Number registry UI + a `WahaConnectionCard` per active session (status, pairing). |
| `src/pages/Settings/WhatsAppAiPage.tsx` | Bot policy (kill switch, schedule, caps). |
| `src/pages/Settings/WhatsAppPermissionsPage.tsx` | Four-level chat visibility per profile. |
| `src/components/WhatsAppOwnerAlerts.tsx`, `WhatsAppOwnerBell.tsx`, `whatsappOwner.ts`, `PushAutoPrompt.tsx` | Owner alerts on inbound (toast, bell, push enrolment). |
| `src/lib/projectMessage/compose.ts`, `src/lib/projectMessageFacts.ts` | Project message composition shared with server senders. |

## Database (see `03-data-model.md` for columns)

| Migration | What it adds |
|---|---|
| `supabase/schema.sql` | `chat_messages`, `whatsapp_numbers` base tables, `activity_log`. |
| `supabase/migrations/2026-07-18_whatsapp_provider.sql` | `provider`, `session_name` on `whatsapp_numbers`. |
| `2026-07-18_scheduled_whatsapp_jobs_queue.sql`, `2026-07-23_scheduled_whatsapp_requeue.sql` | The send queue and its RPCs. |
| `2026-07-26_whatsapp_ai_replies.sql`, `2026-07-28_whatsapp_takeover_scoped_override.sql`, `2026-08-24_ai_schedule_mode.sql`, `2026-08-24_ai_permanent_human_stop.sql` | Bot policy, audit, and the gate `whatsapp_ai_should_reply`. (`responder_mode` was added live with no migration file — see `03-data-model.md`.) |
| `2026-07-22_claude_jobs_queue.sql`, `2026-07-29_claude_runner_singleton_lease.sql`, `2026-07-23_claude_runner_sql_readonly.sql`, `2026-07-28_claude_jobs_restrict_client_insert.sql` | Agent job queue, singleton lease, read-only SQL for sessions. |
| `2026-07-27_whatsapp_lid_dupes_and_bridge_number.sql`, `2026-07-28_chat_messages_hash_uniqueness.sql` | Duplicate repair and `message_hash`. |
| `2026-07-28_whatsapp_per_number_send_budget.sql`, `2026-07-28_whatsapp_remediation_lock_and_unknown_sends.sql`, `2026-07-29_waha_remediation_backoff.sql` | Pacing, fleet-wide remediation lock, unknown state, backoff. |
| `2026-07-28_whatsapp_scope_message_visibility.sql`, `2026-08-14_chat_client_owner_mirror.sql` | Visibility scopes. |
| `2026-07-28_whatsapp_send_source_scoped_supersede.sql`, `2026-07-21_whatsapp_activity_bridge.sql`, `2026-07-04_whatsapp_reply_reconcile.sql`, `2026-07-21_wa_task_dedup.sql` | Sales activity bridge. |
| `2026-07-28_whatsapp_retire_haberchat_scaffolding.sql` | Retired the previous vendor. |
| `2026-07-29_web_push.sql`, `2026-08-18_09/10/11_whatsapp_inbound_push*.sql` | Owner push on inbound. |
| `2026-08-01_04_notifications_platform.sql`, `2026-08-05_mos_step_notify_channels.sql` | Notifications platform WhatsApp lane. |
| `2026-08-31_ops_number_designation.sql` | `is_operations`. |
| `2026-09-03_chat_status_log.sql` | Status change log. |
| `2026-09-13_unit_pdf_jobs_queue.sql` | Unit one-pager PDF queue. |
| `2026-09-13_01_wa_followup_suggestions.sql` | Follow-up Queue suggestions. |
| `2026-09-21_ai_vendor_truth_and_alerts.sql` | `ai_alert_settings` + `ai_balance_alerts_evaluate()` (WhatsApp alerts to the owner). |

## Documents

| File | Role |
|---|---|
| `docs/runbooks/whatsapp.md` | Production runbook. |
| `docs/waha-doha-gateway.md` | VM setup (engine line is stale: GOWS since 2026-07-29). |
| `docs/ops-whatsapp-personal-style.md` | Operations-number message standard (SEND rule). |
| `docs/evaluations/2026-07-18-waha-vs-haberchat.md` | Why WAHA. |
| `docs/prd/chats.md` | Product behaviour of the inbox (search: "Key behaviors", "Data touched", "AI reply agent"). |
| `docs/prd/ai-agent.md`, `docs/prd/access-control.md` | Related PRDs. |
| `CLAUDE.md` | Repo-wide rules; the WhatsApp-relevant ones are "Never raise SQLSTATE 40001", "Silent Failures", "Every AI call is metered". |
