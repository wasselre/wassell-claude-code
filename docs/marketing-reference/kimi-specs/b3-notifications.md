TASK: Write ONE new SQL migration file: supabase/migrations/2026-08-01_04_notifications_platform.sql. Nothing else; do not apply it. It runs after 2026-08-01_01..03 (read those in supabase/migrations/ for style + what exists: workflow engine role-paths created workflow_versions/workflow_role_tasks/surface_access + canonical mos roles with roles.key 'mos_*'; domain batch created mos_settings incl. key 'external_effects'; attributions file created client_attributions).

This is the APP-WIDE notifications platform (nothing marketing-branded — Sales adopts it later), delivering over EXISTING channels only: in-app rows + Supabase Realtime; web push via the existing push_outbox table (see supabase/migrations/2026-07-29_web_push.sql — READ it: push_outbox columns id, user_id, kind, title, body, url, tag, dedupe_key, status default 'pending', attempts, created_at; service-role-only RLS); WhatsApp via a deliveries queue the existing Fly worker drains (worker wiring is a separate task).

Helpers that exist: wassell_app_user_id(auth_uid uuid) -> public.users.id; wassell_is_admin(uuid); wassell_mos_can(text); canonical roles table now has nullable key text ('mos_ceo'...'mos_montage'); users.role_assignments jsonb array of {role_id, field_values}; mos_settings(key text PK, value jsonb).

=== TABLES ===

1. notifications (in-app inbox — one row per recipient per event):
   id uuid PK default gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace text NOT NULL DEFAULT 'marketing' CHECK (workspace IN ('marketing','sales','system')), kind text NOT NULL, title_ar text NOT NULL, title_en text, body_ar text, body_en text, url text, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now().
   Indexes: (user_id, created_at DESC); partial (user_id) WHERE read_at IS NULL.
   RLS ON: SELECT own rows (user_id = wassell_app_user_id(auth.uid())); UPDATE own rows WITH CHECK same (for read_at marking); NO INSERT/DELETE policies (writes via SECURITY DEFINER emit fn / service role).
   Realtime: guarded ALTER PUBLICATION supabase_realtime ADD TABLE notifications (DO block; skip if already a member — check pg_publication_tables).

2. notification_rules (role × event × channel matrix — screen 43):
   role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE, event text NOT NULL, channel text NOT NULL CHECK (channel IN ('inapp','push','whatsapp')), timing text NOT NULL DEFAULT 'immediate' CHECK (timing IN ('immediate','digest')), enabled boolean NOT NULL DEFAULT true, updated_at timestamptz DEFAULT now(), PRIMARY KEY (role_id, event, channel).
   RLS: SELECT authenticated USING true; INSERT/UPDATE/DELETE gated wassell_mos_can('manage_settings').

3. notification_prefs (per-user):
   user_id uuid PK REFERENCES users(id) ON DELETE CASCADE, whatsapp_enabled boolean NOT NULL DEFAULT true, digest_hour int NOT NULL DEFAULT 8 CHECK (digest_hour BETWEEN 0 AND 23), quiet_from int CHECK (quiet_from BETWEEN 0 AND 23), quiet_to int CHECK (quiet_to BETWEEN 0 AND 23), updated_at timestamptz DEFAULT now().
   RLS: SELECT/INSERT/UPDATE own row (user_id = wassell_app_user_id(auth.uid())); no DELETE.

4. notification_deliveries (queue for channels that need HTTP — WhatsApp; the Fly worker drains it):
   id uuid PK default gen_random_uuid(), notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE, channel text NOT NULL CHECK (channel IN ('whatsapp')), status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','sent','failed','skipped')), attempts int NOT NULL DEFAULT 0, last_error text, claimed_at timestamptz, sent_at timestamptz, created_at timestamptz DEFAULT now().
   Index (status, created_at) WHERE status='pending'. RLS ON with NO policies (service-role only — same posture as push_outbox).
   Claim/complete/fail RPCs in the house style of push_outbox (read 2026-07-29_web_push.sql): notification_delivery_claim_next(p_worker text, p_limit int) FOR UPDATE SKIP LOCKED; _complete(p_id) / _fail(p_id, p_error) only touch status='running' rows; watchdog notification_deliveries_watchdog() re-pends running > 10 min. REVOKE from authenticated/anon, GRANT service_role.

