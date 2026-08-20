-- ============================================================================
-- Phase 3 · B6 smoke — the manual-link write surface.
--
-- Assertions are grouped by the thing that could go wrong, and each one names
-- the failure it is guarding against. Run by run_b6_manual_links_test.sh, which
-- also does the before/after comparisons this file cannot see.
--
-- NON-VACUITY FIRST — but note what KIND of non-vacuity this file needs, which
-- is not the same as B5's. Nothing here impersonates `authenticated`: the grant
-- checks are catalog reads (has_table_privilege answers for any role from any
-- session), the retarget refusal is a TRIGGER (which fires for the superuser
-- too), and the role assertions are plain function calls. So the usual "inside
-- a DO block the superuser bypasses RLS" hazard does not apply to these
-- assertions, and claiming it did would be a comment describing a guard that
-- is not there.
--
-- What CAN make this file vacuous is an empty fixture: with no manual link,
-- §2 and §3 silently test nothing at all. That is what §0 checks.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 0. Non-vacuity ─────────────────────────────────────────────────────────
DO $$
BEGIN
  -- The role must exist for the GRANT assertions in §1 to mean anything:
  -- has_table_privilege on a non-existent role raises, but a suite that never
  -- reached §1 would look green.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    RAISE EXCEPTION 'B6 smoke is VACUOUS: no `authenticated` role exists, so the grant assertions cannot run';
  END IF;
  -- The real vacuity risk: §2 and §3 both start by SELECTing one manual link.
  -- With none, they assert nothing and pass.
  IF (SELECT count(*) FROM public.document_links) = 0 THEN
    RAISE EXCEPTION 'B6 smoke is VACUOUS: no manual links in the fixture, so the retarget and role assertions test nothing';
  END IF;
  -- §4 compares two derivations; if the derivation is empty they are trivially
  -- equal and the comparison proves nothing.
  IF NOT EXISTS (SELECT 1 FROM public.file_link_live_sources()) THEN
    RAISE EXCEPTION 'B6 smoke is VACUOUS: the live-source derivation is empty, so global = scoped holds trivially';
  END IF;
END $$;

-- ── 1. The grant layer ─────────────────────────────────────────────────────
-- TRUNCATE is NOT subject to row-level security. The three per-row policies on
-- this table were never in that code path; what stopped an authenticated
-- caller from emptying it was PostgREST not emitting TRUNCATE — middleware,
-- not the database. If this assertion ever fails again, that second line of
-- defence is gone and only the middleware is holding.
DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.document_links', 'TRUNCATE') THEN
    RAISE EXCEPTION 'B6.1 FAILED: authenticated holds TRUNCATE on document_links — RLS does not mediate TRUNCATE, so every manual link is one statement from gone';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
     AND has_table_privilege('anon', 'public.document_links', 'SELECT') THEN
    RAISE EXCEPTION 'B6.1 FAILED: anon can still SELECT document_links';
  END IF;
  -- The three verbs the policies gate, plus the role-correction UPDATE, must
  -- all survive the revoke — over-revoking breaks linking entirely.
  IF NOT (has_table_privilege('authenticated', 'public.document_links', 'SELECT')
      AND has_table_privilege('authenticated', 'public.document_links', 'INSERT')
      AND has_table_privilege('authenticated', 'public.document_links', 'UPDATE')
      AND has_table_privilege('authenticated', 'public.document_links', 'DELETE')) THEN
    RAISE EXCEPTION 'B6.1 FAILED: the revoke was too broad — authenticated lost a verb the policies gate';
  END IF;
END $$;

