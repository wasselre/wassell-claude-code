-- ============================================================================
-- Persist the all_projects unit rollups (was: live-computed at render time).
--
-- The eleven aggregate fields on all_projects (unit_count, available/sold/
-- reserved counts, price/area/bedroom/bathroom ranges, min/max/avg price per
-- m²) USED to be virtual: never stored, recomputed in JS at every render by
-- src/lib/ourProjectsRollup.ts, and STRIPPED before persist. That made the UI
-- correct but the database blind — SQL views, frozen models, BI, dashboards,
-- and the server-side AI sales agent all read records.data and saw null.
--
-- This migration converts them to STORED aggregates maintained by automation:
--   • A SECURITY DEFINER function recomputes the patch from a project's units.
--   • A BEFORE INSERT/UPDATE trigger on the all_projects rows fills the patch
--     inline on EVERY write — so the values can never be wiped by a user edit
--     (record_save overwrites data; the trigger re-fills it) and exist for
--     every reader of records.data.
--   • An AFTER INSERT/UPDATE/DELETE trigger on the units rows "touches" the
--     linked project(s) so a unit change recomputes them — including the
--     unit-moved-between-projects case (recompute BOTH old and new project).
--   • The schema flags are renamed is_computed → is_rollup, computed_kind →
--     rollup_kind, + read_only:true (the app dual-reads both during rollout).
--
-- All three models (units / all_projects / our_projects) are UNFROZEN JSONB in
-- `records`, so there is NO DDL on physical tables — everything is JSONB.
--
-- Idempotent. Safe to re-run. The SQL aggregation MIRRORS the JS semantics
-- exactly (bilingual unit_status matching, string→number coercion via
-- try_numeric, skip unit_area<=0 for price/m², range stored as {min,max}).
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────
-- STAGE 1 — pure functions (no triggers, no data change, invisible to app).
--           Apply first and dry-run recalc_project_rollups_data() to confirm
--           parity with the live UI before installing triggers / backfilling.
-- ────────────────────────────────────────────────────────────────────────

-- Model-id lookups (tiny `models` table → effectively free). STABLE so a
-- single statement caches them; SECURITY DEFINER so trigger contexts can read
-- `models` regardless of the invoking user's RLS.
CREATE OR REPLACE FUNCTION public._rollups_all_projects_model_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT id FROM public.models WHERE name = 'all_projects' LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public._rollups_units_model_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT id FROM public.models WHERE name = 'units' LIMIT 1;
$fn$;

