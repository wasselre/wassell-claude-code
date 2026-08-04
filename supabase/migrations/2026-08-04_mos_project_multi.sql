-- Marketing OS — the Project field on campaigns + content becomes MULTI-value.
--
-- Both objects previously linked exactly ONE project through the scalar
-- `project_id`. The UI now offers a searchable, multi-select picker restricted to
-- Our Projects (all_projects.is_public = true), so a campaign/content item can be
-- tied to several projects.
--
-- Storage: add `project_ids` (jsonb array of the linked project uuids). `project_id`
-- is KEPT as the PRIMARY (first) project so every existing filter, join, attribution
-- read, and single-name display keeps working unchanged — the app derives it from
-- project_ids[0] on every save. Additive + backfilled + idempotent.

BEGIN;

ALTER TABLE public.mos_campaigns
  ADD COLUMN IF NOT EXISTS project_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.mos_content
  ADD COLUMN IF NOT EXISTS project_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Backfill the array from the existing scalar. Idempotent: only touches rows whose
-- array is still empty, so a re-run never double-writes.
UPDATE public.mos_campaigns
   SET project_ids = jsonb_build_array(project_id)
 WHERE project_id IS NOT NULL AND project_ids = '[]'::jsonb;
UPDATE public.mos_content
   SET project_ids = jsonb_build_array(project_id)
 WHERE project_id IS NOT NULL AND project_ids = '[]'::jsonb;

-- Expose project_ids through the read views. CREATE OR REPLACE VIEW only permits
-- ADDING columns at the END of the select list, so project_ids is appended last;
-- the existing column set/order/types are preserved verbatim (captured from prod),
-- and the view's stored options (security_invoker, etc.) are retained.

CREATE OR REPLACE VIEW public.mos_campaign_v AS
 SELECT c.id,
    c.ref,
    c.name,
    c.project_id,
    c.objective,
    c.status,
    c.starts_on,
    c.ends_on,
    c.budget_total,
    c.note,
    c.created_by_user_id,
    c.created_at,
    c.updated_at,
    c.archived_at,
    c.kind,
    c.goal,
    c.owner_role,
    c.success_metric,
    c.success_threshold,
    COALESCE(e.exec_count, 0::bigint) AS execution_count,
    e.total_spend,
    e.total_leads,
    e.total_qualified,
    e.total_impressions,
    e.total_clicks,
    COALESCE(ct.content_count, 0::bigint) AS content_count,
    c.project_ids
   FROM mos_campaigns c
     LEFT JOIN LATERAL ( SELECT count(*) AS exec_count,
            sum(x.spend) AS total_spend,
            sum(x.leads) AS total_leads,
            sum(x.qualified) AS total_qualified,
            sum(x.impressions) AS total_impressions,
            sum(x.clicks) AS total_clicks
           FROM mos_campaign_executions x
          WHERE x.campaign_id = c.id) e ON true
     LEFT JOIN LATERAL ( SELECT count(*) AS content_count
           FROM mos_content m
          WHERE m.campaign_id = c.id) ct ON true;

CREATE OR REPLACE VIEW public.mos_content_v AS
 SELECT c.id,
    c.ref,
    c.content_type_id,
    c.workflow_id,
    c.title,
    c.project_id,
    c.campaign_id,
    c.purpose,
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
            WHEN s.elem IS NOT NULL THEN t.step_key
            WHEN t.id IS NOT NULL THEN 'unassigned'::text
            WHEN tc.total_tasks > 0 THEN 'done'::text
            ELSE 'draft'::text
        END AS status_key,
    c.project_ids
   FROM mos_content c
     JOIN mos_content_types ct ON ct.id = c.content_type_id
     LEFT JOIN workflow_role_tasks t ON t.subject_table = 'mos_content'::text AND t.subject_id = c.id AND t.status = 'open'::text
     LEFT JOIN workflow_versions v ON v.id = c.workflow_version_id
     LEFT JOIN LATERAL ( SELECT e.elem,
            e.ord::integer AS "position"
           FROM jsonb_array_elements((v.definition -> 'metadata'::text) -> 'steps'::text) WITH ORDINALITY e(elem, ord)
          WHERE (e.elem ->> 'key'::text) = t.step_key) s ON true
     LEFT JOIN LATERAL ( SELECT count(*) AS total_tasks
           FROM workflow_role_tasks tt
          WHERE tt.subject_table = 'mos_content'::text AND tt.subject_id = c.id) tc ON true;

COMMIT;
