-- ============================================================================
-- Hashtags are gone from Wassel content (2026-09-22, decision D4 follow-up:
-- «remove the hashtag fields … remove them from old records»).
--
-- What this does:
--   1. the `hashtags` writing field leaves every content type's field schema
--      (only `post` carried it);
--   2. every mos_content record — and its frozen round snapshots — loses the
--      `hashtags` key. The record's writing hash never covered it
--      (`mos_content_writing_hash` excludes 'hashtags'), so no approval reads
--      as "changed" afterwards;
--   3. nothing is appended to a caption at publish any more (code change in
--      api/_lib/marketing/publishRelease.ts); the AI creative director no
--      longer produces hashtags (worker/src/creative/director/schemas.ts).
--
-- Competitor-intelligence tables (`mkt_content_posts.hashtags` etc.) keep
-- their columns: those are COLLECTED data about other accounts, not ours.
--
-- Idempotent. The locked-content guard on mos_content lets a service /
-- migration write through (auth.uid() IS NULL).
-- ============================================================================

BEGIN;

UPDATE public.mos_content_types ct
   SET field_schema = (
         SELECT COALESCE(jsonb_agg(f ORDER BY ord), '[]'::jsonb)
           FROM jsonb_array_elements(ct.field_schema) WITH ORDINALITY t(f, ord)
          WHERE COALESCE(f ->> 'key', f #>> '{}') <> 'hashtags'),
       updated_at = now()
 WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(ct.field_schema) f
                WHERE COALESCE(f ->> 'key', f #>> '{}') = 'hashtags');

UPDATE public.mos_content
   SET data = data - 'hashtags'
 WHERE data ? 'hashtags';

UPDATE public.mos_content_versions
   SET data = data - 'hashtags'
 WHERE data ? 'hashtags';

DO $$
DECLARE v_types int; v_content int; v_versions int;
BEGIN
  SELECT count(*) INTO v_types FROM public.mos_content_types ct
   WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(ct.field_schema) f
                  WHERE COALESCE(f ->> 'key', f #>> '{}') = 'hashtags');
  SELECT count(*) INTO v_content  FROM public.mos_content          WHERE data ? 'hashtags';
  SELECT count(*) INTO v_versions FROM public.mos_content_versions WHERE data ? 'hashtags';
  IF v_types + v_content + v_versions > 0 THEN
    RAISE EXCEPTION 'remove_hashtags: still present — types %, content %, versions %', v_types, v_content, v_versions;
  END IF;
  RAISE NOTICE 'remove_hashtags: clean (types 0, content 0, versions 0)';
END $$;

COMMIT;
