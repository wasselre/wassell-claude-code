-- Production-shaped LINK corpus for the B2A.3 profiling and tests.
--
-- Production carries ~9,856 file_links edges across 7,548 files. The existing
-- fixtures produce only ~19 (fixture_b2a_authz links nothing) or ~1,619
-- (fixture_b2_scale), and B2A.3 is about the per-EDGE cost — so a fixture that
-- is two orders of magnitude short cannot measure the thing being fixed. That
-- is exactly how B2's p95 looked fine in one runner (19 edges) and catastrophic
-- in another (1,619).
--
-- Runs AFTER fixture_b2a_authz.sql / fixture_b2a1_highcard.sql, i.e. on the
-- 8,000-file corpus. Edges are created the way production creates them — by
-- setting files.model_id / files.record_id so the Phase 2 trigger derives them
-- — never by inserting into file_links directly, which would be drift.

-- Records to hang edges on. unified_records is a UNION over `records` plus each
-- frozen model's view, so the targets must be real rows in `records`.
INSERT INTO public.records (id, model_id, data)
SELECT ('a0000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
       (SELECT id FROM public.models WHERE name='units'),
       jsonb_build_object('unit_no', i)
FROM generate_series(1, 400) i
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.records (id, model_id, data)
SELECT ('a1000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
       (SELECT id FROM public.models WHERE name='all_projects'),
       jsonb_build_object('project_no', i)
FROM generate_series(1, 100) i
ON CONFLICT (id) DO NOTHING;

-- Spread ~7,000 of the 8,000 files across those 500 records, so the edge count
-- lands near production's ~9,856 once the multi-role field sources are counted.
DO $link$
DECLARE n integer;
BEGIN
  UPDATE public.files f
     SET model_id  = (SELECT id FROM public.models WHERE name='units'),
         record_id = ('a0000000-0000-4000-8000-'
                      || lpad((((right(f.id::text,12)::bigint) % 400) + 1)::text, 12, '0'))::uuid
   WHERE f.storage_path LIKE 'scale/%'
     AND right(f.id::text,12)::bigint <= 6000;

  UPDATE public.files f
     SET model_id  = (SELECT id FROM public.models WHERE name='all_projects'),
         record_id = ('a1000000-0000-4000-8000-'
                      || lpad((((right(f.id::text,12)::bigint) % 100) + 1)::text, 12, '0'))::uuid
   WHERE f.storage_path LIKE 'scale/%'
     AND right(f.id::text,12)::bigint BETWEEN 6001 AND 7000;

  SELECT count(*) INTO n FROM public.file_links;
  RAISE NOTICE 'B2A.3 fixture: % edges', n;
END $link$;

ANALYZE public.files;
ANALYZE public.file_links;
ANALYZE public.records;

-- ── RECORD VISIBILITY (added after the stage-2 profiling gap) ──────────────
-- fixture_file_links.sql gates records on a `test.visible_records` GUC listing
-- ids. With 500 records that is impractical, so in stage 2 the GUC was never
-- set, EVERY persona saw 0 edges, and the one case the cost-hint fix most
-- needed to be tested against — a caller who can see MOST records, where the
-- cheap predicate filters nothing — was never exercised at all.
--
-- Replaced with a per-persona rule that is deterministic and gives a real
-- spectrum: admin sees everything, others see a fixed fraction, one sees none.
-- A caller's visibility is recorded in the record itself, so the policy is a
-- containment test rather than a GUC string.
UPDATE public.records SET data = data || jsonb_build_object('visible_to',
  CASE
    WHEN (right(id::text,12)::bigint % 10) < 9 THEN
      jsonb_build_array('11111111-1111-1111-1111-111111111111',
                        '88888888-8888-8888-8888-888888888888')
    ELSE jsonb_build_array('88888888-8888-8888-8888-888888888888')
  END
  || CASE WHEN (right(id::text,12)::bigint % 2) = 0
          THEN jsonb_build_array('22222222-2222-2222-2222-222222222222')
          ELSE '[]'::jsonb END
  || CASE WHEN (right(id::text,12)::bigint % 5) = 0
          THEN jsonb_build_array('33333333-3333-3333-3333-333333333333',
                                 '44444444-4444-4444-4444-444444444444')
          ELSE '[]'::jsonb END)
WHERE id::text LIKE 'a0000000-%' OR id::text LIKE 'a1000000-%';

DROP POLICY IF EXISTS records_select ON public.records;
CREATE POLICY records_select ON public.records FOR SELECT TO authenticated
USING (
  public.wassell_is_admin((SELECT auth.uid()))
  OR (data->'visible_to') ? (public.wassell_app_user_id((SELECT auth.uid()))::text)
  -- the Phase 1 fixture's GUC form, kept so its own smokes still work
  OR id::text = ANY(string_to_array(coalesce(current_setting('test.visible_records',true),''),','))
);

ANALYZE public.records;

-- Report the spectrum so a future run cannot silently regress to all-zero.
DO $vis$
DECLARE r record; n bigint;
BEGIN
  FOR r IN SELECT unnest(ARRAY[
      '99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555',
      '88888888-8888-8888-8888-888888888888']::uuid[]) AS uid LOOP
    SELECT count(*) INTO n FROM public.records rec
     WHERE public.wassell_is_admin(r.uid)
        OR (rec.data->'visible_to') ? (public.wassell_app_user_id(r.uid)::text);
    RAISE NOTICE 'B2A.3 fixture: persona % sees % records', left(r.uid::text,8), n;
  END LOOP;
END $vis$;