-- Bilingual, case-insensitive substring status match — mirrors matchesStatus()
-- in src/lib/ourProjectsRollup.ts. needle kinds: 'available' / 'reserved' / 'sold'.
CREATE OR REPLACE FUNCTION public._rollup_status_is(v text, kind text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  WITH s AS (SELECT lower(btrim(coalesce(v, ''))) AS x),
       n AS (
         SELECT unnest(CASE kind
           WHEN 'available' THEN ARRAY['available','متاح','متاحة']
           WHEN 'reserved'  THEN ARRAY['reserved','محجوز','محجوزة']
           WHEN 'sold'      THEN ARRAY['sold','مباع','مباعة','مبيع']
           ELSE ARRAY[]::text[] END) AS ndl
       )
  SELECT EXISTS (
    SELECT 1 FROM s, n
    WHERE s.x <> '' AND (s.x = n.ndl OR position(n.ndl IN s.x) > 0)
  );
$fn$;

-- Range shape: {min,max} when at least one bound exists, JSON null otherwise
-- (matches rangeOf() returning null only when there is no source data).
CREATE OR REPLACE FUNCTION public._rollup_range(a numeric, b numeric)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN a IS NULL AND b IS NULL
              THEN 'null'::jsonb
              ELSE jsonb_build_object('min', a, 'max', b) END;
$fn$;

-- Extract a unit's linked project id (scalar lookup, or first element of a
-- multi-lookup array). Empty string → NULL.
CREATE OR REPLACE FUNCTION public._rollup_project_id_of(d jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN d IS NULL THEN NULL
    WHEN jsonb_typeof(d->'project_id') = 'array' THEN nullif(d->'project_id'->>0, '')
    ELSE nullif(d->>'project_id', '')
  END;
$fn$;

-- Compute the full rollup patch for one project from its units. Returns a
-- jsonb object keyed by each rollup field's slug. SECURITY DEFINER so it
-- counts ALL units irrespective of the caller's RLS (else a unit-creator with
-- no edit rights on the project would under-count it). Honors BOTH is_rollup
-- (post-rename) and is_computed (pre-rename) so it is correct during rollout.
CREATE OR REPLACE FUNCTION public.recalc_project_rollups_data(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_units uuid := public._rollups_units_model_id();
  v_proj  uuid := public._rollups_all_projects_model_id();
  v_pid   text := p_project_id::text;
  a       record;
  v_schema jsonb;
  f       jsonb;
  v_patch jsonb := '{}'::jsonb;
BEGIN
  IF v_units IS NULL OR v_proj IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  -- One pass over the project's units → every aggregate the eleven kinds need.
  SELECT
    count(*)                                                                              AS n,
    count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))  AS n_avail,
    count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','sold'))        AS n_sold,
    count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','reserved'))    AS n_res,
    min(public.try_numeric(u.data->>'total_price'))                                        AS price_min,
    max(public.try_numeric(u.data->>'total_price'))                                        AS price_max,
    min(public.try_numeric(u.data->>'unit_area'))                                          AS area_min,
    max(public.try_numeric(u.data->>'unit_area'))                                          AS area_max,
    min(public.try_numeric(u.data->>'bedrooms'))                                           AS bed_min,
    max(public.try_numeric(u.data->>'bedrooms'))                                           AS bed_max,
    min(public.try_numeric(u.data->>'bathrooms'))                                          AS bath_min,
    max(public.try_numeric(u.data->>'bathrooms'))                                          AS bath_max,
    min(public.try_numeric(u.data->>'total_price') / nullif(public.try_numeric(u.data->>'unit_area'), 0))
      FILTER (WHERE public.try_numeric(u.data->>'unit_area') > 0
                AND public.try_numeric(u.data->>'total_price') IS NOT NULL)                AS ppm_min,
    max(public.try_numeric(u.data->>'total_price') / nullif(public.try_numeric(u.data->>'unit_area'), 0))
      FILTER (WHERE public.try_numeric(u.data->>'unit_area') > 0
                AND public.try_numeric(u.data->>'total_price') IS NOT NULL)                AS ppm_max,
    avg(public.try_numeric(u.data->>'total_price') / nullif(public.try_numeric(u.data->>'unit_area'), 0))
      FILTER (WHERE public.try_numeric(u.data->>'unit_area') > 0
                AND public.try_numeric(u.data->>'total_price') IS NOT NULL)                AS ppm_avg
  INTO a
  FROM public.records u
  WHERE u.model_id = v_units
    AND (
      u.data->>'project_id' = v_pid
      OR (jsonb_typeof(u.data->'project_id') = 'array' AND u.data->'project_id' ? v_pid)
    );

  SELECT schema INTO v_schema FROM public.models WHERE id = v_proj;

  FOR f IN
    SELECT fld
    FROM jsonb_array_elements(v_schema->'sections') sec,
         jsonb_array_elements(sec->'fields') fld
    WHERE (fld->>'is_rollup')::boolean IS TRUE
       OR (fld->>'is_computed')::boolean IS TRUE
  LOOP
    v_patch := v_patch || jsonb_build_object(
      f->>'name',
      CASE COALESCE(f->>'rollup_kind', f->>'computed_kind')
        WHEN 'units_count'           THEN to_jsonb(COALESCE(a.n, 0))
        WHEN 'units_available_count' THEN to_jsonb(COALESCE(a.n_avail, 0))
        WHEN 'units_sold_count'      THEN to_jsonb(COALESCE(a.n_sold, 0))
        WHEN 'units_reserved_count'  THEN to_jsonb(COALESCE(a.n_res, 0))
        WHEN 'price_range'           THEN public._rollup_range(a.price_min, a.price_max)
        WHEN 'area_range'            THEN public._rollup_range(a.area_min, a.area_max)
        WHEN 'bedroom_range'         THEN public._rollup_range(a.bed_min, a.bed_max)
        WHEN 'bathroom_range'        THEN public._rollup_range(a.bath_min, a.bath_max)
        WHEN 'min_price_per_meter'   THEN CASE WHEN a.ppm_min IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_min, 4)) END
        WHEN 'max_price_per_meter'   THEN CASE WHEN a.ppm_max IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_max, 4)) END
        WHEN 'avg_price_per_meter'   THEN CASE WHEN a.ppm_avg IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_avg, 4)) END
        ELSE 'null'::jsonb
      END
    );
  END LOOP;

  RETURN v_patch;
END;
$fn$;

-- ────────────────────────────────────────────────────────────────────────
-- STAGE 2 — triggers, index, flag rename, backup + backfill.
--           Apply AFTER the dual-read app code is deployed (so the renamed
--           flags are honored live) and AFTER stage-1 parity is confirmed.
--           Wrapped in a single transaction for atomicity.
-- ────────────────────────────────────────────────────────────────────────

-- (STAGE-2 BLOCK BELOW IS APPLIED SEPARATELY — see migration runner notes.)

