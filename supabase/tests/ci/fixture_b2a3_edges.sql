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
