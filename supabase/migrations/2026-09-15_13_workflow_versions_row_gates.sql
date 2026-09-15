-- ============================================================================
-- A11 — the row path as a NEW workflow version. 2026-09-15.
--
--   post_std  v8 : `writing` requires caption + headlines
--                  `design`  requires final_square + final_vertical
--   video_std v7 : `first_version` requires final_square + final_vertical
--
-- WHY A NEW VERSION AND NEVER AN EDIT: every content item is pinned to the
-- version it was created under and keeps walking that chain. Publishing a new
-- version is the ONLY mechanism protecting the 24 pre-cutover records (D1) —
-- 9 of their 17 ad-bearing rows have no design slots at all and 0 of 24 carry
-- a caption, so editing a live version would freeze every one of them at its
-- next submit. Editing in place is forbidden here.
--
-- The engine check already exists: `workflow_advance_role_path` refuses on a
-- missing `required_files` role (2026-09-14_03). Every live version simply
-- carries `required_files: []`. This is a DEFINITION edit, not engine work.
--
-- Two deliberate deviations from the plan's literal wording, both recorded:
--
--  1. `video_std` has no step named `writing` and none named `design`. The
--     design-slot gate lands on `first_version` — the montage step that
--     submits the finished cut — not on `editing`, which is work-in-progress.
--
--  2. `video_std`'s writer step (`script`) does NOT gain `headlines`. The
--     `video` content type's `field_schema` is
--     ['idea','hook','scenes','duration','aspect_ratio','caption'] — it has no
--     `headlines` field, so no writer UI can ever fill one, and requiring it
--     would make EVERY video unfinishable. `post`'s field_schema does carry
--     `headlines`, so post_std v8 gets it as specified. If videos are meant to
--     carry headlines, that is an A10-shaped change to `mos_content_types`
--     first, and this version can be re-published afterwards.
--
-- Following the 2026-09-14_05 precedent: a direct INSERT into
-- `workflow_versions` with max(version_no)+1, leaving `workflows.metadata`
-- alone (an UPDATE there fires `workflows_tg_write_version` and would mint a
-- SECOND version). Note this leaves the Builder settings screen showing the
-- pre-2026-09-14 step list — a divergence that predates this migration.
--
-- Nothing is re-pinned. `openFirstTask` (api/marketing-os.ts) pins the highest
-- version_no, so content created AFTER this lands gets the gates and nothing
-- already in flight moves.
--
-- Idempotent: re-running finds the gates already on the latest version and
-- creates nothing.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  r        record;
  v_steps  jsonb;
  v_next   int;
  v_made   int := 0;
  v_note   text := '';
BEGIN
  FOR r IN
    SELECT DISTINCT ON (v.workflow_id)
           v.workflow_id, v.version_no, v.definition,
           v.definition -> 'metadata' ->> 'key' AS wf_key
      FROM public.workflow_versions v
     WHERE v.definition -> 'metadata' ->> 'key' IN ('post_std','video_std')
     ORDER BY v.workflow_id, v.version_no DESC
  LOOP
    -- Already gated? then this migration has run before.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(r.definition -> 'metadata' -> 'steps') s
                WHERE s -> 'required_files' @> '["final_square"]'::jsonb
                  AND s -> 'required_files' @> '["final_vertical"]'::jsonb) THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(jsonb_agg(
             CASE
               -- the writer's step: the caption AND the headline set.
               WHEN r.wf_key = 'post_std' AND s ->> 'key' = 'writing'
                 THEN jsonb_set(s, '{required_fields}', '["caption","headlines"]'::jsonb)
               -- the designer's submit: BOTH destinations, always.
               WHEN (r.wf_key = 'post_std'  AND s ->> 'key' = 'design')
                 OR (r.wf_key = 'video_std' AND s ->> 'key' = 'first_version')
                 THEN jsonb_set(s, '{required_files}', '["final_square","final_vertical"]'::jsonb)
               ELSE s
             END ORDER BY ord), '[]'::jsonb)
      INTO v_steps
      FROM jsonb_array_elements(r.definition -> 'metadata' -> 'steps')
           WITH ORDINALITY t(s, ord);

    SELECT COALESCE(max(version_no), 0) + 1 INTO v_next
      FROM public.workflow_versions WHERE workflow_id = r.workflow_id;

    INSERT INTO public.workflow_versions (workflow_id, version_no, definition)
    VALUES (r.workflow_id, v_next,
            jsonb_set(r.definition, '{metadata,steps}', v_steps));
    v_made := v_made + 1;
    v_note := v_note || format('%s v%s ', r.wf_key, v_next);
  END LOOP;
  RAISE NOTICE 'A11: % new workflow version(s) created: %', v_made, v_note;
END $$;

-- The gates must actually be ON the latest version of both workflows, and the
-- flags that were already there must survive. Loud, because silently losing
-- either breaks ad creation or lets a caption-less writing task pass.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(latest.wf_key || ': ' || latest.why, '; ') INTO v_bad
    FROM (
      SELECT DISTINCT ON (v.workflow_id)
             v.definition -> 'metadata' ->> 'key' AS wf_key,
             v.definition AS def,
             CASE
               WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v.definition -> 'metadata' -> 'steps') s
                                 WHERE s -> 'required_files' @> '["final_square","final_vertical"]'::jsonb)
                 THEN 'no step requires both design slots'
               WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v.definition -> 'metadata' -> 'steps') s
                                 WHERE (s ->> 'auto_meta_ad')::boolean IS TRUE)
                 THEN 'lost auto_meta_ad'
               WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v.definition -> 'metadata' -> 'steps') s
                                 WHERE s -> 'required_fields' @> '["caption"]'::jsonb)
                 THEN 'lost the caption requirement'
               ELSE NULL
             END AS why
        FROM public.workflow_versions v
       WHERE v.definition -> 'metadata' ->> 'key' IN ('post_std','video_std')
       ORDER BY v.workflow_id, v.version_no DESC) latest
   WHERE latest.why IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'MOS:ROW_GATES_NOT_PUBLISHED — %', v_bad;
  END IF;
END $$;

-- post_std's writer step must carry BOTH fields. (video_std deliberately does
-- not — see deviation 2 in the header.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM (SELECT DISTINCT ON (v.workflow_id) v.definition
              FROM public.workflow_versions v
             WHERE v.definition -> 'metadata' ->> 'key' = 'post_std'
             ORDER BY v.workflow_id, v.version_no DESC) latest,
           jsonb_array_elements(latest.definition -> 'metadata' -> 'steps') s
     WHERE s ->> 'key' = 'writing'
       AND s -> 'required_fields' @> '["caption","headlines"]'::jsonb) THEN
    RAISE EXCEPTION 'MOS:ROW_GATES_NOT_PUBLISHED — post_std writing lacks caption+headlines';
  END IF;
END $$;

COMMIT;
