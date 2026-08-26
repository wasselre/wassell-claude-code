-- Caption/paid-organic authoring alignment (Option A) — data layer.
--
-- WHY: the content editor showed four hardcoded organic caption boxes for EVERY
-- content item — including paid ones — and those captions lived in
-- mos_content.data.caption* but were NEVER read at publish time (the publish path
-- reads mos_publications.caption, re-typed by hand). This migration makes the
-- placement rows the single source of truth for captions:
--   * organic captions live on mos_publications (already the publish object);
--   * paid ad copy lives on mos_execution_ads.creative (unchanged, jsonb).
--
-- WHAT THIS DOES:
--   1. mos_content.organic_platforms text[] — the organic channels a creative
--      targets (paid platforms come from the linked campaign's executions, so no
--      column is needed there). Drives which caption editors the content tab shows.
--   2. Surface it on mos_content_v (CREATE OR REPLACE appends at the end — no drop,
--      so the view's grants/dependents are untouched; it has none anyway).
--   3. Backfill: for organic / both content, move each legacy per-platform caption
--      in data.* into a mos_publications draft row (so no old draft "vanishes" under
--      the new model), and seed organic_platforms from those captions + any existing
--      publications. Legacy data.* keys are LEFT IN PLACE (dead copy, not destroyed).
--
-- Backward-compatible: the currently-deployed app ignores the new column and the
-- extra publication rows are ordinary drafts, so applying this before the code PR
-- merges is safe.

BEGIN;

-- 1. The column ------------------------------------------------------------
ALTER TABLE public.mos_content
  ADD COLUMN IF NOT EXISTS organic_platforms text[] NOT NULL DEFAULT '{}'::text[];

-- 2. Surface it on the read view (append-only replace) ---------------------
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

-- 3a. Backfill publications from legacy per-platform captions ---------------
-- One default account per platform (prefer connected, then lowest sort order).
WITH acct AS (
  SELECT DISTINCT ON (platform) platform, id AS account_id
  FROM public.mos_platform_accounts
  WHERE archived_at IS NULL
  ORDER BY platform, is_connected DESC, sort_order ASC
),
legacy(json_key, platform) AS (
  VALUES ('caption','instagram'),
         ('caption_tiktok','tiktok'),
         ('caption_x','x'),
         ('caption_snapchat','snapchat')
),
cap AS (
  SELECT c.id AS content_id, l.platform,
         nullif(btrim(c.data ->> l.json_key), '') AS caption
  FROM public.mos_content c
  JOIN legacy l ON true
  WHERE c.purpose IN ('organic','both')
    AND nullif(btrim(c.data ->> l.json_key), '') IS NOT NULL
)
INSERT INTO public.mos_publications (content_id, platform, account_id, status, caption)
SELECT cap.content_id, cap.platform, acct.account_id, 'draft', cap.caption
FROM cap
LEFT JOIN acct ON acct.platform = cap.platform
WHERE NOT EXISTS (
  SELECT 1 FROM public.mos_publications p
  WHERE p.content_id = cap.content_id AND p.platform = cap.platform
);

-- 3b. Seed captions onto pre-existing EMPTY-caption publications (never
--     overwrite a caption someone already typed on the placement).
WITH legacy(json_key, platform) AS (
  VALUES ('caption','instagram'),
         ('caption_tiktok','tiktok'),
         ('caption_x','x'),
         ('caption_snapchat','snapchat')
),
cap AS (
  SELECT c.id AS content_id, l.platform,
         nullif(btrim(c.data ->> l.json_key), '') AS caption
  FROM public.mos_content c
  JOIN legacy l ON true
  WHERE c.purpose IN ('organic','both')
    AND nullif(btrim(c.data ->> l.json_key), '') IS NOT NULL
)
UPDATE public.mos_publications p
SET caption = cap.caption, updated_at = now()
FROM cap
WHERE p.content_id = cap.content_id
  AND p.platform = cap.platform
  AND (p.caption IS NULL OR btrim(p.caption) = '');

-- 3c. Seed organic_platforms from legacy captions + existing publications ---
WITH legacy(json_key, platform) AS (
  VALUES ('caption','instagram'),
         ('caption_tiktok','tiktok'),
         ('caption_x','x'),
         ('caption_snapchat','snapchat')
),
plats AS (
  SELECT c.id AS content_id, x.platform
  FROM public.mos_content c
  JOIN LATERAL (
    SELECT l.platform FROM legacy l
    WHERE nullif(btrim(c.data ->> l.json_key), '') IS NOT NULL
    UNION
    SELECT p.platform FROM public.mos_publications p WHERE p.content_id = c.id
  ) x ON true
  WHERE c.purpose IN ('organic','both')
)
UPDATE public.mos_content c
SET organic_platforms = sub.platforms
FROM (
  SELECT content_id, array_agg(DISTINCT platform ORDER BY platform) AS platforms
  FROM plats GROUP BY content_id
) sub
WHERE sub.content_id = c.id
  AND array_length(sub.platforms, 1) IS NOT NULL;

COMMIT;
