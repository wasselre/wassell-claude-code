# 03 — Data model

All objects live in Postgres schema `public` (Supabase project `wassell-prod`). Column lists are
the load-bearing ones, not exhaustive; the migration named next to each object is authoritative.

## Core tables

### `chat_messages` — system of record for every message (`supabase/schema.sql`)

| column | meaning |
|---|---|
| `id` text PK | The gateway's serialized message id `<true|false>_<chatId>_<HASH>` (legacy rows: bare hex). Not stable across addressing modes; see `message_hash`. |
| `message_hash` text | The trailing HASH = WhatsApp's own message id. The real identity (`2026-07-28_chat_messages_hash_uniqueness.sql`). |
| `chat_wid` text | Conversation id, canonical `<digits>@c.us` (LID-only chats keep `<n>@lid`). |
| `conversation_record_id` uuid | `uuidv5(chat_wid, CHATS_NAMESPACE)` = the `records.id` of the chats record. |
| `device_id` text | WAHA session name the message was seen on. |
| `flow` | `in` / `out`. |
| `kind`, `subtype` | text, image, video, audio, document, sticker, location, … ; subtype discriminates system events. |
| `body`, `media_file_id`, `media_mime`, `media_size`, `media_caption` | Content. `media_file_id` is a ref: `wt_<path>` (temp outbound in storage), `wf_<session>/<file>` (gateway disk), `wm_<session>/<file>` (mirrored in storage). |
| `from_phone`, `to_phone` | E.164 where known. |
| `ack` | `failed` / `pending` / `sent` / `delivered` / `read` / `played`, **outbound only**; inbound stores null. |
| `reference` | Outbound idempotency key; `ai:*` and `sched:<job>` prefixes mark bot and scheduled sends. |
| `quoted` jsonb | `{wid, body, kind}` for replies. |
| `meta` jsonb | Set once at insert; `meta.ad` carries Click-to-WhatsApp attribution on the opening inbound message. Never overwritten by echo/ack/edit upserts. |
| `send_source` | Who originated an outbound (rep, bot, workflow…); scopes the follow-up supersede rule. |
| `date`, `created_at`, `updated_at` | |

Indexes: `(chat_wid, date desc)`, `(conversation_record_id)`, partial on in-flight acks.
RLS: read visibility defers to the chats view-scope class (`wassell_chat_scope_class`). Writes are
service-role only (webhook, send path, worker).

### `records` rows of the `chats` model — one conversation

