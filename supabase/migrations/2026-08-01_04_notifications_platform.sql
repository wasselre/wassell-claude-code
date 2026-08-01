-- ============================================================================
-- Notifications platform — the app-wide "when does the system interrupt you"
-- layer: in-app inbox, a role × event × channel rule matrix, per-user prefs,
-- and a deliveries queue for channels that need HTTP (WhatsApp today).
--
-- Runs AFTER 2026-08-01_01..03 (canonical mos_* role keys on roles.key,
-- mos_settings.external_effects). APP-WIDE BY DESIGN: nothing here is
-- marketing-branded — Sales adopts the same tables later, which is why
-- notifications.workspace exists ('marketing' today, 'sales'/'system' next).
--
-- CHANNELS, AND WHERE EACH ONE LIVES
--   inapp    — the notifications row itself; the SPA reads it over Supabase
--              Realtime (this migration adds the table to the publication).
--   push     — fan-out INSERTs into the EXISTING push_outbox queue
--              (2026-07-29_web_push.sql); its worker + RPCs are untouched.
--   whatsapp — fan-out INSERTs into notification_deliveries, a new queue the
--              Fly worker drains (worker wiring is a separate task).
--
-- THE KILL SWITCH
-- mos_settings.external_effects gates the two channels that reach OUTSIDE
-- the app (push + whatsapp). The in-app row is ALWAYS written — an internal
-- inbox entry is not an external effect. When the switch is off, would-have-
-- fired whatsapp deliveries are still logged as status='skipped' rows so an
-- operator can SEE what was suppressed; push skips are only RAISE NOTICE
-- (push_outbox is a delivery queue, not an audit log).
--
-- Idempotent: re-running is a no-op.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Generic updated_at touch trigger (mos_tg_touch_updated_at is
--    marketing-module-named; this platform is app-wide, so it gets its own)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.wassell_tg_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------------------
-- 1. notifications — the in-app inbox. One row per recipient per event.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  workspace  text NOT NULL DEFAULT 'marketing'
             CHECK (workspace IN ('marketing','sales','system')),
  -- The event key, e.g. 'task_assigned'. Free text (no enum): new modules
  -- introduce events without a migration.
  kind       text NOT NULL,
  title_ar   text NOT NULL,
  title_en   text,
  body_ar    text,
  body_en    text,
  url        text,             -- in-app path opened when the row is tapped
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.notifications IS
  'App-wide in-app inbox: one row per recipient per event. Writes happen only '
  'through notify_emit (SECURITY DEFINER) or service role — there is no INSERT '
  'policy. Realtime-enabled; the SPA subscribes filtered on user_id.';

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON public.notifications (user_id, created_at DESC);

-- The badge count + "unread first" ordering only ever touch unread rows.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON public.notifications (user_id) WHERE read_at IS NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_own_select ON public.notifications;
CREATE POLICY notifications_own_select ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = public.wassell_app_user_id(auth.uid()));

-- UPDATE exists only to stamp read_at. WITH CHECK re-asserts ownership so a
-- client cannot move a row to someone else.
DROP POLICY IF EXISTS notifications_own_update ON public.notifications;
CREATE POLICY notifications_own_update ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = public.wassell_app_user_id(auth.uid()))
  WITH CHECK (user_id = public.wassell_app_user_id(auth.uid()));

-- No INSERT/DELETE policies: rows are born via notify_emit / service role and
-- never deleted through the client.

-- Realtime: the SPA's notification center subscribes to this table.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
      AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. notification_rules — the role × event × channel matrix (screen 43)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification_rules (
  role_id    uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  event      text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('inapp','push','whatsapp')),
  -- 'digest' = held for the morning summary instead of sent at once.
  timing     text NOT NULL DEFAULT 'immediate' CHECK (timing IN ('immediate','digest')),
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (role_id, event, channel)
);

COMMENT ON TABLE public.notification_rules IS
  'The «الإشعارات — لكل دور» matrix (s43): which events interrupt which role, '
  'on which channel. Off cells are stored as enabled=false rows (not omitted) '
  'so the matrix UI edits rows in place.';

DROP TRIGGER IF EXISTS notification_rules_touch_tg ON public.notification_rules;
CREATE TRIGGER notification_rules_touch_tg
  BEFORE UPDATE ON public.notification_rules
  FOR EACH ROW EXECUTE FUNCTION public.wassell_tg_touch_updated_at();

