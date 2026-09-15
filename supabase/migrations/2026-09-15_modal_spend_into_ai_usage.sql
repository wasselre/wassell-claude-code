-- ============================================================================
-- Modal spend reaches the central ledger  (2026-09-15)
--
-- BUG THIS FIXES: the 2026-09-14 metering work instrumented the TypeScript
-- helper `addCost()` in worker/src/marketing/cv/ledger.ts to mirror cv_process
-- rows into `ai_usage`. That code can never run. `addCost()` is only ever
-- called for the three Claude kinds (shot_analyze, frame_describe,
-- describe_on_demand); the MODAL cost is recorded entirely inside Postgres —
-- `mkt_cv_finalize_video` calls `mkt_cv_cost_add` directly, never touching
-- TypeScript.
--
-- So the single largest line in the AI bill ($53-58, every dollar of Modal
-- spend to date) would have been absent from `ai_usage` while the code looked
-- like it was covered. Recording it here, at the real choke point, is the fix.
--
-- WHY ONLY provider='modal': the Claude kinds reach the provider through
-- `callRole()`, which already writes its own `ai_usage` row. Mirroring them
-- here too would double-count them. Modal is the one provider whose cost
-- arrives only through this function.
--
-- WHAT THE NUMBER MEANS — read before trusting it: `p_cost` is NOT Modal's
-- invoice. It is computed by our own service from a hardcoded rate table in
-- `infra/modal/video-cv/app.py` (`RATES`), as
-- `elapsed_seconds x (gpu + cpu + memory rate)` plus an OCR estimate. It is a
-- good estimate and the best figure available at write time, but it drifts from
-- the real bill if Modal changes prices, if the container spec changes, or for
-- anything Modal charges that the formula omits (volume storage, cold starts
-- billed differently). `meta.cost_source` records this so nobody later mistakes
-- it for a vendor-reported figure.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.mkt_cv_cost_add(
  p_kind text,
  p_video_id uuid,
  p_role text,
  p_provider text,
  p_model text,
  p_cost numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Unchanged: the CV-local ledger and the per-video rollup.
  INSERT INTO public.mkt_cv_cost_ledger (kind, video_id, role, provider, model, cost_usd)
  VALUES (p_kind, p_video_id, p_role, p_provider, p_model, COALESCE(p_cost, 0));

  UPDATE public.mkt_cv_videos
     SET cost_usd = cost_usd + COALESCE(p_cost, 0), updated_at = now()
   WHERE id = p_video_id;

  -- New: mirror MODAL spend into the central ledger. Claude kinds are excluded
  -- because callRole() already records them — see the header.
  IF p_provider = 'modal' THEN
    INSERT INTO public.ai_usage (
      area, call_site, operation, provider, model, status,
      cost_usd, cost_known, entity_kind, entity_id, meta
    )
    VALUES (
      'competitors',
      'worker/cv/' || COALESCE(p_kind, 'unknown'),
      p_role,
      'modal',
      COALESCE(NULLIF(p_model, ''), 'modal-gpu'),
      'ok',
      COALESCE(p_cost, 0),
      -- Known, because we have a figure — but see cost_source below for what
      -- kind of figure it is.
      true,
      'mkt_cv_video',
      p_video_id::text,
      jsonb_build_object(
        'cost_source', 'modal manifest estimate (infra/modal/video-cv/app.py RATES), not a vendor invoice',
        'cv_kind', p_kind)
    );
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.mkt_cv_cost_add IS
  'Records one CV cost to mkt_cv_cost_ledger + the video rollup, and mirrors MODAL spend into ai_usage. Claude kinds are deliberately NOT mirrored — callRole() already records those.';
