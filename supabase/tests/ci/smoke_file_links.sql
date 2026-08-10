-- CI smoke assertions for the Phase 1 file-link projection.
-- Runs against the ephemeral Postgres after fixture_file_links.sql and the
-- migration. Every assertion RAISES on failure so the job actually goes red —
-- the point of this file is that the green badge means something.
--
-- Four parts, in order:
--   1. structure     — what the backfill produced
--   2. privacy       — both-sides RLS, including the uuid-collision case
--   3. constraints   — source identity is enforced by the SCHEMA, not by luck
--   4. staleness     — reconciliation detects removal, replacement and reorder
-- Part 4 MUTATES the fixture, so it runs last.
\set ON_ERROR_STOP on

-- ═══ PART 1 — structure ════════════════════════════════════════════════════
DO $$
DECLARE
  v_edges int; v_sources int; v_multi int; v_pos int; v_fan int; v_trg int; v_n int;
  v_cons bigint; v_anom bigint; v_gap bigint; v_fsrc bigint; v_ext bigint; v_fold bigint; v_role text;
BEGIN
  PERFORM public.file_links_backfill();

  SELECT count(*) INTO v_edges   FROM public.file_links;
  SELECT count(*) INTO v_sources FROM public.file_link_sources;
  IF v_edges   <> 19 THEN RAISE EXCEPTION '1.1: expected 19 semantic edges, got %', v_edges; END IF;
  IF v_sources <> 20 THEN RAISE EXCEPTION '1.2: expected 20 source rows, got %', v_sources; END IF;

  -- Multi-source collapse: exactly ONE edge is proven twice — the unambiguous
  -- legacy pair corroborating the single field role on its triple.
  SELECT count(*) INTO v_multi FROM (
    SELECT link_id FROM public.file_link_sources GROUP BY link_id HAVING count(*)>1) q;
  IF v_multi <> 1 THEN RAISE EXCEPTION '1.3: expected 1 multi-source edge, got %', v_multi; END IF;

  -- ── the corrected generic-attachment rule ──────────────────────────────
  -- (a) UNAMBIGUOUS: one field role on the triple → legacy corroborates it,
  --     and produces NO separate attachment edge.
  SELECT count(*) INTO v_n FROM public.file_link_sources s
    JOIN public.file_links l ON l.id=s.link_id
   WHERE s.source_key = 'attachment:f0000000-0000-0000-0000-00000000000a:11111111-0000-0000-0000-000000000001:a0000000-0000-0000-0000-000000000f11'
     AND l.role = 'floor_plan';
  IF v_n <> 1 THEN RAISE EXCEPTION '1.4: unambiguous legacy pair did not corroborate the floor_plan edge'; END IF;

  -- (b) AMBIGUOUS: two field roles on the triple → its OWN role-neutral edge.
  --     It must NOT have been attached to either field-derived role.
  SELECT l.role INTO v_role FROM public.file_link_sources s
    JOIN public.file_links l ON l.id=s.link_id
   WHERE s.source_key = 'attachment:f0000000-0000-0000-0000-00000000000b:11111111-0000-0000-0000-000000000002:a0000000-0000-0000-0000-000000000f01';
  IF v_role <> 'attachment' THEN
    RAISE EXCEPTION '1.5: ambiguous legacy pair was assigned role %, expected role-neutral attachment', v_role;
  END IF;
  --     …and both field roles must still exist independently.
  SELECT count(*) INTO v_n FROM public.file_links
   WHERE file_id='f0000000-0000-0000-0000-00000000000b' AND role IN ('main_image','gallery_image');
  IF v_n <> 2 THEN RAISE EXCEPTION '1.6: ambiguous case lost a field-derived role (got %)', v_n; END IF;

  -- (c) NO field role at all → its own role-neutral edge.
  SELECT l.role INTO v_role FROM public.file_link_sources s
    JOIN public.file_links l ON l.id=s.link_id
   WHERE s.source_key = 'attachment:f0000000-0000-0000-0000-00000000000f:11111111-0000-0000-0000-000000000002:a0000000-0000-0000-0000-000000000f01';
  IF v_role <> 'attachment' THEN RAISE EXCEPTION '1.7: role-less legacy pair got role %', v_role; END IF;

  -- array ordering survives, and reaches index 2
  SELECT max(source_position) INTO v_pos FROM public.file_link_sources
   WHERE source_field='project_images';
  IF v_pos <> 2 THEN RAISE EXCEPTION '1.8: array position lost, max pos %', v_pos; END IF;

  -- fan-out preserved
  SELECT max(c) INTO v_fan FROM (SELECT count(*) c FROM public.file_links GROUP BY file_id) q;
  IF v_fan <> 4 THEN RAISE EXCEPTION '1.9: expected max fan-out 4, got %', v_fan; END IF;

  -- the frozen model's FIELD values are excluded entirely
  SELECT count(*) INTO v_n FROM public.file_links l
    JOIN public.file_link_sources s ON s.link_id=l.id
   WHERE l.model_id='11111111-0000-0000-0000-000000000004' AND s.origin='field';
  IF v_n <> 0 THEN RAISE EXCEPTION '1.10: frozen model field values were projected (%)', v_n; END IF;

  -- Reconciliation balances. Acceptance is NOT "zero anomalies" — the fixture
  -- deliberately contains a raw URL and a dangling uuid, exactly as production
  -- does. Acceptance is ZERO UNEXPLAINED LOSS. 'gap' rows are NOT subtracted:
  -- those occurrences ARE represented, as edges with role='unmapped'.
  SELECT coalesce(sum(value),0) INTO v_cons FROM public.file_links_reconcile() WHERE category='considered';
  SELECT coalesce(sum(value),0) INTO v_anom FROM public.file_links_reconcile() WHERE category='anomaly';
  SELECT coalesce(sum(value),0) INTO v_gap  FROM public.file_links_reconcile() WHERE category='gap';
  SELECT coalesce(sum(value),0) INTO v_fsrc FROM public.file_links_reconcile()
   WHERE category='source' AND detail='origin=field';
  SELECT coalesce(sum(value),0) INTO v_ext  FROM public.file_links_reconcile() WHERE category='external';
  SELECT coalesce(sum(value),0) INTO v_fold FROM public.file_links_reconcile() WHERE category='folder_ref';
  -- COMPLETE PARTITION: every considered value is represented, external, a
  -- folder reference, or a named anomaly. Nothing may fall between them.
  IF v_cons - v_fsrc - v_ext - v_fold - v_anom <> 0 THEN
    RAISE EXCEPTION '1.11: unexplained loss — considered=% field=% external=% folder=% anomaly=% (gaps=%)',
      v_cons, v_fsrc, v_ext, v_fold, v_anom, v_gap;
  END IF;
  IF v_anom <> 1 THEN RAISE EXCEPTION '1.12: expected exactly 1 named anomaly (the dangling uuid), got %', v_anom; END IF;
  IF v_gap  < 1 THEN RAISE EXCEPTION '1.13: expected the unmapped-role gap to be reported, got %', v_gap; END IF;

  -- a pristine projection must report ZERO drift in every staleness category
  SELECT coalesce(sum(value),0) INTO v_n FROM public.file_links_reconcile()
   WHERE category IN ('missing_source','stale_source','missing_edge','orphan_edge','drift');
  IF v_n <> 0 THEN RAISE EXCEPTION '1.14: fresh projection already reports drift (%)', v_n; END IF;

  -- idempotency, twice in THIS transaction
  PERFORM public.file_links_backfill();
  PERFORM public.file_links_backfill();
  SELECT count(*) INTO v_edges FROM public.file_links;
  SELECT count(*) INTO v_sources FROM public.file_link_sources;
  IF v_edges <> 19 OR v_sources <> 20 THEN
    RAISE EXCEPTION '1.15: backfill not idempotent in-transaction (edges=% sources=%)', v_edges, v_sources;
  END IF;

  -- the projection must NOT have added a trigger to the record-save path
  SELECT count(*) INTO v_trg FROM pg_trigger
   WHERE tgrelid='public.records'::regclass AND NOT tgisinternal;
  IF v_trg <> 0 THEN RAISE EXCEPTION '1.16: a trigger was added to records (%)', v_trg; END IF;

  RAISE NOTICE 'part 1 (structure): 16 assertions passed';
