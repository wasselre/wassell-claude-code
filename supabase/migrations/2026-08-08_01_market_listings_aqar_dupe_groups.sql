-- ============================================================================
-- Market Listings — give Aqar the duplicate grouping every other source has,
-- and repair what freezing the model broke.
--
-- WHAT CHANGED UNDER US
--
-- On 2026-08-07 market_listings was FROZEN (JSONB in `records` -> the physical
-- `public.market_listings` table) and grew to four sources: aqar 57,549,
-- bayut 120,234, dubizzle 118,205, propertyfinder 18,082.
--
-- The freeze carried deed_number / ad_license_number / advertiser_phone across,
-- but it did NOT carry the property identity added on 2026-07-29
-- (2026-08-30_01_market_listings_property_identity.sql — property_key /
-- property_tier / property_split). Those columns do not exist on the frozen
-- table, and both triggers plus market_listing_set_split still point at
-- `records`, which now holds ZERO rows for this model. So:
--
--   * the grouping shipped in a3517d5d is SILENTLY OFF. The SPA still groups on
--     `property_key` (src/lib/marketListings/propertyGroups.ts), nothing supplies
--     it any more, so every row becomes its own group. It fails safe — the list
--     just shows all 314,070 ads again — which is why nobody noticed.
--   * market_listing_set_split UPDATEs `records`, matches 0 rows, and reports
--     success. The split button does nothing.
--
-- WHY THIS DOES NOT RESTORE property_key
--
-- The frozen table already carries `dupe_group_id` / `dupe_role`
-- (canonical|duplicate), filled by the importer that brought in the UAE portals:
-- 256,521 rows, 168,242 groups, keyed `pk_<permit_number>` — the RERA permit,
-- which is the UAE twin of the REGA licence. 2,115 of those groups span more
-- than one source, so it is genuinely cross-portal, the same job property_key
-- was doing for Aqar.
--
-- Two columns for one concept is the "two dedup mechanisms" problem already
-- flagged in docs/prd/market-intelligence.md. So Aqar joins the EXISTING column
-- instead: 0 of 57,549 Aqar rows had a dupe_group_id, i.e. Aqar is the only
-- source with no duplicate detection at all.
--
-- THE AQAR KEY is the one validated on 2026-07-29 against deed ground truth,
-- unchanged — deed + floor(area) + coords@4dp, else coords@4dp + floor(area):
--   * deed alone over-collapses (one deed spans 228 rows / 30 areas — a compound
--     sharing one land deed); deed+area without coordinates merged 68 listings
--     spread over 3 km.
--   * property_type is deliberately excluded: -13 points of recall (93%->79%)
--     for +0.6 of precision, because Aqar labels one plot سكني / أرض / أراضي /
--     قطعة أرض interchangeably.
--   * coords stay at 4dp (~11 m); 3dp (~111 m) nearly triples false merges
--     (11.8% -> 27.9%).
-- Prefixes `dn_` / `ga_` keep these keys in a different namespace from the
-- importer's `pk_`, so an Aqar row can never be merged into a UAE permit group
-- by accident.
--
-- NOT DONE ON PURPOSE: market_listing_merge is not repointed at the frozen
-- table. All four sources were written within the last 2 days, including every
-- Aqar row, so the aqar-scraper's PostgREST push has been superseded by whatever
-- importer now owns the table. Repointing it would be maintaining a dead path.
-- It is made to FAIL LOUDLY instead (see step 6) rather than keep returning 200
-- while updating nothing.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The user's "these are not the same property" override. Replaces
--    property_split, which the freeze dropped. NULL rather than false for the
--    default so the column costs nothing on 314k rows.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.market_listings
  ADD COLUMN IF NOT EXISTS dupe_split boolean;

COMMENT ON COLUMN public.market_listings.dupe_split IS
  'User override: true = do not group this listing with its dupe_group_id peers. '
  'Set only via market_listing_set_split().';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The Aqar key. Row-local and IMMUTABLE so a bulk update and a single-row
