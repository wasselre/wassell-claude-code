-- ============================================================================
-- Market Listings — promote scraped_extras signals to scalar fields
--                   + remove advertiser_reviews_count (unobtainable)
-- Applied to wassell-prod via the management API on 2026-07-02; recorded here.
-- Schema snapshot before change: public._backup_market_listings_schema_20260702.
-- ============================================================================
-- Phase 1b of the listing-quality work (follows
-- 2026-07-01_market_listings_quality_signal_fields.sql):
--
-- 1. REMOVE `advertiser_reviews_count` (Advertiser section). Aqar does not
--    expose review volume, the scraper cannot obtain it, and the key was never
--    written to a single record (verified live: 0 of 46,636 rows carry it).
--    Schema-only removal — no data strip needed.
--
-- 2. PROMOTE three signals out of the read-only `scraped_extras` table field
--    into scalar Signals-section fields, so scoring/ranking can read them
--    without a per-row JSONB scan (same pattern as feature_count):
--      • views_count   (المشاهدات)    — number; on 44,506 rows, all plain digits
--      • deed_number   (رقم الصك)     — text (identifier, NOT numeric — may
--                                       carry leading zeros); on 43,062 rows
--      • street_width  (عرض الشارع)   — number, meters; on 26,244 rows
--
-- MAINTENANCE — trigger-derived, NOT scraper-maintained: unlike the phase-1
-- fields (which the scraper was updated to write), the scraper does not know
-- about these three. It DOES write `scraped_extras` on every scrape, so a
-- BEFORE INSERT/UPDATE trigger on `records` derives them from scraped_extras
-- inline on every write (same DB-authoritative posture as
-- records_fill_project_rollups). No scraper change needed; values can never
-- go stale or be wiped by a full-data overwrite. If a scrape omits a label,
-- the previous value is KEPT (jsonb_strip_nulls drops the null key from the
-- patch), because Aqar sometimes hides sections it rendered before.
--
-- market_listings is UNFROZEN (JSONB in `records`, model_id
-- 8f06bc39-4bee-42e9-9fab-77023fb89ede). The auto-generated v_market_listings
-- BI view regenerates on the models UPDATE (drops the reviews column, adds
-- the three new ones). SLIM STORE (market_listings_summary +
-- SUMMARY_DATA_KEYS) NOT touched — still no ranking consumer; wire together
-- in the scoring phase.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Snapshot the schema before touching it.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public._backup_market_listings_schema_20260702 AS
SELECT id, name, schema, now() AS backed_up_at
FROM public.models WHERE name = 'market_listings';

-- ─────────────────────────────────────────────────────────────────────────
-- 1+2. Schema edit: drop advertiser_reviews_count, add the three Signals
--      fields. Sections located by label_en (not hardcoded index) and the
--      edit is guarded so a re-run is a no-op.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_model_id uuid;
  v_schema jsonb;
  v_adv_idx int;
  v_sig_idx int;
  v_sig_section_id text;
