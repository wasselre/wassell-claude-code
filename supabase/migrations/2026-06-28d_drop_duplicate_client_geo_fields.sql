-- ============================================================================
-- Drop the duplicate client geography fields (2026-06-28d)
--
-- A parallel session re-introduced `preferred_cities` / `preferred_districts`
-- lookup fields on the clients model around the same time as the geography
-- cutover, duplicating the consolidated `location` cascade. They are NOT read by
-- the matcher / assistant (those read `data.location`); only the workspace
-- preferences box listed them. Their data is fully contained in `location`
-- (verified: every preferred_cities id is already in location.city; no
-- preferred_districts data exists). Remove the fields + strip the redundant keys.
-- ============================================================================
BEGIN;

DROP TABLE IF EXISTS public._backup_clients_prefdup_20260628;
CREATE TABLE public._backup_clients_prefdup_20260628 AS
  SELECT * FROM public.records WHERE model_id='2e86f197-385f-4853-908f-b4cb7237f7d8'
    AND (data ? 'preferred_cities' OR data ? 'preferred_districts');

UPDATE public.models m SET schema = jsonb_set(m.schema, '{sections}', (
  SELECT jsonb_agg(jsonb_set(sec, '{fields}', COALESCE((
    SELECT jsonb_agg(f) FROM jsonb_array_elements(sec->'fields') f WHERE (f->>'name') NOT IN ('preferred_cities','preferred_districts')), '[]'::jsonb)))
  FROM jsonb_array_elements(m.schema->'sections') sec))
WHERE m.name='clients';

UPDATE public.records SET data = data - 'preferred_cities' - 'preferred_districts'
WHERE model_id='2e86f197-385f-4853-908f-b4cb7237f7d8' AND (data ? 'preferred_cities' OR data ? 'preferred_districts');

COMMIT;
