-- ============================================================================
-- Phase 2 smoke — transactional synchronisation of the file-link projection.
--
-- Runs on a database that has the Phase 1 fixture, the Phase 1 migration AND
-- the Phase 2 migration. Phase 1's own smoke keeps running on a database with
-- Phase 2 ABSENT, because its parts 4 and 5 deliberately INDUCE drift to prove
-- the reconciler can see it — and Phase 2's whole purpose is that the drift
-- never happens. Those sixteen scenarios are not discarded: part 3 below
-- re-runs every one of them and asserts the exact opposite outcome. That is the
-- strongest available evidence that synchronisation works, because the
-- assertions were written by the phase that had no triggers.
--
-- Every functional assertion ends in the same global check: `file_links_reconcile()`
-- must report ZERO across missing_source / stale_source / missing_edge /
-- orphan_edge / drift. Reconciliation is an INDEPENDENT re-derivation, so a
-- trigger that converged to the wrong answer cannot pass by agreeing with
-- itself.
-- ============================================================================

-- Convergence helper: total drift across every staleness category, globally.
CREATE OR REPLACE FUNCTION pg_temp.drift() RETURNS bigint
LANGUAGE sql AS $$
  SELECT coalesce(sum(value),0)::bigint FROM public.file_links_reconcile()
   WHERE category IN ('missing_source','stale_source','missing_edge','orphan_edge','drift');
$$;

-- Establish the converged starting point exactly as a production rollout would:
-- apply the migration, then converge once.
SELECT * FROM public.file_links_resync_all();

DO $$
DECLARE v bigint;
BEGIN
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '0.1: resync_all did not converge (drift=%)', v; END IF;
  RAISE NOTICE 'part 0: baseline converged';
END $$;

