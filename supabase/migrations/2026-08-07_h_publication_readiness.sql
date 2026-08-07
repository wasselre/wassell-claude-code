-- ============================================================================
-- Public project pages redesign — W8: publication readiness (NO video).
--
-- Computes a per-project readiness checklist from its own facts. Used to (a)
-- surface readiness failures for CURRENT public projects WITHOUT unpublishing
-- them, and (b) gate FUTURE publication. Video is intentionally excluded from
-- readiness entirely.
--
-- Checks (all factual, no AI):
--   identity   — project_name AND developer present
--   location   — resolvable district/city AND usable coordinates
--   images     — a customer-shareable image (main_image or project_images[])
--   brochure   — Wassel brochure_link OR developer brochure
--   inventory  — at least one linked unit (unit_count > 0)
--   pricing    — reliable available pricing (available_price_range) OR an
--                intentional no-price state (sold-out / upcoming), so a
--                sold-out project is READY with no stale price.
--
-- `ready` = every check passes. SECURITY DEFINER so it sees all units/geo
-- regardless of the caller's RLS; granted to authenticated (CRM surfaces it).
-- Additive; changes no data; never unpublishes anything.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.project_publication_readiness(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  d jsonb;
  v_geo jsonb;
  v_has_coords boolean;
  v_has_images boolean;
  v_has_brochure boolean;
  v_unit_count numeric;
  v_has_price boolean;
  v_nostock_state boolean;
  v_status text;
  chk jsonb := '[]'::jsonb;
  v_ready boolean;
BEGIN
  SELECT data INTO d FROM public.records
   WHERE id = p_id AND model_id = public._pub_model_id('all_projects');
  IF d IS NULL THEN RETURN NULL; END IF;

  v_geo := public._pub_geo(d->'location', 'en');
  v_has_coords := public.try_numeric(d->>'latitude') IS NOT NULL
              AND public.try_numeric(d->>'longitude') IS NOT NULL;
  v_has_images := NULLIF(btrim(d->>'main_image'),'') IS NOT NULL
              OR (jsonb_typeof(d->'project_images')='array' AND jsonb_array_length(d->'project_images')>0);
  v_has_brochure := NULLIF(btrim(d->>'brochure_link'),'') IS NOT NULL
                 OR NULLIF(btrim(d->>'broucher_developer'),'') IS NOT NULL;
  v_unit_count := COALESCE(public.try_numeric(d->>'unit_count'), 0);
  v_has_price := public._pub_range(d->'available_price_range') IS NOT NULL;
  v_status := lower(coalesce(d->>'project_status',''));
  -- Intentional no-price states: sold out (no available units) or upcoming.
  v_nostock_state := COALESCE(public.try_numeric(d->>'available_units'),0) = 0
                  OR v_status ~ '(sold|مباع|upcoming|قادم|قريب|soon)';

  chk := jsonb_build_array(
    jsonb_build_object('key','identity','ok',
      (NULLIF(btrim(d->>'project_name'),'') IS NOT NULL AND NULLIF(btrim(d->>'developer'),'') IS NOT NULL)),
    jsonb_build_object('key','location','ok',
      ((v_geo->>'district' IS NOT NULL OR v_geo->>'city' IS NOT NULL) AND v_has_coords)),
    jsonb_build_object('key','images','ok', v_has_images),
    jsonb_build_object('key','brochure','ok', v_has_brochure),
    jsonb_build_object('key','inventory','ok', v_unit_count > 0),
    jsonb_build_object('key','pricing','ok', (v_has_price OR v_nostock_state))
  );

  SELECT bool_and((c->>'ok')::boolean) INTO v_ready FROM jsonb_array_elements(chk) c;

  RETURN jsonb_build_object(
    'id', p_id,
    'is_public', COALESCE((d->>'is_public')::boolean,false),
    'ready', v_ready,
    'checks', chk,
    'missing', (SELECT COALESCE(jsonb_agg(c->>'key'),'[]'::jsonb) FROM jsonb_array_elements(chk) c WHERE (c->>'ok')::boolean = false)
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.project_publication_readiness(uuid) TO authenticated;
