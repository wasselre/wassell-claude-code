-- 2026-09-29 — Switch the material rule on for the month-model post workflow.
--
-- The material rule (api/_lib/marketing/releaseMaterial.ts, 2026-09-15) decides
-- what a release posts: the design slot its destination names (feed → the
-- square, story → the vertical) and the approved caption. It applies to content
-- pinned to a workflow version whose definition carries
-- `metadata.material_rule = 'by_destination'` — and NO version ever got that
-- marker. So every release fell to the legacy path, which posts only files a
-- person picked by hand on the publication row; the month plan picks none. Every
-- one of the 126 planned releases would have been refused with «This publication
-- has no approved file to post» the moment automatic publishing was switched on
-- (measured 2026-09-29 on the six finished يمام بارك 14 releases).
--
-- `440eaadf` (post_std: writing → writing_review → design → design_writer_review
-- → design_review; no scheduling/publish_check steps, because publishing was split
-- out) is the post-cutover chain the rule was written for: 129 content items are
-- pinned to it, including all 73 with planned releases. Only releaseMaterial.ts
-- reads the marker, so this changes the publish path and nothing else. The
-- approval gate shipped the same day still stands in front of it: nothing posts
-- without a final approval, an unfinished row, or with files/caption that moved.
BEGIN;

UPDATE public.workflow_versions
   SET definition = jsonb_set(definition, '{metadata,material_rule}', '"by_destination"'::jsonb, true)
 WHERE id = '440eaadf-f632-4ed9-9991-b14d7c3720cd'
   AND definition -> 'metadata' ->> 'key' = 'post_std'
   AND (definition -> 'metadata' ->> 'material_rule') IS DISTINCT FROM 'by_destination';

-- Guarded: on a fresh database the version does not exist and there is nothing to check.
DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM public.workflow_versions WHERE id = '440eaadf-f632-4ed9-9991-b14d7c3720cd')
     AND NOT EXISTS (
       SELECT 1 FROM public.workflow_versions
        WHERE id = '440eaadf-f632-4ed9-9991-b14d7c3720cd'
          AND definition -> 'metadata' ->> 'material_rule' = 'by_destination'
          AND jsonb_array_length(definition -> 'metadata' -> 'steps') = 5) THEN
    RAISE EXCEPTION 'MATERIAL_RULE: post_std 440eaadf did not take the marker (or its steps changed)';
  END IF;
END $assert$;

COMMIT;
