-- ============================================================================
-- Notification sweeps + digest — the SCHEDULED half of the notifications
-- platform (2026-08-01_04). The Fly worker calls these on a timer; the
-- database itself cannot schedule anything (no pg_cron on this project).
--
--   mos_notification_sweep()   every ~5 min — event-driven notifications that
--                              no user action triggers: a publication whose
--                              scheduled time is approaching (publish_due) and
--                              an open role task past its due_at (task_overdue).
--                              Each sub-sweep is IDEMPOTENT: re-running within
--                              the window never double-notifies.
--
--   mos_notification_digest(h) hourly — the «ملخص يومي» from screen 43: one
--                              summary push per user at their digest_hour,
--                              once per day, only when they have unread
--                              notifications older than 1 hour.
--
-- Also adds users.phone — the staff WhatsApp target the notification
-- WhatsApp lane (notification_deliveries → /api/internal/send-notification-wa)
-- sends to.
--
-- ROLE KEYS: notify_emit matches p_role_keys against roles.key, whose canonical
-- marketing values are mos_*-PREFIXED (2026-08-01_01). workflow_role_tasks.
-- role_key is UNPREFIXED ('writer', 'ops_supervisor', …) — the sweep therefore
-- prefixes with 'mos_' when fanning out, same as wassell_mos_can does.
--
-- Idempotent: re-running is a no-op.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. users.phone — staff WhatsApp number (E.164), the delivery target for the
--    notification WhatsApp lane. Editable in Settings → People + account page.
-- ---------------------------------------------------------------------------

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone text;

COMMENT ON COLUMN public.users.phone IS
  'Staff WhatsApp number in E.164 (e.g. +9665xxxxxxxx). The notification '
  'WhatsApp lane (/api/internal/send-notification-wa) sends here; editable in '
  'Settings → People and the account page.';

-- ---------------------------------------------------------------------------
-- 2. mos_notification_sweep() — called by the Fly worker every ~5 min.
--    SECURITY DEFINER so it can read mos_publications / workflow_role_tasks /
--    notifications regardless of the caller (granted to service_role only).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mos_notification_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_publish_due  integer := 0;
  v_task_overdue integer := 0;
  v_pub          record;
  v_task         record;
  v_url          text;
BEGIN
  -- ── a. publish_due — a scheduled publication inside the next 60 minutes ──
  -- Recipients: the roles that publish/write (per the s43 matrix, «حان وقت
  -- النشر» is للدور الذي ينشر فقط). notify_emit filters channels per the rule
  -- matrix; the in-app row goes to every recipient.
  FOR v_pub IN
    SELECT p.id, p.content_id
      FROM public.mos_publications p
     WHERE p.status = 'scheduled'
       AND p.scheduled_at >= now()
       AND p.scheduled_at <= now() + interval '60 minutes'
  LOOP
    v_url := '/m/content/' || v_pub.content_id || '?tab=publish';

    -- Idempotency: the URL is content-scoped (it opens the content's publish
    -- tab), so the dedupe is per CONTENT — one «حان وقت النشر» covers every
    -- platform publication of that content. (A publication-id substring check
    -- could never match a URL that does not contain the publication id.)
    IF EXISTS (
      SELECT 1 FROM public.notifications n
       WHERE n.kind = 'publish_due' AND n.url = v_url
    ) THEN
      CONTINUE;
    END IF;

    PERFORM public.notify_emit(
      'marketing',
      'publish_due',
      ARRAY['mos_ops_supervisor', 'mos_writer'],
      '{}'::uuid[],
      'حان وقت النشر',
      NULL,
      'محتوى مجدول يقترب موعد نشره خلال الساعة القادمة.',
      NULL,
      v_url
    );
    v_publish_due := v_publish_due + 1;
  END LOOP;

  -- ── b. task_overdue — an open role task past its due_at ──────────────────
  -- Recipients: the task's own role + its assignee. Re-fires at most once per
  -- 24 h per subject (s43: «بعد يوم» — a delayed escalation, not a loop).
  FOR v_task IN
    SELECT t.id, t.subject_table, t.subject_id, t.role_key, t.assignee_user_id
      FROM public.workflow_role_tasks t
     WHERE t.status = 'open'
       AND t.due_at IS NOT NULL
       AND t.due_at < now()
       -- The URL shape below is content-scoped; other subject tables need
       -- their own shape before they join this sweep.
       AND t.subject_table = 'mos_content'
  LOOP
    v_url := '/m/content/' || v_task.subject_id;

    IF EXISTS (
      SELECT 1 FROM public.notifications n
       WHERE n.kind = 'task_overdue'
         AND n.url LIKE '%' || v_task.subject_id || '%'
         AND n.created_at > now() - interval '24 hours'
    ) THEN
      CONTINUE;
    END IF;

    PERFORM public.notify_emit(
      'marketing',
      'task_overdue',
      -- roles.key is mos_*-prefixed; workflow_role_tasks.role_key is not.
      ARRAY['mos_' || v_task.role_key],
      CASE WHEN v_task.assignee_user_id IS NULL
           THEN '{}'::uuid[]
           ELSE ARRAY[v_task.assignee_user_id] END,
      'مهمتك تأخرت',
      NULL,
      'مهمة تجاوزت موعدها المستحق ولم تُغلق بعد.',
      NULL,
      v_url
    );
    v_task_overdue := v_task_overdue + 1;
  END LOOP;

  RETURN jsonb_build_object('publish_due', v_publish_due, 'task_overdue', v_task_overdue);
