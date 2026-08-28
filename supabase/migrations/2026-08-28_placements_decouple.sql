-- Placements model — Phase 1: decouple the creative from its campaign, and let an
-- organic placement carry its OWN (optional) organic campaign.
--
-- Background (see docs/prd/marketing-workspace.md + the Placements build plan):
--   * A creative (mos_content) is a standalone record. Its campaign_id is now
--     PROVENANCE ("where it was born"), not ownership — it does not constrain
--     which placements the content may carry.
--   * A paid placement = an mos_execution_ads row under any execution/ad-set.
--   * An organic placement = an mos_publications row; it may now link to an
--     organic mos_campaigns row, or to NONE (campaign_id NULL).
--   * `purpose` is no longer authored — it is DERIVED from the placements that
--     exist. Computed here in mos_content_v, backward-compatibly (falls back to
--     the stored purpose when the content has no placements yet, so the
--     currently-deployed UI keeps behaving identically until the new UI ships).
--
-- Backward-compatible: additive column + view changes that preserve existing
-- reads. Safe to apply ahead of the code deploy.

BEGIN;

-- 1. Organic placements can carry their own optional organic campaign.
--    NULL = "a placement with no campaign" (an explicitly supported choice).
ALTER TABLE public.mos_publications
  ADD COLUMN IF NOT EXISTS campaign_id uuid
  REFERENCES public.mos_campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS mos_publications_campaign_id_idx
  ON public.mos_publications(campaign_id);

-- 2. Expose campaign_id on the publication view (appended — safe for dependents).
CREATE OR REPLACE VIEW public.mos_publication_v AS
 SELECT p.id,
    p.content_id,
    p.platform,
    p.account_id,
    p.status,
    p.scheduled_at,
    p.published_at,
    p.caption,
    p.file_id,
    p.external_url,
    p.external_id,
    p.published_by_user_id,
    p.note,
    p.created_at,
    p.updated_at,
    a.label_ar AS account_label_ar,
    a.label_en AS account_label_en,
    a.handle AS account_handle,
    a.is_connected AS account_connected,
    s.captured_at AS latest_captured_at,
    s.source AS latest_source,
    s.views AS latest_views,
    s.engagement AS latest_engagement,
    s.enquiries AS latest_enquiries,
    ( SELECT count(*) AS count
           FROM mos_metric_snapshots x
          WHERE x.publication_id = p.id) AS snapshot_count,
    s.likes AS latest_likes,
    s.comments AS latest_comments,
    s.saves AS latest_saves,
    p.asset_id,
    p.bundle_post_id,
    p.bundle_status,
    p.bundle_error,
    p.bundle_synced_at,
    a.can_publish AS account_can_publish,
    p.asset_ids,
    p.campaign_id
   FROM mos_publications p
     LEFT JOIN mos_platform_accounts a ON a.id = p.account_id
     LEFT JOIN LATERAL ( SELECT m.id,
            m.publication_id,
            m.captured_at,
            m.source,
            m.views,
            m.engagement,
            m.enquiries,
            m.likes,
            m.comments,
            m.saves,
            m.extra,
            m.entered_by_user_id,
            m.created_at
           FROM mos_metric_snapshots m
          WHERE m.publication_id = p.id
          ORDER BY m.captured_at DESC
         LIMIT 1) s ON true;

-- 3. Derive `purpose` from the placements that exist. Same column name/position,
--    so CREATE OR REPLACE is valid and no dependent needs rebuilding. The final
--    ELSE preserves the stored value for content with no placements yet, which is
--    what keeps this change backward-compatible for the live app.
CREATE OR REPLACE VIEW public.mos_content_v AS
 SELECT c.id,
    c.ref,
    c.content_type_id,
    c.workflow_id,
    c.title,
    c.project_id,
    c.campaign_id,
        CASE
            WHEN EXISTS (SELECT 1 FROM mos_execution_ads ea WHERE ea.content_id = c.id AND ea.archived_at IS NULL)
                 AND (EXISTS (SELECT 1 FROM mos_publications pp WHERE pp.content_id = c.id)
                      OR COALESCE(array_length(c.organic_platforms, 1), 0) > 0)
                THEN 'both'::text
            WHEN EXISTS (SELECT 1 FROM mos_execution_ads ea WHERE ea.content_id = c.id AND ea.archived_at IS NULL)
                THEN 'paid'::text
            WHEN EXISTS (SELECT 1 FROM mos_publications pp WHERE pp.content_id = c.id)
                 OR COALESCE(array_length(c.organic_platforms, 1), 0) > 0
                THEN 'organic'::text
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
            WHEN s.elem IS NOT NULL THEN t.step_key
            WHEN t.id IS NOT NULL THEN 'unassigned'::text
            WHEN tc.total_tasks > 0 THEN 'done'::text
            ELSE 'draft'::text
        END AS status_key,
    c.project_ids,
    c.approval_asset_id,
    c.organic_platforms
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
