-- ════════════════════════════════════════════════════════════════════
-- refresh_frozen_model_artifacts(model_id) — safe wrapper for re-regenerating
-- a frozen model's artifacts AFTER it is already part of unified_records.
-- ════════════════════════════════════════════════════════════════════
-- WHY: regenerate_frozen_model_artifacts() does `DROP VIEW <name>_v`, but once
-- the model is in unified_records that view depends on <name>_v, so a standalone
-- regen fails with `2BP01: cannot drop view ... because other objects depend`.
-- This surfaced in the Phase 1 pilot (2026-06-25) on an overflow-field add — it
-- had never fired in prod because no model had ever been frozen + re-regenerated.
--
-- This wrapper performs the ONLY correct refresh sequence, transactionally:
--   advisory-lock → DROP unified_records → regenerate → rebuild unified_records.
-- The DROP releases the dependency so regenerate can recreate <name>_v; rebuild
-- re-creates unified_records (and re-GRANTs SELECT). On any failure the whole
-- function rolls back as one transaction, restoring unified_records intact.
--
-- This is the official path the future Builder `models_frozen_artifacts_sync`
-- trigger (and any hand-written frozen-model schema migration) must call instead
-- of bare regenerate_frozen_model_artifacts(). The CLAUDE.md frozen-migration
-- template's "call regen then rebuild" is INCORRECT for a re-regen — use this.
--
-- Not yet applied to a real model: no business model is frozen. Tested in the
-- Phase 1 pilot via the synthetic sandbox canary. See docs/model-migration-phase1-pilot-report.md.
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.refresh_frozen_model_artifacts(p_model_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_model record;
  v_table text;
BEGIN
  SELECT id, name, is_hardcoded INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refresh_frozen_model_artifacts: model % not found', p_model_id;
  END IF;
  IF NOT v_model.is_hardcoded THEN
    RAISE EXCEPTION 'refresh_frozen_model_artifacts: model "%" is not frozen (is_hardcoded=false) — nothing to refresh', v_model.name;
  END IF;
  v_table := public.freeze_safe_ident(v_model.name);

  -- Serialize against concurrent unified_records rebuilds (same lock key
  -- rebuild_unified_records uses; xact-level + re-entrant within this session).
  PERFORM pg_advisory_xact_lock(hashtext('rebuild_unified_records'));

  -- Release the unified_records -> <name>_v dependency, regenerate the _v view +
  -- RLS policies, then rebuild the UNION. regenerate_* and rebuild_* re-GRANT
  -- their own SELECT privileges, so grants are preserved automatically.
  EXECUTE 'DROP VIEW IF EXISTS public.unified_records';
  PERFORM public.regenerate_frozen_model_artifacts(p_model_id);
  PERFORM public.rebuild_unified_records();

  RETURN jsonb_build_object(
    'model_id',     p_model_id,
    'table_name',   v_table,
    'view_name',    v_table || '_v',
    'refreshed_at', now(),
    'success',      true
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.refresh_frozen_model_artifacts(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refresh_frozen_model_artifacts(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.refresh_frozen_model_artifacts(uuid) TO authenticated, service_role;
