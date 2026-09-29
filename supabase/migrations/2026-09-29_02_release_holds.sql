-- 2026-09-29 — A release that cannot go out says so, on the month page.
--
-- WHY. Publishing tasks were switched off on 2026-09-27 (operator rule: publishing
-- is not a task). `mos_release_open_task` — the one door every "this release
-- needs a person" path goes through (the sweep's non-automatable releases, stale
-- releases, failed hand-offs, and every material-rule refusal) — then simply
-- RETURNed NULL. Combined with automatic publishing being off since the 16 Sep
-- test week, 12 releases missed their dates (22 and 24 Sep) with nothing
-- anywhere saying so: no task, no exception line, and a reason label that read
-- "account not connected" while every account was connected.
--
-- WHAT THIS DOES.
--   * mos_publications gains hold_reason / hold_detail / hold_at: WHY the sweep
--     could not post this release. Written by mos_release_open_task when tasks
--     are off, only when it changes. Cleared by a trigger the moment the release
--     is rescheduled, cancelled, published, or handed to bundle.social.
--   * mos_month_exceptions gains arm a10: one «يحتاج قرارك» line per held release,
--     with the three decisions «انشر الآن / أعد الجدولة / ألغِ» (the SPA acts on
--     them through publication_publish / release_reschedule / release_cancel).
--   * mos_release_due names the switch ('auto_publish_off') instead of blaming
--     the account, and no longer re-offers a release already handed to
--     bundle.social (the sweep re-published it, got 409, and logged a failure).
--
-- Nothing here raises SQLSTATE 40001/40P01. No view is replaced (mos_release_v
-- is untouched; a10 joins mos_publications for the new columns).
BEGIN;

-- ── 1. the hold, on the release itself ────────────────────────────────────────
ALTER TABLE public.mos_publications
  ADD COLUMN IF NOT EXISTS hold_reason text,
  ADD COLUMN IF NOT EXISTS hold_detail text,
  ADD COLUMN IF NOT EXISTS hold_at     timestamptz;

COMMENT ON COLUMN public.mos_publications.hold_reason IS
  'Why the release sweep could not post this release (2026-09-29): auto_publish_off, not_approved, in_production, stale, material_unresolved, approval_mismatch, preflight_blocked, publish_failed, … Cleared when the release is rescheduled, cancelled, published or handed off.';

