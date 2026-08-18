-- ============================================================================
-- Phase 3 · Aqar ingestion · 02 · Controlled canonical publisher
-- IDEMPOTENT: safe to re-apply (verified by CI).
-- ----------------------------------------------------------------------------
-- OWNER/PURPOSE: Gate A intentionally shipped WITHOUT a canonical market_listings
-- writer (docs/market-ingest/gate-a.md §12). This migration supplies the ONE
-- controlled publishing path: public.market_listing_publish(...), an owner-run
-- SECURITY DEFINER RPC granted to service_role only.
--
-- SAFETY POSTURE (this table is the FROZEN, customer-facing market_listings —
-- 314k rows, 4.5 GB):
--   * Publishing is DISABLED by default. A row publishes ONLY when its source is
--     is_active AND publishing_enabled AND the (source,external_id) is on the
--     canary allowlist (public.market_publish_allowlist).
--   * Every canonical column write is GATED on an authoritative
--     source_field_mappings decision (status='mapped_existing_field'); a field
--     with no such decision is never written. Governance owns the mapping.
--   * Identity is deterministic (source,external_id): 0 matches → INSERT, 1 →
--     UPDATE preserving the id, >1 → AMBIGUOUS, rejected + quarantined. We do
--     NOT add a UNIQUE constraint here — an ACCESS EXCLUSIVE index build on a
--     4.5 GB frozen table is a production hazard; it is deferred to a separate
--     CREATE UNIQUE INDEX CONCURRENTLY after a dedup audit. The idx_ml_source_ext
--     lookup index already backs the identity SELECT.
--   * Destructive/uncertain changes (a >50% price swing, or a previously-non-null
--     field going null) are sent to listing_change_review and NOT applied.
--   * Touches exactly ONE listing per call — no mass update/delete is possible.
--   * Writes listing_change_events (audit), listing_field_provenance, and the
--     mirror_outbox row in the SAME transaction as the listing change.
--
-- No AI, no scoring/ranking. FORWARD RECOVERY: DROP the function + allowlist
-- table; the seeded source_field_mappings rows are governance data (retain).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(n, ', ' ORDER BY n) INTO v_missing
    FROM unnest(ARRAY[
      'market_listings','listing_sources','source_field_mappings','ingestion_items',
      'listing_change_events','listing_change_review','listing_field_provenance','mirror_outbox']) AS n
   WHERE to_regclass('public.'||n) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: object(s) absent: %. Apply the Gate A chain, the freeze baseline/_06, and 2026-09-06_01 first.', v_missing;
  END IF;
END $preflight$;

-- ── canary allowlist ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.market_publish_allowlist (
  source       text        NOT NULL REFERENCES public.listing_sources(source_key) ON DELETE CASCADE,
  external_id  text        NOT NULL CHECK (btrim(external_id) <> ''),
  note         text,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, external_id)
);
COMMENT ON TABLE public.market_publish_allowlist IS 'Phase3: explicit (source,external_id) allowlist gating the canary publisher. Empty = nothing publishes.';

ALTER TABLE public.market_publish_allowlist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_publish_allowlist_read ON public.market_publish_allowlist;
CREATE POLICY market_publish_allowlist_read ON public.market_publish_allowlist
  FOR SELECT TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())));
-- §12b ACL discipline: revoke inherited defaults, keep SELECT only.
REVOKE ALL ON public.market_publish_allowlist FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.market_publish_allowlist FROM authenticated, service_role;
GRANT SELECT ON public.market_publish_allowlist TO authenticated, service_role;

