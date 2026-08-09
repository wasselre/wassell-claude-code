-- ─────────────────────────────────────────────────────────────────────────
-- market_listings freeze fallout, wave 3 — WRITE paths
--
-- Companion to 2026-08-09_01 (read paths). This one moves the two trigger-
-- driven maintenance jobs off `public.records`, where the freeze left them
-- pointing at zero rows:
--
--   1. Quality signals. `fill_market_listing_extras_signals` is still a BEFORE
--      trigger on `records` scoped by a WHEN clause to the market model, so it
--      has not fired once since 2026-08-07. Measured gap: 168,715 of 314,070
--      rows carry no quality_score — aqar 57,549/57,549 (all pre-freeze), but
--      propertyfinder 100/18,082, dubizzle 29,846/118,205, bayut 57,860/120,234.
--
--   2. The listing photo mirror. Its enqueue trigger is likewise still on
--      `records`, and all four listing_mirror_* RPCs read/write `records`.
--      Worse, `image_mirror_map` was a trigger-maintained JSONB key and never
--      a schema field, so freeze_model dropped it: 0 of 314,070 rows carry one,
--      which orphans the 9,509 objects already sitting in the listing-photos
--      bucket.
--
-- WHERE THE MIRROR MAP LIVES NOW. There is no image_mirror_map column and
-- adding one would mean frozen-table DDL plus a models.schema update plus an
-- artifact regen. It goes in `custom_data` instead — the hybrid-overflow jsonb
-- column the freeze already provides. Both market_listings_v and
-- market_listings_summary end their projection with `|| COALESCE(custom_data,
-- '{}')`, so `data->'image_mirror_map'` resolves for every existing reader
-- exactly as it did pre-freeze. The READER contract is unchanged; only the
-- write target moves. Same home is available for video_mp4_map and the
-- rega_lookup_* lifecycle keys when their workers are repointed.
--
-- Realtime note: market_listings is NOT in the supabase_realtime publication
-- (only `records` is), so the backfill below cannot fan out to clients. That
-- also means live updates for this model no longer reach the SPA at all — a
-- separate freeze casualty, deliberately NOT changed here.
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Quality + extras signals, on the frozen table ─────────────────────
--
-- Column-native port of fill_market_listing_extras_signals. Two deliberate
-- carry-overs from the original:
--   • extras run BEFORE quality, because quality reads deed_number and
--     street_width, which extras can set.
--   • a value found in scraped_extras WINS over what is already on the row
--     (the original did `NEW.data := NEW.data || jsonb_strip_nulls(patch)`),
--     so the coalesce order is coalesce(found, existing) — not the reverse.
--
-- market_listing_quality reads d->'location'->>'district', and `location` is a
-- text column holding a JSON string, so to_jsonb(NEW) has to go through
-- _market_normalize_location or every row scores as if it had no district.
CREATE OR REPLACE FUNCTION public.market_listings_fill_extras_signals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  q jsonb;
BEGIN
  IF jsonb_typeof(NEW.scraped_extras) = 'array' THEN
    SELECT
      coalesce(max(CASE WHEN e->>'raw_label' = 'المشاهدات'
                         AND e->>'details' ~ '^[0-9]+$'
                        THEN (e->>'details')::numeric END), NEW.views_count),
      coalesce(max(CASE WHEN e->>'raw_label' = 'رقم الصك'
                         AND coalesce(e->>'details', '') <> ''
                        THEN e->>'details' END), NEW.deed_number),
      coalesce(max(CASE WHEN e->>'raw_label' = 'عرض الشارع'
                         AND e->>'details' ~ '^[0-9]+(\.[0-9]+)?$'
                        THEN (e->>'details')::numeric END), NEW.street_width)
      INTO NEW.views_count, NEW.deed_number, NEW.street_width
    FROM jsonb_array_elements(NEW.scraped_extras) e;
  END IF;

  q := public.market_listing_quality(
         public._market_normalize_location(to_jsonb(NEW)));

  NEW.quality_score     := (q->>'quality_score')::numeric;
  NEW.quality_grade     := q->>'quality_grade';
  NEW.quality_breakdown := q->'quality_breakdown';

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS market_listings_fill_extras_signals ON public.market_listings;
CREATE TRIGGER market_listings_fill_extras_signals
  BEFORE INSERT OR UPDATE ON public.market_listings
  FOR EACH ROW EXECUTE FUNCTION public.market_listings_fill_extras_signals();

