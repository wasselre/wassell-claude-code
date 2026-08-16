-- ============================================================================
-- Phase 1 · Gate A · 00 · market_listings FREEZE BASELINE (forward-only)
-- ----------------------------------------------------------------------------
-- Reconciles the AD-HOC production freeze of 2026-08-06 (applied via out-of-repo
-- scratchpad SQL) into source control, forward-only, WITHOUT rewriting history
-- and WITHOUT touching the applied 2026-09-04_00 reconciliation.
--
-- WHY THIS FILE SORTS AT 2026-09-03_02 AND NOT 2026-09-05_05:
-- 2026-09-04_00_market_listings_view_reconciliation.sql is applied, immutable,
-- and its preflight ABORTS when public.market_listings is absent. Migration
-- files replay in lexical order, so any baseline numbered after it could never
-- create the table in time and every fresh path would stop dead. Numbering the
-- baseline BELOW it is the only resolution that does not edit an applied,
-- ledger-recorded migration. Replay order is therefore:
--     2026-09-03_02 (this) -> 2026-09-04_00 -> 2026-09-05_01..04 -> _06
--
-- TWO GUARDED BRANCHES, one file:
--   PRODUCTION (market_listings present): ASSERT the expected frozen shape and
--       the pinned fingerprints. Never re-freezes, never regenerates, performs
--       NO destructive mutation of any kind.
--   FRESH (market_listings absent): CONVERGE to the frozen shape as static DDL
--       so that the UNMODIFIED 2026-09-04_00 finds exactly the predecessor
--       state its preflight pins.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT CREATE:
--   market_listings_view_fast and market_listings_view_deny_none. Those are
--   created by 2026-09-04_00, and its preflight relies on the fast policy being
--   ABSENT beforehand. Creating them here would break the very migration this
--   baseline exists to serve.
--
-- DERIVED PREDICATES (deliberate, and verified by assertion below): the frozen
--   view/update/delete predicates are the SAME generated projection. update is
--   view with wassell_can_view_jsonb -> wassell_can_edit_jsonb (identical
--   length, hence identical deparse shape); delete is update wrapped in parens
--   AND'ed with the delete action check. Only one 2,829-char predicate is
--   embedded; the other two are derived and then md5-asserted, so a wrong
--   derivation fails HERE, loudly, instead of confusingly inside 2026-09-04_00.
--
-- Source of truth for every literal below:
--   docs/market-ingest/freeze-baseline-source-of-truth.md (extracted read-only
--   from wassell-prod 2026-08-16; production was never mutated).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path       = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 1. Preflight (fail closed). Both branches need these.
-- ---------------------------------------------------------------------------
DO $preflight$
BEGIN
  IF to_regclass('public.records') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.records is absent — unified_records unions it. Apply the base schema/bootstrap first.';
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.users is absent — market_listings.created_by_user_id references users(id).';
  END IF;
  IF to_regclass('public.models') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.models is absent.';
  END IF;
  IF to_regprocedure('public.wassell_can_view_jsonb(uuid,uuid,uuid,uuid,jsonb)') IS NULL
     OR to_regprocedure('public.wassell_view_scope_class(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the wassell_* authorization functions are absent — the frozen policies and market_listings_summary call them.';
  END IF;
  IF (SELECT id FROM public.models WHERE name='market_listings')
       IS DISTINCT FROM '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid THEN
    RAISE EXCEPTION 'PREFLIGHT: models.id for market_listings is not 8f06bc39-4bee-42e9-9fab-77023fb89ede — every generated predicate hardcodes it.';
  END IF;
END $preflight$;

-- ---------------------------------------------------------------------------
-- 2. FRESH branch — converge. No-op entirely on production.
-- ---------------------------------------------------------------------------
DO $converge$
DECLARE
  -- The single embedded generated projection (frozen_view predicate, 2,829 ch).
  v_view_pred text := $pred$wassell_can_view_jsonb(( SELECT auth.uid() AS uid), '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid, id, created_by_user_id, (((jsonb_build_object('external_id', external_id, 'source', source, 'source_url', source_url, 'title', title, 'listing_type', listing_type, 'category', category, 'property_type', property_type, 'price', (price)::text, 'description', description, 'location', location, 'title_ar', title_ar, 'description_ar', description_ar, 'plot_area', (plot_area)::text, 'furnished', furnished, 'completion_status', completion_status, 'emirate', emirate, 'community', community, 'building', building, 'permit_number', permit_number, 'permit_key', permit_key, 'reference_number', reference_number, 'agency_name', agency_name, 'agent_whatsapp', agent_whatsapp, 'is_verified', (is_verified)::text, 'listed_at', (listed_at)::text, 'dupe_group_id', dupe_group_id, 'dupe_role', dupe_role, 'source_payload', (source_payload)::text, 'area_sqft', (area_sqft)::text, 'plot_area_sqft', (plot_area_sqft)::text, 'purpose', purpose, 'property_age', property_age, 'handover', handover, 'zone_name', zone_name, 'tour_url', tour_url, 'listed_by', listed_by, 'whatsapp_number', whatsapp_number, 'ded_license_number', ded_license_number, 'brn', brn, 'developer', developer) || jsonb_build_object('project_name', project_name, 'area', (area)::text, 'price_per_m2', (price_per_m2)::text, 'bedrooms', (bedrooms)::text, 'bathrooms', (bathrooms)::text, 'living_rooms', (living_rooms)::text, 'floors_count', (floors_count)::text, 'age', age, 'frontage', frontage, 'street_name', street_name, 'location_url', location_url, 'latitude', (latitude)::text, 'longitude', (longitude)::text, 'main_image_url', main_image_url, 'image_urls', (image_urls)::text, 'image_count', (image_count)::text, 'video_urls', (video_urls)::text, 'video_count', (video_count)::text, 'advertiser_name', advertiser_name, 'advertiser_phone', advertiser_phone, 'advertiser', advertiser, 'advertiser_rating', (advertiser_rating)::text, 'ad_license_number', ad_license_number, 'ad_license_url', ad_license_url, 'is_active', (is_active)::text, 'first_seen', (first_seen)::text, 'last_seen', (last_seen)::text, 'sold_at', (sold_at)::text, 'scraped_at', (scraped_at)::text, 'source_last_updated_at', (source_last_updated_at)::text, 'description_char_count', (description_char_count)::text, 'description_word_count', (description_word_count)::text, 'feature_count', (feature_count)::text, 'basic_info_completed_count', (basic_info_completed_count)::text, 'views_count', (views_count)::text, 'deed_number', deed_number, 'street_width', (street_width)::text, 'quality_score', (quality_score)::text, 'quality_grade', quality_grade, 'quality_breakdown', (quality_breakdown)::text)) || jsonb_build_object('scraped_extras', (scraped_extras)::text)) || COALESCE(custom_data, '{}'::jsonb)))$pred$;
  v_edit_pred text;
  v_del_pred  text;
  v_ins_wc    text := $ins$wassell_user_has_action(( SELECT auth.uid() AS uid), '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid, 'create'::text)$ins$;
  r           record;
BEGIN
  IF to_regclass('public.market_listings') IS NOT NULL THEN
    RAISE NOTICE 'freeze baseline: market_listings present — production branch, assert-only.';
    RETURN;
  END IF;

  v_edit_pred := replace(v_view_pred, 'wassell_can_view_jsonb', 'wassell_can_edit_jsonb');
  v_del_pred  := '(' || v_edit_pred
    || $d$ AND wassell_user_has_action(( SELECT auth.uid() AS uid), '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid, 'delete'::text))$d$;

  -- 2.1 Physical table (91 columns, production order).
  CREATE TABLE public.market_listings (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    external_id text, source text, source_url text, title text, listing_type text,
    category text, property_type text, price numeric, description text, location text,
    title_ar text, description_ar text, plot_area numeric, furnished text,
    completion_status text, emirate text, community text, building text,
    permit_number text, permit_key text, reference_number text, agency_name text,
    agent_whatsapp text, is_verified boolean, listed_at timestamptz,
    dupe_group_id text, dupe_role text, source_payload jsonb, area numeric,
    price_per_m2 numeric, bedrooms numeric, bathrooms numeric, living_rooms numeric,
    floors_count numeric, age text, frontage text, street_name text, location_url text,
    latitude numeric, longitude numeric, main_image_url text, image_count numeric,
    video_count numeric, advertiser_name text, advertiser_phone text, advertiser text,
    advertiser_rating numeric, ad_license_number text, ad_license_url text,
    is_active boolean, first_seen timestamptz, last_seen timestamptz, sold_at timestamptz,
    scraped_at timestamptz, source_last_updated_at timestamptz,
    description_char_count numeric, description_word_count numeric, feature_count numeric,
    basic_info_completed_count numeric, views_count numeric, deed_number text,
    street_width numeric, quality_score numeric, quality_grade text,
    quality_breakdown jsonb, scraped_extras jsonb,
    custom_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by_user_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version integer NOT NULL DEFAULT 1,
    area_sqft numeric, plot_area_sqft numeric, purpose text, property_age text,
    handover text, zone_name text, tour_url text, listed_by text, whatsapp_number text,
    ded_license_number text, brn text, detail_enriched_at timestamptz,
    enrich_status text, enrich_attempts integer NOT NULL DEFAULT 0,
    developer text, project_name text, dupe_split boolean,
    image_urls jsonb, video_urls jsonb,
    CONSTRAINT market_listings_pkey PRIMARY KEY (id),
    CONSTRAINT market_listings_created_by_user_id_fkey
      FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL
  );

  -- 2.2 Multi-value junctions (market_listings_v aggregates both).
  CREATE TABLE public.market_listings__features (
    record_id uuid NOT NULL REFERENCES public.market_listings(id) ON DELETE CASCADE,
    value text NOT NULL,
    PRIMARY KEY (record_id, value)
  );
  CREATE TABLE public.market_listings__basic_info_missing_keys (
    record_id uuid NOT NULL REFERENCES public.market_listings(id) ON DELETE CASCADE,
    value text NOT NULL,
    PRIMARY KEY (record_id, value)
  );

  -- 2.3 Indexes (production set).
  CREATE INDEX idx_market_listings_dupe_group_id ON public.market_listings (dupe_group_id);
  CREATE INDEX idx_ml_bedrooms   ON public.market_listings (bedrooms);
  CREATE INDEX idx_ml_created_at ON public.market_listings (created_at DESC);
  CREATE INDEX idx_ml_dupe       ON public.market_listings (dupe_group_id);
  CREATE INDEX idx_ml_emirate    ON public.market_listings (emirate);
  CREATE INDEX idx_ml_enrich_pending ON public.market_listings (source, created_at)
    WHERE detail_enriched_at IS NULL;
  CREATE INDEX idx_ml_is_active  ON public.market_listings (is_active);
  CREATE INDEX idx_ml_permit_key ON public.market_listings (permit_key);
  CREATE INDEX idx_ml_price      ON public.market_listings (price);
  CREATE INDEX idx_ml_scraped_at ON public.market_listings (scraped_at DESC);
  CREATE INDEX idx_ml_source     ON public.market_listings (source);
  CREATE INDEX idx_ml_source_ext ON public.market_listings (source, external_id);

  -- 2.4 RLS + the FOUR frozen policies. view_fast / deny_none are NOT created
  --     here — 2026-09-04_00 owns them and preflights on fast being absent.
  ALTER TABLE public.market_listings ENABLE ROW LEVEL SECURITY;
  EXECUTE format('CREATE POLICY frozen_view ON public.market_listings FOR SELECT TO authenticated USING (%s)', v_view_pred);
  EXECUTE format('CREATE POLICY frozen_insert ON public.market_listings FOR INSERT TO authenticated WITH CHECK (%s)', v_ins_wc);
  EXECUTE format('CREATE POLICY frozen_update ON public.market_listings FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', v_edit_pred, v_edit_pred);
  EXECUTE format('CREATE POLICY frozen_delete ON public.market_listings FOR DELETE TO authenticated USING (%s)', v_del_pred);

  -- 2.5 Model row flips to frozen.
  UPDATE public.models
     SET is_hardcoded = true, table_name = 'market_listings'
   WHERE id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid;

  -- 2.6 Generated JSONB-shape view.
  CREATE VIEW public.market_listings_v AS
   SELECT id,
    '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid AS model_id,
    (jsonb_strip_nulls(((jsonb_build_object('external_id', external_id, 'source', source, 'source_url', source_url, 'title', title, 'listing_type', listing_type, 'category', category, 'property_type', property_type, 'price', price, 'description', description, 'location', location, 'title_ar', title_ar, 'description_ar', description_ar, 'plot_area', plot_area, 'furnished', furnished, 'completion_status', completion_status, 'emirate', emirate, 'community', community, 'building', building, 'permit_number', permit_number, 'permit_key', permit_key, 'reference_number', reference_number, 'agency_name', agency_name, 'agent_whatsapp', agent_whatsapp, 'is_verified', is_verified, 'listed_at', listed_at, 'dupe_group_id', dupe_group_id, 'dupe_role', dupe_role, 'source_payload', source_payload, 'area_sqft', area_sqft, 'plot_area_sqft', plot_area_sqft, 'purpose', purpose, 'property_age', property_age, 'handover', handover, 'zone_name', zone_name, 'tour_url', tour_url, 'listed_by', listed_by, 'whatsapp_number', whatsapp_number, 'ded_license_number', ded_license_number, 'brn', brn, 'developer', developer) || jsonb_build_object('project_name', project_name, 'area', area, 'price_per_m2', price_per_m2, 'bedrooms', bedrooms, 'bathrooms', bathrooms, 'living_rooms', living_rooms, 'floors_count', floors_count, 'age', age, 'frontage', frontage, 'street_name', street_name, 'features', COALESCE(( SELECT jsonb_agg(market_listings__features.value ORDER BY market_listings__features.value) AS jsonb_agg
           FROM market_listings__features
          WHERE (market_listings__features.record_id = t.id)), '[]'::jsonb), 'location_url', location_url, 'latitude', latitude, 'longitude', longitude, 'main_image_url', main_image_url, 'image_urls', image_urls, 'image_count', image_count, 'video_urls', video_urls, 'video_count', video_count, 'advertiser_name', advertiser_name, 'advertiser_phone', advertiser_phone, 'advertiser', advertiser, 'advertiser_rating', advertiser_rating, 'ad_license_number', ad_license_number, 'ad_license_url', ad_license_url, 'is_active', is_active, 'first_seen', first_seen, 'last_seen', last_seen, 'sold_at', sold_at, 'scraped_at', scraped_at, 'source_last_updated_at', source_last_updated_at, 'description_char_count', description_char_count, 'description_word_count', description_word_count, 'feature_count', feature_count, 'basic_info_completed_count', basic_info_completed_count, 'basic_info_missing_keys', COALESCE(( SELECT jsonb_agg(market_listings__basic_info_missing_keys.value ORDER BY market_listings__basic_info_missing_keys.value) AS jsonb_agg
           FROM market_listings__basic_info_missing_keys
          WHERE (market_listings__basic_info_missing_keys.record_id = t.id)), '[]'::jsonb), 'views_count', views_count, 'deed_number', deed_number, 'street_width', street_width, 'quality_score', quality_score)) || jsonb_build_object('quality_grade', quality_grade, 'quality_breakdown', quality_breakdown, 'scraped_extras', scraped_extras))) || COALESCE(custom_data, '{}'::jsonb)) AS data,
    created_by_user_id,
    created_at,
    updated_at,
    version
   FROM market_listings t;

  -- 2.7 Flat BI passthrough.
  CREATE VIEW public.v_market_listings AS
   SELECT id, external_id, source, source_url, title, listing_type, category,
    property_type, price, description, location, title_ar, description_ar, plot_area,
    furnished, completion_status, emirate, community, building, permit_number,
    permit_key, reference_number, agency_name, agent_whatsapp, is_verified, listed_at,
    dupe_group_id, dupe_role, source_payload, area, price_per_m2, bedrooms, bathrooms,
    living_rooms, floors_count, age, frontage, street_name, location_url, latitude,
    longitude, main_image_url, image_urls, image_count, video_urls, video_count,
    advertiser_name, advertiser_phone, advertiser, advertiser_rating, ad_license_number,
    ad_license_url, is_active, first_seen, last_seen, sold_at, scraped_at,
    source_last_updated_at, description_char_count, description_word_count, feature_count,
    basic_info_completed_count, views_count, deed_number, street_width, quality_score,
    quality_grade, quality_breakdown, scraped_extras, custom_data, created_by_user_id,
    created_at, updated_at, version, area_sqft, plot_area_sqft, purpose, property_age,
    handover, zone_name, tour_url, listed_by, whatsapp_number, ded_license_number, brn,
    detail_enriched_at, enrich_status, enrich_attempts, developer, project_name
   FROM market_listings;

  -- 2.8 Scope-gated summary (the SPA's read surface). No source_payload.
  CREATE VIEW public.market_listings_summary AS
   SELECT id,
    '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid AS model_id,
    created_by_user_id,
    created_at,
    updated_at,
    (jsonb_strip_nulls(jsonb_build_object('external_id', external_id, 'source', source, 'title', title, 'title_ar', title_ar, 'listing_type', listing_type, 'category', category, 'property_type', property_type, 'price', price, 'price_per_m2', price_per_m2, 'area', area, 'bedrooms', bedrooms, 'bathrooms', bathrooms, 'location', location, 'latitude', latitude, 'longitude', longitude, 'is_active', is_active, 'main_image_url', main_image_url, 'advertiser_name', advertiser_name, 'image_count', image_count, 'video_count', video_count, 'advertiser_phone', advertiser_phone, 'advertiser', advertiser, 'quality_score', quality_score, 'quality_grade', quality_grade, 'emirate', emirate, 'community', community, 'building', building, 'permit_number', permit_number, 'dupe_group_id', dupe_group_id, 'dupe_role', dupe_role, 'dupe_split', dupe_split, 'reference_number', reference_number)) || COALESCE(custom_data, '{}'::jsonb)) AS data
   FROM market_listings t
  WHERE
        CASE ( SELECT wassell_view_scope_class(( SELECT auth.uid() AS uid), '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid) AS wassell_view_scope_class)
            WHEN 'all'::text THEN true
            WHEN 'none'::text THEN false
            ELSE wassell_can_view_jsonb(( SELECT auth.uid() AS uid), '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid, id, created_by_user_id, jsonb_build_object('source', source, 'is_active', is_active, 'created_by_user_id', created_by_user_id, 'external_id', external_id))
        END;

  -- 2.9 Rebuild the union. Unwind dependents first (they are recreated from
  --     their captured definitions, preserving reloptions and grants — see
  --     CLAUDE.md "Unwinding the view chain").
  CREATE TEMP TABLE _fb_dependents ON COMMIT DROP AS
    SELECT c.relname::text                                   AS relname,
           pg_get_viewdef(c.oid)                             AS def,
           c.reloptions                                      AS reloptions,
           pg_get_userbyid(c.relowner)::text                 AS owner,
           COALESCE((SELECT string_agg(format('GRANT %s ON public.%I TO %s;',
                        a.privilege_type, c.relname,
                        CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                             ELSE quote_ident(pg_get_userbyid(a.grantee)) END), ' ')
                     FROM aclexplode(c.relacl) a
                    WHERE pg_get_userbyid(a.grantee) <> pg_get_userbyid(c.relowner)), '') AS grants
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind = 'v'
       AND c.relname IN ('v_market_properties','v_our_projects_scope','v_website_public');

  FOR r IN SELECT relname FROM _fb_dependents LOOP
    EXECUTE format('DROP VIEW IF EXISTS public.%I', r.relname);
  END LOOP;
  DROP VIEW IF EXISTS public.unified_records;

  CREATE VIEW public.unified_records AS
   SELECT records.id, records.model_id, records.data, records.created_by_user_id,
          records.created_at, records.updated_at, records.version FROM records
  UNION ALL
   SELECT cities_v.id, cities_v.model_id, cities_v.data, cities_v.created_by_user_id,
          cities_v.created_at, cities_v.updated_at, cities_v.version FROM cities_v
  UNION ALL
   SELECT districts_v.id, districts_v.model_id, districts_v.data, districts_v.created_by_user_id,
          districts_v.created_at, districts_v.updated_at, districts_v.version FROM districts_v
  UNION ALL
   SELECT market_listings_v.id, market_listings_v.model_id, market_listings_v.data, market_listings_v.created_by_user_id,
          market_listings_v.created_at, market_listings_v.updated_at, market_listings_v.version FROM market_listings_v
  UNION ALL
   SELECT regions_v.id, regions_v.model_id, regions_v.data, regions_v.created_by_user_id,
          regions_v.created_at, regions_v.updated_at, regions_v.version FROM regions_v;
  ALTER VIEW public.unified_records SET (security_invoker = true);

  -- v_market_properties is recreated from the pinned production definition
  -- (it is one of the three views 2026-09-04_00 pins by md5).
  CREATE VIEW public.v_market_properties AS
   WITH ml AS (
         SELECT ur.id,
            ur.data,
            COALESCE(NULLIF((ur.data ->> 'dupe_group_id'::text), ''::text), (ur.id)::text) AS group_id,
            (ur.data ->> 'dupe_role'::text) AS role
           FROM unified_records ur
          WHERE ((ur.model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid) AND COALESCE(try_boolean((ur.data ->> 'is_active'::text)), true))
        ), grp AS (
         SELECT ml_1.group_id,
            count(*) AS ad_count,
            array_agg(DISTINCT (ml_1.data ->> 'source'::text)) AS sources,
            min(try_numeric((ml_1.data ->> 'price'::text))) AS min_price,
            max(try_numeric((ml_1.data ->> 'price'::text))) AS max_price
           FROM ml ml_1
          GROUP BY ml_1.group_id
        )
 SELECT DISTINCT ON (ml.group_id) ml.group_id AS dupe_group_id,
    ml.id AS canonical_record_id,
    grp.ad_count,
    grp.sources,
    (array_length(grp.sources, 1) > 1) AS cross_platform,
    grp.min_price,
    grp.max_price,
    ml.data
   FROM (ml
     JOIN grp USING (group_id))
  ORDER BY ml.group_id, (ml.role = 'canonical'::text) DESC, (try_boolean((ml.data ->> 'is_verified'::text))) DESC NULLS LAST, COALESCE(try_numeric((ml.data ->> 'image_count'::text)), (0)::numeric) DESC;

  -- Restore the remaining captured dependents verbatim.
  FOR r IN SELECT * FROM _fb_dependents WHERE relname <> 'v_market_properties' LOOP
    EXECUTE format('CREATE VIEW public.%I AS %s', r.relname, r.def);
    IF r.reloptions IS NOT NULL THEN
      EXECUTE format('ALTER VIEW public.%I SET (%s)', r.relname, array_to_string(r.reloptions, ', '));
    END IF;
    EXECUTE format('ALTER VIEW public.%I OWNER TO %I', r.relname, r.owner);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', r.relname);
    IF r.grants <> '' THEN EXECUTE r.grants; END IF;
  END LOOP;

  -- 2.10 Ownership + the pre-2026-09-04_00 grant posture.
  EXECUTE 'ALTER TABLE public.market_listings OWNER TO postgres';
  EXECUTE 'ALTER VIEW public.market_listings_v      OWNER TO postgres';
  EXECUTE 'ALTER VIEW public.unified_records        OWNER TO postgres';
  EXECUTE 'ALTER VIEW public.market_listings_summary OWNER TO postgres';
  EXECUTE 'ALTER VIEW public.v_market_listings      OWNER TO postgres';
  EXECUTE 'ALTER VIEW public.v_market_properties    OWNER TO postgres';

  EXECUTE 'REVOKE ALL ON public.market_listings_summary FROM PUBLIC, anon';
  EXECUTE 'GRANT ALL  ON public.market_listings_summary TO authenticated, service_role';
  EXECUTE 'REVOKE ALL ON public.v_market_listings   FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT ALL  ON public.v_market_listings   TO service_role';
  EXECUTE 'REVOKE ALL ON public.v_market_properties FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT ALL  ON public.v_market_properties TO service_role';
  EXECUTE 'REVOKE ALL ON public.market_listings     FROM PUBLIC, anon';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_listings TO authenticated';
  EXECUTE 'GRANT ALL ON public.market_listings TO service_role';
  EXECUTE 'GRANT SELECT ON public.market_listings_v TO authenticated, service_role';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_listings__features TO authenticated';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_listings__basic_info_missing_keys TO authenticated';

  RAISE NOTICE 'freeze baseline: fresh branch converged.';
END $converge$;

-- ---------------------------------------------------------------------------
-- 3. Assertions — run on BOTH branches. These are the contract with the
--    unmodified 2026-09-04_00: if any fails, that migration would have failed
--    later and more confusingly.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  v_md5 text;
BEGIN
  IF to_regclass('public.market_listings') IS NULL THEN
    RAISE EXCEPTION 'ASSERT: market_listings absent after the baseline';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.market_listings'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'ASSERT: RLS is not enabled on market_listings';
  END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='public.market_listings'::regclass
        AND attnum>0 AND NOT attisdropped) <> 91 THEN
    RAISE EXCEPTION 'ASSERT: market_listings must have exactly 91 columns, found %',
      (SELECT count(*) FROM pg_attribute WHERE attrelid='public.market_listings'::regclass AND attnum>0 AND NOT attisdropped);
  END IF;

  -- 3.1 The four frozen predicates.
  SELECT md5(pg_get_expr(polqual,polrelid)) INTO v_md5 FROM pg_policy
   WHERE polrelid='public.market_listings'::regclass AND polname='frozen_view';
  IF v_md5 IS DISTINCT FROM '6087e8fdcfcb9f3df3da7898c1163c18' THEN
    RAISE EXCEPTION 'ASSERT: frozen_view predicate md5 % <> 6087e8fdcfcb9f3df3da7898c1163c18 — 2026-09-04_00 would refuse this database', v_md5;
  END IF;
  SELECT md5(pg_get_expr(polqual,polrelid)) INTO v_md5 FROM pg_policy
   WHERE polrelid='public.market_listings'::regclass AND polname='frozen_update';
  IF v_md5 IS DISTINCT FROM '9f0255206b5395282618aa80bd147719' THEN
    RAISE EXCEPTION 'ASSERT: frozen_update predicate md5 % <> 9f0255206b5395282618aa80bd147719 (derivation from frozen_view is wrong)', v_md5;
  END IF;
  SELECT md5(pg_get_expr(polqual,polrelid)) INTO v_md5 FROM pg_policy
   WHERE polrelid='public.market_listings'::regclass AND polname='frozen_delete';
  IF v_md5 IS DISTINCT FROM '5c85c440b19c5541a150f8b6f57922a5' THEN
    RAISE EXCEPTION 'ASSERT: frozen_delete predicate md5 % <> 5c85c440b19c5541a150f8b6f57922a5', v_md5;
  END IF;
  SELECT md5(pg_get_expr(polwithcheck,polrelid)) INTO v_md5 FROM pg_policy
   WHERE polrelid='public.market_listings'::regclass AND polname='frozen_insert';
  IF v_md5 IS DISTINCT FROM '4928c9574ded1309015b08236950b256' THEN
    RAISE EXCEPTION 'ASSERT: frozen_insert withcheck md5 % <> 4928c9574ded1309015b08236950b256', v_md5;
  END IF;

  -- 3.2 The three views 2026-09-04_00 pins, plus the generated pair.
  IF md5(pg_get_viewdef('public.market_listings_summary'::regclass)) <> '0ddd7ab480fcf167ca9d684d9c1f2db6' THEN
    RAISE EXCEPTION 'ASSERT: market_listings_summary viewdef md5 mismatch (got %)', md5(pg_get_viewdef('public.market_listings_summary'::regclass));
  END IF;
  IF md5(pg_get_viewdef('public.v_market_listings'::regclass)) <> '3675d4c9bab1019312eae01035ab18ba' THEN
    RAISE EXCEPTION 'ASSERT: v_market_listings viewdef md5 mismatch (got %)', md5(pg_get_viewdef('public.v_market_listings'::regclass));
  END IF;
  IF md5(pg_get_viewdef('public.v_market_properties'::regclass)) <> '416a3eaac713f2eaf27d46f8867c5d4a' THEN
    RAISE EXCEPTION 'ASSERT: v_market_properties viewdef md5 mismatch (got %)', md5(pg_get_viewdef('public.v_market_properties'::regclass));
  END IF;
  IF md5(pg_get_viewdef('public.market_listings_v'::regclass)) <> '09af7a872c06f8d3acc81b7ebe5c82ec' THEN
    RAISE EXCEPTION 'ASSERT: market_listings_v viewdef md5 mismatch (got %)', md5(pg_get_viewdef('public.market_listings_v'::regclass));
  END IF;

  -- 3.3 The five-way union.
  IF md5(pg_get_viewdef('public.unified_records'::regclass)) <> '74602527636617c3549508a67fcc220d' THEN
    RAISE EXCEPTION 'ASSERT: unified_records is not the pinned five-way union (got %)', md5(pg_get_viewdef('public.unified_records'::regclass));
  END IF;

  -- 3.4 The three pinned views must be plain views owned by postgres.
  IF (SELECT count(*) FROM pg_class
       WHERE relname IN ('market_listings_summary','v_market_listings','v_market_properties')
         AND relnamespace='public'::regnamespace AND relkind='v'
         AND pg_get_userbyid(relowner)='postgres') <> 3 THEN
    RAISE EXCEPTION 'ASSERT: the three pinned views must be plain views owned by postgres';
  END IF;

  -- 3.5 The summary must never expose source_payload (2026-09-04_00 §2.7).
  IF pg_get_viewdef('public.market_listings_summary'::regclass) ~* 'source_payload' THEN
    RAISE EXCEPTION 'ASSERT: market_listings_summary exposes source_payload';
  END IF;

  -- 3.6 The model row is frozen.
  IF NOT EXISTS (SELECT 1 FROM public.models
                  WHERE id='8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid
                    AND is_hardcoded AND table_name='market_listings') THEN
    RAISE EXCEPTION 'ASSERT: models row is not marked frozen for market_listings';
  END IF;
END $assert$;

COMMIT;
