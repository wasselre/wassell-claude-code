-- ============================================================================
-- Group C3 + C4 — the ledger charges a row on ONE day, and the content view
-- stops reading a row task as "done". 2026-09-15.
--
-- C3  `mos_work_ledger_v` filtered its first arm on `subject_table =
--     'mos_content'`, so a row task consumed NO capacity at all. It gains a row
--     arm charging the row's whole weight on the batch's PRODUCTION day via
--     `mos_spread_effort_same_day` — three slots on one day is what a row is.
--     The two reservation arms get the same treatment, keyed on `row_id`:
--     `mos_spread_effort` would have laid a weight-3 row reservation across
--     THREE days, which is the opposite of a row, and would have made the
--     preview (JS `effortWeightsSameDay`) and the commit (SQL) disagree — the
--     exact divergence that has already produced a bogus WS409 once.
--
-- C4  `mos_content_v` LEFT JOINed the open task on `subject_table =
--     'mos_content'` only. Move the open task to the row without this and all
--     three members fall into `WHEN tc.total_tasks > 0 THEN 'done'` — and every
--     list, badge, route and notification in the app reads this view. A member
--     now resolves its open task through `row_id`, prefers its OWN task when it
--     has one (a send-back is per post), and counts row tasks in `total_tasks`.
--
-- Also fixed here, both latent until rows exist:
--   * the open-task join could return MORE THAN ONE row per content item and
--     silently duplicate it; it is now a LATERAL … LIMIT 1.
--   * the step-label lookup read the version pinned on the CONTENT; it now
--     reads the version pinned on the TASK, falling back to the content's.
--     Verified safe: 0 live tasks disagree with their content today.
--
-- Additive columns at the end of `mos_content_v`: row_id, row_order,
-- open_task_subject_table. CREATE OR REPLACE keeps every existing column's
-- name, type and position, so no dependent breaks. (Measured 2026-09-15:
-- neither view has any view or RLS-policy dependent.)
--
-- reloptions: CREATE OR REPLACE VIEW does NOT preserve them, it REPLACES them.
-- The first live apply of this file silently turned mos_content_v from an
-- invoker view into a DEFINER one; the ALTER VIEW at the bottom puts it back
-- and asserts it. mos_work_ledger_v has no options and is a definer view by
-- design. Grants ARE preserved by a replace (no anon on either — re-checked).
--
-- Idempotent. No function here raises SQLSTATE 40001/40P01.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- The spread MODE. A row is charged same-day; everything else is spread across
-- working days. One place decides, so the ledger's four arms cannot drift.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_spread_effort_mode(
  p_start date, p_effort numeric, p_same_day boolean)
