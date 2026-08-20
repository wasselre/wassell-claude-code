-- Fix: source_field_catalog has CHECK (jsonb_array_length(example_values) <= 10),
-- but source_field_catalog_observe capped at 15 → every run failed with 23514 and
-- saved NO examples. Cap at 10 (both the incoming batch and the merged union).
-- Applied to prod (wassell-prod) 2026-08-19.
CREATE OR REPLACE FUNCTION public.source_field_catalog_observe(p_platform text, p_observations jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n int := 0; v_obs jsonb; v_path text;
BEGIN
  FOR v_obs IN SELECT value FROM jsonb_array_elements(p_observations) LOOP
    v_path := v_obs->>'source_path';
    CONTINUE WHEN v_path IS NULL OR v_path = '';
    INSERT INTO public.source_field_catalog AS c
      (id, platform, adapter_id, contract_version, source_path, raw_data_type,
       example_values, occurrence_count, first_seen, last_seen)
    VALUES (gen_random_uuid(), p_platform, 'market-ingest/adapters/'||p_platform, 'v001', v_path,
            nullif(v_obs->>'raw_data_type',''),
            (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM (
               SELECT e FROM jsonb_array_elements(coalesce(v_obs->'examples','[]'::jsonb)) AS e LIMIT 10
             ) capped0),
            coalesce((v_obs->>'count')::bigint, 1), now(), now())
    ON CONFLICT (platform, source_path, contract_version) DO UPDATE SET
      raw_data_type = coalesce(nullif(EXCLUDED.raw_data_type,''), c.raw_data_type),
      example_values = (
        SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM (
          SELECT e FROM (
            SELECT jsonb_array_elements(coalesce(c.example_values, '[]'::jsonb)) AS e
            UNION
            SELECT jsonb_array_elements(coalesce(EXCLUDED.example_values, '[]'::jsonb)) AS e
          ) u LIMIT 10
        ) capped
      ),
      occurrence_count = coalesce(c.occurrence_count, 0) + coalesce(EXCLUDED.occurrence_count, 1),
      last_seen = now();
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;
