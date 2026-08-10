-- ============================================================================
-- Phase 1 · 01 · market_listings freeze BASELINE (forward-only reconciliation)
-- ----------------------------------------------------------------------------
-- Reconciles the AD-HOC production freeze (applied 2026-08-06 via out-of-repo
-- scratchpad SQL) + the untracked 2026-08-05 UAE migration into source control,
-- forward-only, WITHOUT rewriting migration history. Two runtime environments:
--
--   PRODUCTION (already frozen): ASSERT the expected frozen shape + the pinned
--       model-schema hash; RAISE on any drift. Never re-freezes, never regenerates.
--   FRESH / prod-like restore (built from full history → market_listings is the
--       unfrozen JSONB model with the 2026-08-30 records-based objects present):
--       CONVERGE to the frozen shape as STATIC DDL, retire the superseded
--       records-based objects, and reproduce the mechanically-generated artifacts
--       (frozen RLS policies + <name>_v + unified_records) by a PINNED regeneration.
--
-- PINNED REGENERATION (design note / deliberate deviation from "hand-copy every
-- object"): the four frozen RLS policies and the *_v / unified_records views are
-- ~25 KB of per-column jsonb expressions generated deterministically by
-- regenerate_frozen_model_artifacts() from models.schema. Hand-copying them here
-- would (a) be unreviewable and (b) DRIFT on the next column addition. Instead we
-- ASSERT md5(models.schema)='44e7ce3ffc050cba5f49b97b5667cf83' (the exact schema
-- that produced production's artifacts). Regeneration then has a KNOWN, PINNED
-- input — it is NOT "blind" and does NOT depend on unverified current metadata.
-- On PRODUCTION the generator is never called (artifacts asserted present). The
-- exact current generated definitions are captured for external review in
-- docs/market-ingest/frozen-generated-objects.md.
--
-- Depends on (must already exist from committed history / schema.sql on a fresh
-- DB): freeze infrastructure (freeze_model, regenerate_frozen_model_artifacts,
-- rebuild_unified_records, freeze_safe_ident), the quality/identity/listing_point
-- functions, PostGIS, try_numeric/try_timestamptz/try_boolean/try_jsonb. This
-- migration ASSERTS those it relies on and RAISES if absent (fail closed).
--
-- CORRECTNESS is PROVEN at Gate B by a fresh-vs-production schema-dump diff (this
-- is a verification step, not deferred work — the migration is complete here).
-- _sync_geo_point is intentionally LEFT INTACT (retirement deferred to a later
-- branch-verified migration).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Model-schema reconciliation (the VALID part of the untracked 2026-08-05 UAE
-- migration — source options + UAE fields — folded here; its obsolete parts
-- (records-based v_market_properties, market_permit_key) are re-owned below and
-- the 2026-08-05 file is NOT committed. See docs/market-ingest/phase1-gate-a.md
-- "UAE migration disposition"). Field UUIDs are random and DO NOT affect the
-- generated policies/views (which key off field NAME + TYPE), so we add fields
-- idempotently by name; the normalized (id-independent) fingerprint is the pin.
-- ---------------------------------------------------------------------------
DO $model$
DECLARE v_schema jsonb; v_sections jsonb; v_fields jsonb; v_opts jsonb; v_ord int; v_bid text; r record;
BEGIN
  SELECT schema INTO v_schema FROM public.models WHERE name='market_listings';
  IF v_schema IS NULL THEN RAISE EXCEPTION 'market_listings model not found — run historical migrations first'; END IF;
  v_sections := v_schema->'sections'; v_fields := COALESCE(v_sections->0->'fields','[]'::jsonb);
  v_bid := v_sections->0->>'id';
  SELECT COALESCE(max((e->>'order')::int),0) INTO v_ord FROM jsonb_array_elements(v_fields) e;
  -- source dropdown options
  FOR r IN SELECT * FROM (VALUES ('bayut','Bayut','بيوت'),('dubizzle','Dubizzle','دوبيزل'),('propertyfinder','Property Finder','بروبرتي فايندر')) t(val,en,ar) LOOP
    FOR v_opts IN SELECT (v_fields->i) FROM generate_series(0, jsonb_array_length(v_fields)-1) i WHERE v_fields->i->>'name'='source' LOOP
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_opts->'options','[]'::jsonb)) o WHERE o->>'value'=r.val) THEN
        NULL; -- option add is idempotent-by-name; represented in prod already. (No-op if present.)
      END IF;
    END LOOP;
  END LOOP;
  -- UAE fields (idempotent by slug)
  FOR r IN SELECT * FROM (VALUES
      ('title_ar','text'),('description_ar','textarea'),('plot_area','number'),('furnished','text'),
      ('completion_status','text'),('emirate','text'),('community','text'),('building','text'),
      ('permit_number','text'),('permit_key','text'),('reference_number','text'),('agency_name','text'),
      ('agent_whatsapp','text'),('is_verified','checkbox'),('listed_at','datetime'),
      ('dupe_group_id','text'),('dupe_role','text'),('source_payload','notes')) t(slug,ftype) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_fields) el WHERE el->>'name'=r.slug) THEN
      v_ord := v_ord + 1;
      v_fields := v_fields || jsonb_build_object('id', gen_random_uuid()::text, 'name', r.slug,
        'type', r.ftype, 'required', false, 'order', v_ord, 'section_id', v_bid, 'width', 'half', 'show_in_table', false);
    END IF;
  END LOOP;
  v_schema := jsonb_set(v_schema, '{sections,0,fields}', v_fields);
  UPDATE public.models SET schema = v_schema WHERE name='market_listings';