RETURNS TABLE(day date, weight numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(p_same_day, false) THEN
    RETURN QUERY SELECT s.day, s.weight
                   FROM public.mos_spread_effort_same_day(p_start, p_effort) s;
  ELSE
    RETURN QUERY SELECT s.day, s.weight
                   FROM public.mos_spread_effort(p_start, p_effort) s;
  END IF;
END $function$;

-- ────────────────────────────────────────────────────────────────────────────
-- C3 — mos_work_ledger_v
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mos_work_ledger_v AS
-- (1) content tasks — one item, spread across working days.
 SELECT t.assignee_user_id AS user_id,
    s.day,
    mos_ledger_bucket(t.workflow_version_id, t.step_key,
                      COALESCE(t.bucket, mos_subject_bucket(t.subject_table, t.subject_id))) AS bucket,
    s.weight,
    'task'::text AS source,
    t.id AS ref_id
   FROM workflow_role_tasks t
     CROSS JOIN LATERAL mos_spread_effort(
       GREATEST(COALESCE(t.scheduled_start, mos_perf_today()), mos_perf_today()),
       GREATEST(COALESCE(t.effort_days,
                         mos_step_effort_days(
                           mos_workflow_key_of(t.subject_id), t.step_key,
                           mos_ledger_bucket(t.workflow_version_id, t.step_key,
                                             COALESCE(t.bucket, mos_perf_bucket_of(t.subject_id)))))
                - COALESCE(t.progress_days, 0::numeric), 0.5)) s(day, weight)
  WHERE t.status = 'open'::text
    AND t.subject_table = 'mos_content'::text
    AND t.assignee_user_id IS NOT NULL
UNION ALL
-- (2) ROW tasks — the whole weight on the batch's production day. One task,
--     three slots, ONE day.
 SELECT t.assignee_user_id AS user_id,
    s.day,
    mos_ledger_bucket(t.workflow_version_id, t.step_key,
                      COALESCE(t.bucket, mos_subject_bucket(t.subject_table, t.subject_id))) AS bucket,
    s.weight,
    'task'::text AS source,
    t.id AS ref_id
   FROM workflow_role_tasks t
     CROSS JOIN LATERAL mos_spread_effort_same_day(
       GREATEST(COALESCE(t.scheduled_start, mos_perf_today()), mos_perf_today()),
       GREATEST(COALESCE(t.effort_days,
                         GREATEST((SELECT count(*) FROM mos_content c WHERE c.row_id = t.subject_id), 1)
                           * mos_step_effort_days(
                               mos_subject_workflow_key(t.subject_table, t.subject_id), t.step_key,
                               mos_ledger_bucket(t.workflow_version_id, t.step_key,
                                                 COALESCE(t.bucket, mos_subject_bucket(t.subject_table, t.subject_id)))))
                - COALESCE(t.progress_days, 0::numeric), 0.5)) s(day, weight)
  WHERE t.status = 'open'::text
    AND t.subject_table = 'mos_content_rows'::text
    AND t.assignee_user_id IS NOT NULL
UNION ALL
-- (3) live reservations — same-day when they name a ROW.
 SELECT r.assignee_user_id AS user_id,
    s.day,
    r.bucket,
    s.weight,
    'reservation'::text AS source,
    r.id AS ref_id
   FROM mos_task_reservations r
     CROSS JOIN LATERAL mos_spread_effort_mode(
       GREATEST(r.planned_start, mos_perf_today()), r.weight, r.row_id IS NOT NULL) s(day, weight)
  WHERE r.status = 'reserved'::text AND r.planned_end >= mos_perf_today() AND r.assignee_user_id IS NOT NULL
UNION ALL
-- (4) stale / overdue reservations — pulled forward to today, same rule.
 SELECT r.assignee_user_id AS user_id,
    s.day,
    r.bucket,
    s.weight,
    'reservation'::text AS source,
    r.id AS ref_id
   FROM mos_task_reservations r
     CROSS JOIN LATERAL mos_spread_effort_mode(
       mos_perf_today(), r.weight, r.row_id IS NOT NULL) s(day, weight)
  WHERE (r.status = 'stale'::text OR r.status = 'reserved'::text AND r.planned_end < mos_perf_today())
    AND r.assignee_user_id IS NOT NULL
UNION ALL
-- (5) hand-assigned work.
 SELECT m.assignee_user_id AS user_id,
    GREATEST(COALESCE((m.due_at AT TIME ZONE 'Asia/Riyadh'::text)::date, mos_perf_today()), mos_perf_today()) AS day,
    mos_manual_task_bucket(m.assignee_user_id) AS bucket,
    COALESCE((mos_planning_cfg() ->> 'manual_task_weight'::text)::numeric, 0.5) AS weight,
    'manual'::text AS source,
    m.id AS ref_id
   FROM mos_manual_tasks m
  WHERE m.status = 'open'::text AND m.assignee_user_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- C4 — mos_content_v
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mos_content_v AS
 SELECT c.id,
    c.ref,
    c.content_type_id,
    c.workflow_id,
    c.title,
    c.project_id,
    c.campaign_id,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM mos_execution_ads ea
              WHERE ea.content_id = c.id AND ea.archived_at IS NULL)) AND ((EXISTS ( SELECT 1
               FROM mos_publications pp
              WHERE pp.content_id = c.id)) OR COALESCE(array_length(c.organic_platforms, 1), 0) > 0) THEN 'both'::text
            WHEN (EXISTS ( SELECT 1
               FROM mos_execution_ads ea
              WHERE ea.content_id = c.id AND ea.archived_at IS NULL)) THEN 'paid'::text
            WHEN (EXISTS ( SELECT 1
               FROM mos_publications pp
              WHERE pp.content_id = c.id)) OR COALESCE(array_length(c.organic_platforms, 1), 0) > 0 THEN 'organic'::text
            ELSE c.purpose
        END AS purpose,
    c.language,
    c.goal,
    c.audience,
    c.angle,
    c.cta,
    c.target_publish_at,
    c.due_at,
    c.data,
    c.created_by_user_id,
    c.created_at,
    c.updated_at,
    c.archived_at,
    c.workflow_version_id,
    ct.key AS content_type_key,
    ct.label_ar AS content_type_label_ar,
    ct.label_en AS content_type_label_en,
    t.id AS open_task_id,
    t.role_key AS owner_role,
    t.assignee_user_id AS current_assignee_user_id,
    t.due_at AS current_task_due_at,
    t.round AS current_round,
    t.step_key AS current_step_key,
    s.elem ->> 'label_ar'::text AS current_step_label_ar,
    s.elem ->> 'label_en'::text AS current_step_label_en,
    s."position" AS current_step_position,
        CASE
            WHEN c.rejected_at IS NOT NULL THEN 'rejected'::text
            WHEN c.on_hold_at IS NOT NULL THEN 'on_hold'::text
            WHEN s.elem IS NOT NULL THEN t.step_key
            WHEN t.id IS NOT NULL THEN 'unassigned'::text
            WHEN tc.total_tasks > 0 THEN 'done'::text
            WHEN cp.content_id IS NOT NULL AND cp.status = 'planned'::text THEN 'planned'::text
            ELSE 'draft'::text
        END AS status_key,
    c.project_ids,
    c.approval_asset_id,
    c.organic_platforms,
    cp.status AS plan_status,
    cp.plan_id,
    cp.required_ready_at,
    cp.need_at,
    cp.production_start,
    cp.priority AS plan_priority,
    NULLIF(btrim(COALESCE(c.data ->> 'caption'::text, ''::text)), ''::text) AS caption,
    NULLIF(c.data ->> 'caption'::text, ''::text) IS NOT NULL AND (c.data ->> 'caption_confirmed_text'::text) = (c.data ->> 'caption'::text) AS caption_confirmed,
    c.on_hold_at,
    c.rejected_at,
    -- ── added 2026-09-15 (C4). The row this post belongs to, and where its
    --    open task actually sits, so a caller can tell a row card from a post
    --    card without a second read.
    c.row_id,
    c.row_order,
    t.subject_table AS open_task_subject_table
   FROM mos_content c
     JOIN mos_content_types ct ON ct.id = c.content_type_id
     LEFT JOIN LATERAL ( SELECT tt.*
           FROM workflow_role_tasks tt
          WHERE tt.status = 'open'::text
            AND (tt.subject_table = 'mos_content'::text AND tt.subject_id = c.id
                 OR tt.subject_table = 'mos_content_rows'::text
                    AND c.row_id IS NOT NULL AND tt.subject_id = c.row_id)
          -- A member's OWN task wins: a send-back is per post and leaves the
          -- other two approved, so the specific task is the truer one.
          ORDER BY (tt.subject_table = 'mos_content'::text) DESC, tt.opened_at
          LIMIT 1) t ON true
     LEFT JOIN workflow_versions v ON v.id = COALESCE(t.workflow_version_id, c.workflow_version_id)
     LEFT JOIN mos_content_plan cp ON cp.content_id = c.id
     LEFT JOIN LATERAL ( SELECT e.elem,
            e.ord::integer AS "position"
           FROM jsonb_array_elements((v.definition -> 'metadata'::text) -> 'steps'::text) WITH ORDINALITY e(elem, ord)
          WHERE (e.elem ->> 'key'::text) = t.step_key) s ON true
     LEFT JOIN LATERAL ( SELECT count(*) AS total_tasks
           FROM workflow_role_tasks tt
          WHERE tt.subject_table = 'mos_content'::text AND tt.subject_id = c.id
             OR tt.subject_table = 'mos_content_rows'::text
                AND c.row_id IS NOT NULL AND tt.subject_id = c.row_id) tc ON true;

