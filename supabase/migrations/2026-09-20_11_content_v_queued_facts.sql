-- ============================================================================
-- `mos_content_v` tells the truth about work that is QUEUED.
-- 2026-09-20.
--
-- A task waiting on capacity deliberately has no `due_at`: the 24-hour
-- allowance starts when the task reaches a person, so nothing is "late" because
-- of a queue. That design is right, and the task TABLE already renders it
-- correctly — it shows «بانتظار الطاقة» from `waiting_since`.
--
-- The CONTENT-ROW table could not, because the view published only
-- `current_task_due_at`. So fourteen of September's fifteen ad creatives read
-- «بلا موعد» — "no date" — when the system knew exactly when each one is
-- produced (27–28 Sep) and exactly when it goes live (29 Sep). "No date" reads
-- as "nobody planned this". The plan was there the whole time; only this screen
-- could not see it.
--
-- Four columns, appended. Nothing existing moves or changes type, and
-- `mos_content_v` has no view or policy dependents (checked), so
-- CREATE OR REPLACE is the whole change.
-- ============================================================================

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
    c.row_id,
    c.row_order,
    t.subject_table AS open_task_subject_table,
    t.waiting_since AS current_task_waiting_since,
    t.waiting_reason AS current_task_waiting_reason,
    t.scheduled_start AS current_task_scheduled_start,
    t.scheduled_end AS current_task_scheduled_end
   FROM mos_content c
     JOIN mos_content_types ct ON ct.id = c.content_type_id
     LEFT JOIN LATERAL ( SELECT tt.id,
            tt.subject_table,
            tt.subject_id,
            tt.workflow_version_id,
            tt.step_key,
            tt.role_key,
            tt.assignee_user_id,
            tt.status,
            tt.result,
            tt.note,
            tt.revision_targets,
            tt.round,
            tt.opened_at,
            tt.due_at,
            tt.closed_at,
            tt.closed_by_user_id,
            tt.created_at,
            tt.updated_at,
            tt.bucket,
            tt.blocked,
            tt.blocked_reason,
            tt.blocked_by,
            tt.blocked_at,
            tt.late_flag,
            tt.scheduled_start,
            tt.scheduled_end,
            tt.effort_days,
            tt.progress_days,
            tt.reservation_id,
            tt.waiting_since,
            tt.waiting_reason
           FROM workflow_role_tasks tt
          WHERE tt.status = 'open'::text AND (tt.subject_table = 'mos_content'::text AND tt.subject_id = c.id OR tt.subject_table = 'mos_content_rows'::text AND c.row_id IS NOT NULL AND tt.subject_id = c.row_id)
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
          WHERE tt.subject_table = 'mos_content'::text AND tt.subject_id = c.id OR tt.subject_table = 'mos_content_rows'::text AND c.row_id IS NOT NULL AND tt.subject_id = c.row_id) tc ON true;

-- ────────────────────────────────────────────────────────────────────────────
-- reloptions are NOT preserved by CREATE OR REPLACE VIEW — it REPLACES them,
-- so the statement above silently turns `mos_content_v` into a DEFINER view
-- and its RLS stops being the CALLER's. Put it back, and assert it.
--
-- This is the second time: `2026-09-15_11_row_ledger_and_content_view.sql`
-- carries the same ALTER and the same warning, added minutes after that
-- migration's first apply. This migration reproduced the bug on 2026-09-20 and
-- ran without the ALTER against production for roughly fifty minutes before it
-- was caught and reverted by hand. Any future CREATE OR REPLACE on this view
-- MUST carry this block.
-- ────────────────────────────────────────────────────────────────────────────
ALTER VIEW public.mos_content_v SET (security_invoker = true);

DO $$
DECLARE v int;
  v_opts text[];
BEGIN
  SELECT c.reloptions INTO v_opts
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'mos_content_v';
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY(v_opts)) THEN
    RAISE EXCEPTION 'MOS:VIEW_SECURITY_INVOKER_LOST mos_content_v — options are %', v_opts;
  END IF;

  SELECT count(*) INTO v FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'mos_content_v'
     AND column_name IN ('current_task_waiting_since', 'current_task_waiting_reason',
                         'current_task_scheduled_start', 'current_task_scheduled_end');
  IF v <> 4 THEN RAISE EXCEPTION 'MOS:CONTENT_V_MISSING_COLUMNS got %', v; END IF;

  -- And where queued work EXISTS, it must carry its production day. Guarded on
  -- there being any, so the migration still replays on an empty database — a
  -- data assertion that cannot hold on a fresh install is a migration that
  -- cannot be replayed.
  IF EXISTS (SELECT 1 FROM public.mos_content_v WHERE current_task_waiting_reason IS NOT NULL) THEN
    SELECT count(*) INTO v FROM public.mos_content_v
     WHERE current_task_waiting_reason IS NOT NULL
       AND current_task_scheduled_start IS NOT NULL;
    IF v = 0 THEN RAISE EXCEPTION 'MOS:CONTENT_V_NO_QUEUED_ROWS_CARRY_A_DAY'; END IF;
  END IF;
END $$;