-- ── seed the authoritative aqar v001 mappings (source_path → canonical_field). ─
-- canonical_field == the market_listings column the publisher writes. Fields with
-- no direct column (rooms, area_unit, city, region, district, country) are recorded
-- as review_required / reviewed_source_specific — captured in evidence, not written.
INSERT INTO public.source_field_mappings (platform, source_path, contract_version, status, canonical_field, reviewer, reason, decided_at) VALUES
  ('aqar','jsonld.name','v001','mapped_existing_field','title',NULL,NULL,NULL),
  ('aqar','jsonld.description','v001','mapped_existing_field','description',NULL,NULL,NULL),
  ('aqar','offers.price','v001','mapped_existing_field','price',NULL,NULL,NULL),
  ('aqar','offers.itemOffered.floorSize.value','v001','mapped_existing_field','area',NULL,NULL,NULL),
  ('aqar','offers.itemOffered.numberOfBedrooms','v001','mapped_existing_field','bedrooms',NULL,NULL,NULL),
  ('aqar','offers.itemOffered.numberOfBathroomsTotal','v001','mapped_existing_field','bathrooms',NULL,NULL,NULL),
  ('aqar','url.category','v001','mapped_existing_field','property_type',NULL,NULL,NULL),
  ('aqar','url.category.raw','v001','mapped_existing_field','category',NULL,NULL,NULL),
  ('aqar','offers.itemOffered.geo.latitude','v001','mapped_existing_field','latitude',NULL,NULL,NULL),
  ('aqar','offers.itemOffered.geo.longitude','v001','mapped_existing_field','longitude',NULL,NULL,NULL),
  ('aqar','jsonld.image','v001','mapped_existing_field','image_urls',NULL,NULL,NULL),
  ('aqar','video.contentUrl','v001','mapped_existing_field','video_urls',NULL,NULL,NULL),
  ('aqar','offers.itemOffered.address.streetAddress','v001','mapped_existing_field','street_name',NULL,NULL,NULL),
  ('aqar','url.self','v001','mapped_existing_field','source_url',NULL,NULL,NULL),
  ('aqar','jsonld.datePosted','v001','mapped_existing_field','source_last_updated_at',NULL,NULL,NULL),
  ('aqar','offers.itemOffered.numberOfRooms','v001','review_required',NULL,NULL,NULL,NULL),
  ('aqar','offers.itemOffered.address.addressLocality','v001','reviewed_source_specific',NULL,'system','no canonical text column for district; geo lat/long carries location',now())
ON CONFLICT (platform, source_path, contract_version) DO NOTHING;

