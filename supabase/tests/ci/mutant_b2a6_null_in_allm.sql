-- ============================================================================
-- NEGATIVE CONTROL — a NULL reaches the hoisted model set.
--
-- Branch 2 selects links whose model is NOT IN the set. SQL's NOT IN returns
-- NULL, not TRUE, as soon as the set contains a NULL — so branch 2 silently
-- yields NOTHING and the caller loses every link that needed a per-row check.
-- This is a NARROWING, and it is the one failure mode `WHERE s.model_id IS NOT
-- NULL` in the migration exists to make impossible.
--
-- The real classifier cannot emit NULL today, so this mutant injects one, which
-- is the point: it demonstrates the hazard the guard is defending against
-- rather than the current behaviour. It MUST change the result — for the
-- personas whose visibility depends on the residue branch.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.wassell_my_record_derived_file_ids()
RETURNS TABLE (file_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $fn$
DECLARE
  v_auth        uuid := (SELECT auth.uid());
  v_link_models uuid[];
BEGIN
  IF NOT public.wassell_file_derived_access_enabled() THEN RETURN; END IF;
  IF public.wassell_app_user_id(v_auth) IS NULL THEN RETURN; END IF;
  SELECT array_agg(DISTINCT l.model_id) INTO v_link_models FROM public.file_links l;
  IF v_link_models IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(v_link_models) m(mid)
                  WHERE public.wassell_user_has_action(v_auth, m.mid, 'view')) THEN RETURN; END IF;
  RETURN QUERY
  WITH allm AS MATERIALIZED (
    SELECT s.model_id FROM public.wassell_my_view_scope_all_models() s   -- IS NOT NULL guard removed
    UNION ALL SELECT NULL::uuid)                                          -- and a NULL injected
  SELECT l.file_id FROM public.file_links l
    JOIN public.records r ON r.id = l.record_id AND r.model_id = l.model_id
   WHERE l.model_id IN (SELECT model_id FROM allm)
  UNION
  SELECT l.file_id FROM public.file_links l
    JOIN public.records r ON r.id = l.record_id AND r.model_id = l.model_id
   WHERE l.model_id NOT IN (SELECT model_id FROM allm)
     AND public.wassell_can_view_record(v_auth, r.*);
END;
$fn$;
