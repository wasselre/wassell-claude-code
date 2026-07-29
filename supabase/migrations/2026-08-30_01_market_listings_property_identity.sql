-- ============================================================================
-- Market Listings — property identity: one property, many broker listings.
--
-- THE PROBLEM
--
-- The same physical property is advertised by several brokers at once, and each
-- ad is its own row. Deed 717823000238 (a 750 m² plot in الخير) is five rows,
-- five different REGA licences, five different advertisers, asking 975,000 to
-- 1,100,002. Deed 310115001836 is another five. The list shows five listings;
-- there is one plot.
--
-- Measured on the 53,488 live rows before this migration:
--   • 33,353 rows carry a deed number; they cover only 17,612 distinct deeds
--   • under a strict key (deed + area + coords @4dp) 7,149 rows — 21.4% of the
--     deed-bearing set — are surplus copies of a property already listed
--
-- That inflates every supply count and drags every price-per-m² average toward
-- whichever property happens to be listed most often.
--
-- WHAT THIS DOES — group, never merge
--
-- Each listing gets a deterministic `property_key`. Rows sharing a key are the
-- same property; the UI collapses them into one card showing the agent count and
-- the asking-price spread. NO ROW IS DELETED OR REWRITTEN. The spread across
-- brokers is a sales signal (the real anchor on that الخير plot is 975,000, not
-- the 1.1M someone is asking), and a wrong grouping must stay reversible.
--
-- THE KEY — why it is shaped this way (all three decisions are measured)
--
-- 1. Deed FIRST, but NEVER deed alone — and not even deed + area. Deed alone
--    over-collapses: the worst deed in the live data is on 228 rows spanning 30
--    distinct areas — a compound where every unit shares one land deed. Adding
--    area is not enough either; that was tried against live data first and
--    collapsed 13,836 rows, including one group of 68 listings spread over
--    3,024 m × 3,334 m (a developer's master deed across a whole development,
--    priced 1.6M–4.5M) and another of 38 listings at 27 distinct spots held by
--    29 different agents. Coordinates at 4dp are therefore part of the tier-2
--    key: it collapses 7,149 rows with a worst intra-group span of 11 m.
--    Every deed-bearing row in the live set has usable coordinates and area
--    (verified: 0 exceptions), so requiring them costs no coverage.
--
-- 2. Geo + area as the fallback, at 4 decimal places (~11 m). Validated against
--    deed ground truth on the rows where the true answer is known:
--        key                     grouped   wrongly grouped   recall
--        deed + area (truth)       7,149          —            —
--        geo@4dp + area            7,506     882  (11.8%)      93%
--        geo@4dp + area + type     6,389     715  (11.2%)      79%
--        geo@3dp (~111m) + area    9,519   2,884  (27.9%)      —
--    So: 11 m is the operating point (111 m nearly triples the error), and
--    property_type is deliberately NOT in the key — it costs 13 points of recall
--    to buy 0.6 points of precision, because Aqar's types are inconsistent for
--    one plot ("سكني", "أرض", "أراضي", "قطعة أرض", "أرض سكنية (فلل)" all appear
--    on the same deed).
--
-- 3. floor(area), not round(). Across portals the same property's area is
--    truncated inconsistently (Wasalt 126.93 vs Aqar 126 for deed
--    2312636666500008). floor() matches those; a boundary case (126.99 vs
--    127.01) splits into two groups instead of merging — under-grouping is the
--    safe failure, over-grouping is not.
--
-- TIERS — what the key was resolved from, so the UI can say how sure it is:
--    2 = deed + area          → same property, high confidence, group silently
--    3 = geo + area           → probable (~88% precise), group but LABEL it and
--                               offer a split
--   (1 is reserved for a cross-portal ad_license_number match — the same
--    advertisement syndicated to two portals. Inside one portal a licence is
--    unique (33,357 distinct across 33,359 rows: each re-advertisement gets a
--    fresh licence), so tier 1 only starts firing when a second source lands.
--    market_listing_bridge_property_keys() below implements it, ready.)
--
-- WHY A TRIGGER, NOT A SCRAPER FIELD: the same posture as
-- records_fill_project_rollups — the database is authoritative, so no scraper
-- push, no backfill gap and no full-data overwrite can leave a row unkeyed.
--
-- market_listings is UNFROZEN (JSONB in `records`, model
-- 8f06bc39-4bee-42e9-9fab-77023fb89ede).
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The key function. Row-local and IMMUTABLE on purpose: no cross-row read,
--    so it is order-independent — a bulk insert can never produce a different
--    answer than a one-row update. try_numeric() (IMMUTABLE, returns NULL on
--    unparseable input) keeps one bad area or coordinate string from erroring
--    out a whole batch.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.market_listing_property_identity(d jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
  WITH v AS (
    SELECT
      NULLIF(btrim(COALESCE(d->>'deed_number', '')), '')                        AS deed,
      public.try_numeric(regexp_replace(COALESCE(d->>'area', ''), '[^0-9.]', '', 'g')) AS area,
      public.try_numeric(d->>'latitude')                                        AS lat,
      public.try_numeric(d->>'longitude')                                       AS lng
  )
  SELECT CASE
    WHEN v.deed IS NOT NULL AND v.area > 0 AND v.lat IS NOT NULL AND v.lng IS NOT NULL THEN
      jsonb_build_object(
        'property_key',  'D:' || v.deed || ':' || floor(v.area)::text
                              || ':' || round(v.lat, 4)::text || ':' || round(v.lng, 4)::text,
        'property_tier', 2)
    WHEN v.lat IS NOT NULL AND v.lng IS NOT NULL AND v.area > 0 THEN
      jsonb_build_object(
        'property_key',  'G:' || round(v.lat, 4)::text || ':' || round(v.lng, 4)::text
                              || ':' || floor(v.area)::text,
        'property_tier', 3)
    -- No deed and no usable coordinates: the row stands alone. NULL key (not a
    -- per-row synthetic one) so `GROUP BY property_key` never invents a group
    -- and the UI can fall back to rendering it as a single listing.
    ELSE jsonb_build_object('property_key', NULL, 'property_tier', NULL)
  END
  FROM v;
$$;

COMMENT ON FUNCTION public.market_listing_property_identity(jsonb) IS
  'Deterministic property grouping key for a market_listings data blob. '
  'Tier 2 = deed+area, tier 3 = geo@4dp+area. Never includes property_type '
  '(measured: -13pts recall for +0.6pts precision). See the migration header.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Fill it on every write. `property_split` is deliberately NOT touched
--    here — it is a user decision (see the split RPC below) and must survive
--    every subsequent scrape.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fill_market_listing_property_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
BEGIN
  NEW.data := NEW.data || public.market_listing_property_identity(NEW.data);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS records_fill_market_property_identity ON public.records;
CREATE TRIGGER records_fill_market_property_identity
  BEFORE INSERT OR UPDATE ON public.records
  FOR EACH ROW
  -- WHEN clause, not an IF inside the function: every other model's writes skip
  -- the function call entirely rather than paying a call + jsonb concat.
  WHEN (NEW.model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid)
  EXECUTE FUNCTION public.fill_market_listing_property_identity();

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Tier 1 — the cross-portal licence bridge.
--
--    A REGA advertising licence identifies ONE advertisement. When the same ad
--    is syndicated to two portals both rows carry the same licence number, so a
--    row that arrived without a deed can inherit the deed-based key of its twin.
--    Measured on a 384-listing Wasalt sample against the live Aqar set: licence
--    matched 19 of 50, deed matched 27, and licence matched NOTHING deed missed
--    — so this adds no recall today. It buys certainty (a licence match needs no
--    area/coordinate tolerance) and it is what will carry deed-less rows from a
--    second source. Idempotent; safe to re-run after every scraper push.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.market_listing_bridge_property_keys()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  v_model uuid := '8f06bc39-4bee-42e9-9fab-77023fb89ede';
  v_n     integer;
BEGIN
  WITH anchor AS (
    -- One deed-derived key per licence. DISTINCT ON keeps this deterministic if
    -- a licence ever maps to two deeds (measured today: never — max 1).
    SELECT DISTINCT ON (data->>'ad_license_number')
           data->>'ad_license_number' AS lic,
           data->>'property_key'      AS key
    FROM public.records
    WHERE model_id = v_model
      AND COALESCE(data->>'ad_license_number', '') <> ''
      AND (data->>'property_tier')::int = 2
    ORDER BY data->>'ad_license_number', id
  )
  UPDATE public.records r
     SET data = r.data || jsonb_build_object('property_key', a.key, 'property_tier', 1)
    FROM anchor a
   WHERE r.model_id = v_model
     AND r.data->>'ad_license_number' = a.lic
     AND COALESCE((r.data->>'property_tier')::int, 9) <> 2   -- never demote a deed row
     AND r.data->>'property_key' IS DISTINCT FROM a.key;     -- no-op writes skipped
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.market_listing_bridge_property_keys() FROM public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The split — a user pulling a group apart.
--
--    Targeted UPDATE, NOT a whole-record save. market_listings is a SUMMARY
--    model: the SPA only holds the slim projection in memory, so calling
--    saveRecord from the list would write that slim blob back and wipe every
--    heavy field (description, image_urls, …). Same reasoning as
--    clean_text_entry_patch — a list-level action patches one key.
--
--    SECURITY INVOKER: the records RLS UPDATE policy is the gate, exactly as it
--    is for any other edit to a listing.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.market_listing_set_split(
  p_ids   uuid[],
  p_split boolean
)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.records
     SET data = CASE
                  WHEN p_split THEN data || jsonb_build_object('property_split', true)
                  ELSE data - 'property_split'
                END
   WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'
     AND id = ANY (p_ids)
     AND COALESCE((data->>'property_split')::boolean, false) IS DISTINCT FROM p_split;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

GRANT EXECUTE ON FUNCTION public.market_listing_set_split(uuid[], boolean) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Index for grouping reads. Partial on the model so it stays small and is
--    only consulted for market listings.
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_records_market_property_key
  ON public.records ((data->>'property_key'))
  WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede';

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Stop the daily push from ERASING the identity fields this all rests on.
--
-- market_listing_merge already existed (bulkFetch.mjs uses it, precisely "so
-- enrichment-owned fields are never clobbered") — but the daily push never used
-- it. pushToCrm did `PATCH /records {data:{...}}`, which REPLACES the whole
-- JSONB column with build()'s 35 keys. deed_number / ad_license_number /
-- scraped_extras are written only by the one-off enrichment, so every touched
-- row lost them: of the 3,350 rows the 2026-07-26 reconcile updated, exactly ONE
-- still had a deed afterwards. Deed coverage was decaying ~3,000 rows a week —
-- and the same overwrite wiped property_split plus the REGA worker's
-- advertiser_phone / rega_lookup_* set.
--
-- Adding jsonb_strip_nulls lets the daily push route through this RPC safely:
-- a key the scraper has no value for is left alone instead of nulled.
-- (The scraper side is aqar-scraper/src/sync/crmClient.ts `patch()`.)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.market_listing_merge(p_id uuid, p_patch jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_patch jsonb;
  k text;
BEGIN
  v_patch := jsonb_strip_nulls(p_patch);
  -- ...except where an explicit null IS the new value: a listing that came back
  -- from 'sold' to 'active' must lose its sold_at.
  FOREACH k IN ARRAY ARRAY['sold_at'] LOOP
    IF p_patch ? k THEN v_patch := v_patch || jsonb_build_object(k, p_patch -> k); END IF;
  END LOOP;

  UPDATE public.records
     SET data = data || v_patch,
         updated_at = now()
   WHERE id = p_id
     AND model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede';
END $function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 6b. Belt AND braces: make the enrichment fields sticky at the DB level.
--
-- Step 6 fixes the scraper, but the scraper is a separately-deployed Fly app —
-- until it ships, every reconcile keeps erasing deeds, and any FUTURE writer
-- that replaces `data` wholesale would reintroduce the same bug. None of these
-- keys is ever produced by a scrape: they come from the one-off bulkFetch
-- enrichment, the REGA lookup worker, or the user (property_split). So the
-- database refuses to let an UPDATE drop them.
--
-- Trigger NAME matters: Postgres fires per-row triggers alphabetically, and
-- "..._enrichment_guard" sorts before "..._property_identity", so the deed is
-- back in NEW.data before the property key is computed from it.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preserve_market_listing_enrichment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $$
DECLARE k text;
BEGIN
  FOREACH k IN ARRAY ARRAY[
    'deed_number','ad_license_number','ad_license_url','scraped_extras',
    'property_split','advertiser','advertiser_phone',
    'rega_lookup_status','rega_lookup_at','rega_lookup_error',
    'rega_license_no','rega_agent_name','rega_fal_license','rega_unified_number'
  ] LOOP
    IF (OLD.data ? k) AND NOT (NEW.data ? k) THEN
      NEW.data := NEW.data || jsonb_build_object(k, OLD.data -> k);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS records_fill_market_enrichment_guard ON public.records;
CREATE TRIGGER records_fill_market_enrichment_guard
  BEFORE UPDATE ON public.records
  FOR EACH ROW
  WHEN (NEW.model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid)
  EXECUTE FUNCTION public.preserve_market_listing_enrichment();

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Slim store: the three new keys must ride the summary projection, because
--    the grouping happens client-side over the in-memory summary set. The key
--    ARRAY is the HARD-SYNCED PAIR of SUMMARY_DATA_KEYS.market_listings in
--    src/lib/lazyModels.ts. Everything else is unchanged from
--    2026-07-17_market_listings_summary_fast_path.sql — see that file for why
--    it is security_invoker=false + a scope-class InitPlan + one jsonb_each pass.
-- ─────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.market_listings_summary;

CREATE VIEW public.market_listings_summary
WITH (security_invoker = false) AS
SELECT
  r.id, r.model_id, r.created_by_user_id, r.created_at, r.updated_at,
  (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
     FROM jsonb_each(r.data) e
    WHERE e.key = ANY (ARRAY[
      'external_id','source','title','listing_type','category','property_type',
      'price','price_per_m2','area','bedrooms','bathrooms',
      'location','latitude','longitude',
      'is_active','main_image_url','advertiser_name','image_count','video_count',
      'advertiser_phone','rega_lookup_status','rega_lookup_error','rega_lookup_at',
      'advertiser','quality_score','quality_grade',
      'property_key','property_tier','property_split'
    ])) AS data
FROM public.records r
WHERE r.model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'
  AND (CASE (SELECT public.wassell_view_scope_class(auth.uid(), '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid))
         WHEN 'all'  THEN true
         WHEN 'none' THEN false
         ELSE public.wassell_can_view_record(auth.uid(), r.*)
       END);

GRANT SELECT ON public.market_listings_summary TO authenticated;

COMMIT;

-- ============================================================================
-- 6. BACKFILL — deliberately OUTSIDE the transaction above and run with
--    triggers suppressed for THIS SESSION ONLY.
--
--    A plain `UPDATE … SET data = data || key` across 53,488 rows would fire
--    records_capture_workflow_event once per row, inserting 53k workflow_jobs
--    rows each carrying previous_data + new_data (~2.4 KB each) — roughly
--    250 MB of junk for a job runner that is currently inert. It would also
--    re-upsert 53k listing_points and bump every row's version + updated_at,
--    making a pure backfill look like real user activity.
--
--    session_replication_role = 'replica' disables triggers for this session
--    only — concurrent writers keep their triggers. Because that also disables
--    the BEFORE trigger created above, the patch is computed inline here.
-- ============================================================================
BEGIN;

SET LOCAL session_replication_role = 'replica';

UPDATE public.records r
   SET data = r.data || public.market_listing_property_identity(r.data)
 WHERE r.model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede';

COMMIT;

-- Licence bridge over the freshly-keyed set (a no-op today by construction —
-- every deed-bearing row already resolved to tier 2).
SELECT public.market_listing_bridge_property_keys();
