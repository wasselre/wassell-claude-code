-- ============================================================================
-- NEGATIVE CONTROL — branch 1 without the existence join.
--
-- B2A.6's branch 1 concludes "this model is unrestricted, so the caller may see
-- this record" and therefore only still needs to know the record EXISTS. Drop
-- that join and every ORPHAN edge — a link whose record was deleted — starts
-- leaking its file id.
--
-- Production carries exactly 24 such edges and the fixture reproduces them, so
-- this MUST widen. If it does not, the existence check is untested and the
-- "reduce it to a model-visibility test" shortcut would look safe.
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
    SELECT s.model_id FROM public.wassell_my_view_scope_all_models() s WHERE s.model_id IS NOT NULL)
  SELECT l.file_id FROM public.file_links l
   WHERE l.model_id IN (SELECT model_id FROM allm)          -- <-- existence join removed
  UNION
  SELECT l.file_id FROM public.file_links l
    JOIN public.records r ON r.id = l.record_id AND r.model_id = l.model_id
   WHERE l.model_id NOT IN (SELECT model_id FROM allm)
     AND public.wassell_can_view_record(v_auth, r.*);
END;
$fn$;