-- ── the publisher ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.market_listing_publish(
  p_source text, p_external_id text, p_canonical jsonb,
  p_snapshot_id uuid DEFAULT NULL, p_adapter_version text DEFAULT NULL, p_ingestion_item_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_active boolean; v_enabled boolean; v_allowed boolean;
  v_latest text; v_mapped text[];
  v_id uuid; v_match_count int; v_action text;
  v_old public.market_listings%ROWTYPE;
  v_title text; v_price numeric; v_area numeric; v_beds numeric; v_baths numeric;
  v_ptype text; v_cat text; v_lat numeric; v_long numeric; v_street text; v_surl text;
  v_imgs jsonb; v_vids jsonb; v_posted timestamptz;
  v_destructive boolean := false; v_reason text;
  v_diff jsonb; v_prov jsonb; v_gapcount int;
BEGIN
  -- (0) source must exist
  SELECT is_active, publishing_enabled INTO v_active, v_enabled
    FROM public.listing_sources WHERE source_key = p_source;
  IF v_active IS NULL THEN RAISE EXCEPTION 'market_listing_publish: unknown source %', p_source USING ERRCODE='foreign_key_violation'; END IF;

  -- (1) gate: active AND publishing_enabled AND allowlisted — else controlled no-op
  SELECT EXISTS (SELECT 1 FROM public.market_publish_allowlist a WHERE a.source=p_source AND a.external_id=p_external_id)
    INTO v_allowed;
  IF NOT v_active OR NOT v_enabled OR NOT v_allowed THEN
    RETURN jsonb_build_object('published', false,
      'reason', CASE WHEN NOT v_active THEN 'source_inactive'
                     WHEN NOT v_enabled THEN 'publishing_disabled'
                     ELSE 'not_allowlisted' END);
  END IF;

  -- (2) authoritative mapped canonical fields for the latest contract version
  SELECT max(contract_version) INTO v_latest FROM public.source_field_mappings WHERE platform=p_source;
  v_mapped := ARRAY(SELECT DISTINCT canonical_field FROM public.source_field_mappings
                     WHERE platform=p_source AND contract_version=v_latest
                       AND status='mapped_existing_field' AND canonical_field IS NOT NULL);

  -- extract candidate values, each gated on an authoritative mapping decision
  v_title := CASE WHEN 'title'          = ANY(v_mapped) THEN nullif(p_canonical->>'title','') END;
  v_price := CASE WHEN 'price'          = ANY(v_mapped) THEN (p_canonical->>'price')::numeric END;
  v_area  := CASE WHEN 'area'           = ANY(v_mapped) THEN (p_canonical->>'area')::numeric END;
  v_beds  := CASE WHEN 'bedrooms'       = ANY(v_mapped) THEN (p_canonical->>'bedrooms')::numeric END;
  v_baths := CASE WHEN 'bathrooms'      = ANY(v_mapped) THEN (p_canonical->>'bathrooms')::numeric END;
  v_ptype := CASE WHEN 'property_type'  = ANY(v_mapped) THEN nullif(p_canonical->>'property_type','') END;
  v_cat   := CASE WHEN 'category'       = ANY(v_mapped) THEN nullif(p_canonical->>'property_category','') END;
  v_lat   := CASE WHEN 'latitude'       = ANY(v_mapped) THEN (p_canonical->>'latitude')::numeric END;
  v_long  := CASE WHEN 'longitude'      = ANY(v_mapped) THEN (p_canonical->>'longitude')::numeric END;
  v_street:= CASE WHEN 'street_name'    = ANY(v_mapped) THEN nullif(p_canonical->>'street','') END;
  v_surl  := CASE WHEN 'source_url'     = ANY(v_mapped) THEN nullif(p_canonical->>'listing_url','') END;
  v_posted:= CASE WHEN 'source_last_updated_at' = ANY(v_mapped) THEN (p_canonical->>'date_posted')::timestamptz END;
  v_imgs  := CASE WHEN 'image_urls'     = ANY(v_mapped) AND jsonb_typeof(p_canonical->'image_urls')='array' THEN p_canonical->'image_urls' END;
  v_vids  := CASE WHEN 'video_urls'     = ANY(v_mapped) AND nullif(p_canonical->>'video_url','') IS NOT NULL
                  THEN jsonb_build_array(p_canonical->>'video_url') END;

  -- (3) required-field validation → quarantine (critical), do not write
  IF v_title IS NULL OR v_price IS NULL THEN
    INSERT INTO public.listing_change_review (record_id, source, external_id, field, reason, criticality, snapshot_id)
      VALUES (NULL, p_source, p_external_id, 'required', 'missing required title/price', 'critical', p_snapshot_id);
    IF p_ingestion_item_id IS NOT NULL THEN
      UPDATE public.ingestion_items SET state='validation_failed', error='missing required title/price' WHERE id=p_ingestion_item_id;
    END IF;
    RETURN jsonb_build_object('published', false, 'reason', 'missing_required');
  END IF;

  -- (4) deterministic identity
  SELECT count(*) INTO v_match_count FROM public.market_listings WHERE source=p_source AND external_id=p_external_id;
  IF v_match_count > 1 THEN
    INSERT INTO public.listing_change_review (record_id, source, external_id, field, reason, criticality, snapshot_id)
      VALUES (NULL, p_source, p_external_id, 'identity', format('ambiguous identity: %s rows match', v_match_count), 'critical', p_snapshot_id);
    IF p_ingestion_item_id IS NOT NULL THEN
      UPDATE public.ingestion_items SET state='quarantined', error='ambiguous identity' WHERE id=p_ingestion_item_id;
    END IF;
    RETURN jsonb_build_object('published', false, 'reason', 'ambiguous_identity');
  END IF;

  IF v_match_count = 1 THEN
    SELECT * INTO v_old FROM public.market_listings WHERE source=p_source AND external_id=p_external_id;
    v_id := v_old.id; v_action := 'update';
    -- (5) destructive/uncertain guard → quarantine, do NOT apply
    IF (v_old.price IS NOT NULL AND v_price IS NOT NULL AND abs(v_price - v_old.price) > 0.5 * v_old.price)
       OR (v_old.title IS NOT NULL AND v_title IS NULL)
       OR (v_old.price IS NOT NULL AND v_price IS NULL) THEN
      v_destructive := true;
    END IF;
    IF v_destructive THEN
      INSERT INTO public.listing_change_review (record_id, source, external_id, field, before_value, after_value, reason, criticality, snapshot_id)
        VALUES (v_id, p_source, p_external_id, 'price/title',
                to_jsonb(v_old.price), to_jsonb(v_price), 'destructive change held for review', 'critical', p_snapshot_id);
      IF p_ingestion_item_id IS NOT NULL THEN
        UPDATE public.ingestion_items SET state='quarantined', error='destructive change' WHERE id=p_ingestion_item_id;
      END IF;
      RETURN jsonb_build_object('published', false, 'reason', 'quarantined_destructive', 'record_id', v_id);
    END IF;
  ELSE
    v_id := gen_random_uuid(); v_action := 'insert';
  END IF;

  -- (6) apply — INSERT or UPDATE the mapped columns only
  IF v_action = 'insert' THEN
    INSERT INTO public.market_listings
      (id, source, external_id, title, description, price, area, bedrooms, bathrooms,
       property_type, category, latitude, longitude, image_urls, video_urls, main_image_url,
       image_count, video_count, feature_count, street_name, source_url, source_last_updated_at,
       version, created_at, updated_at)
    VALUES
      (v_id, p_source, p_external_id, v_title,
       CASE WHEN 'description'=ANY(v_mapped) THEN nullif(p_canonical->>'description','') END,
       v_price, v_area, v_beds, v_baths, v_ptype, v_cat, v_lat, v_long,
       coalesce(v_imgs,'[]'::jsonb), coalesce(v_vids,'[]'::jsonb),
       v_imgs->>0,
       coalesce(jsonb_array_length(coalesce(v_imgs,'[]'::jsonb)),0),
       coalesce(jsonb_array_length(coalesce(v_vids,'[]'::jsonb)),0),
       coalesce(jsonb_array_length(coalesce(p_canonical->'features','[]'::jsonb)),0),
       v_street, v_surl, v_posted, 1, now(), now());
  ELSE
    UPDATE public.market_listings SET
      title       = coalesce(v_title, title),
      description  = CASE WHEN 'description'=ANY(v_mapped) AND p_canonical ? 'description' THEN nullif(p_canonical->>'description','') ELSE description END,
      price        = coalesce(v_price, price),
      area         = coalesce(v_area, area),
      bedrooms     = coalesce(v_beds, bedrooms),
      bathrooms    = coalesce(v_baths, bathrooms),
      property_type = coalesce(v_ptype, property_type),
      category     = coalesce(v_cat, category),
      latitude     = coalesce(v_lat, latitude),
      longitude    = coalesce(v_long, longitude),
      image_urls   = coalesce(v_imgs, image_urls),
      video_urls   = coalesce(v_vids, video_urls),
      main_image_url = coalesce(v_imgs->>0, main_image_url),
      image_count  = CASE WHEN v_imgs IS NOT NULL THEN jsonb_array_length(v_imgs) ELSE image_count END,
      video_count  = CASE WHEN v_vids IS NOT NULL THEN jsonb_array_length(v_vids) ELSE video_count END,
      street_name  = coalesce(v_street, street_name),
      source_url   = coalesce(v_surl, source_url),
      source_last_updated_at = coalesce(v_posted, source_last_updated_at),
      version      = coalesce(version,0) + 1,
      updated_at   = now()
    WHERE id = v_id;
  END IF;

  -- (7) provenance (one row per listing, overwritten) — mapped fields only
  v_prov := (SELECT jsonb_object_agg(cf, jsonb_build_object('tier','source','snapshot_id',p_snapshot_id,'adapter_version',p_adapter_version))
               FROM unnest(v_mapped) AS cf);
  INSERT INTO public.listing_field_provenance (record_id, field_provenance, updated_at)
    VALUES (v_id, coalesce(v_prov,'{}'::jsonb), now())
  ON CONFLICT (record_id) DO UPDATE SET field_provenance = EXCLUDED.field_provenance, updated_at = now();

  -- (8) append-only change event
  v_diff := jsonb_strip_nulls(jsonb_build_object(
    'price', jsonb_build_object('before', to_jsonb(v_old.price), 'after', to_jsonb(v_price)),
    'title', jsonb_build_object('before', to_jsonb(v_old.title), 'after', to_jsonb(v_title))));
  INSERT INTO public.listing_change_events (record_id, source, external_id, actor, kind, reason, adapter_version, raw_snapshot_id, diff)
    VALUES (v_id, p_source, p_external_id, 'system:'||p_source, 'system_publish', v_action, p_adapter_version, p_snapshot_id, coalesce(v_diff,'{}'::jsonb));

  -- (9) transactional photo-mirror outbox (dedup on image set)
  IF v_imgs IS NOT NULL AND jsonb_array_length(v_imgs) > 0 THEN
    INSERT INTO public.mirror_outbox (record_id, image_urls_hash)
      VALUES (v_id, encode(digest(v_imgs::text,'sha256'),'hex'))
    ON CONFLICT (record_id, image_urls_hash) DO NOTHING;
  END IF;

  -- (10) advance the ingestion item (published, or published_with_schema_gaps)
  IF p_ingestion_item_id IS NOT NULL THEN
    SELECT count(*) INTO v_gapcount FROM public.schema_gap_events
      WHERE platform=p_source AND status IN ('open','notified','in_review');
    UPDATE public.ingestion_items
       SET state = CASE WHEN v_gapcount > 0 THEN 'published_with_schema_gaps' ELSE 'published' END,
           error = NULL
     WHERE id = p_ingestion_item_id;
  END IF;

  RETURN jsonb_build_object('published', true, 'record_id', v_id, 'action', v_action);
END $$;
COMMENT ON FUNCTION public.market_listing_publish(text,text,jsonb,uuid,text,uuid)
  IS 'Phase3: controlled canonical publisher — allowlist+publishing_enabled gated, source_field_mappings-governed, identity-safe, quarantines destructive changes, writes audit/provenance/outbox. service_role-only.';

-- §12b ACL: EXECUTE for service_role only.
DO $lock$
DECLARE v_fn text := 'public.market_listing_publish(text,text,jsonb,uuid,text,uuid)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn); END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_fn); END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn); END IF;
END $lock$;

COMMIT;