END $$;

-- idempotency ACROSS transactions (the block above committed)
DO $$
DECLARE v_edges int; v_sources int;
BEGIN
  PERFORM public.file_links_backfill();
  SELECT count(*) INTO v_edges FROM public.file_links;
  SELECT count(*) INTO v_sources FROM public.file_link_sources;
  IF v_edges <> 19 OR v_sources <> 20 THEN
    RAISE EXCEPTION '1.17: backfill not idempotent across transactions (edges=% sources=%)', v_edges, v_sources;
  END IF;
  RAISE NOTICE 'part 1b: cross-transaction idempotency passed';
END $$;

-- ═══ PART 1c — value-shape classification ══════════════════════════════════
-- The governing rule is "does this value resolve to a canonical files.id?",
-- never "what is the field's declared type". These assertions pin that down for
-- every shape production actually stores.
DO $$
DECLARE n int; v_pos int; v_role text;
BEGIN
  -- multi_file, SCALAR shape → one projected edge
  SELECT count(*) INTO n FROM public.file_links l
    JOIN public.file_link_sources s ON s.link_id=l.id
   WHERE l.record_id='a0000000-0000-0000-0000-000000000f41' AND s.origin='field';
  IF n <> 1 THEN RAISE EXCEPTION '1c.1: scalar multi_file not parsed (got %)', n; END IF;

  -- multi_file, ARRAY shape → two edges, positions 0 and 1 preserved
  SELECT count(*) INTO n FROM public.file_link_sources s
    JOIN public.file_links l ON l.id=s.link_id
   WHERE l.record_id='a0000000-0000-0000-0000-000000000f42' AND s.source_field='files';
  IF n <> 2 THEN RAISE EXCEPTION '1c.2: array multi_file not parsed (got %)', n; END IF;
  SELECT max(s.source_position) INTO v_pos FROM public.file_link_sources s
    JOIN public.file_links l ON l.id=s.link_id
   WHERE l.record_id='a0000000-0000-0000-0000-000000000f42' AND s.source_field='files';
  IF v_pos <> 1 THEN RAISE EXCEPTION '1c.3: multi_file array position lost (max %)', v_pos; END IF;

  -- multi_file gets a real role, not the unmapped sentinel
  SELECT DISTINCT l.role INTO v_role FROM public.file_links l
   WHERE l.file_id='f0000000-0000-0000-0000-000000000013';
  IF v_role <> 'task_attachment' THEN RAISE EXCEPTION '1c.4: multi_file role is %, expected task_attachment', v_role; END IF;

  -- MIXED multi_video: the canonical uuid is projected with a video role…
  SELECT count(*) INTO n FROM public.file_links
   WHERE file_id='f0000000-0000-0000-0000-000000000011' AND role='video';
  IF n <> 1 THEN RAISE EXCEPTION '1c.5: canonical uuid in a mixed multi_video array was not projected'; END IF;
  -- …at its TRUE index (0), even though external URLs share the array…
  SELECT s.source_position INTO v_pos FROM public.file_link_sources s
    JOIN public.file_links l ON l.id=s.link_id
   WHERE l.file_id='f0000000-0000-0000-0000-000000000011';
  IF v_pos <> 0 THEN RAISE EXCEPTION '1c.6: mixed-array position lost (got %)', v_pos; END IF;
  -- …and the external URLs produce NO edge at all.
  SELECT coalesce(sum(value),0) INTO n FROM public.file_links_reconcile()
   WHERE category='external' AND detail='all_projects.project_videos';
  IF n <> 2 THEN RAISE EXCEPTION '1c.7: expected 2 external project_videos values, got %', n; END IF;

  -- External URLs are NOT anomalies: an anomaly implies data loss, a YouTube
  -- link is correct data that simply is not a file.
  SELECT coalesce(sum(value),0) INTO n FROM public.file_links_reconcile() WHERE category='anomaly';
  IF n <> 1 THEN RAISE EXCEPTION '1c.8: external URLs were counted as anomalies (anomaly total %)', n; END IF;

  -- OBJECT-shaped {id,type:'file'} → projected
  SELECT count(*) INTO n FROM public.file_links
   WHERE file_id='f0000000-0000-0000-0000-000000000012' AND role='developer_content';
  IF n <> 1 THEN RAISE EXCEPTION '1c.9: object-shaped {type:file} was not projected'; END IF;

  -- FOLDER reference → reported, never an edge. A folder is a different
  -- resource; manufacturing a file relationship from one is a fabrication.
  SELECT count(*) INTO n FROM public.file_links
   WHERE file_id='d0000000-0000-0000-0000-000000000001';
  IF n <> 0 THEN RAISE EXCEPTION '1c.10: a folder reference became a file edge'; END IF;
  SELECT coalesce(sum(value),0) INTO n FROM public.file_links_reconcile() WHERE category='folder_ref';
  IF n <> 1 THEN RAISE EXCEPTION '1c.11: folder reference not reported (got %)', n; END IF;

  -- A uuid with no files row IS an anomaly — that one is real loss.
  SELECT coalesce(sum(value),0) INTO n FROM public.file_links_reconcile()
   WHERE category='anomaly' AND detail LIKE 'dangling%';
  IF n <> 1 THEN RAISE EXCEPTION '1c.12: dangling uuid not reported (got %)', n; END IF;

  -- No canonical file reference is hiding in a field type we do not scan.
  SELECT coalesce(sum(value),0) INTO n FROM public.file_links_reconcile() WHERE category='unscanned';
  IF n <> 0 THEN RAISE EXCEPTION '1c.13: % file reference(s) sit in non-candidate fields', n; END IF;

  RAISE NOTICE 'part 1c (value-shape classification): 13 assertions passed';