BEGIN
  SELECT id, schema INTO v_model_id, v_schema
  FROM public.models WHERE name = 'market_listings';
  IF v_model_id IS NULL THEN
    RAISE EXCEPTION 'market_listings model not found';
  END IF;

  SELECT i - 1 INTO v_adv_idx
  FROM jsonb_array_elements(v_schema->'sections') WITH ORDINALITY t(sec, i)
  WHERE sec->>'label_en' = 'Advertiser';
  SELECT i - 1 INTO v_sig_idx
  FROM jsonb_array_elements(v_schema->'sections') WITH ORDINALITY t(sec, i)
  WHERE sec->>'label_en' = 'Signals';
  IF v_adv_idx IS NULL OR v_sig_idx IS NULL THEN
    RAISE EXCEPTION 'Advertiser/Signals section not found (adv=%, sig=%)', v_adv_idx, v_sig_idx;
  END IF;
  v_sig_section_id := v_schema->'sections'->v_sig_idx->>'id';

  -- 1. Remove advertiser_reviews_count from the Advertiser section.
  v_schema := jsonb_set(
    v_schema, ARRAY['sections', v_adv_idx::text, 'fields'],
    (SELECT coalesce(jsonb_agg(f ORDER BY ord), '[]'::jsonb)
     FROM jsonb_array_elements(v_schema->'sections'->v_adv_idx->'fields')
          WITH ORDINALITY t(f, ord)
     WHERE f->>'name' <> 'advertiser_reviews_count'));

  -- 2. Append the three promoted fields to the Signals section (idempotent).
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_schema->'sections'->v_sig_idx->'fields') f
    WHERE f->>'name' = 'views_count'
  ) THEN
    v_schema := jsonb_set(
      v_schema, ARRAY['sections', v_sig_idx::text, 'fields'],
      (v_schema->'sections'->v_sig_idx->'fields')
      || jsonb_build_object(
           'id', gen_random_uuid()::text, 'name', 'views_count',
           'label_ar', 'عدد المشاهدات', 'label_en', 'Views',
           'type', 'number', 'required', false, 'order', 5,
           'section_id', v_sig_section_id,
           'width', 'third', 'show_in_table', false, 'read_only', true)
      || jsonb_build_object(
           'id', gen_random_uuid()::text, 'name', 'deed_number',
           'label_ar', 'رقم الصك', 'label_en', 'Deed Number',
           'type', 'text', 'required', false, 'order', 6,
           'section_id', v_sig_section_id,
           'width', 'third', 'show_in_table', false, 'read_only', true)
      || jsonb_build_object(
           'id', gen_random_uuid()::text, 'name', 'street_width',
           'label_ar', 'عرض الشارع (م)', 'label_en', 'Street Width (m)',
           'type', 'number', 'required', false, 'order', 7,
           'section_id', v_sig_section_id,
           'width', 'third', 'show_in_table', false, 'read_only', true));
  END IF;

  UPDATE public.models SET schema = v_schema WHERE id = v_model_id;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Derive-on-write trigger: fill the three fields from scraped_extras on
--    every market_listings write. BEFORE trigger mutating NEW inline — no
--    second write, no recursion. Values derived from what THIS write carries;
--    labels absent from this scrape keep their previous value.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fill_market_listing_extras_signals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  patch jsonb;
BEGIN
  IF jsonb_typeof(NEW.data->'scraped_extras') IS DISTINCT FROM 'array' THEN
    RETURN NEW;
  END IF;

  SELECT jsonb_strip_nulls(jsonb_build_object(
    'views_count',  max(CASE WHEN e->>'raw_label' = 'المشاهدات'
                              AND e->>'details' ~ '^[0-9]+$'
                             THEN (e->>'details')::numeric END),
    'deed_number',  max(CASE WHEN e->>'raw_label' = 'رقم الصك'
                              AND coalesce(e->>'details', '') <> ''
                             THEN e->>'details' END),
    'street_width', max(CASE WHEN e->>'raw_label' = 'عرض الشارع'
                              AND e->>'details' ~ '^[0-9]+(\.[0-9]+)?$'
                             THEN (e->>'details')::numeric END)
  ))
  INTO patch
  FROM jsonb_array_elements(NEW.data->'scraped_extras') e;

  NEW.data := NEW.data || coalesce(patch, '{}'::jsonb);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS records_fill_market_extras_signals ON public.records;
CREATE TRIGGER records_fill_market_extras_signals
BEFORE INSERT OR UPDATE ON public.records
FOR EACH ROW
WHEN (NEW.model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede')
EXECUTE FUNCTION public.fill_market_listing_extras_signals();

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Backfill: a touch-update fires the trigger, so the trigger is the ONE
--    implementation of the derivation (no second copy to drift).
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.records
SET data = data
WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'
  AND jsonb_typeof(data->'scraped_extras') = 'array';

COMMIT;