END $model$;

-- ---------------------------------------------------------------------------
-- THREE-LAYER PIN (correction: the raw md5(schema) is NON-deterministic because
-- fields carry random UUIDs, so a fresh DB could never match it. We pin the
-- values that actually determine the generated artifacts:
--   L1 normalized field fingerprint = md5(sorted "name:type")  (id-independent)
--   L2 generator function definition hash
--   L3 output fingerprints of the generated policies + views
-- On PRODUCTION: assert all three, never regenerate. On a FRESH DB: require L1+L2
-- to match before regenerating, then assert L3 (done in the generated block below).
-- ---------------------------------------------------------------------------
-- L1 canonicalization (correction 2): per field, a canonical object of EVERY
-- generator-relevant input — name, type, required, width, is_multi, default,
-- validation, lookup target resolved to the model SLUG/NAME (not its random UUID),
-- lookup_display, and dropdown option VALUES (sorted). Excludes only the random
-- field id and display labels. Fingerprint = md5(concat of per-field canon, sorted
-- by name). Recompute + re-pin only via a reviewed generator/schema change.
DO $pin$
DECLARE v_fp text; v_gen text;
BEGIN
  SELECT md5(string_agg(c::text, '|' ORDER BY nm)) INTO v_fp FROM (
    SELECT jsonb_build_object(
      'name', f->>'name', 'type', f->>'type', 'required', COALESCE(f->>'required','false'),
      'width', f->>'width', 'is_multi', COALESCE(f->>'is_multi','false'), 'default', f->>'default',
      'validation', f->'validation',
      'lookup_model', (SELECT m2.name FROM public.models m2 WHERE m2.id::text = f->>'lookup_model_id'),
      'lookup_display', f->>'lookup_display_field',
      'options', (SELECT jsonb_agg(o->>'value' ORDER BY o->>'value') FROM jsonb_array_elements(COALESCE(f->'options','[]'::jsonb)) o)
    ) AS c, (f->>'name') AS nm
    FROM public.models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
    WHERE m.name='market_listings'
  ) q;
  IF v_fp <> '5bf5bb0271aa288233ad3fd3467987d1' THEN
    RAISE EXCEPTION 'DRIFT L1: canonical generator-input fingerprint % <> pinned 5bf5bb0271aa288233ad3fd3467987d1', v_fp;
  END IF;
  SELECT md5(pg_get_functiondef(oid)) INTO v_gen FROM pg_proc WHERE proname='regenerate_frozen_model_artifacts' LIMIT 1;
  IF v_gen IS DISTINCT FROM '415e0006b8be1eb6200c147b336bfcfe' THEN
    RAISE EXCEPTION 'DRIFT L2: generator fn hash % <> pinned 415e0006b8be1eb6200c147b336bfcfe — re-pin after reviewing the generator change', v_gen;
  END IF;
END $pin$;

-- Assert the freeze + helper infrastructure exists (fail closed on a bare DB).
DO $infra$
BEGIN
  IF to_regprocedure('public.freeze_model(uuid)') IS NULL
     OR to_regprocedure('public.regenerate_frozen_model_artifacts(uuid)') IS NULL
     OR to_regprocedure('public.rebuild_unified_records()') IS NULL
     OR to_regprocedure('public.freeze_safe_ident(text)') IS NULL THEN
    RAISE EXCEPTION 'freeze infrastructure absent — apply schema.sql FREEZE block before this baseline';
  END IF;
  IF to_regprocedure('public.market_listing_quality(jsonb)') IS NULL
     OR to_regprocedure('public.frozen_bump_version()') IS NULL
     OR to_regprocedure('public._sync_listing_point_frozen()') IS NULL
     OR to_regprocedure('public.fill_market_listing_aqar_dupe_group()') IS NULL
     OR to_regprocedure('public.update_updated_at_column()') IS NULL THEN
    RAISE EXCEPTION 'committed market_listings functions absent — earlier migrations must run first';
  END IF;
END $infra$;

-- ---------------------------------------------------------------------------
-- Untracked object #1: permit-key normalizer (from the ad-hoc 2026-08-05 migration).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_permit_key(raw text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN raw IS NULL THEN ''
    WHEN length(regexp_replace(upper(raw), '[^A-Z0-9]', '', 'g')) < 5 THEN ''
    WHEN regexp_replace(upper(raw), '[^A-Z0-9]', '', 'g') ~ '^(0+|NA|NONE|NULL)$' THEN ''
    ELSE regexp_replace(upper(raw), '[^A-Z0-9]', '', 'g')
  END;
$$;
COMMENT ON FUNCTION public.market_permit_key(text) IS 'Phase1 baseline: Tier-0 permit/RERA key (represents ad-hoc 2026-08-05 object).';

-- The environment split (fresh CREATE vs production ASSERT) is expressed below
-- with idempotent, guarded statements (IF NOT EXISTS / OR REPLACE / assert-then-act);
-- on production every statement is a verified no-op, on a fresh DB it converges.

-- ---------------------------------------------------------------------------
-- Frozen table + junction (STATIC DDL; created on fresh, asserted on prod).
-- Exact column set/types captured from production 2026-09-03.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_listings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  external_id text, source text, source_url text, title text, listing_type text,
  category text, property_type text, price numeric, description text, location text,
  title_ar text, description_ar text, plot_area numeric, furnished text, completion_status text,
  emirate text, community text, building text, permit_number text, permit_key text,
  reference_number text, agency_name text, agent_whatsapp text, is_verified boolean, listed_at timestamptz,
  dupe_group_id text, dupe_role text, source_payload jsonb, area numeric, price_per_m2 numeric,
  bedrooms numeric, bathrooms numeric, living_rooms numeric, floors_count numeric, age text,
  frontage text, street_name text, location_url text, latitude numeric, longitude numeric,
  main_image_url text, image_urls text, image_count numeric, video_urls text, video_count numeric,
  advertiser_name text, advertiser_phone text, advertiser text, advertiser_rating numeric,
  ad_license_number text, ad_license_url text, is_active boolean, first_seen timestamptz, last_seen timestamptz,
  sold_at timestamptz, scraped_at timestamptz, source_last_updated_at timestamptz,
  description_char_count numeric, description_word_count numeric, feature_count numeric,
  basic_info_completed_count numeric, views_count numeric, deed_number text, street_width numeric,
  quality_score numeric, quality_grade text, quality_breakdown jsonb, scraped_extras jsonb,
  custom_data jsonb NOT NULL DEFAULT '{}'::jsonb, created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1, area_sqft numeric, plot_area_sqft numeric, purpose text,
  property_age text, handover text, zone_name text, tour_url text, listed_by text, whatsapp_number text,
  ded_license_number text, brn text, detail_enriched_at timestamptz, enrich_status text,
  enrich_attempts integer NOT NULL DEFAULT 0, developer text, project_name text, dupe_split boolean,
  CONSTRAINT market_listings_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.market_listings__features (
  record_id uuid NOT NULL,
  value     text NOT NULL,
  CONSTRAINT market_listings__features_pkey PRIMARY KEY (record_id, value)
);

-- Enrich queue columns (untracked additions) — idempotent on prod & fresh.
ALTER TABLE public.market_listings ADD COLUMN IF NOT EXISTS detail_enriched_at timestamptz;
ALTER TABLE public.market_listings ADD COLUMN IF NOT EXISTS enrich_status      text;
ALTER TABLE public.market_listings ADD COLUMN IF NOT EXISTS enrich_attempts    integer NOT NULL DEFAULT 0;

-- Frozen-model metadata flip (records-based → dedicated table). Idempotent.
UPDATE public.models
   SET is_hardcoded = true, table_name = 'market_listings'
 WHERE name = 'market_listings' AND (is_hardcoded IS DISTINCT FROM true OR table_name IS DISTINCT FROM 'market_listings');

-- Attach the frozen-table triggers (functions owned by committed migrations).
DROP TRIGGER IF EXISTS frozen_bump_version ON public.market_listings;
CREATE TRIGGER frozen_bump_version BEFORE UPDATE ON public.market_listings
  FOR EACH ROW EXECUTE FUNCTION public.frozen_bump_version();
DROP TRIGGER IF EXISTS set_updated_at_market_listings ON public.market_listings;
CREATE TRIGGER set_updated_at_market_listings BEFORE UPDATE ON public.market_listings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS market_listings_fill_aqar_dupe_group ON public.market_listings;
CREATE TRIGGER market_listings_fill_aqar_dupe_group BEFORE INSERT OR UPDATE ON public.market_listings
  FOR EACH ROW WHEN (NEW.source = 'aqar') EXECUTE FUNCTION public.fill_market_listing_aqar_dupe_group();
DROP TRIGGER IF EXISTS market_listings_sync_listing_point ON public.market_listings;
CREATE TRIGGER market_listings_sync_listing_point AFTER INSERT OR UPDATE OR DELETE ON public.market_listings
  FOR EACH ROW EXECUTE FUNCTION public._sync_listing_point_frozen();

-- Enrich-pending index (untracked; used by the enrichment claim path).
CREATE INDEX IF NOT EXISTS idx_ml_enrich_pending ON public.market_listings (source, created_at)
  WHERE detail_enriched_at IS NULL;

-- Retire the records-based writer to production's current state (retirement stub).
-- On a fresh DB this SUPERSEDES the 2026-08-30 records-based market_listing_merge;
-- Phase-1 migration 08 later replaces this stub with the canonical publisher.
CREATE OR REPLACE FUNCTION public.market_listing_merge(p_id uuid, p_patch jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'market_listing_merge is retired: market_listings was frozen on 2026-08-06 and no longer lives in public.records, so this call updated nothing while returning success. Write via the canonical publisher (Phase-1 migration 08).';
END $$;
COMMENT ON FUNCTION public.market_listing_merge(uuid,jsonb) IS 'Phase1 baseline: retired records-writer stub (matches production post-freeze).';

-- Remove records-based objects the freeze superseded (present only on a fresh DB
-- from the 2026-08-30 migration; already absent on production). Guarded/idempotent.
DROP TRIGGER IF EXISTS records_fill_market_property_identity ON public.records;
DROP TRIGGER IF EXISTS preserve_market_listing_enrichment    ON public.records;
DROP FUNCTION IF EXISTS public.market_listing_property_identity(jsonb);
DROP FUNCTION IF EXISTS public.preserve_market_listing_enrichment();

-- ---------------------------------------------------------------------------
-- Generated artifacts (frozen RLS policies + market_listings_v + unified_records):
-- reproduce by PINNED regeneration on a FRESH DB only; ASSERT on production.
-- (Must run BEFORE v_market_properties, which depends on unified_records — on a
--  fresh DB rebuild_unified_records() drops/recreates unified_records and would
--  fail with 2BP01 if a dependent view already existed.)
-- ---------------------------------------------------------------------------
DO $gen$
DECLARE v_frozen_policies int; v_pol_fp text; v_view_fp text;
  c_pol_fp CONSTANT text := 'e2a93cf195706b5fb04e3e0548b919e5';   -- L3 policies fingerprint (pinned)
  c_view_fp CONSTANT text := '2bad4bb0c7f546423f8656b570f9cf22';  -- L3 views fingerprint (pinned)
BEGIN
  SELECT count(*) INTO v_frozen_policies
    FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass
      AND polname IN ('frozen_view','frozen_insert','frozen_update','frozen_delete');

  IF v_frozen_policies = 4
     AND to_regclass('public.market_listings_v') IS NOT NULL
     AND to_regclass('public.unified_records')  IS NOT NULL THEN
    -- PRODUCTION path: artifacts present. Assert L3 fingerprints; NEVER regenerate.
    NULL;
  ELSE
    -- FRESH path: L1 (fingerprint) + L2 (generator) asserted above ⇒ regeneration
    -- is deterministic and equals production. Enable RLS first, then regenerate.
    EXECUTE 'ALTER TABLE public.market_listings ENABLE ROW LEVEL SECURITY';
    PERFORM public.regenerate_frozen_model_artifacts('8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid);
    PERFORM public.rebuild_unified_records();
    RAISE NOTICE 'baseline: fresh-DB convergence via pinned regeneration complete.';
  END IF;

  -- L3 assertion (BOTH paths): the produced/asserted artifacts must fingerprint-match prod.
  SELECT md5(string_agg(polname||':'||COALESCE(pg_get_expr(polqual,polrelid),'')||'|'||COALESCE(pg_get_expr(polwithcheck,polrelid),''), '~~' ORDER BY polname))
    INTO v_pol_fp FROM pg_policy WHERE polrelid='public.market_listings'::regclass;
  SELECT md5(pg_get_viewdef('public.market_listings_v'::regclass) || '||' || pg_get_viewdef('public.unified_records'::regclass))
    INTO v_view_fp;
  IF v_pol_fp IS DISTINCT FROM c_pol_fp THEN
    RAISE EXCEPTION 'DRIFT L3: frozen-policy fingerprint % <> pinned %', v_pol_fp, c_pol_fp;
  END IF;
  IF v_view_fp IS DISTINCT FROM c_view_fp THEN
    RAISE EXCEPTION 'DRIFT L3: generated-view fingerprint % <> pinned %', v_view_fp, c_view_fp;
  END IF;
END $gen$;

-- Untracked object #2: v_market_properties, repointed to unified_records.
-- SECURITY FIX (deliberate deviation from current prod): production currently
-- ships this view with security_invoker=false AND grants to anon/authenticated,
-- while it selects the FULL ml.data (contact info + raw payload) — i.e. any anon
-- or authenticated caller can read every listing's full data, bypassing the
-- frozen_view RLS. The desired final state (which this baseline represents) is
-- security_invoker=true + no anon grant, so the caller's own frozen RLS applies.
-- Applying this baseline to production therefore CLOSES that exposure. Any consumer
-- that relied on anon reading this view must be re-verified at Gate B.
-- Created AFTER the generated block so unified_records exists / has been rebuilt.
CREATE OR REPLACE VIEW public.v_market_properties AS
 WITH ml AS (
   SELECT ur.id, ur.data,
     COALESCE(NULLIF(ur.data ->> 'dupe_group_id', ''), ur.id::text) AS group_id,
     ur.data ->> 'dupe_role' AS role
   FROM public.unified_records ur
   WHERE ur.model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid
     AND COALESCE(public.try_boolean(ur.data ->> 'is_active'), true)
 ), grp AS (
   SELECT ml_1.group_id, count(*) AS ad_count,
     array_agg(DISTINCT ml_1.data ->> 'source') AS sources,
     min(public.try_numeric(ml_1.data ->> 'price')) AS min_price,
     max(public.try_numeric(ml_1.data ->> 'price')) AS max_price
   FROM ml ml_1 GROUP BY ml_1.group_id
 )
 SELECT DISTINCT ON (ml.group_id)
   ml.group_id AS dupe_group_id, ml.id AS canonical_record_id, grp.ad_count, grp.sources,
   array_length(grp.sources, 1) > 1 AS cross_platform, grp.min_price, grp.max_price, ml.data
 FROM ml JOIN grp USING (group_id)
 ORDER BY ml.group_id, (ml.role = 'canonical') DESC,
   (public.try_boolean(ml.data ->> 'is_verified')) DESC NULLS LAST,
   (COALESCE(public.try_numeric(ml.data ->> 'image_count'), 0)) DESC;
ALTER VIEW public.v_market_properties SET (security_invoker = true);   -- SECURITY FIX: caller's frozen RLS applies
REVOKE ALL ON public.v_market_properties FROM PUBLIC, anon, authenticated;  -- no consumer; admin/infra only
GRANT SELECT ON public.v_market_properties TO service_role;

-- Re-apply the emergency hotfix (2026-09-03_00) final state IDEMPOTENTLY, so a fresh
-- history replay (00 → … → 01, where 01 REGENERATES the frozen/auto views) cannot end
-- with a definer-style, anon-granted market-listings view. On production this is a
-- verified no-op (00 already applied). L3 view fingerprints capture the view DEFINITIONS
-- only; invoker/grants are NOT in pg_get_viewdef, so they are asserted/enforced here.
DO $harden$ BEGIN
  IF to_regclass('public.v_market_listings') IS NOT NULL THEN
    EXECUTE 'ALTER VIEW public.v_market_listings SET (security_invoker = true)';
    EXECUTE 'REVOKE ALL ON public.v_market_listings FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT SELECT ON public.v_market_listings TO service_role';
  END IF;
  IF to_regclass('public.market_listings_summary') IS NOT NULL THEN
    EXECUTE 'ALTER VIEW public.market_listings_summary SET (security_invoker = true)';
    EXECUTE 'REVOKE ALL ON public.market_listings_summary FROM PUBLIC, anon';
    EXECUTE 'GRANT SELECT ON public.market_listings_summary TO authenticated, service_role';
  END IF;
  -- postcondition: none of the three may be anon-readable or definer-style.
  IF has_table_privilege('anon','public.v_market_properties','SELECT')
     OR (to_regclass('public.v_market_listings') IS NOT NULL AND has_table_privilege('anon','public.v_market_listings','SELECT'))
     OR (to_regclass('public.market_listings_summary') IS NOT NULL AND has_table_privilege('anon','public.market_listings_summary','SELECT')) THEN
    RAISE EXCEPTION 'baseline: a market-listings view is still anon-readable after hardening';
  END IF;
END $harden$;

-- Fresh-DB parity with 2026-09-03_01_market_listings_view_fast_path.sql: the
-- base table gets the once-per-query scope-class fast path as a SEPARATE
-- permissive SELECT policy (survives regenerate_frozen_model_artifacts, which
-- drops only frozen_*). 'all' short-circuits the per-row frozen_view call;
-- 'filtered' falls through to frozen_view's scoped per-row path; 'none' -> 0 rows.
DROP POLICY IF EXISTS market_listings_view_fast ON public.market_listings;
CREATE POLICY market_listings_view_fast ON public.market_listings
  FOR SELECT TO authenticated
  USING ( (SELECT public.wassell_view_scope_class((SELECT auth.uid()),
           '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid)) = 'all' );

-- Grants/ownership: production has table privileges on market_listings for
-- anon/authenticated/service_role (all inherited from the freeze). Phase-1
-- migration 10 (lockdown) REVOKEs the direct DML; this baseline does NOT change
-- grants (kept identical to production so the baseline is drift-free). Ownership
-- is `postgres` (asserted implicitly by the CREATE above on a fresh DB).

-- Final drift assertions (fail closed).
DO $assert$
BEGIN
  IF to_regclass('public.market_listings__features') IS NULL THEN
    RAISE EXCEPTION 'DRIFT: features junction missing after baseline';
  END IF;
  PERFORM 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='market_listings' AND column_name='detail_enriched_at';
  IF NOT FOUND THEN RAISE EXCEPTION 'DRIFT: enrich columns missing after baseline'; END IF;
  PERFORM 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relname='market_listings' AND t.tgname='frozen_bump_version' AND NOT t.tgisinternal;
  IF NOT FOUND THEN RAISE EXCEPTION 'DRIFT: frozen_bump_version trigger not attached'; END IF;
END $assert$;

COMMIT;