END $$;

-- ═══ PART 2 — privacy ══════════════════════════════════════════════════════
DO $$
DECLARE n int; v_model uuid; v_role text;
BEGIN
  -- both sides visible → the link is visible
  PERFORM set_config('test.visible_files','f0000000-0000-0000-0000-00000000000c',true);
  PERFORM set_config('test.visible_records','a0000000-0000-0000-0000-000000000f21',true);
  SET LOCAL ROLE authenticated; SELECT count(*) INTO n FROM public.file_links; RESET ROLE;
  IF n <> 1 THEN RAISE EXCEPTION '2.1: both-sides visible should yield 1 link, got %', n; END IF;

  -- FILE visible, RECORD hidden → nothing, and no sources either
  PERFORM set_config('test.visible_records','',true);
  SET LOCAL ROLE authenticated; SELECT count(*) INTO n FROM public.file_links; RESET ROLE;
  IF n <> 0 THEN RAISE EXCEPTION '2.2: file-only access leaked % link(s)', n; END IF;
  SET LOCAL ROLE authenticated; SELECT count(*) INTO n FROM public.file_link_sources; RESET ROLE;
  IF n <> 0 THEN RAISE EXCEPTION '2.3: file-only access leaked % source(s)', n; END IF;

  -- RECORD visible, FILE hidden → nothing
  PERFORM set_config('test.visible_files','',true);
  PERFORM set_config('test.visible_records','a0000000-0000-0000-0000-000000000f21',true);
  SET LOCAL ROLE authenticated; SELECT count(*) INTO n FROM public.file_links; RESET ROLE;
  IF n <> 0 THEN RAISE EXCEPTION '2.4: record-only access leaked % link(s)', n; END IF;

  -- ── THE UUID COLLISION ───────────────────────────────────────────────────
  -- One record uuid, two models. collision-doc.pdf links to BOTH: as a
  -- floor_plan on the `units` row, and as a supporting_document on the frozen
  -- `market_listings` row. Seeing one must never reveal the other.
  PERFORM set_config('test.visible_files','f0000000-0000-0000-0000-000000000010',true);

  -- (a) units side visible, frozen side hidden
  PERFORM set_config('test.visible_records','c0111de0-0000-0000-0000-000000000001',true);
  PERFORM set_config('test.visible_frozen','',true);
  SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.file_links;
    SELECT model_id, role INTO v_model, v_role FROM public.file_links LIMIT 1;
  RESET ROLE;
  IF n <> 1 THEN RAISE EXCEPTION '2.5: uuid collision — expected exactly 1 visible link, got %', n; END IF;
  IF v_model <> '11111111-0000-0000-0000-000000000001' OR v_role <> 'floor_plan' THEN
    RAISE EXCEPTION '2.6: uuid collision — wrong side visible (model=% role=%)', v_model, v_role;
  END IF;

  -- (b) frozen side visible, units side hidden — the mirror image
  PERFORM set_config('test.visible_records','',true);
  PERFORM set_config('test.visible_frozen','c0111de0-0000-0000-0000-000000000001',true);
  SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.file_links;
    SELECT model_id, role INTO v_model, v_role FROM public.file_links LIMIT 1;
  RESET ROLE;
  IF n <> 1 THEN RAISE EXCEPTION '2.7: uuid collision (mirror) — expected 1 link, got %', n; END IF;
  IF v_model <> '11111111-0000-0000-0000-000000000004' OR v_role <> 'supporting_document' THEN
    RAISE EXCEPTION '2.8: uuid collision (mirror) — wrong side visible (model=% role=%)', v_model, v_role;
  END IF;

  -- (c) neither side visible → nothing, even though the uuid exists somewhere
  PERFORM set_config('test.visible_frozen','',true);
  SET LOCAL ROLE authenticated; SELECT count(*) INTO n FROM public.file_links; RESET ROLE;
  IF n <> 0 THEN RAISE EXCEPTION '2.9: uuid collision — leaked % link(s) with neither side visible', n; END IF;

  RAISE NOTICE 'part 2 (privacy incl. uuid collision): 9 assertions passed';