-- ═══ PART 1 — structure, safety, and the absence of recursion ══════════════
DO $$
DECLARE n int; v_txt text;
BEGIN
  -- 1.1 exactly the four intended triggers exist, all AFTER and all ROW-level
  SELECT count(*) INTO n FROM pg_trigger
   WHERE NOT tgisinternal AND tgname IN ('records_sync_file_links','files_sync_file_links',
         'document_links_sync_file_links','mos_assets_sync_file_links');
  IF n <> 4 THEN RAISE EXCEPTION '1.1: expected 4 sync triggers, got %', n; END IF;

  -- tgtype bit 0 = ROW, bit 1 = BEFORE. AFTER ROW means bit0 set, bit1 clear.
  SELECT count(*) INTO n FROM pg_trigger
   WHERE NOT tgisinternal AND tgname LIKE '%_sync_file_links'
     AND NOT ((tgtype & 1) = 1 AND (tgtype & 2) = 0);
  IF n <> 0 THEN RAISE EXCEPTION '1.2: % sync trigger(s) are not AFTER-ROW', n; END IF;

  -- 1.3 the projection tables must carry NO trigger. This is the structural
  --     proof that a sync cannot re-enter itself: the only writes the sync
  --     performs are to these two tables, and nothing fires there.
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid IN ('public.file_links'::regclass,'public.file_link_sources'::regclass)
     AND NOT tgisinternal;
  IF n <> 0 THEN RAISE EXCEPTION '1.3: the projection carries % trigger(s)', n; END IF;

  -- 1.4 files deliberately has NO delete trigger (FK cascade covers it)
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid='public.files'::regclass AND tgname='files_sync_file_links'
     AND (tgtype & 8) <> 0;                              -- bit 3 = DELETE
  IF n <> 0 THEN RAISE EXCEPTION '1.4: files sync trigger fires on DELETE'; END IF;

  -- 1.5 every Phase 2 function pins search_path
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public'
     AND p.proname IN ('file_link_field_occurrences_scoped','file_link_live_sources_scoped',
         'file_link_target_lock_key','file_link_global_lock_key','file_link_bulk_target_threshold',
         'file_links_sync_target','file_links_converge_target','file_links_mark_dirty',
         'file_links_drain_dirty','file_links_resync_all',
         'tg_records_sync_file_links','tg_files_sync_file_links',
         'tg_document_links_sync_file_links','tg_mos_assets_sync_file_links',
         'tg_file_links_drain')
     AND NOT coalesce(array_to_string(p.proconfig,',') LIKE '%search_path=%', false);
  IF n <> 0 THEN RAISE EXCEPTION '1.5: % Phase 2 function(s) do not pin search_path', n; END IF;

  -- 1.6 no dynamic SQL anywhere in the sync path — nothing to inject into
  SELECT string_agg(p.proname,',') INTO v_txt FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public'
     AND p.proname IN ('file_links_sync_target','file_links_converge_target',
         'file_links_mark_dirty','file_links_drain_dirty','file_links_resync_all',
         'tg_records_sync_file_links','tg_files_sync_file_links',
         'tg_document_links_sync_file_links','tg_mos_assets_sync_file_links',
         'tg_file_links_drain')
     AND p.prosrc ~* '\mEXECUTE\M';
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION '1.6: dynamic SQL in %', v_txt; END IF;

  -- 1.7 ordinary roles cannot invoke the privileged sync machinery
  SELECT count(*) INTO n FROM (VALUES
      ('public.file_links_sync_target(uuid,uuid)'),
      ('public.file_links_converge_target(uuid,uuid)'),
      ('public.file_links_mark_dirty(uuid,uuid)'),
      ('public.file_links_drain_dirty()'),
      ('public.file_links_resync_all()'),
      ('public.file_link_live_sources_scoped(uuid,uuid)'),
      ('public.file_link_field_occurrences_scoped(uuid,uuid)'),
      ('public.file_link_target_lock_key(uuid,uuid)'),
      ('public.file_link_global_lock_key()')
    ) f(sig)
   WHERE has_function_privilege('anon', f.sig,'EXECUTE')
      OR has_function_privilege('authenticated', f.sig,'EXECUTE');
  IF n <> 0 THEN RAISE EXCEPTION '1.7: % sync function(s) executable by anon/authenticated', n; END IF;

  -- 1.8 Phase 2 widened nothing on the projection tables themselves
  SELECT count(*) INTO n FROM (VALUES ('public.file_links'),('public.file_link_sources')) t(rel),
       (VALUES ('INSERT'),('UPDATE'),('DELETE')) p(priv)
   WHERE has_table_privilege('anon', t.rel, p.priv)
      OR has_table_privilege('authenticated', t.rel, p.priv);
  IF n <> 0 THEN RAISE EXCEPTION '1.8: anon/authenticated hold % write grant(s) on the projection', n; END IF;

  -- 1.9 the convergence functions run as definer (they must see all sources,
  --     not only the writer's visible ones)
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public'
     AND p.proname IN ('file_links_sync_target','file_links_converge_target',
         'file_links_drain_dirty','file_links_mark_dirty',
         'file_link_live_sources_scoped','file_link_field_occurrences_scoped')
     AND NOT p.prosecdef;
  IF n <> 0 THEN RAISE EXCEPTION '1.9: % convergence function(s) are not SECURITY DEFINER', n; END IF;

  -- 1.10 the drain trigger exists and is genuinely DEFERRED. If it were
  --      immediate, the transaction would acquire its target locks
  --      incrementally in data-dependent order and could deadlock — the exact
  --      defect this design exists to remove.
  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgname='file_link_dirty_drain'
     AND tgrelid='public.file_link_dirty_targets'::regclass
     AND tgdeferrable AND tginitdeferred;
  IF n <> 1 THEN RAISE EXCEPTION '1.10: the drain trigger is missing or not initially deferred'; END IF;

  -- 1.11 the dirty set is internal: RLS on, no policies, no role grants
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.file_link_dirty_targets'::regclass) THEN
    RAISE EXCEPTION '1.11: the dirty set does not have RLS enabled';
  END IF;
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='file_link_dirty_targets';
  IF n <> 0 THEN RAISE EXCEPTION '1.11: the dirty set has % policy(ies); it must be unreachable', n; END IF;
  -- including service_role: the dirty set drives convergence and is reached only
  -- through the definer functions, so nothing outside them needs a grant.
  SELECT count(*) INTO n FROM (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(priv),
       (VALUES ('anon'),('authenticated'),('service_role')) g(role)
   WHERE has_table_privilege(g.role,'public.file_link_dirty_targets',p.priv);
  IF n <> 0 THEN RAISE EXCEPTION '1.12: % grant(s) remain on the dirty set', n; END IF;

  RAISE NOTICE 'part 1 (structure + safety): 12 assertions passed';
END $$;

-- ═══ PART 2 — the two derivations are proven equal ════════════════════════
-- Phase 2 could not share ONE parameterised body with Phase 1: an optional
-- scope cannot be planned as an equality probe and cost 400x on the save path
-- (the measurements are in the migration header). So the scoped twin is a
-- SECOND text, and this part is the contract that keeps it honest: the global
-- function must equal the UNION of the scoped function over every target,
-- exactly, in both directions, for both derivations. Edit one and not the
-- other and CI fails here.
--
-- This also protects every functional test below. If the trigger and the
-- reconciler disagreed, they would be measuring the same bug twice.
DROP TABLE IF EXISTS pg_temp._t, pg_temp._g, pg_temp._s, pg_temp._og, pg_temp._os;
CREATE TEMP TABLE _t AS
  SELECT DISTINCT r.model_id, r.id AS record_id FROM public.records r
  UNION
  SELECT DISTINCT d.model_id, d.record_id FROM public.file_link_live_sources() d;

CREATE TEMP TABLE _g AS SELECT * FROM public.file_link_live_sources();
CREATE TEMP TABLE _s AS
  SELECT d.* FROM _t t, LATERAL public.file_link_live_sources_scoped(t.model_id, t.record_id) d;

CREATE TEMP TABLE _og AS SELECT * FROM public.file_link_field_occurrences();
CREATE TEMP TABLE _os AS
  SELECT o.* FROM _t t, LATERAL public.file_link_field_occurrences_scoped(t.model_id, t.record_id) o;

DO $$
DECLARE n int; d int;
BEGIN
  -- 2.1 no source appears under two targets. This IS the partition property the
  --     lock granularity depends on: if a source could belong to two targets,
  --     a per-target lock would not cover a complete edge identity.
  SELECT count(*), count(DISTINCT source_key) INTO n, d FROM _s;
  IF n <> d THEN RAISE EXCEPTION '2.1: % scoped sources but only % distinct keys — sources are NOT partitioned by target', n, d; END IF;

  -- 2.2 / 2.3 live sources: set equality in both directions
  SELECT count(*) INTO n FROM (SELECT * FROM _g EXCEPT SELECT * FROM _s) x;
  IF n <> 0 THEN RAISE EXCEPTION '2.2: % live source(s) the scoped derivation MISSES', n; END IF;
  SELECT count(*) INTO n FROM (SELECT * FROM _s EXCEPT SELECT * FROM _g) x;
  IF n <> 0 THEN RAISE EXCEPTION '2.3: % live source(s) the scoped derivation INVENTS', n; END IF;

  -- 2.4 / 2.5 same for the occurrence classifier (roles, classes, positions)
  SELECT count(*) INTO n FROM (SELECT * FROM _og EXCEPT SELECT * FROM _os) x;
  IF n <> 0 THEN RAISE EXCEPTION '2.4: % occurrence(s) the scoped classifier MISSES', n; END IF;
  SELECT count(*) INTO n FROM (SELECT * FROM _os EXCEPT SELECT * FROM _og) x;
  IF n <> 0 THEN RAISE EXCEPTION '2.5: % occurrence(s) the scoped classifier INVENTS', n; END IF;

  -- 2.6 the row COUNTS match too, so a duplicate on one side cannot hide behind
  --     EXCEPT's set semantics
  IF (SELECT count(*) FROM _g) <> (SELECT count(*) FROM _s) THEN
    RAISE EXCEPTION '2.6: global has % live sources, scoped union has %',
      (SELECT count(*) FROM _g), (SELECT count(*) FROM _s);
  END IF;

  -- 2.7 the scope is REQUIRED, not optional: a NULL scope is not a wildcard.
  --     If someone "helpfully" restores NULL-means-everything, the save path
  --     silently returns to a full scan of records — assert it stays required.
  SELECT count(*) INTO n FROM public.file_link_live_sources_scoped(NULL, NULL);
  IF n <> 0 THEN RAISE EXCEPTION '2.7: a NULL scope behaved as a wildcard and returned % rows', n; END IF;

  -- 2.8 a scope naming a target with nothing in it returns nothing
  SELECT count(*) INTO n FROM public.file_link_live_sources_scoped(
    '11111111-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000ff');
  IF n <> 0 THEN RAISE EXCEPTION '2.8: an empty scope returned % rows', n; END IF;

  RAISE NOTICE 'part 2 (the two derivations are equal): 8 assertions passed';
END $$;
DROP TABLE pg_temp._t, pg_temp._g, pg_temp._s, pg_temp._og, pg_temp._os;

-- ═══ PART 3 — Phase 1's drift scenarios, inverted ══════════════════════════
-- Every mutation here is copied verbatim from smoke_file_links.sql parts 4 and
-- 5, where each one is asserted to PRODUCE drift. With Phase 2 installed each
-- must now produce none.
DO $$
DECLARE v bigint; n int;
BEGIN
  -- This block mutates and asserts inside ONE transaction, where the deferred
  -- drain has not run yet. Firing the constraint trigger immediately gives
  -- per-statement convergence here; part 6 proves the commit-time path.
  SET CONSTRAINTS ALL IMMEDIATE;
  -- 3.1 (was 4.1/4.2) remove a field reference
  UPDATE public.records
     SET data = jsonb_set(data,'{project_images}',
         jsonb_build_array('f0000000-0000-0000-0000-00000000000d',
                           'f0000000-0000-0000-0000-00000000000b'))
   WHERE id='a0000000-0000-0000-0000-000000000f01';
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '3.1: removing a field reference left drift=%', v; END IF;
  -- and the edge it solely proved is really gone
  IF EXISTS (SELECT 1 FROM public.file_links
              WHERE file_id='f0000000-0000-0000-0000-00000000000e'
                AND record_id='a0000000-0000-0000-0000-000000000f01') THEN
    RAISE EXCEPTION '3.2: the removed file kept its edge';
  END IF;

  -- 3.3 (was 4.3/4.4) repoint a scalar field from file A to file B
  UPDATE public.records SET data = jsonb_set(data,'{unit_plan}',
           '"f0000000-0000-0000-0000-00000000000e"')
   WHERE id='a0000000-0000-0000-0000-000000000f12';
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '3.3: repointing a scalar field left drift=%', v; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.file_links
                  WHERE file_id='f0000000-0000-0000-0000-00000000000e'
                    AND record_id='a0000000-0000-0000-0000-000000000f12') THEN
    RAISE EXCEPTION '3.4: the new file got no edge';
  END IF;
  IF EXISTS (SELECT 1 FROM public.file_links
              WHERE file_id='f0000000-0000-0000-0000-00000000000a'
                AND record_id='a0000000-0000-0000-0000-000000000f12') THEN
    RAISE EXCEPTION '3.5: the old file kept its edge after being repointed away';
  END IF;

  -- 3.6 (was 4.5) reorder an array — the projected position must follow
  UPDATE public.records
     SET data = jsonb_set(data,'{project_images}',
         jsonb_build_array('f0000000-0000-0000-0000-00000000000b',
                           'f0000000-0000-0000-0000-00000000000d'))
   WHERE id='a0000000-0000-0000-0000-000000000f01';
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '3.6: reordering an array left drift=%', v; END IF;
  SELECT s.source_position INTO n FROM public.file_link_sources s JOIN public.file_links l ON l.id=s.link_id
   WHERE s.origin='field' AND s.source_field='project_images'
     AND l.file_id='f0000000-0000-0000-0000-00000000000d'
     AND l.record_id='a0000000-0000-0000-0000-000000000f01';
  IF n <> 1 THEN RAISE EXCEPTION '3.7: after the reorder the projected position is %, expected 1', n; END IF;

  -- 3.8 (was 4.6) clear a marketing relationship
  UPDATE public.mos_assets SET project_id = NULL;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '3.8: clearing mos_assets.project_id left drift=%', v; END IF;
  IF EXISTS (SELECT 1 FROM public.file_link_sources WHERE origin='marketing') THEN
    RAISE EXCEPTION '3.9: a marketing source survived its project being cleared';
  END IF;

  -- 3.10 (was 5a) manual link retargeted to a different RECORD
  UPDATE public.mos_assets SET project_id='a0000000-0000-0000-0000-000000000f01';
  UPDATE public.document_links SET record_id='a0000000-0000-0000-0000-000000000f11'
   WHERE file_id='f0000000-0000-0000-0000-00000000000b';
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '3.10: manual record retarget left drift=%', v; END IF;

  -- 3.11 (was 5b) manual link moved to a different MODEL, same record uuid
  UPDATE public.document_links SET model_id='11111111-0000-0000-0000-000000000004',
                                   record_id='c0111de0-0000-0000-0000-000000000001'
   WHERE file_id='f0000000-0000-0000-0000-00000000000b';
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '3.11: manual MODEL retarget left drift=%', v; END IF;

  -- 3.12 (was 5c) manual link repointed to a different FILE
  UPDATE public.document_links SET file_id='f0000000-0000-0000-0000-00000000000e'
   WHERE file_id='f0000000-0000-0000-0000-00000000000b';
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '3.12: manual FILE repoint left drift=%', v; END IF;

  -- 3.13 (was 5d) unlink + relink of the SAME fact is not a change
  SELECT count(*) INTO n FROM public.file_links;
  DELETE FROM public.document_links WHERE file_id='f0000000-0000-0000-0000-00000000000e';
  INSERT INTO public.document_links (file_id, model_id, record_id)
  VALUES ('f0000000-0000-0000-0000-00000000000e','11111111-0000-0000-0000-000000000004',
          'c0111de0-0000-0000-0000-000000000001');
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '3.13: unlink+relink of the same fact left drift=%', v; END IF;
  IF (SELECT count(*) FROM public.file_links) <> n THEN
    RAISE EXCEPTION '3.14: unlink+relink of the same fact changed the edge count';
  END IF;

  -- 3.15 (was 5e) marketing asset moved between projects
  UPDATE public.mos_assets SET project_id='a0000000-0000-0000-0000-000000000f11';
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '3.15: marketing project retarget left drift=%', v; END IF;

  -- 3.16 (was 5f) swapping EXTERNAL urls in a mixed array changes nothing
  UPDATE public.records SET data = jsonb_set(data,'{project_videos}',
    jsonb_build_array('f0000000-0000-0000-0000-000000000011',
                      'https://www.youtube.com/watch?v=CHANGED',
                      'https://vimeo.com/999'))
   WHERE id='a0000000-0000-0000-0000-000000000f01';
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '3.16: swapping external urls left drift=%', v; END IF;
  SELECT count(*) INTO n FROM public.file_links WHERE role='video';
  IF n <> 1 THEN RAISE EXCEPTION '3.17: the canonical video edge changed when only urls moved (got %)', n; END IF;

  -- 3.18 (was 5g) moving the canonical entry inside that mixed array DOES move
  --      its projected position — and still leaves no drift
  UPDATE public.records SET data = jsonb_set(data,'{project_videos}',
    jsonb_build_array('https://www.youtube.com/watch?v=CHANGED',
                      'f0000000-0000-0000-0000-000000000011',
                      'https://vimeo.com/999'))
   WHERE id='a0000000-0000-0000-0000-000000000f01';
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '3.18: reordering a mixed array left drift=%', v; END IF;
  SELECT s.source_position INTO n FROM public.file_link_sources s JOIN public.file_links l ON l.id=s.link_id
   WHERE s.source_field='project_videos' AND l.file_id='f0000000-0000-0000-0000-000000000011';
  IF n <> 1 THEN RAISE EXCEPTION '3.19: mixed-array position is %, expected 1', n; END IF;

  RAISE NOTICE 'part 3 (Phase 1 drift scenarios, inverted): 19 assertions passed';
END $$;

-- ═══ PART 4 — the mutation matrix ══════════════════════════════════════════
DO $$
DECLARE v bigint; n int; v_role text; v_link uuid; v_new uuid;
BEGIN
  -- This block mutates and asserts inside ONE transaction, where the deferred
  -- drain has not run yet. Firing the constraint trigger immediately gives
  -- per-statement convergence here; part 6 proves the commit-time path.
  SET CONSTRAINTS ALL IMMEDIATE;
  -- ---- 4a. scalar field: add on a record that had none -------------------
  INSERT INTO public.records (id, model_id, data) VALUES
    ('a0000000-0000-0000-0000-0000000000c1','11111111-0000-0000-0000-000000000001','{}');
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.1: inserting an empty record left drift=%', v; END IF;

  UPDATE public.records SET data='{"unit_plan":"f0000000-0000-0000-0000-00000000000c"}'
   WHERE id='a0000000-0000-0000-0000-0000000000c1';
  IF NOT EXISTS (SELECT 1 FROM public.file_links WHERE record_id='a0000000-0000-0000-0000-0000000000c1'
                  AND file_id='f0000000-0000-0000-0000-00000000000c' AND role='floor_plan') THEN
    RAISE EXCEPTION '4.2: adding a scalar reference created no edge';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.3: adding a scalar reference left drift=%', v; END IF;

  -- clear it: the last source goes, so the edge must go
  UPDATE public.records SET data='{}' WHERE id='a0000000-0000-0000-0000-0000000000c1';
  IF EXISTS (SELECT 1 FROM public.file_links WHERE record_id='a0000000-0000-0000-0000-0000000000c1') THEN
    RAISE EXCEPTION '4.4: clearing the only reference left an unproven edge';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.5: clearing a scalar reference left drift=%', v; END IF;

  -- ---- 4b. array grow / shrink -------------------------------------------
  UPDATE public.records SET data = jsonb_set(data,'{project_images}',
    jsonb_build_array('f0000000-0000-0000-0000-00000000000d',
                      'f0000000-0000-0000-0000-00000000000e',
                      'f0000000-0000-0000-0000-000000000012'))
   WHERE id='a0000000-0000-0000-0000-000000000f01';
  SELECT count(*) INTO n FROM public.file_link_sources s JOIN public.file_links l ON l.id=s.link_id
   WHERE s.source_field='project_images' AND l.record_id='a0000000-0000-0000-0000-000000000f01';
  IF n <> 3 THEN RAISE EXCEPTION '4.6: growing the array gave % sources, expected 3', n; END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.7: growing an array left drift=%', v; END IF;

  UPDATE public.records SET data = jsonb_set(data,'{project_images}','[]'::jsonb)
   WHERE id='a0000000-0000-0000-0000-000000000f01';
  SELECT count(*) INTO n FROM public.file_link_sources s JOIN public.file_links l ON l.id=s.link_id
   WHERE s.source_field='project_images' AND l.record_id='a0000000-0000-0000-0000-000000000f01';
  IF n <> 0 THEN RAISE EXCEPTION '4.8: emptying the array left % sources', n; END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.9: emptying an array left drift=%', v; END IF;

  -- ---- 4c. object-shaped values, folders excluded ------------------------
  --  developer_content holds {id,type:'file'} and {id,type:'folder'}. Only the
  --  file may become an edge; fabricating one from a folder would invent a
  --  relationship to a different kind of resource.
  IF NOT EXISTS (SELECT 1 FROM public.file_links WHERE file_id='f0000000-0000-0000-0000-000000000012'
                  AND record_id='a0000000-0000-0000-0000-000000000f01') THEN
    RAISE EXCEPTION '4.10: the {type:file} object produced no edge';
  END IF;
  IF EXISTS (SELECT 1 FROM public.file_links WHERE file_id='d0000000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION '4.11: a folder entry was projected as a file relationship';
  END IF;

  -- ---- 4d. malformed values must be classified, never fatal --------------
  --  Each of these is a value the app should never write. The source write must
  --  still succeed, and must create nothing.
  UPDATE public.records SET data='{"unit_plan":12345}' WHERE id='a0000000-0000-0000-0000-0000000000c1';
  UPDATE public.records SET data='{"unit_plan":true}'  WHERE id='a0000000-0000-0000-0000-0000000000c1';
  UPDATE public.records SET data='{"unit_plan":{"nested":{"deep":1}}}' WHERE id='a0000000-0000-0000-0000-0000000000c1';
  UPDATE public.records SET data='{"unit_plan":""}'    WHERE id='a0000000-0000-0000-0000-0000000000c1';
  UPDATE public.records SET data='{"unit_plan":"not-a-uuid-at-all"}' WHERE id='a0000000-0000-0000-0000-0000000000c1';
  UPDATE public.records SET data='{"unit_plan":"f0000000-0000-0000-0000-0000deadbee5"}'
   WHERE id='a0000000-0000-0000-0000-0000000000c1';                       -- dangling uuid
  UPDATE public.records SET data='{"unit_plan":null}'  WHERE id='a0000000-0000-0000-0000-0000000000c1';
  IF EXISTS (SELECT 1 FROM public.file_links WHERE record_id='a0000000-0000-0000-0000-0000000000c1') THEN
    RAISE EXCEPTION '4.12: a malformed or dangling value produced an edge';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.13: malformed values left drift=%', v; END IF;

  -- a malformed ARRAY, mixing every bad shape at once, alongside one good uuid
  UPDATE public.records SET data = jsonb_set(data,'{project_images}',
    '[null, 42, true, {"no_id":true}, "", "https://x/y.jpg", "f0000000-0000-0000-0000-00000000000d"]'::jsonb)
   WHERE id='a0000000-0000-0000-0000-000000000f01';
  SELECT count(*) INTO n FROM public.file_link_sources s JOIN public.file_links l ON l.id=s.link_id
   WHERE s.source_field='project_images' AND l.record_id='a0000000-0000-0000-0000-000000000f01';
  IF n <> 1 THEN RAISE EXCEPTION '4.14: the mixed malformed array produced % sources, expected 1', n; END IF;
  -- and it kept its TRUE index, not a compacted one
  SELECT s.source_position INTO n FROM public.file_link_sources s JOIN public.file_links l ON l.id=s.link_id
   WHERE s.source_field='project_images' AND l.record_id='a0000000-0000-0000-0000-000000000f01';
  IF n <> 6 THEN RAISE EXCEPTION '4.15: the surviving entry got position %, expected its true index 6', n; END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.16: a malformed array left drift=%', v; END IF;

  -- ---- 4e. legacy attachment provenance, and its RE-evaluation -----------
  --  loose-scan.pdf is a files.record_id pair with NO field role → role-neutral.
  SELECT l.role INTO v_role FROM public.file_links l
   WHERE l.file_id='f0000000-0000-0000-0000-00000000000f'
     AND l.record_id='a0000000-0000-0000-0000-000000000f01';
  IF v_role <> 'attachment' THEN RAISE EXCEPTION '4.17: a zero-role legacy pair got role %, expected attachment', v_role; END IF;

  --  Give it exactly ONE field role. The attachment now CORROBORATES that role
  --  and must migrate onto it — provenance re-evaluated by a field edit.
  UPDATE public.records SET data = jsonb_set(data,'{main_image}',
    '"f0000000-0000-0000-0000-00000000000f"') WHERE id='a0000000-0000-0000-0000-000000000f01';
  SELECT count(*) INTO n FROM public.file_links
   WHERE file_id='f0000000-0000-0000-0000-00000000000f' AND record_id='a0000000-0000-0000-0000-000000000f01';
  IF n <> 1 THEN RAISE EXCEPTION '4.18: one field role should give exactly one edge, got %', n; END IF;
  SELECT l.role INTO v_role FROM public.file_links l
   WHERE l.file_id='f0000000-0000-0000-0000-00000000000f' AND l.record_id='a0000000-0000-0000-0000-000000000f01';
  IF v_role <> 'main_image' THEN RAISE EXCEPTION '4.19: attachment did not corroborate the single field role (got %)', v_role; END IF;
  SELECT count(*) INTO n FROM public.file_link_sources s JOIN public.file_links l ON l.id=s.link_id
   WHERE l.file_id='f0000000-0000-0000-0000-00000000000f' AND l.record_id='a0000000-0000-0000-0000-000000000f01';
  IF n <> 2 THEN RAISE EXCEPTION '4.20: corroborated edge should carry 2 sources, got %', n; END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.21: attachment corroboration left drift=%', v; END IF;

  --  Now give it a SECOND, different field role. Two roles is ambiguous, so the
  --  attachment must fall back to its own role-neutral edge — never pick one.
  UPDATE public.records SET data = jsonb_set(data,'{project_images}',
    '["f0000000-0000-0000-0000-00000000000f"]'::jsonb) WHERE id='a0000000-0000-0000-0000-000000000f01';
  SELECT l.role INTO v_role FROM public.file_link_sources s JOIN public.file_links l ON l.id=s.link_id
   WHERE s.origin='attachment' AND l.file_id='f0000000-0000-0000-0000-00000000000f';
  IF v_role <> 'attachment' THEN RAISE EXCEPTION '4.22: an ambiguous legacy pair chose role % instead of staying neutral', v_role; END IF;
  SELECT count(*) INTO n FROM public.file_links
   WHERE file_id='f0000000-0000-0000-0000-00000000000f' AND record_id='a0000000-0000-0000-0000-000000000f01';
  IF n <> 3 THEN RAISE EXCEPTION '4.23: expected main_image + gallery_image + attachment edges, got %', n; END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.24: ambiguous attachment left drift=%', v; END IF;

  --  Back to zero field roles → neutral again, and the two field edges vanish.
  UPDATE public.records SET data = jsonb_set(jsonb_set(data,'{main_image}','null'::jsonb),
                                             '{project_images}','[]'::jsonb)
   WHERE id='a0000000-0000-0000-0000-000000000f01';
  SELECT count(*) INTO n FROM public.file_links
   WHERE file_id='f0000000-0000-0000-0000-00000000000f' AND record_id='a0000000-0000-0000-0000-000000000f01';
  IF n <> 1 THEN RAISE EXCEPTION '4.25: after removing both field roles, % edges remain, expected 1', n; END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.26: role re-evaluation left drift=%', v; END IF;

  -- ---- 4f. files.model_id / files.record_id ------------------------------
  --  attach a previously loose file to a record
  UPDATE public.files SET model_id='11111111-0000-0000-0000-000000000001',
                          record_id='a0000000-0000-0000-0000-000000000f13'
   WHERE id='f0000000-0000-0000-0000-000000000014';
  IF NOT EXISTS (SELECT 1 FROM public.file_links WHERE file_id='f0000000-0000-0000-0000-000000000014'
                  AND record_id='a0000000-0000-0000-0000-000000000f13' AND role='attachment') THEN
    RAISE EXCEPTION '4.27: attaching a file created no attachment edge';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.28: attaching a file left drift=%', v; END IF;

  --  move it to another record: BOTH targets must converge in one statement
  UPDATE public.files SET record_id='a0000000-0000-0000-0000-000000000f12'
   WHERE id='f0000000-0000-0000-0000-000000000014';
  IF EXISTS (SELECT 1 FROM public.file_links WHERE file_id='f0000000-0000-0000-0000-000000000014'
              AND record_id='a0000000-0000-0000-0000-000000000f13') THEN
    RAISE EXCEPTION '4.29: the OLD target kept its edge after the file moved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.file_links WHERE file_id='f0000000-0000-0000-0000-000000000014'
                  AND record_id='a0000000-0000-0000-0000-000000000f12') THEN
    RAISE EXCEPTION '4.30: the NEW target got no edge after the file moved';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.31: moving a file between records left drift=%', v; END IF;

  --  detach entirely
  UPDATE public.files SET model_id=NULL, record_id=NULL WHERE id='f0000000-0000-0000-0000-000000000014';
  IF EXISTS (SELECT 1 FROM public.file_link_sources WHERE source_key LIKE 'attachment:f0000000-0000-0000-0000-000000000014%') THEN
    RAISE EXCEPTION '4.32: detaching a file left its attachment source';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.33: detaching a file left drift=%', v; END IF;

  --  deleting the FILE removes its edges through the FK cascade, with no
  --  trigger on files DELETE. This is the claim the missing trigger rests on.
  INSERT INTO public.files (id, original_name) VALUES ('f0000000-0000-0000-0000-0000000000ff','temp.pdf');
  UPDATE public.records SET data='{"unit_plan":"f0000000-0000-0000-0000-0000000000ff"}'
   WHERE id='a0000000-0000-0000-0000-0000000000c1';
  IF NOT EXISTS (SELECT 1 FROM public.file_links WHERE file_id='f0000000-0000-0000-0000-0000000000ff') THEN
    RAISE EXCEPTION '4.34: the temp file got no edge';
  END IF;
  DELETE FROM public.files WHERE id='f0000000-0000-0000-0000-0000000000ff';
  IF EXISTS (SELECT 1 FROM public.file_links WHERE file_id='f0000000-0000-0000-0000-0000000000ff') THEN
    RAISE EXCEPTION '4.35: deleting a file left its edge behind';
  END IF;
  --  the record still names the dead uuid; it now classifies as dangling, so
  --  the projection is convergent WITHOUT a delete trigger on files
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.36: deleting a referenced file left drift=%', v; END IF;

  -- ---- 4g. document_links -------------------------------------------------
  INSERT INTO public.document_links (file_id, model_id, record_id)
  VALUES ('f0000000-0000-0000-0000-00000000000c','11111111-0000-0000-0000-000000000001',
          'a0000000-0000-0000-0000-000000000f13');
  IF NOT EXISTS (SELECT 1 FROM public.file_links WHERE file_id='f0000000-0000-0000-0000-00000000000c'
                  AND record_id='a0000000-0000-0000-0000-000000000f13' AND role='supporting_document') THEN
    RAISE EXCEPTION '4.37: a manual link created no edge';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.38: creating a manual link left drift=%', v; END IF;

  DELETE FROM public.document_links WHERE file_id='f0000000-0000-0000-0000-00000000000c'
     AND record_id='a0000000-0000-0000-0000-000000000f13';
  IF EXISTS (SELECT 1 FROM public.file_links WHERE file_id='f0000000-0000-0000-0000-00000000000c'
              AND record_id='a0000000-0000-0000-0000-000000000f13') THEN
    RAISE EXCEPTION '4.39: deleting a manual link left its edge';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.40: deleting a manual link left drift=%', v; END IF;

  --  a manual link pointing at a FROZEN model is a legitimate target: frozen
  --  FIELDS are excluded, frozen TARGETS are not.
  IF NOT EXISTS (SELECT 1 FROM public.file_links
                  WHERE model_id='11111111-0000-0000-0000-000000000004'
                    AND record_id='c0111de0-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION '4.41: a manual link to a frozen model produced no edge';
  END IF;
  --  …while the frozen model's own file FIELD still produces nothing
  IF EXISTS (SELECT 1 FROM public.file_link_sources s JOIN public.file_links l ON l.id=s.link_id
              WHERE s.origin='field' AND l.model_id='11111111-0000-0000-0000-000000000004') THEN
    RAISE EXCEPTION '4.42: a frozen model contributed a FIELD source';
  END IF;
  --  editing the frozen model's record must not change anything
  UPDATE public.records SET data='{"image_urls":["f0000000-0000-0000-0000-00000000000c"]}'
   WHERE id='a0000000-0000-0000-0000-000000000f31';
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.43: editing a frozen model record left drift=%', v; END IF;

  -- ---- 4h. mos_assets -----------------------------------------------------
  INSERT INTO public.mos_assets (id, title, file_id, project_id) VALUES
    ('b0000000-0000-0000-0000-0000000000a1','second asset',
     'f0000000-0000-0000-0000-000000000013','a0000000-0000-0000-0000-000000000f01');
  IF NOT EXISTS (SELECT 1 FROM public.file_links WHERE file_id='f0000000-0000-0000-0000-000000000013'
                  AND record_id='a0000000-0000-0000-0000-000000000f01' AND role='marketing_asset') THEN
    RAISE EXCEPTION '4.44: a marketing asset created no edge';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.45: creating a marketing asset left drift=%', v; END IF;

  --  changing the LINKED FILE on the sidecar
  UPDATE public.mos_assets SET file_id='f0000000-0000-0000-0000-00000000000d'
   WHERE id='b0000000-0000-0000-0000-0000000000a1';
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.46: changing a marketing asset''s file left drift=%', v; END IF;

  --  a title-only edit must be a no-op for the projection
  SELECT count(*) INTO n FROM public.file_link_sources;
  UPDATE public.mos_assets SET title='renamed' WHERE id='b0000000-0000-0000-0000-0000000000a1';
  IF (SELECT count(*) FROM public.file_link_sources) <> n THEN
    RAISE EXCEPTION '4.47: a title-only marketing edit changed the projection';
  END IF;

  --  deleting the sidecar
  DELETE FROM public.mos_assets WHERE id='b0000000-0000-0000-0000-0000000000a1';
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.48: deleting a marketing asset left drift=%', v; END IF;

  -- ---- 4i. multi-source edges survive losing ONE source ------------------
  --  type-villa-layout.webp on unit f11 is proven by BOTH a field and the legacy
  --  attachment pair. Removing the field must leave the edge standing on the
  --  attachment alone, and removing the attachment too must finally drop it.
  SELECT count(*) INTO n FROM public.file_link_sources s JOIN public.file_links l ON l.id=s.link_id
   WHERE l.file_id='f0000000-0000-0000-0000-00000000000a' AND l.record_id='a0000000-0000-0000-0000-000000000f11';
  IF n <> 2 THEN RAISE EXCEPTION '4.49: expected a dual-provenance edge, got % sources', n; END IF;

  UPDATE public.records SET data='{}' WHERE id='a0000000-0000-0000-0000-000000000f11';
  IF NOT EXISTS (SELECT 1 FROM public.file_links WHERE file_id='f0000000-0000-0000-0000-00000000000a'
                  AND record_id='a0000000-0000-0000-0000-000000000f11') THEN
    RAISE EXCEPTION '4.50: an edge with a surviving source was deleted';
  END IF;
  SELECT count(*) INTO n FROM public.file_link_sources s JOIN public.file_links l ON l.id=s.link_id
   WHERE l.file_id='f0000000-0000-0000-0000-00000000000a' AND l.record_id='a0000000-0000-0000-0000-000000000f11';
  IF n <> 1 THEN RAISE EXCEPTION '4.51: expected 1 surviving source, got %', n; END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.52: removing one of two sources left drift=%', v; END IF;

  UPDATE public.files SET model_id=NULL, record_id=NULL WHERE id='f0000000-0000-0000-0000-00000000000a';
  IF EXISTS (SELECT 1 FROM public.file_links WHERE file_id='f0000000-0000-0000-0000-00000000000a'
              AND record_id='a0000000-0000-0000-0000-000000000f11') THEN
    RAISE EXCEPTION '4.53: removing the FINAL source did not delete the edge';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.54: removing the final source left drift=%', v; END IF;

  -- ---- 4j. record DELETE ---------------------------------------------------
  --  Field sources die with the record. Sources that live in OTHER tables still
  --  assert, so their edges legitimately survive — the projection reflects what
  --  is asserted, and both-sides RLS hides an edge whose record cannot be seen.
  INSERT INTO public.records (id, model_id, data) VALUES
    ('a0000000-0000-0000-0000-0000000000c2','11111111-0000-0000-0000-000000000001',
     '{"unit_plan":"f0000000-0000-0000-0000-00000000000d"}');
  INSERT INTO public.document_links (file_id, model_id, record_id) VALUES
    ('f0000000-0000-0000-0000-00000000000e','11111111-0000-0000-0000-000000000001',
     'a0000000-0000-0000-0000-0000000000c2');
  SELECT count(*) INTO n FROM public.file_links WHERE record_id='a0000000-0000-0000-0000-0000000000c2';
  IF n <> 2 THEN RAISE EXCEPTION '4.55: expected 2 edges before the delete, got %', n; END IF;

  DELETE FROM public.records WHERE id='a0000000-0000-0000-0000-0000000000c2';
  IF EXISTS (SELECT 1 FROM public.file_link_sources WHERE origin='field'
              AND source_key LIKE '%a0000000-0000-0000-0000-0000000000c2%') THEN
    RAISE EXCEPTION '4.56: a field source survived its record being deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.file_links WHERE record_id='a0000000-0000-0000-0000-0000000000c2'
                  AND role='supporting_document') THEN
    RAISE EXCEPTION '4.57: a manual link stopped asserting because the record was deleted elsewhere';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.58: deleting a record left drift=%', v; END IF;

  --  once the manual link is withdrawn too, nothing is left
  DELETE FROM public.document_links WHERE record_id='a0000000-0000-0000-0000-0000000000c2';
  IF EXISTS (SELECT 1 FROM public.file_links WHERE record_id='a0000000-0000-0000-0000-0000000000c2') THEN
    RAISE EXCEPTION '4.59: edges survived with no asserting source at all';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.60: withdrawing the last assertion left drift=%', v; END IF;

  -- ---- 4k. a model created at RUNTIME, with no migration -----------------
  --  Models are user-authored data. A file field invented in the Builder after
  --  this migration shipped must synchronise with no code change at all.
  v_new := '11111111-0000-0000-0000-0000000000aa';
  INSERT INTO public.models (id,name,schema) VALUES
    (v_new,'inspections','{"sections":[{"fields":[{"name":"report","type":"attachment"}]}]}');
  INSERT INTO public.records (id, model_id, data) VALUES
    ('a0000000-0000-0000-0000-0000000000c3', v_new,
     '{"report":"f0000000-0000-0000-0000-00000000000c"}');
  IF NOT EXISTS (SELECT 1 FROM public.file_links WHERE record_id='a0000000-0000-0000-0000-0000000000c3'
                  AND file_id='f0000000-0000-0000-0000-00000000000c') THEN
    RAISE EXCEPTION '4.61: a model created at runtime did not synchronise';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.62: a runtime-created model left drift=%', v; END IF;

  -- ---- 4l. the uuid collision across models ------------------------------
  --  c0111de0… exists as a `units` record AND as a frozen market_listings row.
  --  Touching one target must not disturb the other's edges.
  SELECT count(*) INTO n FROM public.file_links
   WHERE record_id='c0111de0-0000-0000-0000-000000000001'
     AND model_id='11111111-0000-0000-0000-000000000004';
  UPDATE public.records SET data='{"unit_plan":"f0000000-0000-0000-0000-00000000000d"}'
   WHERE id='c0111de0-0000-0000-0000-000000000001';
  IF (SELECT count(*) FROM public.file_links
       WHERE record_id='c0111de0-0000-0000-0000-000000000001'
         AND model_id='11111111-0000-0000-0000-000000000004') <> n THEN
    RAISE EXCEPTION '4.63: editing one model''s record changed another model''s edges for the same uuid';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.64: the uuid-collision edit left drift=%', v; END IF;

  -- ---- 4m. idempotency ----------------------------------------------------
  SELECT count(*) INTO n FROM public.file_link_sources;
  UPDATE public.records SET data = data WHERE model_id='11111111-0000-0000-0000-000000000002';
  UPDATE public.files SET model_id = model_id;
  UPDATE public.document_links SET file_id = file_id;
  UPDATE public.mos_assets SET file_id = file_id;
  IF (SELECT count(*) FROM public.file_link_sources) <> n THEN
    RAISE EXCEPTION '4.65: re-writing every source with identical values changed the projection';
  END IF;
  --  and an explicit double convergence is a no-op
  PERFORM public.file_links_sync_target('11111111-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000f01');
  PERFORM public.file_links_sync_target('11111111-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000f01');
  IF (SELECT count(*) FROM public.file_link_sources) <> n THEN
    RAISE EXCEPTION '4.66: converging the same target twice changed the projection';
  END IF;
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '4.67: idempotency checks left drift=%', v; END IF;

  RAISE NOTICE 'part 4 (mutation matrix): 67 assertions passed';
END $$;

-- ═══ PART 5 — the writer needs no privilege on the sync path ═══════════════
-- The sync functions are revoked from every ordinary role. If that also stopped
-- the trigger from firing, the migration would silently do nothing for real
-- application writes. Prove the two are independent, with a role that CAN write
-- records and CANNOT execute a single sync function.
DO $r$ BEGIN CREATE ROLE smoke_writer NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
GRANT USAGE ON SCHEMA public TO smoke_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.records TO smoke_writer;
DROP POLICY IF EXISTS records_smoke_writer ON public.records;
CREATE POLICY records_smoke_writer ON public.records FOR ALL TO smoke_writer USING (true) WITH CHECK (true);

DO $$
DECLARE n int;
BEGIN
  -- 5.1 the writer holds no EXECUTE on anything in the sync path
  SELECT count(*) INTO n FROM (VALUES
      ('public.file_links_sync_target(uuid,uuid)'),
      ('public.file_links_converge_target(uuid,uuid)'),
      ('public.file_links_mark_dirty(uuid,uuid)'),
      ('public.file_links_drain_dirty()'),
      ('public.file_link_live_sources_scoped(uuid,uuid)'),
      ('public.file_links_resync_all()')
    ) f(sig)
   WHERE has_function_privilege('smoke_writer', f.sig, 'EXECUTE');
  IF n <> 0 THEN RAISE EXCEPTION '5.1: the writer can execute % sync function(s)', n; END IF;

  -- 5.2 nor any write on the projection
  IF has_table_privilege('smoke_writer','public.file_links','INSERT')
     OR has_table_privilege('smoke_writer','public.file_link_sources','INSERT') THEN
    RAISE EXCEPTION '5.2: the writer can write the projection directly';
  END IF;
END $$;

-- 5.3 a direct call is refused
DO $$
BEGIN
  SET LOCAL ROLE smoke_writer;
  BEGIN
    PERFORM public.file_links_sync_target('11111111-0000-0000-0000-000000000001',
                                          'a0000000-0000-0000-0000-000000000f12');
    RESET ROLE;
    RAISE EXCEPTION '5.3: an ordinary role invoked file_links_sync_target directly';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;                       -- expected
  END;
END $$;

-- 5.4 …yet its ordinary record write still synchronises, in its own transaction
DO $$
DECLARE v bigint;
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;   -- see part 3's note; part 6 covers commit time
  SET LOCAL ROLE smoke_writer;
  INSERT INTO public.records (id, model_id, data) VALUES
    ('a0000000-0000-0000-0000-0000000000c4','11111111-0000-0000-0000-000000000001',
     '{"unit_plan":"f0000000-0000-0000-0000-00000000000d"}');
  RESET ROLE;

  IF NOT EXISTS (SELECT 1 FROM public.file_links WHERE record_id='a0000000-0000-0000-0000-0000000000c4') THEN
    RAISE EXCEPTION '5.4: a write by an unprivileged role did not synchronise';
  END IF;

  -- 5.5 the projection it produced is byte-for-byte what the reconciler expects
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '5.5: an unprivileged write left drift=%', v; END IF;

  -- 5.6 and the sync ran as definer, so a source the WRITER cannot see was
  --     still honoured: this record's file is invisible to it, yet the edge
  --     carries the correct role rather than being silently skipped.
  IF NOT EXISTS (SELECT 1 FROM public.file_links
                  WHERE record_id='a0000000-0000-0000-0000-0000000000c4' AND role='floor_plan') THEN
    RAISE EXCEPTION '5.6: the definer-side derivation did not run for an unprivileged writer';
  END IF;

  SET LOCAL ROLE smoke_writer;
  DELETE FROM public.records WHERE id='a0000000-0000-0000-0000-0000000000c4';
  RESET ROLE;
  IF EXISTS (SELECT 1 FROM public.file_links WHERE record_id='a0000000-0000-0000-0000-0000000000c4') THEN
    RAISE EXCEPTION '5.7: a delete by an unprivileged role did not synchronise';
  END IF;

  RAISE NOTICE 'part 5 (unprivileged writers): 7 assertions passed';
END $$;

DROP POLICY IF EXISTS records_smoke_writer ON public.records;

-- ═══ PART 6 — the commit-time contract ════════════════════════════════════
-- Convergence runs from a DEFERRED constraint trigger, so it happens at COMMIT
-- rather than at each statement. Three things must hold, and every one of them
-- is a property of a transaction BOUNDARY, so these run at top level rather
-- than inside a DO block.
--
-- 6.1  mid-transaction the projection still shows the pre-transaction state
-- 6.2  at COMMIT it converges, with no explicit call from the writer
-- 6.3  on ROLLBACK nothing survives — the projection cannot outlive its source
-- 6.4  the dirty set is scratch space and never leaks rows

BEGIN;
INSERT INTO public.records (id, model_id, data) VALUES
  ('a0000000-0000-0000-0000-0000000000c5','11111111-0000-0000-0000-000000000001',
   '{"unit_plan":"f0000000-0000-0000-0000-00000000000d"}');
DO $$
BEGIN
  -- The deferral is the whole reason this design is deadlock-free. Asserting it
  -- keeps anyone from "fixing" it back to an immediate trigger unnoticed.
  IF EXISTS (SELECT 1 FROM public.file_links WHERE record_id='a0000000-0000-0000-0000-0000000000c5') THEN
    RAISE EXCEPTION '6.1: converged before COMMIT — the drain is not deferred';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.file_link_dirty_targets
                  WHERE record_id='a0000000-0000-0000-0000-0000000000c5') THEN
    RAISE EXCEPTION '6.1: the write did not mark its target dirty';
  END IF;
