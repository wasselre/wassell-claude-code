TASK: Wire notification delivery + scheduled ticks into the EXISTING Fly worker, plus the server send endpoint and a small migration. Files you may modify/create:
- NEW supabase/migrations/2026-08-01_06_notification_sweeps.sql
- NEW api/internal/send-notification-wa.ts
- worker/src/index.ts (add loops — follow the existing loop patterns in that file)
- NEW worker/src/runNotificationDelivery.ts
- worker/src/env.ts (declare any new env)
Nothing else.

READ FIRST: supabase/migrations/2026-08-01_04_notifications_platform.sql (tables notifications/notification_rules/notification_prefs/notification_deliveries + RPCs notification_delivery_claim_next/_complete/_fail/_watchdog + notify_emit); api/internal/run-workflow-job.ts (the worker→API internal-endpoint pattern with shared secret); worker/src/index.ts (poll-loop + watchdog house style, e.g. the push loop at ~1264); api/_lib/whatsappGateway.ts (sendMessage — the ONLY WhatsApp send path); supabase/migrations/2026-07-29_web_push.sql (house style for claim RPCs).

DESIGN — the worker never talks to WAHA directly (no second WhatsApp impl): it claims notification_deliveries rows and POSTs each to APP_URL/api/internal/send-notification-wa with the shared secret WORKFLOW_RUNNER_SECRET (reuse the same env the run-workflow-job endpoint uses); that endpoint (service-role Supabase client) loads the notification + recipient, resolves the recipient's WhatsApp number from users.phone, sends via whatsappGateway.sendMessage on the default device, and returns ok/failed so the worker can call _complete/_fail.

MIGRATION 2026-08-01_06_notification_sweeps.sql:
1. ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text; (staff WhatsApp target; comment: E.164; editable in Settings/people + account page)
2. mos_notification_sweep() RETURNS jsonb SECURITY DEFINER — called by the worker every ~5 min; each sub-sweep is idempotent (never double-notifies):
   a. publish_due: mos_publications status='scheduled' with scheduled_at within the next 60 min AND no notifications row exists with kind='publish_due' and url containing the publication id → notify_emit to role_keys ['ops_supervisor','writer'] (per rules; notify_emit filters channels) with url '/m/content/'||content_id||'?tab=publish'.
   b. task_overdue: workflow_role_tasks open with due_at < now() AND no notifications row kind='task_overdue' with url containing the subject id created in the last 24h → notify_emit to the task's role_key + assignee.
   c. RETURN jsonb counts {publish_due: n, task_overdue: n}.
3. mos_notification_digest(p_hour int) RETURNS int SECURITY DEFINER — for each user whose notification_prefs.digest_hour = p_hour (default 8 when no prefs row): if they have unread notifications older than 1 hour, emit ONE summary push directly INTO push_outbox (kind 'notify:digest', title Arabic 'ملخص التسويق: N إشعارات غير مقروءة' with the count, dedupe_key 'digest:'||user_id||':'||to_char(now(),'YYYY-MM-DD')) — dedupe key makes it once/day. Respect mos_settings external_effects (skip inserts when disabled). Returns users digested.
4. GRANT EXECUTE on both to service_role only (REVOKE others).

worker/src/runNotificationDelivery.ts: export async function runNotificationDelivery(job, env): claim gave {id, notification_id, channel}; POST `${env.APP_URL}/api/internal/send-notification-wa` json {delivery_id: id} with header authorization bearer WORKFLOW_RUNNER_SECRET, 30s timeout; non-200 or {ok:false} → throw with the body text.

worker/src/index.ts additions (mirror the push loop's shape EXACTLY — claim via rpc notification_delivery_claim_next(worker id, limit 10), per row runNotificationDelivery then _complete, catch → _fail with error message; loop interval ~5s; plus a 5-min tick calling rpc mos_notification_sweep() and rpc notification_deliveries_watchdog(), plus an hourly tick calling mos_notification_digest(new Date().getHours()) computed in Asia/Riyadh — compute Riyadh hour from UTC+3 (fixed offset, KSA has no DST; comment that).

api/internal/send-notification-wa.ts: nodejs runtime; POST only; bearer secret check EXACTLY like run-workflow-job; body {delivery_id}; service-role client loads the delivery + its notification + recipient user (users.phone, name); no phone → mark the delivery failed with 'no-phone' via rpc notification_delivery_fail and return {ok:false, reason:'no-phone'} (200 — the worker treats ok:false as handled, does NOT retry); check mos_settings external_effects — disabled → rpc notification_delivery_fail? NO: return {ok:true, skipped:true} after marking the delivery status 'skipped' directly with the service client (log why). Otherwise send: message text = title_ar + '\n' + (body_ar ?? '') + (url ? '\n' + absolute app url : '') via whatsappGateway sendMessage({ phone, message, device: resolveDefaultDeviceId() }) — READ the gateway's actual signature and use it correctly. Success → {ok:true}; WahaError → {ok:false, error} with 200 status (worker fails the delivery with the message; the RPC guards retries).

VERIFY: npm run typecheck:api passes; cd worker && npx tsc --noEmit passes (worker is its own package — check its tsconfig). Print exactly: WORKER-NOTIFICATIONS WIRED + the tsc results.