END $$;

-- ═══ PART 3 — constraints and grants ═══════════════════════════════════════
DO $$
DECLARE lid uuid; v text;
BEGIN
  SELECT id INTO lid FROM public.file_links LIMIT 1;

  -- source_key is UNIQUE: a second identical insert must fail deterministically
  BEGIN
    INSERT INTO public.file_link_sources (link_id, origin, source_key)
    VALUES (lid, 'manual', 'attachment:f0000000-0000-0000-0000-00000000000a:11111111-0000-0000-0000-000000000001:a0000000-0000-0000-0000-000000000f11');
    RAISE EXCEPTION '3.1: duplicate source_key was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- source_key is NOT NULL
  BEGIN
    INSERT INTO public.file_link_sources (link_id, origin, source_key) VALUES (lid, 'manual', NULL);
    RAISE EXCEPTION '3.2: NULL source_key was accepted';
  EXCEPTION WHEN not_null_violation THEN NULL; END;

  -- …and not empty
  BEGIN
    INSERT INTO public.file_link_sources (link_id, origin, source_key) VALUES (lid, 'manual', '');
    RAISE EXCEPTION '3.3: empty source_key was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- THE REGRESSION THIS REPLACED: with NULL source_field and NULL
  -- source_position, the old composite unique constraint would have permitted
  -- unlimited duplicates. Under source_key it must not.
  INSERT INTO public.file_link_sources (link_id, origin, source_key, source_field, source_position)
  VALUES (lid, 'manual', 'probe:null-field-and-position', NULL, NULL);
  BEGIN
    INSERT INTO public.file_link_sources (link_id, origin, source_key, source_field, source_position)
    VALUES (lid, 'manual', 'probe:null-field-and-position', NULL, NULL);
    RAISE EXCEPTION '3.4: duplicate accepted when source_field and source_position are NULL';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  DELETE FROM public.file_link_sources WHERE source_key = 'probe:null-field-and-position';

  -- edge identity includes model_id: same file+record+role under two models is legal
  BEGIN
    INSERT INTO public.file_links (file_id, model_id, record_id, role)
    VALUES ('f0000000-0000-0000-0000-000000000010','11111111-0000-0000-0000-000000000002',
            'c0111de0-0000-0000-0000-000000000001','floor_plan');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION '3.5: model_id is not participating in edge identity';
  END;
  DELETE FROM public.file_links
   WHERE model_id='11111111-0000-0000-0000-000000000002'
     AND record_id='c0111de0-0000-0000-0000-000000000001';

  -- writes must be denied to authenticated at the GRANT layer
  IF has_table_privilege('authenticated','public.file_links','INSERT')  THEN RAISE EXCEPTION '3.6: authenticated can INSERT file_links'; END IF;
  IF has_table_privilege('authenticated','public.file_links','UPDATE')  THEN RAISE EXCEPTION '3.7: authenticated can UPDATE file_links'; END IF;
  IF has_table_privilege('authenticated','public.file_links','DELETE')  THEN RAISE EXCEPTION '3.8: authenticated can DELETE file_links'; END IF;
  IF has_table_privilege('authenticated','public.file_link_sources','INSERT') THEN RAISE EXCEPTION '3.9: authenticated can INSERT file_link_sources'; END IF;

  -- functions: PUBLIC default EXECUTE must be closed, not merely revoked from
  -- `authenticated` (the Phase 0b lesson).
  FOREACH v IN ARRAY ARRAY['public.file_links_backfill()','public.file_links_reconcile()',
                           'public.file_link_live_sources()','public.file_link_field_occurrences()'] LOOP
    IF has_function_privilege('authenticated', v, 'EXECUTE') THEN RAISE EXCEPTION '3.10: authenticated can execute %', v; END IF;
    IF has_function_privilege('anon',          v, 'EXECUTE') THEN RAISE EXCEPTION '3.11: anon can execute %', v; END IF;
    IF NOT has_function_privilege('service_role', v, 'EXECUTE') THEN RAISE EXCEPTION '3.12: service_role CANNOT execute %', v; END IF;
  END LOOP;

  -- every projection function pins a safe search_path
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname LIKE 'file_link%'
       AND NOT ('search_path=public, pg_temp' = ANY(coalesce(p.proconfig,ARRAY[]::text[]))
             OR 'search_path="public", "pg_temp"' = ANY(coalesce(p.proconfig,ARRAY[]::text[])))
  ) THEN RAISE EXCEPTION '3.13: a file_link* function does not pin search_path'; END IF;

  RAISE NOTICE 'part 3 (constraints + grants): 13 assertions passed';