ALTER TABLE public.notification_rules ENABLE ROW LEVEL SECURITY;

-- Everyone can READ the matrix — the settings UI renders it and notify_emit's
-- fan-out is definer-side anyway.
DROP POLICY IF EXISTS notification_rules_read ON public.notification_rules;
CREATE POLICY notification_rules_read ON public.notification_rules
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS notification_rules_ins ON public.notification_rules;
CREATE POLICY notification_rules_ins ON public.notification_rules
  FOR INSERT TO authenticated
  WITH CHECK (public.wassell_mos_can('manage_settings'));

DROP POLICY IF EXISTS notification_rules_upd ON public.notification_rules;
CREATE POLICY notification_rules_upd ON public.notification_rules
  FOR UPDATE TO authenticated
  USING (public.wassell_mos_can('manage_settings'))
  WITH CHECK (public.wassell_mos_can('manage_settings'));

DROP POLICY IF EXISTS notification_rules_del ON public.notification_rules;
CREATE POLICY notification_rules_del ON public.notification_rules
  FOR DELETE TO authenticated
  USING (public.wassell_mos_can('manage_settings'));

-- ---------------------------------------------------------------------------
-- 3. notification_prefs — per-user delivery preferences
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification_prefs (
  user_id          uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  whatsapp_enabled boolean NOT NULL DEFAULT true,
  -- Local hour the daily digest lands. 8 = «٨:٠٠ ص» on s43.
  digest_hour      integer NOT NULL DEFAULT 8 CHECK (digest_hour BETWEEN 0 AND 23),
  quiet_from       integer CHECK (quiet_from BETWEEN 0 AND 23),
  quiet_to         integer CHECK (quiet_to BETWEEN 0 AND 23),
  updated_at       timestamptz DEFAULT now()
);

COMMENT ON TABLE public.notification_prefs IS
  'Per-user overrides: whatsapp on/off, digest hour, quiet hours. Absent row = '
  'all defaults (whatsapp on, digest at 8, no quiet hours).';

DROP TRIGGER IF EXISTS notification_prefs_touch_tg ON public.notification_prefs;
CREATE TRIGGER notification_prefs_touch_tg
  BEFORE UPDATE ON public.notification_prefs
  FOR EACH ROW EXECUTE FUNCTION public.wassell_tg_touch_updated_at();

ALTER TABLE public.notification_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_prefs_own_select ON public.notification_prefs;
CREATE POLICY notification_prefs_own_select ON public.notification_prefs
  FOR SELECT TO authenticated
  USING (user_id = public.wassell_app_user_id(auth.uid()));

DROP POLICY IF EXISTS notification_prefs_own_insert ON public.notification_prefs;
CREATE POLICY notification_prefs_own_insert ON public.notification_prefs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.wassell_app_user_id(auth.uid()));

DROP POLICY IF EXISTS notification_prefs_own_update ON public.notification_prefs;
CREATE POLICY notification_prefs_own_update ON public.notification_prefs
  FOR UPDATE TO authenticated
  USING (user_id = public.wassell_app_user_id(auth.uid()))
  WITH CHECK (user_id = public.wassell_app_user_id(auth.uid()));

-- No DELETE policy: prefs are flipped, not removed.

-- ---------------------------------------------------------------------------
-- 4. notification_deliveries — the WhatsApp outbox the Fly worker drains.
--    Same posture as push_outbox: service-role only, no client access.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('whatsapp')),
  -- 'skipped' = deliberately not sent (e.g. external-effects-off) — a visible
  -- no-op log, NOT a failure. Same reason push_outbox keeps no_devices apart.
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','sent','failed','skipped')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  claimed_at      timestamptz,
  sent_at         timestamptz,
  created_at      timestamptz DEFAULT now()
);

COMMENT ON TABLE public.notification_deliveries IS
  'WhatsApp delivery queue, one row per (notification, channel). Drained by '
  'the Fly worker via notification_delivery_claim_next. RLS with NO policies: '
  'service-role only, same as push_outbox.';

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_pending
  ON public.notification_deliveries (status, created_at) WHERE status = 'pending';

ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: the queue is written by notify_emit and drained by
-- the worker. RLS denies everything to normal clients.

