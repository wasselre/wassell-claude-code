-- Frozen `location` fields render fix.
--
-- The freeze field-type → column-type map (regenerate_frozen_model_artifacts /
-- freeze_apply_row) does NOT list `location`, so it fell through to the `text`
-- default. A text column stores the {country,region,city,district} object as a
-- JSON *string*, and the generated `<name>_v` view emitted it verbatim into
-- jsonb_build_object — i.e. as a jsonb STRING. The location cascade field
-- (LocationCascadeField) only accepts an object value, so it ignored the string
-- and showed the model's location_default (Riyadh) — the field never rendered a
-- stored district for any frozen model. Same class of bug as the 2026-08-09
-- multi_image/multi_video freeze fix.
--
-- Fix: emit try_jsonb(<col>) for location-type fields so `data.location` is a
-- real object. No table rewrite and no view-chain unwind — CREATE OR REPLACE
-- keeps market_listings_v's output shape (data jsonb) unchanged, so
-- unified_records and its downstream views are untouched. try_jsonb() returns
-- NULL on non-JSON input, so empty/malformed values just drop out via
-- jsonb_strip_nulls (same as before).
--
-- Applied to prod (wassell-prod) 2026-08-19; verified data.location is 'object'
-- for market_listings rows. This file is idempotent + CI-safe (guards on
-- to_regclass so it no-ops where the frozen model/view doesn't exist yet).

BEGIN;

-- Part 1 — durable: teach the frozen-artifact generator to parse location fields.
DO $mig$
DECLARE fn text; fn2 text;
BEGIN
  fn := pg_get_functiondef('public.regenerate_frozen_model_artifacts(uuid)'::regprocedure);
  IF position('ELSIF v_ftype = ''location''' in fn) > 0 THEN
    RAISE NOTICE 'generator already parses location — skipping';
  ELSE
    fn2 := replace(fn,
'    ELSE
      v_view_arr := array_append(v_view_arr, format(''%L, t.%I'', v_fname, v_fname));',
'    ELSIF v_ftype = ''location'' THEN
      v_view_arr := array_append(v_view_arr, format(''%L, public.try_jsonb(t.%I)'', v_fname, v_fname));
      v_data_arr := array_append(v_data_arr, format(''%L, %I::text'', v_fname, v_fname));
    ELSE
      v_view_arr := array_append(v_view_arr, format(''%L, t.%I'', v_fname, v_fname));');
    IF fn2 = fn THEN RAISE EXCEPTION 'regen: scalar ELSE anchor not found — aborting'; END IF;
    EXECUTE fn2;
  END IF;
END $mig$;

-- Part 2 — immediate: fix the live market_listings_v view in place (prod-only object;
-- absent on a fresh CI DB that hasn't frozen the model, so guard on to_regclass).
DO $mig$
DECLARE v text; v2 text;
BEGIN
  IF to_regclass('public.market_listings_v') IS NULL THEN
    RAISE NOTICE 'market_listings_v not present — skipping (fresh DB)';
    RETURN;
  END IF;
  v := pg_get_viewdef('public.market_listings_v'::regclass, true);
  IF position('try_jsonb(location)' in v) > 0 THEN
    RAISE NOTICE 'market_listings_v already parses location — skipping';
    RETURN;
  END IF;
  v2 := replace(v, '''location'', location,', '''location'', public.try_jsonb(location),');
  IF v2 = v THEN RAISE EXCEPTION 'view: location anchor not found — aborting'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.market_listings_v WITH (security_invoker=true) AS ' || v2;
END $mig$;

COMMIT;