END $$;
COMMIT;

DO $$
DECLARE n int;
BEGIN
  -- 6.2 committed → converged, with no explicit drain call anywhere above
  IF NOT EXISTS (SELECT 1 FROM public.file_links
                  WHERE record_id='a0000000-0000-0000-0000-0000000000c5' AND role='floor_plan') THEN
    RAISE EXCEPTION '6.2: the deferred drain did not fire at COMMIT';
  END IF;
  -- 6.4 and left nothing behind
  SELECT count(*) INTO n FROM public.file_link_dirty_targets;
  IF n <> 0 THEN RAISE EXCEPTION '6.4: the dirty set leaked % row(s) after commit', n; END IF;
END $$;

-- 6.3 a rolled-back write leaves no trace in the projection
BEGIN;
INSERT INTO public.records (id, model_id, data) VALUES
  ('a0000000-0000-0000-0000-0000000000c6','11111111-0000-0000-0000-000000000001',
   '{"unit_plan":"f0000000-0000-0000-0000-00000000000e"}');
ROLLBACK;

DO $$
DECLARE n int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.file_links WHERE record_id='a0000000-0000-0000-0000-0000000000c6') THEN
    RAISE EXCEPTION '6.3: an edge outlived the rolled-back record that proved it';
  END IF;
  SELECT count(*) INTO n FROM public.file_link_dirty_targets;
  IF n <> 0 THEN RAISE EXCEPTION '6.4: the dirty set leaked % row(s) after rollback', n; END IF;

  -- and the committed record from 6.2 is still correctly projected
  IF pg_temp.drift() <> 0 THEN RAISE EXCEPTION '6.5: drift after the commit/rollback pair'; END IF;

  RAISE NOTICE 'part 6 (commit-time contract): 5 assertions passed';