END $$;

-- ═══ PART 4 — staleness detection (MUTATES the fixture) ════════════════════
DO $$
DECLARE v_stale bigint; v_missing bigint; v_orphan bigint; v_drift bigint; v_miss_edge bigint;
BEGIN
  -- 4a. REMOVE a field reference. gallery2.jpg was project_images[1] and had no
  --     other source, so both its provenance and its edge go stale.
  UPDATE public.records
     SET data = jsonb_set(data,'{project_images}',
         jsonb_build_array('f0000000-0000-0000-0000-00000000000d',
                           'f0000000-0000-0000-0000-00000000000b'))
   WHERE id='a0000000-0000-0000-0000-000000000f01';

  SELECT coalesce(sum(value),0) INTO v_stale  FROM public.file_links_reconcile() WHERE category='stale_source';
  SELECT coalesce(sum(value),0) INTO v_orphan FROM public.file_links_reconcile() WHERE category='orphan_edge';
  IF v_stale = 0  THEN RAISE EXCEPTION '4.1: removing a field reference produced no stale_source'; END IF;
  IF v_orphan = 0 THEN RAISE EXCEPTION '4.2: removing a field reference produced no orphan_edge'; END IF;

  -- 4b. REPLACE file A with file B in a scalar field. B must be reported
  --     missing, A stale.
  UPDATE public.records SET data = jsonb_set(data,'{unit_plan}',
           '"f0000000-0000-0000-0000-00000000000e"')
   WHERE id='a0000000-0000-0000-0000-000000000f12';
  SELECT coalesce(sum(value),0) INTO v_missing FROM public.file_links_reconcile() WHERE category='missing_source';
  SELECT coalesce(sum(value),0) INTO v_miss_edge FROM public.file_links_reconcile() WHERE category='missing_edge';
  IF v_missing = 0   THEN RAISE EXCEPTION '4.3: replacing a file produced no missing_source for the new file'; END IF;
  IF v_miss_edge = 0 THEN RAISE EXCEPTION '4.4: replacing a file produced no missing_edge'; END IF;

  -- 4c. REORDER an array. Same file, same field, new index → positional drift.
  UPDATE public.records
     SET data = jsonb_set(data,'{project_images}',
         jsonb_build_array('f0000000-0000-0000-0000-00000000000b',
                           'f0000000-0000-0000-0000-00000000000d'))
   WHERE id='a0000000-0000-0000-0000-000000000f01';
  SELECT coalesce(sum(value),0) INTO v_drift FROM public.file_links_reconcile()
   WHERE category='drift' AND detail LIKE 'positional%';
  IF v_drift = 0 THEN RAISE EXCEPTION '4.5: an array reorder was not detected as positional drift'; END IF;

  -- 4d. REMOVE a marketing project relationship → its marketing source goes stale.
  UPDATE public.mos_assets SET project_id = NULL;
  SELECT coalesce(sum(value),0) INTO v_stale FROM public.file_links_reconcile()
   WHERE category='stale_source' AND detail='origin=marketing';
  IF v_stale <> 1 THEN RAISE EXCEPTION '4.6: clearing mos_assets.project_id gave % stale marketing sources, expected 1', v_stale; END IF;

  -- 4e. Reconciliation REPORTS drift; it must never repair or prune it.
  --     The stale rows are still there after all that reporting.
  IF NOT EXISTS (SELECT 1 FROM public.file_link_sources WHERE origin='marketing') THEN
    RAISE EXCEPTION '4.7: reconciliation deleted a stale source — it must only report';
  END IF;

  -- 4f. A re-run converges: after the backfill, live and projected agree again
  --     on everything that still exists (missing_* goes to zero). Stale rows
  --     remain, because pruning is destructive and out of scope for this phase.
  PERFORM public.file_links_backfill();
  SELECT coalesce(sum(value),0) INTO v_missing FROM public.file_links_reconcile()
   WHERE category IN ('missing_source','missing_edge');
  IF v_missing <> 0 THEN RAISE EXCEPTION '4.8: after re-backfill, % source/edge still missing', v_missing; END IF;

  RAISE NOTICE 'part 4 (staleness detection): 8 assertions passed';
