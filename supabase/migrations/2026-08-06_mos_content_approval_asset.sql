-- ============================================================================
-- MOS: bridge content approval to the approved ("final") file, and let a
-- publication reference its approved file by ASSET id.
--
-- THE PROBLEM THIS FIXES
--
-- Uploading a material files it as a 'source' link; the marketing manager's
-- Approve only advances the workflow TASK. Nothing ever creates the role='final'
-- link that the Publishing tab reads — so Publishing always says "Nothing
-- approved yet" even after a file is uploaded and the item is approved. And the
-- per-publication file pick was keyed by mos_assets.file_id, which is NULL for
-- any material uploaded straight into the marketing bucket, so a chosen approved
-- file could never resolve for uploaded videos/files.
--
-- 1. mos_content.approval_asset_id  — the ONE material the item's owner submits
--    for approval. On an 'approved' task result the API promotes it to a
--    'final' link (see mos_promote_approval_asset).
-- 2. mos_publications.asset_id      — the approved material a publication uses,
--    keyed by asset id (always present), replacing the NULL-prone file_id path.
--
-- Backward-compatible: adds nullable columns and appends columns to the two read
-- views. Nothing is dropped; safe to apply before the code PR ships.
-- ============================================================================
BEGIN;

-- 1. The single material chosen for approval on a content item.
ALTER TABLE public.mos_content
  ADD COLUMN IF NOT EXISTS approval_asset_id uuid
    REFERENCES public.mos_assets(id) ON DELETE SET NULL;

-- 2. The approved material a publication carries — keyed by ASSET id.
ALTER TABLE public.mos_publications
  ADD COLUMN IF NOT EXISTS asset_id uuid
    REFERENCES public.mos_assets(id) ON DELETE SET NULL;

-- 3. Promote the chosen approval asset to an approved ('final') link. Called by
--    the API on an 'approved' task result. SECURITY DEFINER: the approver
--    (e.g. marketing_manager) may not hold asset-write RLS, and approving is a
--    system bridge, not a manual asset edit. EXPLICIT selection ONLY — this
--    never guesses a file, so a customer-facing publish can never end up
--    attached to the wrong one.
CREATE OR REPLACE FUNCTION public.mos_promote_approval_asset(p_content_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_asset uuid;
BEGIN
  SELECT approval_asset_id INTO v_asset FROM public.mos_content WHERE id = p_content_id;
  IF v_asset IS NULL THEN RETURN NULL; END IF;
  -- Only promote a material that is actually linked to this item.
  IF NOT EXISTS (
    SELECT 1 FROM public.mos_asset_links
     WHERE content_id = p_content_id AND asset_id = v_asset
  ) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.mos_asset_links (asset_id, content_id, role)
    VALUES (v_asset, p_content_id, 'final')
    ON CONFLICT (asset_id, content_id) DO UPDATE SET role = 'final';
  RETURN v_asset;
END $$;

GRANT EXECUTE ON FUNCTION public.mos_promote_approval_asset(uuid) TO authenticated, service_role;

-- 4. Expose the new columns on the read views (append-only, so CREATE OR REPLACE
--    needs no drop and dependents are preserved). Definitions are the live ones;
--    the ONLY change is the appended trailing column. Preserve each view's
--    reloptions exactly: mos_content_v runs as owner (no security_invoker),
--    mos_publication_v is security_invoker=true.
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
    c.project_ids,
    c.approval_asset_id
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

CREATE OR REPLACE VIEW public.mos_publication_v WITH (security_invoker=true) AS
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
    p.asset_id
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

COMMIT;
