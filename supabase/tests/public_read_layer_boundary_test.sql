-- ============================================================================
-- Boundary test for the public read layer (W1). Proves the allowlisted RPCs
-- NEVER surface an internal / source / audit key, over live public projects.
--
-- Runnable against prod (Supabase SQL editor / MCP). Self-skips on an ephemeral
-- CI DB that has no all_projects model (guarded by _pub_model_id IS NULL), so it
-- never fails the fixture-only CI job. Each assertion RAISEs on failure.
-- ============================================================================
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_ap uuid := public._pub_model_id('all_projects');
  v_id uuid;
  v_payload text;
  v_bad text;
  v_forbidden text[] := ARRAY[
    'internal_sales_notes','objection_handling_notes','source_notes','ai_audit_notes',
    'data_sources','missing_required_fields','geo_confidence','geo_source',
    'source_fx_rate','source_file','source_synced_at','developer_unit_code',
    'data_confidence_score','project_targt_status','sales_priority','exclusive_status'
  ];
  k text;
  v_scanned int := 0;
BEGIN
  IF v_ap IS NULL THEN
    RAISE NOTICE 'public_read_layer_boundary_test: no all_projects model (CI fixture DB) — skipping';
    RETURN;
  END IF;

  FOR v_id IN
    SELECT id FROM public.records
    WHERE model_id = v_ap AND COALESCE((data->>'is_public')::boolean,false) = true
  LOOP
    v_scanned := v_scanned + 1;

    -- project DTO, both languages
    v_payload := COALESCE(public.get_public_project(v_id,'ar')::text,'')
              || COALESCE(public.get_public_project(v_id,'en')::text,'');
    -- units DTO (first two pages) + summary
    v_payload := v_payload
              || COALESCE(public.get_public_project_units(v_id,60,0,'ar','{}'::jsonb)::text,'')
              || COALESCE(public.get_public_project_units(v_id,60,60,'en','{}'::jsonb)::text,'')
              || COALESCE(public.get_public_project_unit_summary(v_id)::text,'');

    FOREACH k IN ARRAY v_forbidden LOOP
      IF position(k IN v_payload) > 0 THEN
        RAISE EXCEPTION 'BOUNDARY FAIL: forbidden key "%" leaked in public payload for project %', k, v_id;
      END IF;
    END LOOP;
  END LOOP;

  -- listing + points + site settings must also be clean
  v_payload := COALESCE(public.list_public_projects('ar')::text,'')
            || COALESCE(public.list_public_projects('en')::text,'')
            || COALESCE(public.list_public_project_points('ar')::text,'')
            || COALESCE(public.get_public_site_settings()::text,'');
  FOREACH k IN ARRAY v_forbidden LOOP
    IF position(k IN v_payload) > 0 THEN
      RAISE EXCEPTION 'BOUNDARY FAIL: forbidden key "%" leaked in listing/points/site-settings', k;
    END IF;
  END LOOP;

  RAISE NOTICE 'public_read_layer_boundary_test: OK — % public projects scanned, no forbidden keys', v_scanned;
END $$;

-- Geography assertion: the two Dubai reference projects resolve to UAE, never Saudi.
DO $$
DECLARE
  v jsonb;
BEGIN
  IF public._pub_model_id('all_projects') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.records WHERE id='4f3a08d5-8791-4712-8dc6-f43f3ec020a1') THEN
    v := public.get_public_project('4f3a08d5-8791-4712-8dc6-f43f3ec020a1','en');
    IF (v->'location'->>'country_code') <> 'AE' THEN
      RAISE EXCEPTION 'GEO FAIL: Dubai project country_code = % (expected AE)', v->'location'->>'country_code';
    END IF;
    IF (v->'location'->>'country') = 'Saudi Arabia' THEN
      RAISE EXCEPTION 'GEO FAIL: Dubai project country fabricated as Saudi Arabia';
    END IF;
    RAISE NOTICE 'geo assertion: OK — Dubai project resolves to %', v->'location'->>'country';
  END IF;
END $$;