END $$;

-- clean up so part 7's totals reflect the mutation matrix, not this part
DELETE FROM public.records WHERE id='a0000000-0000-0000-0000-0000000000c5';

-- ═══ PART 7 — final state ══════════════════════════════════════════════════
DO $$
DECLARE v bigint; n int;
BEGIN
  -- 7.1 after every mutation above, the graph is still exactly what an
  --     independent whole-graph re-derivation says it should be
  v := pg_temp.drift();
  IF v <> 0 THEN RAISE EXCEPTION '7.1: final drift=%', v; END IF;

  -- 7.2 a full resync changes nothing — the triggers had already converged
  SELECT count(*) INTO n FROM public.file_link_sources;
  PERFORM public.file_links_resync_all();
  IF (SELECT count(*) FROM public.file_link_sources) <> n THEN
    RAISE EXCEPTION '7.2: resync_all changed a projection the triggers had already converged';
  END IF;

  -- 7.3 no edge exists without a source
  SELECT count(*) INTO n FROM public.file_links l
   WHERE NOT EXISTS (SELECT 1 FROM public.file_link_sources s WHERE s.link_id=l.id);
  IF n <> 0 THEN RAISE EXCEPTION '7.3: % unproven edge(s) remain', n; END IF;

  -- 7.4 anomalies are still REPORTED, not swallowed: the dangling uuid and the
  --     raw url from the fixture must still surface in reconciliation
  SELECT coalesce(sum(value),0) INTO v FROM public.file_links_reconcile() WHERE category='anomaly';
  IF v < 1 THEN RAISE EXCEPTION '7.4: synchronisation silenced anomaly reporting'; END IF;

  RAISE NOTICE 'part 7 (final state): 4 assertions passed';
  RAISE NOTICE 'file-link SYNC smoke: all 122 assertions passed';
END $$;