-- The records-side trigger is WHEN-scoped to the market model, so it can never
-- fire again. Drop it rather than leave a decoy.
DROP TRIGGER IF EXISTS records_fill_market_extras_signals ON public.records;

-- ── 2. Mirror pipeline, repointed at the frozen table ────────────────────
--
-- image_urls is a text column holding a JSON array, hence try_jsonb; the map
-- lives at custom_data->'image_mirror_map'.

CREATE OR REPLACE FUNCTION public.listing_mirror_enqueue(p_listing_id uuid, p_reason text DEFAULT 'manual'::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job_id  uuid;
  v_urls    jsonb;
  v_map     jsonb;
  v_missing int;
  v_depth   int;
  v_cap     int;
BEGIN
  SELECT public.try_jsonb(m.image_urls),
         COALESCE(m.custom_data->'image_mirror_map', '{}'::jsonb)
    INTO v_urls, v_map
  FROM public.market_listings m
  WHERE m.id = p_listing_id;

  IF v_urls IS NULL OR jsonb_typeof(v_urls) <> 'array' THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_missing
  FROM jsonb_array_elements_text(v_urls) AS u(url)
  WHERE u.url ~ '^https?://'
    AND v_map -> u.url IS NULL;

  IF v_missing = 0 THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.generation_jobs
    WHERE record_id = p_listing_id
      AND kind = 'listing-mirror'
      AND status IN ('queued','running')
  ) THEN
    RETURN NULL;
  END IF;

  -- The queue-depth cap is load-bearing: without it one scanner catch-up run
  -- would queue tens of thousands of downloads through the shared me-central1
  -- proxy. Turning a listing away is free — the backlog lives in the DATA
  -- (image_mirror_map), so the next scan or the backfill script picks it up.
  SELECT s.max_queue_depth INTO v_cap FROM public.listing_mirror_settings s WHERE s.id;
  IF COALESCE(v_cap, 0) > 0 THEN
    SELECT count(*) INTO v_depth
    FROM public.generation_jobs
    WHERE kind = 'listing-mirror' AND status = 'queued';
    IF v_depth >= v_cap THEN
      RETURN NULL;
    END IF;
  END IF;

  v_job_id := gen_random_uuid();
  INSERT INTO public.generation_jobs (id, record_id, message_id, user_id, kind, status, prompt, params)
  VALUES (
    v_job_id, p_listing_id, NULL, NULL, 'listing-mirror', 'queued', NULL,
    jsonb_build_object('listing_id', p_listing_id, 'reason', p_reason, 'missing_at_enqueue', v_missing)
  );
  RETURN v_job_id;
END;
$function$;