END $$;

-- ═══ PART 5 — retargeting (every key must track the asserted FACT) ═════════
-- Each case starts from a PRISTINE projection. The backfill deliberately never
-- prunes, so stale rows accumulate across mutations; measuring absolute totals
-- after several edits would conflate this case with the previous one.
DO $$
DECLARE v_stale bigint; v_missing bigint; n int;

BEGIN
  -- 5a. MANUAL link retargeted to a different RECORD.
  DELETE FROM public.file_links;  PERFORM public.file_links_backfill();
  UPDATE public.document_links SET record_id='a0000000-0000-0000-0000-000000000f11'
   WHERE file_id='f0000000-0000-0000-0000-00000000000b';
  SELECT coalesce(sum(value),0) INTO v_stale FROM public.file_links_reconcile()
   WHERE category='stale_source' AND detail='origin=manual';
  SELECT coalesce(sum(value),0) INTO v_missing FROM public.file_links_reconcile()
   WHERE category='missing_source' AND detail='origin=manual';
  IF v_stale <> 1 OR v_missing <> 1 THEN
    RAISE EXCEPTION '5.1: manual record retarget gave stale=% missing=%, expected 1/1', v_stale, v_missing;
  END IF;

  -- 5b. MANUAL link moved to a different MODEL while keeping the SAME record
  --     uuid. If the key ignored model_id this would look like no change at all.
  DELETE FROM public.file_links;  PERFORM public.file_links_backfill();
  UPDATE public.document_links SET model_id='11111111-0000-0000-0000-000000000004',
                                   record_id='c0111de0-0000-0000-0000-000000000001'
   WHERE file_id='f0000000-0000-0000-0000-00000000000b';
  SELECT coalesce(sum(value),0) INTO v_stale FROM public.file_links_reconcile()
   WHERE category='stale_source' AND detail='origin=manual';
  SELECT coalesce(sum(value),0) INTO v_missing FROM public.file_links_reconcile()
   WHERE category='missing_source' AND detail='origin=manual';
  IF v_stale <> 1 OR v_missing <> 1 THEN
    RAISE EXCEPTION '5.2: manual MODEL retarget gave stale=% missing=%, expected 1/1', v_stale, v_missing;
  END IF;

  -- 5c. MANUAL link repointed to a different FILE.
  DELETE FROM public.file_links;  PERFORM public.file_links_backfill();
  UPDATE public.document_links SET file_id='f0000000-0000-0000-0000-00000000000e'
   WHERE file_id='f0000000-0000-0000-0000-00000000000b';
  SELECT coalesce(sum(value),0) INTO v_stale FROM public.file_links_reconcile()
   WHERE category='stale_source' AND detail='origin=manual';
  SELECT coalesce(sum(value),0) INTO v_missing FROM public.file_links_reconcile()
   WHERE category='missing_source' AND detail='origin=manual';
  IF v_stale <> 1 OR v_missing <> 1 THEN
    RAISE EXCEPTION '5.3: manual FILE repoint gave stale=% missing=%, expected 1/1', v_stale, v_missing;
  END IF;

  -- 5d. Re-asserting the SAME manual fact must NOT look like drift. This is
  --     exactly why the key is the fact and not document_links.id: the app
  --     unlinks and re-links rather than updating, so a surrogate key would
  --     report false drift on every such round-trip.
  DELETE FROM public.file_links;  PERFORM public.file_links_backfill();
  DELETE FROM public.document_links WHERE file_id='f0000000-0000-0000-0000-00000000000e';
  INSERT INTO public.document_links (file_id, model_id, record_id)
  VALUES ('f0000000-0000-0000-0000-00000000000e','11111111-0000-0000-0000-000000000004',
          'c0111de0-0000-0000-0000-000000000001');
  SELECT coalesce(sum(value),0) INTO v_stale FROM public.file_links_reconcile()
   WHERE category IN ('stale_source','missing_source') AND detail='origin=manual';
  IF v_stale <> 0 THEN
    RAISE EXCEPTION '5.4: unlink+relink of the SAME fact reported % false drift', v_stale;
  END IF;

  -- 5e. MARKETING asset moved between projects. Part 4d cleared project_id, so
  --     restore a real relationship FIRST — otherwise there is no baseline fact
  --     to go stale and the case would silently test nothing.
  UPDATE public.mos_assets SET project_id='a0000000-0000-0000-0000-000000000f01';
  DELETE FROM public.file_links;  PERFORM public.file_links_backfill();
  UPDATE public.mos_assets SET project_id='a0000000-0000-0000-0000-000000000f11';
  SELECT coalesce(sum(value),0) INTO v_stale FROM public.file_links_reconcile()
   WHERE category='stale_source' AND detail='origin=marketing';
  SELECT coalesce(sum(value),0) INTO v_missing FROM public.file_links_reconcile()
   WHERE category='missing_source' AND detail='origin=marketing';
  IF v_stale <> 1 OR v_missing <> 1 THEN
    RAISE EXCEPTION '5.5: marketing project retarget gave stale=% missing=%, expected 1/1', v_stale, v_missing;
  END IF;

  -- 5f. Changing EXTERNAL URLs must create no edge and no drift whatsoever.
  DELETE FROM public.file_links;  PERFORM public.file_links_backfill();
  UPDATE public.records SET data = jsonb_set(data,'{project_videos}',
    jsonb_build_array('f0000000-0000-0000-0000-000000000011',
                      'https://www.youtube.com/watch?v=CHANGED',
                      'https://vimeo.com/999'))
   WHERE id='a0000000-0000-0000-0000-000000000f01';
  SELECT coalesce(sum(value),0) INTO v_stale FROM public.file_links_reconcile()
   WHERE category IN ('stale_source','missing_source','missing_edge','orphan_edge');
  IF v_stale <> 0 THEN
    RAISE EXCEPTION '5.6: swapping external URLs produced % drift — they are not files', v_stale;
  END IF;
  SELECT count(*) INTO n FROM public.file_links WHERE role='video';
  IF n <> 1 THEN RAISE EXCEPTION '5.7: the canonical video edge changed when only URLs moved (got %)', n; END IF;

  -- 5g. …but moving the canonical entry to a NEW INDEX inside that same mixed
  --     array IS drift, and must be reported as positional.
  DELETE FROM public.file_links;  PERFORM public.file_links_backfill();
  UPDATE public.records SET data = jsonb_set(data,'{project_videos}',
    jsonb_build_array('https://www.youtube.com/watch?v=CHANGED',
                      'f0000000-0000-0000-0000-000000000011',
                      'https://vimeo.com/999'))
   WHERE id='a0000000-0000-0000-0000-000000000f01';
  SELECT coalesce(sum(value),0) INTO n FROM public.file_links_reconcile()
   WHERE category='drift' AND detail LIKE 'positional%';
  IF n <> 1 THEN RAISE EXCEPTION '5.8: reordering a MIXED array did not report positional drift (got %)', n; END IF;

  RAISE NOTICE 'part 5 (retargeting): 8 assertions passed';
  RAISE NOTICE 'file-link projection smoke: all 75 assertions passed';
END $$;