-- 2a. Touch one project so the BEFORE-fill trigger recomputes it. SECURITY
--     DEFINER so the project UPDATE applies even when the unit-writer lacks
--     edit rights on the project row (else its rollups would silently stale).
CREATE OR REPLACE FUNCTION public._touch_project(p_pid text, p_proj uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_uuid uuid;
BEGIN
  BEGIN
    v_uuid := p_pid::uuid;
  EXCEPTION WHEN others THEN
    RETURN;  -- not a uuid → nothing to touch
  END;
  UPDATE public.records SET data = data WHERE id = v_uuid AND model_id = p_proj;
END;
$fn$;

-- 2b. BEFORE INSERT/UPDATE on all_projects rows → fill the rollups inline.
CREATE OR REPLACE FUNCTION public.tg_records_fill_project_rollups()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.model_id = public._rollups_all_projects_model_id() THEN
    NEW.data := COALESCE(NEW.data, '{}'::jsonb) || public.recalc_project_rollups_data(NEW.id);
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS records_fill_project_rollups ON public.records;
CREATE TRIGGER records_fill_project_rollups
BEFORE INSERT OR UPDATE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_records_fill_project_rollups();

-- 2c. AFTER INSERT/UPDATE/DELETE on units rows → recompute affected project(s).
CREATE OR REPLACE FUNCTION public.tg_records_touch_project_on_unit_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_units uuid := public._rollups_units_model_id();
  v_proj  uuid := public._rollups_all_projects_model_id();
  v_old   text;
  v_new   text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.model_id <> v_units THEN RETURN OLD; END IF;
    v_old := public._rollup_project_id_of(OLD.data);
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.model_id <> v_units THEN RETURN NEW; END IF;
    v_new := public._rollup_project_id_of(NEW.data);
  ELSE  -- UPDATE
    IF NEW.model_id <> v_units THEN RETURN NEW; END IF;
    v_old := public._rollup_project_id_of(OLD.data);
    v_new := public._rollup_project_id_of(NEW.data);
  END IF;

  IF v_new IS NOT NULL THEN
    PERFORM public._touch_project(v_new, v_proj);
  END IF;
  IF v_old IS NOT NULL AND v_old IS DISTINCT FROM v_new THEN
    PERFORM public._touch_project(v_old, v_proj);
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

DROP TRIGGER IF EXISTS records_touch_project_on_unit_change ON public.records;
CREATE TRIGGER records_touch_project_on_unit_change
AFTER INSERT OR UPDATE OR DELETE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_records_touch_project_on_unit_change();

-- 2d. Speed up the per-project unit lookup (recalc + touch path + backfill).
CREATE INDEX IF NOT EXISTS idx_records_model_project_id
ON public.records (model_id, (data->>'project_id'));

-- 2e. Rename the schema flags on all_projects: is_computed → is_rollup,
--     computed_kind → rollup_kind, + read_only:true. (Behavior unchanged for
--     the dual-read app; this just settles the canonical naming.)
DO $rename$
DECLARE
  v_id uuid;
  v_schema jsonb;
  v_secs jsonb := '[]'::jsonb;
  v_sec jsonb;
  v_flds jsonb;
  v_fld jsonb;
BEGIN
  SELECT id, schema INTO v_id, v_schema FROM public.models WHERE name = 'all_projects';
  IF v_id IS NULL THEN RAISE NOTICE 'all_projects not found — skip rename'; RETURN; END IF;

  FOR v_sec IN SELECT * FROM jsonb_array_elements(v_schema->'sections') LOOP
    v_flds := '[]'::jsonb;
    FOR v_fld IN SELECT * FROM jsonb_array_elements(COALESCE(v_sec->'fields','[]'::jsonb)) LOOP
      IF (v_fld->>'is_computed')::boolean IS TRUE OR (v_fld->>'is_rollup')::boolean IS TRUE THEN
        v_fld := (v_fld - 'is_computed' - 'computed_kind')
                 || jsonb_build_object(
                      'is_rollup',   true,
                      'rollup_kind', COALESCE(v_fld->>'rollup_kind', v_fld->>'computed_kind'),
                      'read_only',   true
                    );
      END IF;
      v_flds := v_flds || jsonb_build_array(v_fld);
    END LOOP;
    v_sec := jsonb_set(v_sec, '{fields}', v_flds);
    v_secs := v_secs || jsonb_build_array(v_sec);
  END LOOP;

  UPDATE public.models
  SET schema = jsonb_set(v_schema, '{sections}', v_secs), updated_at = now()
  WHERE id = v_id;

  PERFORM public.regenerate_model_view(v_id);  -- refresh v_all_projects
END $rename$;

-- 2f. Backup, then backfill: touch every all_projects row → BEFORE-fill
--     recomputes and stores the rollups for all 1,372 projects.
CREATE TABLE IF NOT EXISTS public._backup_all_projects_rollups_20260615 AS
  SELECT * FROM public.records WHERE model_id = public._rollups_all_projects_model_id();

UPDATE public.records
SET data = data
WHERE model_id = public._rollups_all_projects_model_id();