-- The words a person reads for each reason. One place, used by the hold and the
-- month page; the task branch keeps its own (older) wording untouched.
CREATE OR REPLACE FUNCTION public.mos_release_hold_text(p_reason text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_reason
    WHEN 'auto_publish_off'         THEN 'النشر الآلي متوقف من الإعدادات، فلم يُرسل هذا المنشور.'
    WHEN 'not_approved'             THEN 'لم يُعتمد التصميم النهائي بعد — لا يُنشر شيء قبل الاعتماد.'
    WHEN 'in_production'            THEN 'المحتوى ما زال قيد العمل — يُنشر بعد اعتماده النهائي.'
    WHEN 'stale'                    THEN 'فات موعده بأكثر من يوم فلم يُنشر آليًا.'
    WHEN 'material_unresolved'      THEN 'ينقص التصميم المطلوب لهذه الوجهة.'
    WHEN 'approval_mismatch'        THEN 'تغيّر التصميم أو الكابشن بعد الاعتماد — لن يُنشر شيء غير معتمد.'
    WHEN 'preflight_blocked'        THEN 'لا يستوفي شروط المنصة.'
    WHEN 'publish_failed'           THEN 'فشل إرساله إلى المنصة.'
    WHEN 'account_not_connected'    THEN 'الحساب غير موصول أو لا يملك صلاحية النشر.'
    WHEN 'platform_not_automatable' THEN 'هذه المنصة بلا ربط نشر آلي.'
    WHEN 'manual_by_policy'         THEN 'النشر على هذه المنصة يدوي بقرار التشغيل.'
    ELSE 'توقّف قبل النشر وينتظر قرارك.'
  END;
$function$;

CREATE OR REPLACE FUNCTION public.mos_release_hold_label(p_reason text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_reason
    WHEN 'auto_publish_off'         THEN 'لم يُنشر: النشر الآلي متوقف'
    WHEN 'not_approved'             THEN 'حان موعده ولم يُعتمد'
    WHEN 'in_production'            THEN 'حان موعده وما زال قيد العمل'
    WHEN 'stale'                    THEN 'فات موعده ولم يُنشر'
    WHEN 'material_unresolved'      THEN 'ينقصه التصميم'
    WHEN 'approval_mismatch'        THEN 'تغيّر بعد الاعتماد'
    WHEN 'preflight_blocked'        THEN 'لا يستوفي شروط المنصة'
    WHEN 'publish_failed'           THEN 'فشل النشر'
    WHEN 'account_not_connected'    THEN 'يحتاج نشرًا يدويًا'
    WHEN 'platform_not_automatable' THEN 'يحتاج نشرًا يدويًا'
    WHEN 'manual_by_policy'         THEN 'يحتاج نشرًا يدويًا'
    ELSE 'متوقف بانتظار قرارك'
  END;
$function$;

-- A hold describes the release as it WAS. The moment someone reschedules it,
-- cancels it, or it is handed off or published, the old reason is no longer
-- true — clear it in the same write so the month page never shows a stale one.
CREATE OR REPLACE FUNCTION public.mos_tg_publication_hold_clear()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.hold_reason IS NOT NULL
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
          OR NEW.bundle_post_id IS DISTINCT FROM OLD.bundle_post_id) THEN
    NEW.hold_reason := NULL;
    NEW.hold_detail := NULL;
    NEW.hold_at := NULL;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS mos_publication_hold_clear ON public.mos_publications;
CREATE TRIGGER mos_publication_hold_clear
  BEFORE UPDATE OF status, scheduled_at, bundle_post_id ON public.mos_publications
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_publication_hold_clear();


-- ── mos_release_due — re-emitted from LIVE; changes marked 2026-09-29 ──
CREATE OR REPLACE FUNCTION public.mos_release_due(p_horizon_minutes integer DEFAULT NULL::integer)
 RETURNS TABLE(release_id uuid, content_id uuid, platform text, account_id uuid, due_at timestamp with time zone, automatable boolean, reason text, open_task_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT r.release_id, r.content_id, r.platform, r.account_id, r.due_at, r.automatable,
         CASE
           WHEN r.automatable THEN NULL
           -- The switch, named as the switch (2026-09-29). This used to fall
           -- through to 'account_not_connected' while every account was connected.
           WHEN NOT COALESCE((public.mos_planning_cfg() ->> 'release_auto_publish')::boolean, true)
             THEN 'auto_publish_off'
           WHEN NOT EXISTS (SELECT 1 FROM public.mos_platform_accounts a
                             WHERE a.platform = r.platform AND a.archived_at IS NULL)
             THEN 'platform_not_automatable'
           WHEN public.mos_planning_cfg() -> 'release_manual_platforms' @> to_jsonb(r.platform)
             THEN 'manual_by_policy'
           ELSE 'account_not_connected'
         END AS reason,
         r.open_task_id
    FROM public.mos_release_v r
   WHERE r.status IN ('planned','draft','scheduled')
     -- Already handed to bundle.social: the platform owns it now. Re-offering it
     -- made the sweep re-publish, get a 409 and log a false failure every tick.
     AND r.bundle_post_id IS NULL
     AND r.due_at IS NOT NULL
     AND r.due_at <= now() + make_interval(
           mins => COALESCE(p_horizon_minutes,
                            (public.mos_planning_cfg() ->> 'release_sweep_horizon_minutes')::int,
                            15))
   ORDER BY r.due_at;
$function$;

-- ── mos_release_open_task — re-emitted from LIVE; only the tasks-off branch changes ──
CREATE OR REPLACE FUNCTION public.mos_release_open_task(p_publication_id uuid, p_reason text, p_detail text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rel      record;
  v_existing uuid;
  v_owner    uuid;
  v_role     text := COALESCE(public.mos_planning_cfg() ->> 'release_owner_role', 'mos_writer');
  v_id       uuid;
  v_title    text;
BEGIN
  -- Publishing is not a task (2026-09-27). Off unless the setting says exactly
  -- true: no publish task is opened, by any caller. NULL is the function's own
  -- "nothing to open" answer, which every caller already handles.
  IF COALESCE(public.mos_planning_cfg() ->> 'publish_tasks_enabled', 'false') <> 'true' THEN
    -- Still no task — but never silence (2026-09-29). Until now this RETURNed
    -- and the release sat in 'planned' with nobody told: 12 posts missed their
    -- dates that way. The reason is recorded on the release itself, where the
    -- month page's «يحتاج قرارك» lists it with «انشر الآن / أعد الجدولة / ألغِ».
    -- Written only when it changes, so a 5-minute sweep re-refusing the same
    -- release does not rewrite the row every tick.
    UPDATE public.mos_publications p
       SET hold_reason = p_reason,
           hold_detail = COALESCE(NULLIF(btrim(p_detail), ''), public.mos_release_hold_text(p_reason)),
           hold_at     = now()
     WHERE p.id = p_publication_id
       AND p.status NOT IN ('published', 'cancelled')
       AND p.bundle_post_id IS NULL
       AND (p.hold_reason IS DISTINCT FROM p_reason
            OR p.hold_detail IS DISTINCT FROM
               COALESCE(NULLIF(btrim(p_detail), ''), public.mos_release_hold_text(p_reason)));
    RETURN NULL;
  END IF;

  SELECT * INTO v_rel FROM public.mos_release_v WHERE release_id = p_publication_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:RELEASE_NOT_FOUND %', p_publication_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT id INTO v_existing FROM public.mos_manual_tasks
   WHERE kind = 'publish' AND ref_id = p_publication_id AND status = 'open' LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  IF v_rel.status IN ('published','cancelled') THEN RETURN NULL; END IF;

  -- 1. whoever holds the configured release role, most publishing headroom first
  SELECT u.id INTO v_owner
    FROM public.users u
    JOIN public.roles r
      ON r.key = v_role
     AND r.id::text IN (SELECT e ->> 'role_id'
                          FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
   WHERE u.is_active
   ORDER BY public.mos_user_daily_slots(u.id, 'publishing') DESC, u.id
   LIMIT 1;

  -- 2. the marketing manager, who can always reassign it
  IF v_owner IS NULL THEN
    SELECT u.id INTO v_owner
      FROM public.users u
      JOIN public.roles r
        ON r.key = 'mos_marketing_manager'
       AND r.id::text IN (SELECT e ->> 'role_id'
                            FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
     WHERE u.is_active
     ORDER BY u.id
     LIMIT 1;
  END IF;

  -- 3. anyone who works in marketing at all
  IF v_owner IS NULL THEN
    SELECT u.id INTO v_owner
      FROM public.users u
      JOIN public.roles r
        ON r.key LIKE 'mos\_%' ESCAPE '\'
       AND r.id::text IN (SELECT e ->> 'role_id'
                            FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
     WHERE u.is_active
     ORDER BY u.id
     LIMIT 1;
  END IF;

  -- Nobody at all. Say so in the log instead of returning a quiet NULL that
  -- reads like "nothing to do": this release cannot go out and no one knows.
  IF v_owner IS NULL THEN
    RAISE WARNING 'MOS:RELEASE_UNASSIGNABLE % (%) — no active marketing user to own it', p_publication_id, p_reason;
    RETURN NULL;
  END IF;

  v_title := 'نشر — ' || COALESCE(v_rel.content_title, v_rel.content_ref, '') ||
             ' · ' || v_rel.platform;

  INSERT INTO public.mos_manual_tasks
    (title, details, assignee_user_id, created_by_user_id, campaign_id, content_id, project_id,
     status, due_at, kind, ref_id, entity_kind, entity_id, action)
  VALUES (
    left(v_title, 200),
    COALESCE(p_detail, CASE p_reason
      WHEN 'account_not_connected'    THEN 'الحساب غير موصول أو لا يملك صلاحية النشر — انشر يدويًا ثم ألصق الرابط.'
      WHEN 'platform_not_automatable' THEN 'هذه المنصة بلا ربط نشر — انشر يدويًا ثم ألصق الرابط.'
      WHEN 'manual_by_policy'         THEN 'النشر على هذه المنصة يدوي بقرار التشغيل.'
      WHEN 'preflight_blocked'        THEN 'متطلبات المنصة غير مستوفاة — عالجها ثم انشر.'
      WHEN 'publish_failed'           THEN 'فشل النشر الآلي — راجع السبب ثم أعد المحاولة.'
      ELSE 'يحتاج النشر إلى تدخل يدوي.' END),
    v_owner, v_owner, v_rel.campaign_id, v_rel.content_id, v_rel.project_id,
    'open', v_rel.due_at, 'publish', p_publication_id, 'publication', p_publication_id, p_reason)
  RETURNING id INTO v_id;

  RETURN v_id;
END $function$;

-- ── mos_month_exceptions — re-emitted from LIVE; adds arm a10 (held releases) ──
CREATE OR REPLACE FUNCTION public.mos_month_exceptions(p_month date DEFAULT NULL::date)
 RETURNS TABLE(kind text, severity text, subject_kind text, subject_id uuid, label_ar text, detail_ar text, occurred_on date, project_id uuid, campaign_id uuid, action_hint text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH
  gate AS (SELECT (public.mos_caller_is_trusted_service() OR public.wassell_mos_can('read')) AS ok),
  today AS (SELECT public.mos_perf_today() AS d),

  a1 AS (
    SELECT 'row_incomplete'::text, 'blocker'::text, 'row'::text, r.id,
           'صف غير مكتمل في موعد نشره'::text,
           ('الصف فيه ' || (SELECT count(*) FROM public.mos_content c WHERE c.row_id = r.id)
             || ' منشورات وما زال عليه عمل مفتوح عند '
             || COALESCE(r.batch_day::text, '—'))::text,
           r.batch_day, r.project_id, r.campaign_id,
           'move_row_or_drop_late_post'::text
      FROM public.mos_content_rows r, today
     WHERE r.batch_day IS NOT NULL
       AND r.batch_day <= today.d
       AND (EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                     WHERE t.status = 'open'
                       AND t.subject_table = 'mos_content_rows' AND t.subject_id = r.id)
         OR EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                      JOIN public.mos_content c ON c.id = t.subject_id
                     WHERE t.status = 'open' AND t.subject_table = 'mos_content'
                       AND c.row_id = r.id))),

  a2 AS (
    SELECT 'changes_requested_3'::text, 'blocker'::text,
           CASE WHEN t.subject_table = 'mos_content_rows' THEN 'row' ELSE 'content' END::text,
           t.subject_id,
           'أُعيد للتعديل ثلاث مرات أو أكثر'::text,
           ('عدد مرات الإعادة: ' || count(*)::text)::text,
           max((t.closed_at AT TIME ZONE 'Asia/Riyadh')::date),
           NULL::uuid, NULL::uuid,
           'replace_or_move_row'::text
      FROM public.workflow_role_tasks t
     WHERE t.status = 'done'
       AND t.result IN ('changes_requested', 'rejected')
       AND t.subject_table IN ('mos_content','mos_content_rows')
       AND EXISTS (SELECT 1 FROM public.workflow_role_tasks o
                    WHERE o.status = 'open'
                      AND o.subject_table = t.subject_table
                      AND o.subject_id = t.subject_id)
     GROUP BY t.subject_table, t.subject_id
    HAVING count(*) >= 3),

  a3 AS (
    SELECT 'ad_failed'::text, 'blocker'::text, 'ad'::text,
           COALESCE(m.entity_id, m.ref_id, m.id),
           'فشل إنشاء إعلان'::text,
           COALESCE(NULLIF(btrim(m.details), ''), m.title)::text,
           (m.created_at AT TIME ZONE 'Asia/Riyadh')::date,
           m.project_id, m.campaign_id,
           'retry_or_replace_creative'::text
      FROM public.mos_manual_tasks m
     WHERE m.status = 'open' AND m.kind = 'ad_failed'),

  rel AS (
    SELECT r.*, t.d AS today,
           CASE
             WHEN r.due_at IS NOT NULL AND r.due_at <= now()
                  AND (r.account_id IS NULL
                       OR COALESCE(r.account_connected, false) = false
                       OR COALESCE(r.account_can_publish, false) = false)
               THEN 'account_not_connected'
             WHEN public.mos_exception_is_platform_rejection(r.bundle_status, r.bundle_error)
               THEN 'platform_rejected'
             WHEN COALESCE(r.bundle_status, '') IN ('failed','error')
                  OR NULLIF(btrim(r.bundle_error), '') IS NOT NULL
               THEN 'publish_failed'
             ELSE NULL
           END AS why
      FROM public.mos_release_v r, today t
     WHERE r.status NOT IN ('published','cancelled')),

  a456 AS (
    SELECT r.why::text, 'blocker'::text, 'release'::text, r.release_id,
           (CASE r.why
              WHEN 'account_not_connected' THEN 'الحساب غير موصول أو لا يملك صلاحية النشر'
              WHEN 'platform_rejected'     THEN 'المنصة رفضت المنشور'
              ELSE 'فشل النشر الآلي' END)::text,
           (CASE r.why
              WHEN 'account_not_connected'
                THEN 'المنصة: ' || r.platform || COALESCE(' · ' || r.account_handle, '')
              ELSE COALESCE(NULLIF(btrim(r.bundle_error), ''),
                            'حالة النشر: ' || COALESCE(r.bundle_status, '—')) END)::text,
           COALESCE((r.due_at AT TIME ZONE 'Asia/Riyadh')::date, r.today),
           r.project_id, r.campaign_id,
           (CASE r.why
              WHEN 'account_not_connected' THEN 'connect_account_then_retry'
              WHEN 'platform_rejected'     THEN 'fix_what_was_named_then_retry'
              ELSE 'retry_or_record_manually' END)::text
      FROM rel r
     WHERE r.why IS NOT NULL),

  a7 AS (
    SELECT DISTINCT 'project_sold_out'::text, 'blocker'::text, 'project'::text, p.id,
           'مشروع نفدت وحداته'::text,
           ('الوحدات المتاحة: 0 من ' ||
             COALESCE(public.try_numeric(p.data ->> 'unit_count')::text, '—'))::text,
           t.d, p.id, NULL::uuid,
           'pick_replacement_project'::text
      FROM public.records p, today t
     WHERE p.model_id = (SELECT m.id FROM public.models m WHERE m.name = 'all_projects')
       AND COALESCE(public.try_numeric(p.data ->> 'unit_count'), 0) > 0
       AND COALESCE(public.try_numeric(p.data ->> 'available_units'), 0) = 0
       AND (EXISTS (SELECT 1 FROM public.mos_content_rows r
                     WHERE r.project_id = p.id
                       AND COALESCE(r.batch_day, t.d) >= t.d)
         OR EXISTS (SELECT 1 FROM public.mos_campaigns cm
                     WHERE cm.project_id = p.id AND cm.status = 'active'
                       AND cm.archived_at IS NULL))),

  a8 AS (
    SELECT 'capacity_breach'::text, 'warning'::text, 'person'::text, l.user_id,
           'حمل يتجاوز طاقة اليوم'::text,
           ('اليوم ' || l.day::text || ' · ' || l.bucket || ' · '
             || round(sum(l.weight), 2)::text || ' من ' || cap.daily_slots::text)::text,
           l.day, NULL::uuid, NULL::uuid,
           'rebalance_or_move_a_batch'::text
      FROM public.mos_work_ledger_v l
      JOIN public.mos_user_capacity cap
        ON cap.user_id = l.user_id AND cap.bucket = l.bucket
      CROSS JOIN today t
     WHERE l.day >= t.d
       AND cap.daily_slots > 0
     GROUP BY l.user_id, l.day, l.bucket, cap.daily_slots
    HAVING sum(l.weight) > cap.daily_slots),

  a9 AS (
    SELECT 'ranking_cleared_none'::text, 'blocker'::text, 'cycle'::text, cy.id,
           'الترتيب الأسبوعي لم يرشّح أي تصميم'::text,
           COALESCE(cy.decision -> 'exception' ->> 'message_ar',
                    cy.decision -> 'exception' ->> 'message',
                    'لم يجتز أي إعلان حدّي الإنفاق والظهور، فلن يُوقَف شيء بينما تُفعَّل خمسة جديدة.')::text,
           COALESCE(cy.decision_due_on, cy.refresh_on),
           cm.project_id, ex.campaign_id,
           'decide_slate_manually'::text
      FROM public.mos_refresh_cycles cy
      JOIN public.mos_campaign_executions ex ON ex.id = cy.execution_id
      LEFT JOIN public.mos_campaigns cm ON cm.id = ex.campaign_id
     WHERE cy.decision -> 'exception' ->> 'code' = 'ranking_empty'
       AND cy.status NOT IN ('applied','cancelled','skipped')),

  -- A release the sweep could not post and recorded why (2026-09-29). One line
  -- per release, and only when the arm above has not already named a cause for
  -- it (account / platform rejection / failure keep their own wording).
  a10 AS (
    SELECT 'release_held'::text, 'blocker'::text, 'release'::text, r.release_id,
           public.mos_release_hold_label(p.hold_reason)::text,
           (COALESCE(r.content_ref, '') || ' · '
             || CASE p.placement_variant WHEN 'feed' THEN 'فيد' WHEN 'story' THEN 'ستوري'
                                        ELSE r.platform END
             || ' — ' || COALESCE(p.hold_detail, public.mos_release_hold_text(p.hold_reason)))::text,
           COALESCE((r.due_at AT TIME ZONE 'Asia/Riyadh')::date, t.d),
           r.project_id, r.campaign_id,
           'publish_now_reschedule_or_cancel'::text
      FROM public.mos_release_v r
      JOIN public.mos_publications p ON p.id = r.release_id
      CROSS JOIN today t
     WHERE p.hold_reason IS NOT NULL
       AND r.status NOT IN ('published', 'cancelled')
       AND r.bundle_post_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM rel x WHERE x.release_id = r.release_id AND x.why IS NOT NULL)),

  all_rows(kind, severity, subject_kind, subject_id, label_ar, detail_ar,
           occurred_on, project_id, campaign_id, action_hint) AS (
    SELECT * FROM a1 UNION ALL SELECT * FROM a2 UNION ALL SELECT * FROM a3
    UNION ALL SELECT * FROM a456
    UNION ALL SELECT * FROM a7 UNION ALL SELECT * FROM a8 UNION ALL SELECT * FROM a9
    UNION ALL SELECT * FROM a10)
SELECT x.*
  FROM all_rows x, gate
 WHERE gate.ok
   AND (p_month IS NULL
        OR x.occurred_on IS NULL
        OR date_trunc('month', x.occurred_on) = date_trunc('month', p_month))
 ORDER BY (x.severity = 'blocker') DESC, x.occurred_on NULLS LAST, x.kind, x.subject_id;
$function$;

-- ── assertions — loud, in the same transaction ────────────────────────────────
DO $assert$
DECLARE
  v_def text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'mos_publications'
         AND column_name IN ('hold_reason', 'hold_detail', 'hold_at')) <> 3 THEN
    RAISE EXCEPTION 'RELEASE_HOLDS: hold columns missing on mos_publications';
  END IF;

  v_def := pg_get_functiondef('public.mos_release_due(integer)'::regprocedure);
  IF position('auto_publish_off' IN v_def) = 0 OR position('r.bundle_post_id IS NULL' IN v_def) = 0 THEN
    RAISE EXCEPTION 'RELEASE_HOLDS: mos_release_due did not take the reason/hand-off changes';
  END IF;

  v_def := pg_get_functiondef('public.mos_release_open_task(uuid, text, text)'::regprocedure);
  IF position('hold_reason = p_reason' IN v_def) = 0 THEN
    RAISE EXCEPTION 'RELEASE_HOLDS: mos_release_open_task does not record the hold';
  END IF;

  v_def := pg_get_functiondef('public.mos_month_exceptions(date)'::regprocedure);
  IF position('release_held' IN v_def) = 0 OR position('UNION ALL SELECT * FROM a10' IN v_def) = 0 THEN
    RAISE EXCEPTION 'RELEASE_HOLDS: mos_month_exceptions has no held-release arm';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.mos_publications'::regclass
                    AND tgname = 'mos_publication_hold_clear') THEN
    RAISE EXCEPTION 'RELEASE_HOLDS: hold-clearing trigger missing';
  END IF;

  IF public.mos_release_hold_label('stale') IS NULL OR public.mos_release_hold_text('nonsense') IS NULL THEN
    RAISE EXCEPTION 'RELEASE_HOLDS: hold wording functions return NULL';
  END IF;
END $assert$;

COMMIT;