-- ── 2. A link may be re-roled but never retargeted ─────────────────────────
-- Rewriting the triple in place would be invisible to Phase 2's convergence for
-- the OLD target: the trigger sees only the NEW triple, so the record the link
-- used to belong to would keep a stale edge until some unrelated write touched
-- it. The trigger makes that unreachable.
DO $$
DECLARE v_id uuid; v_file uuid; v_model uuid; v_rec uuid; v_other uuid; v_ok boolean := false;
BEGIN
  SELECT id, file_id, model_id, record_id INTO v_id, v_file, v_model, v_rec
    FROM public.document_links LIMIT 1;

  -- Re-roling is allowed.
  UPDATE public.document_links SET role = 'brochure' WHERE id = v_id;
  IF (SELECT role FROM public.document_links WHERE id = v_id) IS DISTINCT FROM 'brochure' THEN
    RAISE EXCEPTION 'B6.2 FAILED: a role correction did not stick';
  END IF;

  -- Retargeting is not.
  SELECT record_id INTO v_other FROM public.document_links
   WHERE record_id <> v_rec LIMIT 1;
  IF v_other IS NULL THEN v_other := gen_random_uuid(); END IF;
  BEGIN
    UPDATE public.document_links SET record_id = v_other WHERE id = v_id;
  EXCEPTION WHEN check_violation THEN
    v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'B6.2 FAILED: a link was retargeted in place — the old target keeps a stale edge that nothing will converge';
  END IF;

  -- created_by is history: the trigger pins it to OLD regardless of what the
  -- statement sets. Asserted, not merely commented — a comment describing a
  -- guard nobody checks is how the guard quietly disappears.
  DECLARE v_before uuid; v_after uuid;
  BEGIN
    SELECT created_by_user_id INTO v_before FROM public.document_links WHERE id = v_id;
    UPDATE public.document_links
       SET created_by_user_id = '00000000-0000-0000-0000-000000000000', role = NULL
     WHERE id = v_id;
    SELECT created_by_user_id INTO v_after FROM public.document_links WHERE id = v_id;
    IF v_after IS DISTINCT FROM v_before THEN
      RAISE EXCEPTION 'B6.2 FAILED: created_by_user_id was rewritten (% -> %) — who made a link is history', v_before, v_after;
    END IF;
  END;
END $$;

-- ── 3. The projection honours document_links.role ──────────────────────────
-- B1 added the column for "the document type asserted by the person who made
-- the manual link" and the derivation hardcoded past it, so it was write-only
-- until B6. A regression here makes the Attach picker's type selector a lie:
-- the row says brochure, the panel files it under supporting document.
DO $$
DECLARE v_file uuid; v_model uuid; v_rec uuid; v_role text;
BEGIN
  SELECT file_id, model_id, record_id INTO v_file, v_model, v_rec
    FROM public.document_links LIMIT 1;

  UPDATE public.document_links SET role = 'brochure'
   WHERE file_id = v_file AND model_id = v_model AND record_id = v_rec;
  SELECT role INTO v_role FROM public.file_link_live_sources()
   WHERE source_key = 'manual:'||v_file||':'||v_model||':'||v_rec;
  IF v_role IS DISTINCT FROM 'brochure' THEN
    RAISE EXCEPTION 'B6.3 FAILED: the global derivation ignores document_links.role (got %)', coalesce(v_role,'<null>');
  END IF;

  -- The scoped twin must agree. Phase 2 keeps TWO texts on purpose (an optional
  -- scope cannot be planned as an equality probe and measured 400x slower), and
  -- the ONLY thing keeping them honest is that they are asserted equal.
  SELECT role INTO v_role FROM public.file_link_live_sources_scoped(v_model, v_rec)
   WHERE source_key = 'manual:'||v_file||':'||v_model||':'||v_rec;
  IF v_role IS DISTINCT FROM 'brochure' THEN
    RAISE EXCEPTION 'B6.3 FAILED: the SCOPED twin ignores document_links.role (got %) — the two derivations have drifted apart', coalesce(v_role,'<null>');
  END IF;

  -- NULL still means supporting_document, which is what makes the change a
  -- no-op for every link that existed before it.
  UPDATE public.document_links SET role = NULL
   WHERE file_id = v_file AND model_id = v_model AND record_id = v_rec;
  SELECT role INTO v_role FROM public.file_link_live_sources()
   WHERE source_key = 'manual:'||v_file||':'||v_model||':'||v_rec;
  IF v_role IS DISTINCT FROM 'supporting_document' THEN
    RAISE EXCEPTION 'B6.3 FAILED: a NULL role no longer defaults to supporting_document (got %)', coalesce(v_role,'<null>');
  END IF;
END $$;

-- ── 4. Global still equals the union of scoped ─────────────────────────────
-- Phase 2's own invariant, re-asserted here because B6 edited both texts.
DO $$
DECLARE v_global text; v_scoped text;
BEGIN
  SELECT md5(string_agg(source_key||'|'||role, ',' ORDER BY source_key))
    INTO v_global FROM public.file_link_live_sources();

  SELECT md5(string_agg(s.source_key||'|'||s.role, ',' ORDER BY s.source_key))
    INTO v_scoped
    FROM (SELECT DISTINCT model_id, record_id FROM public.file_link_live_sources()) t,
         LATERAL public.file_link_live_sources_scoped(t.model_id, t.record_id) s;

  IF v_global IS DISTINCT FROM v_scoped THEN
    RAISE EXCEPTION 'B6.4 FAILED: global derivation <> union of scoped (% vs %)', v_global, v_scoped;
  END IF;
END $$;

SELECT 'B6 smoke: all assertions passed' AS result;
