-- ============================================================================
-- C7 — «يحتاج قرارك»: the exceptions list. 2026-09-15.
--
-- One function, nine arms. It is the whole of §3.3: the list is empty when
-- everything follows the rules, and each line is ONE exception with the
-- smallest decision that resolves it.
--
-- THE MEASUREMENT THAT SHAPED THIS: `workflow_role_tasks.result = 'rejected'`
-- has ZERO rows across 322 tasks. The live value is `changes_requested`
-- (15 rows today: writing_review, design_review, design, editing). A
-- "rejected three times" predicate written against 'rejected' would NEVER
-- FIRE — the list would look permanently clean while a post went round four
-- times. Arm 2 counts `changes_requested`, and `rejected` is accepted only as
-- a defensive alias so a future writer of that value is not invisible.
--
-- The nine:
--   1 row_incomplete        a row still has open work at its batch date
--   2 changes_requested_3   an item sent back three times or more
--   3 ad_failed             Meta refused the ad, with Meta's own message
--   4 publish_failed        the automatic publish failed
--   5 account_not_connected the account cannot publish and the moment passed
--   6 platform_rejected     the platform refused the post, with its message
--   7 project_sold_out      a project with units but none available
--   8 capacity_breach       a person is booked past their day
--   9 ranking_cleared_none  the weekly ranking cleared NO creative (E1b)
--
-- Arm 9's contract is already written by the other half of this build:
-- `worker/src/runRefreshCycleJob.ts` sets `decision->'exception'->>'code' =
-- 'ranking_empty'` and its own comment says "the exceptions list (C7) reads
-- this key, not a log line". With auto-apply on and no decision screen, an
-- empty ranking is SILENCE while five new creatives activate against a slate
-- nothing retired — so it must produce a line.
--
-- Honest about what could not be measured: `mos_publications.bundle_status`
-- and `.bundle_error` are NULL on all 10 live rows (nothing has ever
-- published), so arms 4/6 split "the platform refused it" from "it failed"
-- on a text match over the platform's own words. Re-measure after the first
-- real failure and tighten `mos_exception_is_platform_rejection` — it is a
-- separate one-line function precisely so that tightening is a one-line edit.
--
-- SECURITY DEFINER + a `read` capability gate: it spans
-- `mos_content_rows` (RLS-enabled with ZERO policies today), `records`,
-- `mos_work_ledger_v` and `mos_refresh_cycles`. Same posture as
-- `mos_work_ledger_v` and `mos_release_due`, both definer reads.
--
-- Idempotent. Never raises SQLSTATE 40001/40P01.
-- ============================================================================

BEGIN;

-- Does this failure carry the PLATFORM's refusal, rather than ours?
-- One place, so tightening it after the first real failure is a one-line edit.
CREATE OR REPLACE FUNCTION public.mos_exception_is_platform_rejection(
  p_bundle_status text, p_bundle_error text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(p_bundle_status, '') ~* '(reject|denied|refus|violat|policy|disapprov)'
      OR COALESCE(p_bundle_error,  '') ~* '(reject|denied|refus|violat|policy|disapprov)';
$function$;

CREATE OR REPLACE FUNCTION public.mos_month_exceptions(p_month date DEFAULT NULL)
RETURNS TABLE(
  kind         text,
  severity     text,
  subject_kind text,
  subject_id   uuid,
  label_ar     text,
  detail_ar    text,
  occurred_on  date,
  project_id   uuid,
  campaign_id  uuid,
  action_hint  text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
WITH
  gate AS (SELECT (public.mos_caller_is_trusted_service() OR public.wassell_mos_can('read')) AS ok),
  today AS (SELECT public.mos_perf_today() AS d),

  -- 1. A row is not complete by its batch date. The WHOLE row waits; it never
  --    goes out as two posts.
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

  -- 2. Sent back three times or more, and still in flight.
  --    'changes_requested' is the LIVE value; 'rejected' is a defensive alias
  --    that has never once been written (0 of 322 tasks).
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

  -- 3. An ad failed at Meta, with Meta's own message.
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

  -- 4/5/6. The publish side, ONE line per release with a RANKED cause. The arm
  --        test found the three conditions overlapping on a single stuck
  --        release and emitting three lines; §3.3 says each line is one
  --        exception with the SMALLEST decision that resolves it, and a
  --        disconnected account explains the failure that follows from it.
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

  -- 7. A project sold out while it still owns rows or a running campaign.
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

  -- 8. A person booked past their day. mos_work_ledger_v is the ONLY union of
  --    workflow tasks + reservations + manual tasks, so this is the only
  --    honest place to read it.
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

  -- 9. The weekly ranking cleared NO creative. Written by the refresh worker as
  --    decision->'exception'->>'code' = 'ranking_empty'.
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

  -- The alias list is load-bearing: every arm selects bare literals, so without
  -- it every column here would be named `?column?` and the ORDER BY below could
  -- not resolve `severity`.
  all_rows(kind, severity, subject_kind, subject_id, label_ar, detail_ar,
           occurred_on, project_id, campaign_id, action_hint) AS (
    SELECT * FROM a1 UNION ALL SELECT * FROM a2 UNION ALL SELECT * FROM a3
    UNION ALL SELECT * FROM a456
    UNION ALL SELECT * FROM a7 UNION ALL SELECT * FROM a8 UNION ALL SELECT * FROM a9)
SELECT x.*
  FROM all_rows x, gate
 WHERE gate.ok
   AND (p_month IS NULL
        OR x.occurred_on IS NULL
        OR date_trunc('month', x.occurred_on) = date_trunc('month', p_month))
 ORDER BY (x.severity = 'blocker') DESC, x.occurred_on NULLS LAST, x.kind, x.subject_id;
$function$;

-- anon is revoked explicitly: Supabase's default privileges grant it on every new
-- function in `public`, and REVOKE … FROM PUBLIC does not remove that. Without
-- this the whole exceptions list was readable without a session (found and fixed
-- 2026-09-15; anon now gets 42501, re-measured against the live API).
REVOKE ALL ON FUNCTION public.mos_month_exceptions(date)                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mos_exception_is_platform_rejection(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mos_month_exceptions(date)                      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mos_exception_is_platform_rejection(text, text) TO authenticated, service_role;

-- The regression this arm exists to prevent: a predicate written against
-- `result = 'rejected'` is dead code on this database.
DO $assert$
DECLARE v_rejected int; v_changes int;
BEGIN
  SELECT count(*) FILTER (WHERE result = 'rejected'),
         count(*) FILTER (WHERE result = 'changes_requested')
    INTO v_rejected, v_changes
    FROM public.workflow_role_tasks;
  RAISE NOTICE 'C7: workflow_role_tasks result — rejected=%, changes_requested=%',
    v_rejected, v_changes;
  IF NOT (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'mos_month_exceptions')
         LIKE '%changes_requested%' THEN
    RAISE EXCEPTION 'MOS:EXCEPTIONS_WRONG_PREDICATE — the send-back arm must count changes_requested';
  END IF;
END $assert$;

COMMIT;