--    write can never disagree.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.market_listing_aqar_dupe_key(
  p_deed text,
  p_area numeric,
  p_lat  numeric,
  p_lng  numeric
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
  SELECT CASE
    WHEN NULLIF(btrim(COALESCE(p_deed, '')), '') IS NOT NULL
     AND p_area > 0 AND p_lat IS NOT NULL AND p_lng IS NOT NULL
      THEN 'dn_' || btrim(p_deed) || '_' || floor(p_area)::text
                 || '_' || round(p_lat, 4)::text || '_' || round(p_lng, 4)::text
    WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL AND p_area > 0
      THEN 'ga_' || round(p_lat, 4)::text || '_' || round(p_lng, 4)::text
                 || '_' || floor(p_area)::text
    -- No deed and no usable coordinates: stands alone. NULL, never a synthetic
    -- per-row key, so `GROUP BY dupe_group_id` can't invent a group.
    ELSE NULL
  END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Keep new Aqar writes keyed. Scoped to source='aqar' by the WHEN clause —
--    every other source is keyed by its own importer and must not be touched.
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_market_listings_dupe_group_id
  ON public.market_listings (dupe_group_id);

CREATE OR REPLACE FUNCTION public.fill_market_listing_aqar_dupe_group()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  k text;
BEGIN
  k := public.market_listing_aqar_dupe_key(NEW.deed_number, NEW.area, NEW.latitude, NEW.longitude);
  NEW.dupe_group_id := k;
  IF k IS NULL THEN
    NEW.dupe_role := NULL;
  ELSIF EXISTS (
    SELECT 1 FROM public.market_listings
     WHERE dupe_group_id = k AND dupe_role = 'canonical' AND id <> NEW.id
  ) THEN
    NEW.dupe_role := 'duplicate';
  ELSE
    NEW.dupe_role := 'canonical';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS market_listings_fill_aqar_dupe_group ON public.market_listings;
CREATE TRIGGER market_listings_fill_aqar_dupe_group
  BEFORE INSERT OR UPDATE ON public.market_listings
  FOR EACH ROW
  WHEN (NEW.source = 'aqar')
  EXECUTE FUNCTION public.fill_market_listing_aqar_dupe_group();

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The split, repointed at the frozen table.
--    SECURITY INVOKER: the frozen_update RLS policy is the gate, same as any
--    other edit to a listing.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.market_listing_set_split(
  p_ids   uuid[],
  p_split boolean
) RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.market_listings
     SET dupe_split = CASE WHEN p_split THEN true ELSE NULL END
   WHERE id = ANY (p_ids)
     AND COALESCE(dupe_split, false) IS DISTINCT FROM p_split;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

GRANT EXECUTE ON FUNCTION public.market_listing_set_split(uuid[], boolean) TO authenticated;

COMMIT;

-- ============================================================================
-- 5. BACKFILL — outside the transaction above, triggers suppressed for THIS
--    SESSION ONLY (session_replication_role is session-scoped; concurrent
--    writers keep their triggers). Same posture as the 2026-07-29 backfill: a
--    plain UPDATE across 57k rows would fire the version bump, the updated_at
--    touch and the listing_points sync for every row, making a pure backfill
--    look like real activity.
-- ============================================================================
BEGIN;

SET LOCAL session_replication_role = 'replica';

UPDATE public.market_listings
   SET dupe_group_id = public.market_listing_aqar_dupe_key(deed_number, area, latitude, longitude)
 WHERE source = 'aqar';

-- One canonical per group, the rest duplicates. Prefer an ACTIVE listing as the
-- canonical (a delisted ad is a poor representative), then the most recently
-- updated, then id for determinism.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY dupe_group_id
           ORDER BY (is_active IS NOT TRUE), updated_at DESC NULLS LAST, id
         ) AS rn
  FROM public.market_listings
  WHERE source = 'aqar' AND dupe_group_id IS NOT NULL
)
UPDATE public.market_listings m
   SET dupe_role = CASE WHEN r.rn = 1 THEN 'canonical' ELSE 'duplicate' END
  FROM ranked r
 WHERE m.id = r.id;

COMMIT;

-- ============================================================================
-- 6. Retire what the freeze orphaned, LOUDLY rather than silently.
--
-- These two triggers sit on `records`, which has no market_listings rows any
-- more, and market_listing_merge UPDATEs `records` — matching nothing and
-- returning success. A write path that reports 200 while changing nothing is
-- exactly the silent-failure pattern CLAUDE.md warns about, so the merge RPC now
-- raises instead. Any caller still on it (aqar-scraper crmClient.patch,
-- bulkFetch.mjs) gets a clear error naming the cause.
-- ============================================================================
DROP TRIGGER IF EXISTS records_fill_market_property_identity ON public.records;
DROP TRIGGER IF EXISTS records_fill_market_enrichment_guard  ON public.records;
DROP FUNCTION IF EXISTS public.fill_market_listing_property_identity();
DROP FUNCTION IF EXISTS public.preserve_market_listing_enrichment();
DROP FUNCTION IF EXISTS public.market_listing_bridge_property_keys();
DROP FUNCTION IF EXISTS public.market_listing_property_identity(jsonb);

CREATE OR REPLACE FUNCTION public.market_listing_merge(p_id uuid, p_patch jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION
    'market_listing_merge is retired: market_listings was frozen on 2026-08-07 '
    'and no longer lives in public.records, so this call updated nothing while '
    'returning success. Write to public.market_listings (or go through the '
    'record_save dispatcher) instead.'
    USING ERRCODE = 'raise_exception';
END $function$;
