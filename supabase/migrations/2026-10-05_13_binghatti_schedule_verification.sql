-- Enabling Binghatti is a final, evidence-backed step. This migration alone
-- does not enable weekly updates or daily captures.
BEGIN;
CREATE OR REPLACE FUNCTION public.project_update_enable_binghatti(
  p_first_dry uuid, p_live uuid, p_second_dry uuid, p_revert_test uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $function$
DECLARE
  v_first public.project_update_runs; v_live public.project_update_runs;
  v_second public.project_update_runs; v_revert public.project_update_runs;
  v_portal uuid; v_registered int; v_projects int;
BEGIN
  SELECT * INTO v_first FROM public.project_update_runs WHERE id=p_first_dry;
  SELECT * INTO v_live FROM public.project_update_runs WHERE id=p_live;
  SELECT * INTO v_second FROM public.project_update_runs WHERE id=p_second_dry;
  SELECT * INTO v_revert FROM public.project_update_runs WHERE id=p_revert_test;
  IF v_first.id IS NULL OR v_live.id IS NULL OR v_second.id IS NULL OR v_revert.id IS NULL
    OR v_first.source_type<>'binghatti_broker' OR v_live.source_type<>'binghatti_broker'
    OR v_second.source_type<>'binghatti_broker' OR v_revert.source_type<>'binghatti_broker'
    OR NOT v_first.dry_run OR v_live.dry_run OR NOT v_second.dry_run
    OR v_first.status<>'done' OR v_live.status<>'done' OR v_second.status<>'done'
    OR v_live.outcome NOT IN ('applied','no_change')
    OR v_first.finished_at>v_live.created_at OR v_live.finished_at>v_second.created_at THEN
    RAISE EXCEPTION 'Binghatti requires completed first dry, live and second dry runs in that order' USING ERRCODE='WS422';
  END IF;
  IF COALESCE((v_first.summary->>'failed')::int,-1)<>0
    OR COALESCE((v_live.summary->>'failed')::int,-1)<>0
    OR COALESCE((v_live.summary->>'held')::int,-1)<>0
    OR COALESCE((v_second.summary->>'failed')::int,-1)<>0
    OR COALESCE((v_second.summary->>'held')::int,-1)<>0
    OR COALESCE((v_second.summary->>'total_changes')::int,-1)<>0
    OR v_first.summary->'area_validation'->>'complete' IS DISTINCT FROM 'true'
    OR v_live.summary->'area_validation'->>'complete' IS DISTINCT FROM 'true'
    OR v_second.summary->'area_validation'->>'complete' IS DISTINCT FROM 'true'
    OR v_second.summary->'mapping'->>'held' IS DISTINCT FROM 'false'
    OR v_second.summary->'snapshot'->>'complete' IS DISTINCT FROM 'true'
    OR COALESCE((v_second.summary->'snapshot'->>'totalCount')::int,0)<=0
    OR COALESCE((v_second.summary->'snapshot'->>'saved_at')::timestamptz,'epoch')<now()-interval '36 hours'
    OR (v_second.summary->'snapshot'->>'saved_at')::timestamptz>now()
    OR jsonb_array_length(COALESCE(v_second.summary->'unmapped_crm_projects','[null]'::jsonb))<>0 THEN
    RAISE EXCEPTION 'Binghatti verification is incomplete, held, stale or not idempotent' USING ERRCODE='WS422';
  END IF;
  IF v_revert.reverted_at IS NULL OR v_revert.reverted_at>v_second.created_at
    OR NOT EXISTS(SELECT 1 FROM public.project_update_changes WHERE run_id=p_revert_test
      AND model='units' AND reverted_at IS NOT NULL AND revert_note='reverted') THEN
    RAISE EXCEPTION 'Binghatti requires a successful real-unit revert proof before the second dry run' USING ERRCODE='WS422';
  END IF;
  SELECT count(*) INTO v_projects FROM public.records
    WHERE model_id='220c49b9-de57-492d-9eca-c0d9f54fd40f' AND data->>'developer'='759fa833-e60e-4775-86ab-292005c8d517';
  SELECT count(DISTINCT data->>'project') INTO v_registered FROM public.records
    WHERE model_id='aa10c001-2026-4824-9000-000000000001' AND data->>'source_type'='binghatti_broker'
      AND data->>'is_active'='true' AND COALESCE(data->>'auto_scope','full')='full';
  IF v_registered<>v_projects OR v_projects=0
    OR COALESCE((v_second.summary->>'registered')::int,-1)<>v_projects
    OR v_second.params ? 'registry_ids' THEN
    RAISE EXCEPTION 'Binghatti verification must cover every CRM project' USING ERRCODE='WS422';
  END IF;
  v_portal:=(v_second.summary->'snapshot'->>'portal_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.records WHERE id=v_portal
    AND model_id='1ead0000-0000-4000-8000-000000000001'
    AND data->>'developer'='759fa833-e60e-4775-86ab-292005c8d517'
    AND data->>'browserbase_persist_context'='true' AND NULLIF(data->>'browserbase_context_id','') IS NOT NULL) THEN
    RAISE EXCEPTION 'Binghatti persistent broker login has not been verified' USING ERRCODE='WS422';
  END IF;
  UPDATE public.records SET data=data||'{"status_sync_enabled":true,"inventory_capture_enabled":true}'::jsonb WHERE id=v_portal;
  UPDATE public.project_update_settings
    SET scheduled_sources=CASE WHEN 'binghatti_broker'=ANY(scheduled_sources) THEN scheduled_sources
      ELSE array_append(scheduled_sources,'binghatti_broker') END, updated_at=now() WHERE id=1;
  RETURN jsonb_build_object('enabled',true,'projects',v_projects,'portal_id',v_portal);
END $function$;
REVOKE ALL ON FUNCTION public.project_update_enable_binghatti(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.project_update_enable_binghatti(uuid,uuid,uuid,uuid) TO service_role;
COMMIT;