=== EMIT FUNCTION ===

notify_emit(p_workspace text, p_event text, p_role_keys text[], p_user_ids uuid[], p_title_ar text, p_title_en text, p_body_ar text, p_body_en text, p_url text) RETURNS int, plpgsql SECURITY DEFINER SET search_path=public:
- Recipients = union of: explicit p_user_ids; and holders of each role key in p_role_keys — users u WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(u.role_assignments) e JOIN roles r ON r.id::text = e->>'role_id' WHERE r.key = ANY(p_role_keys)) AND u.is_active. Dedupe.
- external_effects := COALESCE((SELECT (value->>'enabled')::boolean FROM mos_settings WHERE key='external_effects'), true).
- For each recipient: ALWAYS insert the notifications row (in-app is not an external effect).
- Channel fan-out per recipient: find their role_ids for this workspace's rules; a channel fires if ANY of their roles has (event, channel) enabled:
  - push: if enabled AND external_effects → INSERT INTO push_outbox (user_id, kind, title, body, url, tag, dedupe_key) VALUES (uid, 'notify:'||p_event, COALESCE(p_title_ar,p_title_en), p_body_ar, p_url, 'ntf-'||p_event, 'ntf:'||<new notification id>||':'||uid) ON CONFLICT (dedupe_key) DO NOTHING (match the real unique index — check 2026-07-29_web_push.sql for its exact name/definition and use the matching conflict target).
  - whatsapp: if enabled AND external_effects AND recipient prefs whatsapp_enabled (default true when no prefs row) → INSERT notification_deliveries (channel 'whatsapp').
  - when external_effects is FALSE: skip push+whatsapp entirely BUT insert a notification_deliveries row with status='skipped', last_error='external-effects-off' ONLY for would-have-fired whatsapp (visible no-op log), and RAISE NOTICE for push skips.
- RETURNS number of notifications rows inserted. GRANT EXECUTE to authenticated (it is definer; app endpoints call it server-side; direct client calls are acceptable because it only notifies).

mark_notifications_read(p_ids uuid[]) RETURNS void SECURITY DEFINER: UPDATE notifications SET read_at=now() WHERE id = ANY(p_ids) AND user_id = wassell_app_user_id(auth.uid()) AND read_at IS NULL. GRANT authenticated.

=== SEED notification_rules (screen 43's matrix) ===
READ docs/marketing-reference/source/screens/s43.html and transcribe its per-role rules EXACTLY: which events × channels are on per role. Use role subselects (SELECT id FROM roles WHERE key='mos_writer') etc. Event keys: use snake_case identifiers derived from the screen's rows (e.g. task_assigned, task_due_soon, task_overdue, approval_pending, changes_requested, content_ready, publish_due, publish_confirmed, metrics_missing, budget_signature) — add a SQL comment mapping each Arabic row label to its event key so the transcription is auditable. HARD SPEC RULES from the design: WhatsApp is for BLOCKING events only; the CEO gets exactly TWO WhatsApp events (budget-signature request and the weekly summary per s43 — transcribe what the screen actually shows; if the screen shows different two, follow the screen). Where s43 shows a pill as off, seed enabled=false rather than omitting the row (the matrix UI edits these rows).

Validation DO block before COMMIT: assert notify_emit exists, notification_rules has rows for all 5 mos_* roles, and the CEO whatsapp-enabled rule count is exactly the number shown on s43 (hardcode the number you transcribed, with a comment).

When done print exactly: NOTIFICATIONS-MIGRATION WRITTEN.