-- ────────────────────────────────────────────────────────────────────────────
-- mos_row_summary — the row's own facts, for the queue.
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER on purpose, gated by the `read` capability: `mos_content_rows`
-- carries RLS with ZERO policies today (A1 shipped the table, not its policies),
-- so a browser SELECT on it returns an empty set with no error. The queue must
-- not silently lose row cards while that is true. Same posture as
-- `mos_work_ledger_v`, which is also a definer read.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_row_summary(p_row_ids uuid[])
RETURNS TABLE(
  row_id uuid, kind text, batch_day date, row_key text,
  campaign_id uuid, project_id uuid, plan_id uuid,
  workflow_version_id uuid, member_count integer, member_ids uuid[])
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT r.id, r.kind, r.batch_day, r.row_key,
         r.campaign_id, r.project_id, r.plan_id, r.workflow_version_id,
         COALESCE(m.n, 0)::int, COALESCE(m.ids, ARRAY[]::uuid[])
    FROM public.mos_content_rows r
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n,
             array_agg(c.id ORDER BY c.row_order NULLS LAST, c.created_at) AS ids
        FROM public.mos_content c WHERE c.row_id = r.id) m ON true
   WHERE r.id = ANY(COALESCE(p_row_ids, ARRAY[]::uuid[]))
     AND (public.mos_caller_is_trusted_service() OR public.wassell_mos_can('read'));
$function$;

-- anon is revoked explicitly: Supabase's default privileges grant it on every
-- new function in `public`, and REVOKE … FROM PUBLIC does not remove that.
REVOKE ALL ON FUNCTION public.mos_row_summary(uuid[])                        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mos_spread_effort_mode(date, numeric, boolean)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mos_row_summary(uuid[])                        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mos_spread_effort_mode(date, numeric, boolean)  TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- reloptions are NOT preserved by CREATE OR REPLACE VIEW — it REPLACES them.
-- The replace above therefore drops `security_invoker=true` from mos_content_v
-- and silently turns it into a DEFINER view. Put it back, and assert it.
-- (Caught live on 2026-09-15, minutes after the first apply.)
-- ────────────────────────────────────────────────────────────────────────────
ALTER VIEW public.mos_content_v SET (security_invoker = true);

DO $assert$
DECLARE v_opts text[];
BEGIN
  SELECT c.reloptions INTO v_opts
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'mos_content_v';
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY(v_opts)) THEN
    RAISE EXCEPTION 'MOS:VIEW_SECURITY_INVOKER_LOST mos_content_v — options are %', v_opts;
  END IF;
END $assert$;

COMMIT;