Stored as JSONB `data` like every model. Keys the WhatsApp code relies on: `wid`, `name`, `phone`,
`kind`, `device_id`, `status` (`active` / `resolved` / `archived`), `owner`, `labels`,
`unread_count`, `last_message_at`, `last_message_preview`, `last_message_flow`, `client_link`
(lookup to a clients record, resolved by phone), `client_owner` (read-only mirror of the linked
client's owner, filled by trigger), `close_reason`, `closed_at`, `ai_managed`. Record id is
`uuidv5(chat_wid)`. `chat_status_log` (trigger `tg_log_chat_status_change`) records status changes.

### `whatsapp_numbers` — the number registry (`supabase/schema.sql` + `2026-07-18_whatsapp_provider.sql` + `2026-08-31_ops_number_designation.sql`)

| column | meaning |
|---|---|
| `device_id` text PK | For WAHA numbers this IS the session name. |
| `phone` | E.164 display. |
| `provider` | `waha` (the only live value; `haberchat` is retired). |
| `session_name` | WAHA session name (same as `device_id` for WAHA rows). |
| `is_default` | The sales/customer line; at most one (partial unique index). |
| `is_operations` | The operations line; should not coincide with `is_default`. |
| `is_active` | **The one lever**: false stops the queue drain and the session watchdog for this number. |
| `friendly_name_ar`, `friendly_name_en` | Labels. |

### `scheduled_whatsapp_jobs` — the send queue (`2026-07-18_scheduled_whatsapp_jobs_queue.sql`, `2026-07-23_…requeue.sql`, `2026-07-28_…unknown_sends.sql`)

Columns: `id`, `device_id`, `chat_wid`, `phone`, `body`, `media` (jsonb array of
`{fileId|url, kind, caption}`), `reference`, `deliver_at`, `status`
(`pending` → `running` → `sent` / `failed` / `cancelled` / `unknown`), `attempts`,
`created_by_user_id`, `result`, `error_message`, `worker_id`, `created_at`, `started_at`, `finished_at`.

RPCs: `scheduled_whatsapp_enqueue(p_device_id, p_chat_wid, p_phone, p_body, p_media, p_deliver_at, p_reference, …)`,
`scheduled_whatsapp_claim_due(p_worker, …)` (time-gated, `SKIP LOCKED`, budget-aware),
`scheduled_whatsapp_complete`, `scheduled_whatsapp_fail`, `scheduled_whatsapp_requeue`,
`scheduled_whatsapp_cancel`, `scheduled_whatsapp_list_for_chat`, `scheduled_whatsapp_watchdog`.

### `whatsapp_send_budget` — pacing per number (`2026-07-28_whatsapp_per_number_send_budget.sql`)

`device_id`, `max_per_minute` (40), `max_per_hour` (600), `updated_at`. Enforced inside
`scheduled_whatsapp_claim_due`; `whatsapp_send_budget_remaining(device_id)` reports headroom.
Tighten after a 463 without a deploy.

### `waha_session_remediation` — session watchdog state (`2026-07-28_…remediation_lock…`, `2026-07-29_waha_remediation_backoff.sql`)

Per session: last attempt, `last_outcome`, `last_recovered_at`, `alerted_at`, backoff.
RPCs: `waha_try_remediation_lock(session)` (fleet-wide advisory lock so five machines issue one
restart), `waha_remediation_record_outcome`, `waha_should_alert_unrecoverable`.

## Bot and agent tables

### `whatsapp_ai_settings` — singleton policy (`2026-07-26_whatsapp_ai_replies.sql`, `2026-08-24_ai_schedule_mode.sql`, `2026-08-24_ai_permanent_human_stop.sql`)

Live columns on 2026-09-22 (verified against production): `is_enabled` (default false),
`schedule_mode` (`outside_hours` default / `inside_hours` / `always`), `work_start_hour` (9),
`work_end_hour` (18), `work_days` (ISO weekdays, default Sun–Thu), `timezone` (Asia/Riyadh),
`max_replies_per_chat` (12), `human_quiet_hours` (6), `stop_forever_after_human` (true),
`responder_mode` (`basic` default / `agent`). Admin-only update via RLS.

**Drift to know about:** `responder_mode` exists in production but no migration file in this
repository adds it (it was applied directly to the live database). A fresh or branch database
built from `supabase/migrations/` will lack the column; `api/whatsapp/basic-reply.ts` reads it
with `maybeSingle()` and falls back to `'basic'`, so the bot still works there, but the agent
path cannot be selected. If you rebuild the schema elsewhere, add
`ALTER TABLE whatsapp_ai_settings ADD COLUMN responder_mode text NOT NULL DEFAULT 'basic';`.

### `whatsapp_ai_should_reply(p_chat_wid)` — the gate

Returns `{should_reply, reason}` with reasons `disabled`, `working_hours`, `human_active`,
`reply_cap_reached`, `ai_managed` (takeover: schedule ignored), `disabled_globally_despite_takeover`,
`ok`. `human_active` = an outbound message in the last `human_quiet_hours` that is NOT in
`whatsapp_ai_replies` — which is why every bot send must be audited.

### `whatsapp_ai_replies` — bot send audit

One row per bot send (`chat_wid`, body, `job_id` uuid-or-null, timestamps). The
human-vs-bot discriminator used by the gate. Media sends by the bot are not audited, so the bot
always sends an audited intro text before a media package.

### `whatsapp_ai_enqueue(chat_wid, …)` / `claude_jobs` / `claude_runner_lease`

`claude_jobs` (`2026-07-22_claude_jobs_queue.sql`): kind `whatsapp_reply`, `claimed_by`,
attempts; RPCs `claude_job_claim_next`, `claude_job_complete`, `claude_job_fail`,
`claude_jobs_watchdog`, `claude_job_interrupt`. `whatsapp_ai_enqueue` debounces on any
pending/running job for the chat. `claude_runner_lease` (`2026-07-29_claude_runner_singleton_lease.sql`):
`claude_runner_lease_acquire / _release / _status` — the guarantee that one agent process runs.
`claude_runner_sql_readonly` gives the session read-only SQL.

### `ai_notifications`

Operator-facing notes from the agent (`source`, `severity`, `title`, `body`, `chat_wid`,
`chat_record_id`, `client_record_id`, `target_user_id`, `meta`). Shown in Tasks → AI notifications.

### `unit_pdf_jobs` (`2026-09-13_unit_pdf_jobs_queue.sql`)

Render-and-send queue for the unit one-pager; RPCs `unit_pdf_job_enqueue / _claim_next /
_complete / _fail`, `unit_pdf_jobs_watchdog`. Delivery rides `scheduled_whatsapp_enqueue`
with `{fileId:'wt_<path>', kind:'document'}`.

## Alerts and notifications

### `ai_alert_settings` — singleton (`2026-09-21_ai_vendor_truth_and_alerts.sql`)

`whatsapp_to` (E.164 digits, set only in the live DB), `whatsapp_device` (default `wassel_ops`),
`enabled`. Consumed by `ai_balance_alerts_evaluate()`, the ONLY sender of cost alerts; it
row-locks per-provider state so two callers in the same minute send one message.

### Notifications platform (`2026-08-01_04_notifications_platform.sql`, `2026-08-05_mos_step_notify_channels.sql`)

`notifications` (in-app inbox, Realtime), `notification_rules` (role × event × channel grid),
per-user prefs, `notification_deliveries` (WhatsApp queue: `notification_id`, `channel`,
`status`, attempts). Function `notify_emit(p_workspace, p_event, p_role_keys, p_user_ids,
p_title_ar, p_title_en, p_body_ar, p_body_en, p_url, p_channels)`. Kill switch
`mos_settings.external_effects`. Worker RPCs `notification_delivery_claim_next / _complete / _fail`.

### Push (`2026-07-29_web_push.sql`, `2026-08-18_09/10/11_whatsapp_inbound_push*.sql`)

`push_subscriptions` (per device), `push_outbox` (queue), `push_builtin_settings`
(`whatsapp_inbound_enabled`, `whatsapp_inbox_user_id` fallback). Trigger
`chat_messages_enqueue_push` (fn `tg_chat_messages_enqueue_push`) on inbound rows, with the
owner ladder: chats `client_owner` → linked client's owner → phone match → chat `owner` →
inbox fallback user.

## Sales activity bridge (server-side, called from the webhook)

- `reconcile_outbound_whatsapp(client_id, message_at)` — any outbound on a client-linked chat arms
  the client's WhatsApp follow-up as waiting-for-customer (+24 h deadline) and cancels open
  booking / no-show tasks; skips terminal stages; idempotent. Scoped by `send_source`
  (`2026-07-28_whatsapp_send_source_scoped_supersede.sql`).
- `reconcile_inbound_whatsapp` — wraps `mark_whatsapp_replied` and creates a "your turn" task when
  the client has no open follow-up.
- `mos_capture_ad_acquisition` — ad-resolved opener → find-or-create client + attribution.
- `wa_followup_suggestions` (`2026-09-13_01`) — AI follow-up suggestions surfaced on the
  Follow-up Queue page.

## Visibility and audit

- `wassell_chat_scope_class(...)` (`2026-07-28_whatsapp_scope_message_visibility.sql`) — the RLS
  class that `chat_messages` policies defer to.
- Triggers `tg_records_fill_chat_client_owner`, `tg_records_sync_chats_on_client_owner`
  (`2026-08-14_chat_client_owner_mirror.sql`).
- `activity_log` — webhook receipts (category `webhook`, source `waha`), send attempts (masked
  phone, category `whatsapp`), `session_remediation` / `session_unrecoverable` events.
- `haberchat_webhook_dlq` — webhook events whose handler threw.
- `chat_status_log` — every chat status change with actor and reason.

## Storage buckets

- `wassel-files` (private): `waha-outbound/<uuid>.<ext>` temp outbound media (`wt_`),
  `whatsapp-media/<session>/<file>` mirrored media (`wm_`), unit PDFs.
- The gateway's own disk holds `wf_` media only until a restart/re-pair; never rely on it.
