-- ============================================================================
-- The PRE-B2A.5 records_view policy — the baseline every fingerprint is taken
-- against. Byte-identical to what production runs today (verified via
-- pg_policies on wassell-prod, 2026-08-19).
--
-- Applied AFTER the runner has injected the real wassell_can_view_record from
-- supabase/schema.sql, because the policy refers to it.
-- ============================================================================

ALTER TABLE public.records    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_links ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.records, public.unified_records, public.file_links,
                public.models TO authenticated;

DROP POLICY IF EXISTS records_view ON public.records;
CREATE POLICY records_view ON public.records
  FOR SELECT TO authenticated
  USING (public.wassell_can_view_record((SELECT auth.uid()), records.*));

-- The record half of file_links_select, isolated. B2A.4's file half is not
-- reproduced here: this suite is about the RECORD half, and mixing in the file
-- half would let a file-side change mask a record-side regression.
DROP POLICY IF EXISTS file_links_record_half ON public.file_links;
CREATE POLICY file_links_record_half ON public.file_links
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.unified_records ur
                  WHERE ur.id = file_links.record_id
                    AND ur.model_id = file_links.model_id));

-- ── NON-VACUITY: prove the corpus discriminates BEFORE anything is measured ──
-- Every guard below has failed in some form during this programme. A suite that
-- passes because its fixture is uniform is not evidence.
DO $$
DECLARE
  n_admin int; n_all int; n_partial int; n_zero int; n_noview int;
  n_inactive int; n_mixed int; n_ghost int; n_total int; n_orphan int;
BEGIN
  SELECT count(*) INTO n_total FROM public.records;
  SELECT count(*) INTO n_orphan FROM public.file_links l
   WHERE NOT EXISTS (SELECT 1 FROM public.records r
                      WHERE r.id = l.record_id AND r.model_id = l.model_id);

  SELECT count(*) INTO n_admin    FROM public.records r WHERE public.wassell_can_view_record('99999999-9999-9999-9999-999999999999', r.*);
  SELECT count(*) INTO n_all      FROM public.records r WHERE public.wassell_can_view_record('11111111-1111-1111-1111-111111111111', r.*);
  SELECT count(*) INTO n_partial  FROM public.records r WHERE public.wassell_can_view_record('22222222-2222-2222-2222-222222222222', r.*);
  SELECT count(*) INTO n_zero     FROM public.records r WHERE public.wassell_can_view_record('33333333-3333-3333-3333-333333333333', r.*);
  SELECT count(*) INTO n_noview   FROM public.records r WHERE public.wassell_can_view_record('44444444-4444-4444-4444-444444444444', r.*);
  SELECT count(*) INTO n_inactive FROM public.records r WHERE public.wassell_can_view_record('55555555-5555-5555-5555-555555555555', r.*);
  SELECT count(*) INTO n_mixed    FROM public.records r WHERE public.wassell_can_view_record('66666666-6666-6666-6666-666666666666', r.*);
  SELECT count(*) INTO n_ghost    FROM public.records r WHERE public.wassell_can_view_record('00000000-0000-0000-0000-0000000000ff', r.*);

  RAISE NOTICE 'B2A.5 corpus: % records, % orphan edges', n_total, n_orphan;
  RAISE NOTICE '  admin=%  allscope=%  partial=%  zerofilter=%  noview=%  inactive=%  mixed=%  ghost=%',
    n_admin, n_all, n_partial, n_zero, n_noview, n_inactive, n_mixed, n_ghost;

  IF n_total < 30000 THEN
    RAISE EXCEPTION 'corpus too small (% records) — CI would be gentler than production', n_total;
  END IF;
  IF n_orphan <> 24 THEN
    RAISE EXCEPTION 'expected 24 orphan edges, found % — the existence probe would be untested', n_orphan;
  END IF;
  IF n_admin <> n_total THEN
    RAISE EXCEPTION 'admin should see every record, sees % of %', n_admin, n_total;
  END IF;

  -- The 'filtered' persona must be a genuine PARTIAL. If this ever becomes 0 or
  -- everything, the filtered branch is no longer being tested and every
  -- fingerprint below it is vacuous.
  IF n_partial = 0 OR n_partial >= n_total THEN
    RAISE EXCEPTION 'filtered persona 2222 sees % of % — not a partial, filtered branch is vacuous', n_partial, n_total;
  END IF;
  IF n_mixed = 0 OR n_mixed >= n_total THEN
    RAISE EXCEPTION 'mixed persona 6666 sees % of % — not a partial', n_mixed, n_total;
  END IF;

  -- The three zero personas are the load-bearing ones: they are what a widening
  -- would show up in first.
  IF n_noview   <> 0 THEN RAISE EXCEPTION 'persona 4444 (edit but not view) should see 0, sees %', n_noview; END IF;
  IF n_inactive <> 0 THEN RAISE EXCEPTION 'persona 5555 (deactivated) should see 0, sees %', n_inactive; END IF;
  IF n_ghost    <> 0 THEN RAISE EXCEPTION 'persona 00ff (no user row) should see 0, sees %', n_ghost; END IF;

  -- 1111… must see whole models (its three "unrestricted" spellings), and 3333…
  -- must see m04 whole but nothing of m03.
  IF n_all <= 0 OR n_all >= n_total THEN
    RAISE EXCEPTION 'persona 1111 sees % of % — expected several whole models, not all and not none', n_all, n_total;
  END IF;
  IF n_zero <> 500 THEN
    RAISE EXCEPTION 'persona 3333 should see exactly m04 (500 rows) and none of m03, sees %', n_zero;
  END IF;
END $$;