END;
$$;

COMMENT ON FUNCTION public.mos_notification_sweep() IS
  'Scheduled-notification sweep (publish_due + task_overdue), called by the '
  'Fly worker every ~5 min. Idempotent: dedupes on the notification URL so a '
  're-run inside the window never double-notifies.';

-- ---------------------------------------------------------------------------
-- 3. mos_notification_digest(p_hour) — the daily «ملخص يومي» (s43). One push
--    per user whose digest_hour matches, ONLY when they have unread
--    notifications older than 1 hour. The dedupe_key makes it once/day.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mos_notification_digest(p_hour integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_external boolean;
  v_user     record;
  v_unread   integer;
  v_count    integer := 0;
BEGIN
  -- The digest is a push — an external effect. The kill switch suppresses it.
  v_external := COALESCE(
    (SELECT (value->>'enabled')::boolean FROM public.mos_settings WHERE key = 'external_effects'),
    true);
  IF NOT v_external THEN
    RAISE NOTICE 'mos_notification_digest: skipped (external_effects off) hour=%', p_hour;
    RETURN 0;
  END IF;

  FOR v_user IN
    SELECT u.id
      FROM public.users u
      LEFT JOIN public.notification_prefs p ON p.user_id = u.id
     WHERE u.is_active
       -- Absent prefs row = the default digest hour (8 = «٨:٠٠ ص» on s43).
       AND COALESCE(p.digest_hour, 8) = p_hour
  LOOP
    SELECT count(*) INTO v_unread
      FROM public.notifications n
     WHERE n.user_id = v_user.id
       AND n.read_at IS NULL
       -- Only notifications that have sat unread for a while — something you
       -- received 5 minutes ago is not yet "missed".
       AND n.created_at < now() - interval '1 hour';

    IF v_unread = 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO public.push_outbox (user_id, kind, title, body, url, tag, dedupe_key)
    VALUES (
      v_user.id,
      'notify:digest',
      'ملخص التسويق: ' || v_unread || ' إشعارات غير مقروءة',
      '',
      '/m',
      'ntf-digest',
      -- Once per user per day. The day boundary is the DB server's clock
      -- (UTC); the worker passes the Riyadh hour, and for the digest hours
      -- anyone would actually pick (morning) the two calendars agree.
      'digest:' || v_user.id || ':' || to_char(now(), 'YYYY-MM-DD')
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.mos_notification_digest(p_hour integer) IS
  'Daily digest (s43 «ملخص يومي»): queues ONE summary push into push_outbox '
  'for every active user whose digest_hour = p_hour and who has unread '
  'notifications older than 1 hour. Dedupe-keyed once/day; gated on '
  'mos_settings.external_effects. Called hourly by the Fly worker with the '
  'Asia/Riyadh hour. Returns the number of users digested.';

-- ---------------------------------------------------------------------------
-- 4. Grants — service_role only (the Fly worker). Clients never call these.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.mos_notification_sweep() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_notification_digest(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mos_notification_sweep() TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_notification_digest(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- Validation — fail loudly inside the transaction if anything did not land
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'phone'
  ) THEN
    RAISE EXCEPTION 'NTF:PHONE_MISSING — users.phone was not added';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'mos_notification_sweep'
  ) THEN
    RAISE EXCEPTION 'NTF:SWEEP_MISSING — mos_notification_sweep was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'mos_notification_digest'
  ) THEN
    RAISE EXCEPTION 'NTF:DIGEST_MISSING — mos_notification_digest was not created';
  END IF;
END $$;

COMMIT;