-- Merges one sub-object inside a single row-locked UPDATE — no version check,
-- so it can never convoy against the scanner merge or the REGA worker writing
-- the same row (the clean_text_entry_patch lesson from 2026-07-18).
CREATE OR REPLACE FUNCTION public.listing_mirror_map_patch(p_listing_id uuid, p_patch jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows int;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'listing_mirror_map_patch: p_patch must be a jsonb object';
  END IF;

  UPDATE public.market_listings m
  SET custom_data = jsonb_set(
        COALESCE(m.custom_data, '{}'::jsonb),
        '{image_mirror_map}',
        COALESCE(m.custom_data->'image_mirror_map', '{}'::jsonb) || p_patch
      ),
      updated_at = now()
  WHERE m.id = p_listing_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'listing_mirror_map_patch: listing % not found', p_listing_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.listing_mirror_backlog(p_limit integer DEFAULT 500, p_active_only boolean DEFAULT true)
RETURNS TABLE(listing_id uuid, external_id text, missing integer, total integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT m.id,
         m.external_id,
         (SELECT count(*)::int
            FROM jsonb_array_elements_text(urls.j) AS u(url)
           WHERE u.url ~ '^https?://'
             AND COALESCE(m.custom_data->'image_mirror_map','{}'::jsonb) -> u.url IS NULL),
         jsonb_array_length(urls.j)
  FROM public.market_listings m
  CROSS JOIN LATERAL (SELECT public.try_jsonb(m.image_urls) AS j) urls
  -- Aqar-only, matching the enqueue trigger. The mirror exists solely because
  -- Aqar's Cloudflare 403s our datacenter egress by ASN; the UAE portals have
  -- no such block. Pre-freeze this needed no filter because market_listings
  -- WAS Aqar-only. Unscoped after the 4-source reshape it reported 295,545
  -- listings / 3,360,452 photos "pending" — and this function is what the
  -- operator-run scripts/backfill-listing-mirrors.mjs walks, so leaving it
  -- unscoped would push ~3.3M pointless UAE downloads through the shared
  -- me-central1 proxy that also hosts the WhatsApp gateway.
  WHERE COALESCE(m.source, 'aqar') = 'aqar'
    AND jsonb_typeof(urls.j) = 'array'
    AND jsonb_array_length(urls.j) > 0
    AND (NOT p_active_only OR COALESCE(m.is_active, true))
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(urls.j) AS u(url)
      WHERE u.url ~ '^https?://'
        AND COALESCE(m.custom_data->'image_mirror_map','{}'::jsonb) -> u.url IS NULL
    )
  ORDER BY m.created_at DESC
  LIMIT p_limit;
$function$;

CREATE OR REPLACE FUNCTION public.listing_mirror_stats(p_active_only boolean DEFAULT true)
RETURNS TABLE(listings_total integer, listings_pending integer, photos_total integer, photos_mirrored integer, photos_pending integer)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $function$
  WITH per_listing AS (
    SELECT m.id,
           count(*) FILTER (WHERE u.url ~ '^https?://')::int AS total,
           count(*) FILTER (
             WHERE u.url ~ '^https?://'
               AND COALESCE(m.custom_data->'image_mirror_map','{}'::jsonb) -> u.url IS NULL
           )::int AS missing
    FROM public.market_listings m
    CROSS JOIN LATERAL (SELECT public.try_jsonb(m.image_urls) AS j) urls
    CROSS JOIN LATERAL jsonb_array_elements_text(urls.j) AS u(url)
    WHERE COALESCE(m.source, 'aqar') = 'aqar'   -- see listing_mirror_backlog above
      AND jsonb_typeof(urls.j) = 'array'
      AND (NOT p_active_only OR COALESCE(m.is_active, true))
    GROUP BY m.id
  )
  SELECT count(*)::int,
         count(*) FILTER (WHERE missing > 0)::int,
         COALESCE(sum(total), 0)::int,
         COALESCE(sum(total - missing), 0)::int,
         COALESCE(sum(missing), 0)::int
  FROM per_listing;
$function$;

-- Enqueue trigger, moved to the frozen table. Guards preserved verbatim:
-- Aqar-only (the mirror exists because Aqar's CDN 403s our datacenter egress),
-- skip when image_urls did not change (keeps the weekly ~3,000-row price
-- reconcile free), and honour the kill switch.
CREATE OR REPLACE FUNCTION public.market_listings_enqueue_listing_mirror()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_enabled boolean;
BEGIN
  IF COALESCE(NEW.source, 'aqar') <> 'aqar' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.image_urls IS NOT DISTINCT FROM OLD.image_urls THEN
    RETURN NULL;
  END IF;

  SELECT s.is_enabled INTO v_enabled FROM public.listing_mirror_settings s WHERE s.id;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN NULL;
  END IF;

  PERFORM public.listing_mirror_enqueue(
    NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN 'scan-insert' ELSE 'scan-update' END);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS market_listings_enqueue_listing_mirror ON public.market_listings;
CREATE TRIGGER market_listings_enqueue_listing_mirror
  AFTER INSERT OR UPDATE ON public.market_listings
  FOR EACH ROW EXECUTE FUNCTION public.market_listings_enqueue_listing_mirror();

DROP TRIGGER IF EXISTS records_enqueue_listing_mirror ON public.records;

COMMIT;