-- Claim a batch. SKIP LOCKED so several worker machines never take the same
-- row. p_worker is accepted for fleet symmetry with the other queues' claim
-- RPCs and for future attribution; there is deliberately no column for it yet.
CREATE OR REPLACE FUNCTION public.notification_delivery_claim_next(
  p_worker text,
  p_limit  integer DEFAULT 10
)
RETURNS SETOF public.notification_deliveries
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE notification_deliveries
     SET status = 'running', attempts = attempts + 1, claimed_at = now()
   WHERE id IN (
     SELECT id FROM notification_deliveries
      WHERE status = 'pending'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit
   )
   RETURNING *;
$$;

-- Terminal writes only touch rows still 'running', so a late completion after
-- the watchdog has already swept the row is a no-op instead of an overwrite.
CREATE OR REPLACE FUNCTION public.notification_delivery_complete(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE notification_deliveries
     SET status = 'sent', sent_at = now()
   WHERE id = p_id AND status = 'running';
$$;

-- Give up after 5 attempts; before that, put it back for another machine.
CREATE OR REPLACE FUNCTION public.notification_delivery_fail(p_id uuid, p_error text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE notification_deliveries
     SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
         last_error = p_error
   WHERE id = p_id AND status = 'running';
$$;

-- A crashed worker must not strand a delivery in 'running' forever.
CREATE OR REPLACE FUNCTION public.notification_deliveries_watchdog()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH swept AS (
    UPDATE notification_deliveries
       SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
           last_error = 'watchdog: claimed but never completed'
     WHERE status = 'running' AND claimed_at < now() - interval '10 minutes'
     RETURNING 1
  )
  SELECT COALESCE(count(*), 0)::integer FROM swept;
$$;

REVOKE ALL ON FUNCTION public.notification_delivery_claim_next(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notification_delivery_complete(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notification_delivery_fail(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notification_deliveries_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notification_delivery_claim_next(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.notification_delivery_complete(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.notification_delivery_fail(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.notification_deliveries_watchdog() TO service_role;

-- ---------------------------------------------------------------------------
-- 5. notify_emit — the one door every notification enters through.
--
-- Recipients = explicit user ids ∪ active holders of the given role keys,
-- deduped. EVERY recipient gets the in-app row; push / whatsapp then fan out
-- per the rule matrix: a channel fires for a recipient when ANY role they
-- hold has (event, channel) enabled. external_effects gates both external
-- channels; whatsapp additionally respects the recipient's prefs row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.notify_emit(
  p_workspace text,
  p_event     text,
  p_role_keys text[],
  p_user_ids  uuid[],
  p_title_ar  text,
  p_title_en  text,
  p_body_ar   text,
  p_body_en   text,
  p_url       text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_external   boolean;
  v_uid        uuid;
  v_nid        uuid;
  v_count      integer := 0;
  v_role_ids   uuid[];
  v_push_on    boolean;
  v_wa_on      boolean;
  v_wa_pref    boolean;
BEGIN
  v_external := COALESCE(
    (SELECT (value->>'enabled')::boolean FROM public.mos_settings WHERE key = 'external_effects'),
    true);

  FOR v_uid IN
    SELECT DISTINCT s.uid
      FROM (
        SELECT unnest(p_user_ids) AS uid
        UNION
        SELECT u.id
          FROM public.users u
         WHERE u.is_active
           AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e
               JOIN public.roles r ON r.id::text = e->>'role_id'
              WHERE r.key = ANY(p_role_keys))
      ) s
     WHERE s.uid IS NOT NULL
  LOOP
    -- In-app is not an external effect: the row is written unconditionally.
    INSERT INTO public.notifications
      (user_id, workspace, kind, title_ar, title_en, body_ar, body_en, url)
    VALUES
      (v_uid, p_workspace, p_event, p_title_ar, p_title_en, p_body_ar, p_body_en, p_url)
    RETURNING id INTO v_nid;
    v_count := v_count + 1;

    -- The recipient's own roles decide which channels fire.
    SELECT array_agg((e->>'role_id')::uuid)
      INTO v_role_ids
      FROM public.users u,
           jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e
     WHERE u.id = v_uid;

    SELECT COALESCE(bool_or(nr.enabled), false) INTO v_push_on
      FROM public.notification_rules nr
     WHERE nr.event = p_event AND nr.channel = 'push'
       AND nr.role_id = ANY(COALESCE(v_role_ids, '{}'));

    SELECT COALESCE(bool_or(nr.enabled), false) INTO v_wa_on
      FROM public.notification_rules nr
     WHERE nr.event = p_event AND nr.channel = 'whatsapp'
       AND nr.role_id = ANY(COALESCE(v_role_ids, '{}'));

    -- ── push → existing push_outbox queue ─────────────────────────────────
    IF v_push_on THEN
      IF v_external THEN
        INSERT INTO public.push_outbox (user_id, kind, title, body, url, tag, dedupe_key)
        VALUES (
          v_uid,
          'notify:' || p_event,
          COALESCE(p_title_ar, p_title_en),
          COALESCE(p_body_ar, p_body_en, ''),
          p_url,
          'ntf-' || p_event,
          'ntf:' || v_nid || ':' || v_uid
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
      ELSE
        RAISE NOTICE 'notify_emit: push skipped (external_effects off) event=% user=%', p_event, v_uid;
      END IF;
    END IF;

    -- ── whatsapp → notification_deliveries queue ──────────────────────────
    IF v_wa_on THEN
      -- Absent prefs row = whatsapp on (the default).
      SELECT p.whatsapp_enabled INTO v_wa_pref
        FROM public.notification_prefs p WHERE p.user_id = v_uid;
      v_wa_pref := COALESCE(v_wa_pref, true);

      IF v_external AND v_wa_pref THEN
        INSERT INTO public.notification_deliveries (notification_id, channel)
        VALUES (v_nid, 'whatsapp');
      ELSIF NOT v_external AND v_wa_pref THEN
        -- Visible no-op: the delivery WOULD have fired. Logged so an operator
        -- can see exactly what the kill switch suppressed.
        INSERT INTO public.notification_deliveries (notification_id, channel, status, last_error)
        VALUES (v_nid, 'whatsapp', 'skipped', 'external-effects-off');
      END IF;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Definer function: it only notifies, so direct client calls are acceptable —
-- but server-side endpoints are the intended callers.
GRANT EXECUTE ON FUNCTION public.notify_emit(text, text, text[], uuid[], text, text, text, text, text)
  TO authenticated;

-- Bulk "mark as read" for the notification center. Bound to the caller's own
-- rows even though it is definer — the WHERE clause re-checks ownership.
CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.notifications
     SET read_at = now()
   WHERE id = ANY(p_ids)
     AND user_id = public.wassell_app_user_id(auth.uid())
     AND read_at IS NULL;
$$;

GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Seed the matrix from screen 43 (الإشعارات — لكل دور)
--
-- EVENT KEY MAP (Arabic row label on s43 → event key):
--   فُتحت لك مهمة            → task_assigned        «اعتُمدت خطوة سابقة ودورك بدأ»
--   أُعيد عملك بتعديلات       → changes_requested    «مع الملاحظة كاملة في نص الإشعار»
--   اعتُمد عملك              → content_approved
--   مهمتك تستحق غدًا          → task_due_soon
--   مهمتك تأخرت              → task_overdue
--   ذُكِرتَ في تعليق          → mentioned_in_comment
--   حان وقت النشر            → publish_due          «للدور الذي ينشر فقط»
--   ميزانية تنتظر توقيعك      → budget_signature     (CEO card)
--   التقرير الشهري جاهز       → monthly_report_ready (CEO card)
--
-- WHAT THE SCREEN SHOWS, LITERALLY: only the الكاتب tab's matrix is rendered,
-- plus the CEO comparison card («إشعاران فقط»: budget signature + monthly
-- report). The other three roles' tabs are NOT rendered, so their seeds below
-- are derived defaults from the screen's own annotations and are marked as
-- such — s43 is the audit surface for the writer and the CEO.
--
-- CELL → ROW MAPPING: the screen's «ملخص يومي» column is not a channel (the
-- channel domain is inapp/push/whatsapp); a digest-only pill becomes the
-- inapp row with timing='digest'. Where inapp shows «فوري» AND the digest
-- column shows «ضمن الملخص» (content_approved, task_overdue), the immediate
-- row wins — digest inclusion alongside an immediate send is a UI rollup
-- concern, and one (role,event,channel) row carries one timing.
--
-- WHATSAPP IS FOR BLOCKING EVENTS ONLY (s43 footer: «واتساب لما يعطّل شخصًا
-- آخر إن لم يُنجَز»): task_assigned, changes_requested, publish_due,
-- mentioned_in_comment for doers; task_overdue («بعد يوم» — a delayed
-- escalation, seeded enabled with the delay noted here) for everyone; for
-- the CEO exactly budget_signature + monthly_report_ready.
--
-- PUSH: s43 renders no push column (its 3 channels are داخل التطبيق / واتساب
-- / ملخص يومي). The channel ships DISABLED for every role — the matrix UI
-- can grant it per role later; notify_emit already honors it.
--
-- Off cells are seeded as enabled=false rows (full 5 roles × 9 events ×
-- 3 channels = 135 rows) so the matrix UI edits rows in place.
-- ---------------------------------------------------------------------------

WITH on_cells(role_key, event, channel, timing) AS (
  VALUES
  -- ── الكاتب (mos_writer) — transcribed verbatim from the rendered tab ──
  ('mos_writer', 'task_assigned',         'inapp',    'immediate'),
  ('mos_writer', 'task_assigned',         'whatsapp', 'immediate'),
  ('mos_writer', 'changes_requested',     'inapp',    'immediate'),
  ('mos_writer', 'changes_requested',     'whatsapp', 'immediate'),
  ('mos_writer', 'content_approved',      'inapp',    'immediate'),  -- + «ضمن الملخص»
  ('mos_writer', 'task_due_soon',         'inapp',    'digest'),     -- «٨:٠٠ ص»
  ('mos_writer', 'task_overdue',          'inapp',    'immediate'),
  ('mos_writer', 'task_overdue',          'whatsapp', 'immediate'),  -- «بعد يوم»: delayed escalation
  ('mos_writer', 'mentioned_in_comment',  'inapp',    'immediate'),
  ('mos_writer', 'mentioned_in_comment',  'whatsapp', 'immediate'),
  -- publish_due: row dimmed for the writer («للدور الذي ينشر فقط») → all off.

  -- ── المونتاج (mos_montage) — NOT rendered on s43; same matrix as the
  --    writer: both are production doers, and the screen presents المونتير
  --    as the sibling tab of the same matrix. ──
  ('mos_montage', 'task_assigned',        'inapp',    'immediate'),
  ('mos_montage', 'task_assigned',        'whatsapp', 'immediate'),
  ('mos_montage', 'changes_requested',    'inapp',    'immediate'),
  ('mos_montage', 'changes_requested',    'whatsapp', 'immediate'),
  ('mos_montage', 'content_approved',     'inapp',    'immediate'),
  ('mos_montage', 'task_due_soon',        'inapp',    'digest'),
  ('mos_montage', 'task_overdue',         'inapp',    'immediate'),
  ('mos_montage', 'task_overdue',         'whatsapp', 'immediate'),
  ('mos_montage', 'mentioned_in_comment', 'inapp',    'immediate'),
  ('mos_montage', 'mentioned_in_comment', 'whatsapp', 'immediate'),

  -- ── مشرف العمليات + مدير التسويق — NOT rendered on s43; approver/publisher
  --    defaults derived from the screen's annotations: they publish
  --    (publish_due on, inapp+whatsapp) and a late task blocks their pipeline
  --    (task_overdue on, inapp+whatsapp). Everything else in-app only. ──
  ('mos_ops_supervisor', 'task_assigned',        'inapp',    'immediate'),
  ('mos_ops_supervisor', 'changes_requested',    'inapp',    'immediate'),
  ('mos_ops_supervisor', 'content_approved',     'inapp',    'immediate'),
  ('mos_ops_supervisor', 'task_due_soon',        'inapp',    'digest'),
  ('mos_ops_supervisor', 'task_overdue',         'inapp',    'immediate'),
  ('mos_ops_supervisor', 'task_overdue',         'whatsapp', 'immediate'),
  ('mos_ops_supervisor', 'mentioned_in_comment', 'inapp',    'immediate'),
  ('mos_ops_supervisor', 'publish_due',          'inapp',    'immediate'),
  ('mos_ops_supervisor', 'publish_due',          'whatsapp', 'immediate'),

  ('mos_marketing_manager', 'task_assigned',        'inapp',    'immediate'),
  ('mos_marketing_manager', 'changes_requested',    'inapp',    'immediate'),
  ('mos_marketing_manager', 'content_approved',     'inapp',    'immediate'),
  ('mos_marketing_manager', 'task_due_soon',        'inapp',    'digest'),
  ('mos_marketing_manager', 'task_overdue',         'inapp',    'immediate'),
  ('mos_marketing_manager', 'task_overdue',         'whatsapp', 'immediate'),
  ('mos_marketing_manager', 'mentioned_in_comment', 'inapp',    'immediate'),
  ('mos_marketing_manager', 'publish_due',          'inapp',    'immediate'),
  ('mos_marketing_manager', 'publish_due',          'whatsapp', 'immediate'),

  -- ── الرئيس التنفيذي (mos_ceo) — the comparison card, transcribed:
  --    «إشعاران فقط في المنظومة كلها: ميزانية تنتظر توقيعك ← التقرير الشهري
  --    جاهز». Both are blocking-level for this role, so both get whatsapp;
  --    every other cell stays off. ──
  ('mos_ceo', 'budget_signature',     'inapp',    'immediate'),
  ('mos_ceo', 'budget_signature',     'whatsapp', 'immediate'),
  ('mos_ceo', 'monthly_report_ready', 'inapp',    'immediate'),
  ('mos_ceo', 'monthly_report_ready', 'whatsapp', 'immediate')
),
roles5(role_key) AS (
  VALUES ('mos_ceo'), ('mos_marketing_manager'), ('mos_ops_supervisor'),
         ('mos_writer'), ('mos_montage')
),
events9(event) AS (
  VALUES ('task_assigned'), ('changes_requested'), ('content_approved'),
         ('task_due_soon'), ('task_overdue'), ('mentioned_in_comment'),
         ('publish_due'), ('budget_signature'), ('monthly_report_ready')
),
channels3(channel) AS (
  VALUES ('inapp'), ('push'), ('whatsapp')
)
INSERT INTO public.notification_rules (role_id, event, channel, timing, enabled)
SELECT r.id,
       e.event,
       c.channel,
       COALESCE(o.timing, 'immediate'),
       (o.role_key IS NOT NULL)
  FROM roles5 ro
  JOIN public.roles r ON r.key = ro.role_key
 CROSS JOIN events9 e
 CROSS JOIN channels3 c
  LEFT JOIN on_cells o
    ON o.role_key = ro.role_key AND o.event = e.event AND o.channel = c.channel
ON CONFLICT (role_id, event, channel) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Validation — fail loudly inside the transaction if anything did not land
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'notify_emit'
  ) THEN
    RAISE EXCEPTION 'NTF:EMIT_MISSING — notify_emit was not created';
  END IF;

  IF (SELECT count(DISTINCT r.key)
        FROM public.notification_rules nr
        JOIN public.roles r ON r.id = nr.role_id
       WHERE r.key IN ('mos_ceo','mos_marketing_manager','mos_ops_supervisor','mos_writer','mos_montage')
     ) < 5 THEN
    RAISE EXCEPTION 'NTF:RULES_ROLE_MISSING — notification_rules must cover all 5 mos_* roles';
  END IF;

  -- s43's CEO card shows EXACTLY TWO notifications for the role (ميزانية تنتظر
  -- توقيعك + التقرير الشهري جاهز), and whatsapp is reserved for blocking
  -- events — so the CEO's whatsapp-enabled rule count must be exactly 2.
  IF (SELECT count(*)
        FROM public.notification_rules nr
        JOIN public.roles r ON r.id = nr.role_id
       WHERE r.key = 'mos_ceo' AND nr.channel = 'whatsapp' AND nr.enabled
     ) <> 2 THEN
    RAISE EXCEPTION 'NTF:CEO_WHATSAPP_COUNT — expected exactly 2 whatsapp-enabled rules for mos_ceo (s43), found %',
      (SELECT count(*)
         FROM public.notification_rules nr
         JOIN public.roles r ON r.id = nr.role_id
        WHERE r.key = 'mos_ceo' AND nr.channel = 'whatsapp' AND nr.enabled);
  END IF;
END $$;

COMMIT;
