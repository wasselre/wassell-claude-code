-- ============================================================================
-- Remove the seven legacy preference fields from the clients form (2026-09-27)
-- ============================================================================
-- Follows 2026-09-27_03 (values moved to Client Options / location /
-- location_items / preference_notes; backup _backup_clients_legacy_prefs_20260927)
-- and the app change that switched every reader to those homes.
--
-- Removes the FIELDS from models.schema only. The keys stay in records.data
-- (nothing reads them; the backup holds them anyway) so no client row is
-- rewritten and no open form meets a version bump.
-- `clients` is unfrozen (is_hardcoded=false): the schema edit is the whole job;
-- the models_view_sync trigger regenerates v_clients.
-- Checked 2026-09-27: no workflow, dashboard or profile references these slugs.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_models_clients_schema_20260927 AS
SELECT id, name, schema, now() AS backed_up_at FROM public.models WHERE name = 'clients';
REVOKE ALL ON public._backup_models_clients_schema_20260927 FROM anon, authenticated;

UPDATE public.models m
SET schema = jsonb_set(
  m.schema, '{sections}',
  (SELECT jsonb_agg(
            s || jsonb_build_object('fields',
              COALESCE((SELECT jsonb_agg(f ORDER BY ord)
                        FROM jsonb_array_elements(s->'fields') WITH ORDINALITY AS x(f, ord)
                        WHERE NOT (f->>'name' = ANY (ARRAY[
                          'preferred_projects','preferred_units','preferred_market_listings',
                          'preferred_city','preferred_neighborhoods','preferred_direction','preferred_country']))),
                       '[]'::jsonb))
            ORDER BY sord)
   FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS y(s, sord)))
WHERE m.name = 'clients';

DO $assert$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left
  FROM public.models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
  WHERE m.name = 'clients' AND f->>'name' = ANY (ARRAY[
    'preferred_projects','preferred_units','preferred_market_listings',
    'preferred_city','preferred_neighborhoods','preferred_direction','preferred_country']);
  IF v_left <> 0 THEN RAISE EXCEPTION 'LEGACY_FIELDS_STILL_PRESENT %', v_left; END IF;
END $assert$;

COMMIT;
