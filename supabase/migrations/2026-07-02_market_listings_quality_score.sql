-- ============================================================================
-- Market Listings — QUALITY SCORE (the scoring phase)
-- Applied to wassell-prod via the management API on 2026-07-02; recorded here.
-- ============================================================================
-- Phase 2 of the listing-quality work (follows
-- 2026-07-01_market_listings_quality_signal_fields.sql and
-- 2026-07-02_market_listings_extras_signals.sql). Adds a deterministic
-- 0–100 quality score + A/B/C/D grade + per-dimension breakdown, computed
-- DB-side in the same BEFORE-trigger that derives the extras signals — one
-- implementation, DB-authoritative, no scraper change needed.
--
-- THE FORMULA (weights sum to 100; all inputs are per-row scalars):
--
--   Completeness 30 = 21×(core filled ÷ expected) + 9×(secondary ÷ expected)
--     CATEGORY-AWARE expected sets — the fix for land being punished for
--     having no bedrooms:
--       shared core (all): price>0, area>0, property_type, location.district, title
--       housing (فلل/شقق/دور/استراحة): + bedrooms, bathrooms          (7 core)
--       land (أراضي):                + street_width>0, frontage       (7 core)
--       buildings (عمائر):            shared only                      (5 core)
--       secondary — housing: age, street_name, frontage, living_rooms,
--       floors_count, coords (6); buildings: age, street_name, frontage,
--       floors_count, coords (5); land: street_name, coords (2).
--   Media 25 = 20×min(1, sqrt(image_count / img_full)) + 5 if any video
--     img_full is CATEGORY-AWARE: housing 10, buildings/istiraha 5, land 3.
--     (Live means: villas avg 11.9 photos, land avg 2.1 — a 3-photo land
--     listing IS fully documented. sqrt ≈ the piecewise curve we validated:
--     1 img→0.32, 5→0.71, 10→1.0 for housing.)
--   Description 20 = 14×min(1, chars / desc_full) + 6×min(1, features / feat_full)
--     desc_full: housing 400 (p50=356), buildings/istiraha 300, land 250.
--     feat_full: housing 5 (p75), others 3. Capped — no credit for
--     keyword-stuffed walls beyond the anchor.
--   Trust 15 = 7.5×has(ad_license_number) + 4.5×has(deed_number) + 3×rating01
--     rating01: NULL or EXACTLY 4.0 → 0.5 neutral (the 11,629-row spike at
--     exactly 4.0 is Aqar's default for unrated advertisers — no information);
--     else clamp((rating−3)/2, 0..1).
--   Freshness 10 = 1.0 at ≤7d since source_last_updated_at, linear → 0 at 90d,
--     missing → 0.5 neutral. Recomputed on every write; the scraper touches
--     live rows continuously (77% ≤7d), so decay tracks reality.
--
--   views_count is DELIBERATELY EXCLUDED — it measures demand, not quality,
--   and is age-confounded. Keep it a separate raw signal.
--
-- GRADES (calibrated on the live distribution, dry-run over all 46,636 rows
-- BEFORE this migration; per-category means converge to 77.3–82.6 after the
-- category-aware anchors — land 79.2 vs villas 81.4):
--   A ≥92 (~15%) · B 83–91 (~34%) · C 70–82 (~35%) · D <70 (~15%)
--
-- CONSUMERS wired with this migration:
--   • market_listings_summary view + SUMMARY_DATA_KEYS (src/lib/lazyModels.ts)
--     gain quality_score + quality_grade — the hard-synced pair, shipped in
--     the SAME commit. quality_grade is show_in_table → colored chip column.
--   • wassell_market_candidates(_json) NOT touched: the finder consumes the
--     FULL filtered set (too_many guard, never truncates), and the RPC
--     returns full r.data — quality fields ride along for free.
--
-- RETUNING: all weights/anchors/thresholds live in market_listing_quality()
-- below. To retune: CREATE OR REPLACE the function, then touch-update the
-- model rows (see backfill at the bottom). No app deploy needed.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Snapshot the schema before touching it.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public._backup_market_listings_schema_20260702_quality AS
SELECT id, name, schema, now() AS backed_up_at
FROM public.models WHERE name = 'market_listings';

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Schema: quality_score / quality_grade / quality_breakdown in the
--    Signals section. Grade is show_in_table (colored chips in the list).
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_model_id uuid;
  v_schema jsonb;
  v_sig_idx int;
  v_sig_section_id text;
BEGIN
  SELECT id, schema INTO v_model_id, v_schema
  FROM public.models WHERE name = 'market_listings';
  IF v_model_id IS NULL THEN
    RAISE EXCEPTION 'market_listings model not found';
  END IF;

  SELECT i - 1 INTO v_sig_idx
  FROM jsonb_array_elements(v_schema->'sections') WITH ORDINALITY t(sec, i)
  WHERE sec->>'label_en' = 'Signals';
  IF v_sig_idx IS NULL THEN
    RAISE EXCEPTION 'Signals section not found';
  END IF;
  v_sig_section_id := v_schema->'sections'->v_sig_idx->>'id';

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_schema->'sections'->v_sig_idx->'fields') f
    WHERE f->>'name' = 'quality_score'
  ) THEN
    v_schema := jsonb_set(
      v_schema, ARRAY['sections', v_sig_idx::text, 'fields'],
      (v_schema->'sections'->v_sig_idx->'fields')
      || jsonb_build_object(
           'id', gen_random_uuid()::text, 'name', 'quality_score',
           'label_ar', 'درجة الجودة', 'label_en', 'Quality Score',
           'type', 'number', 'required', false, 'order', 8,
           'section_id', v_sig_section_id,
           'width', 'third', 'show_in_table', false, 'read_only', true)
      || jsonb_build_object(
           'id', gen_random_uuid()::text, 'name', 'quality_grade',
           'label_ar', 'تصنيف الجودة', 'label_en', 'Quality Grade',
           'type', 'dropdown', 'required', false, 'order', 9,
           'section_id', v_sig_section_id,
           'width', 'third', 'show_in_table', true, 'read_only', true,
           'options', jsonb_build_array(
             jsonb_build_object('id','qg_a','value','A','label_ar','ممتاز (A)','label_en','A — Excellent','color','#B8734F'),
             jsonb_build_object('id','qg_b','value','B','label_ar','جيد (B)','label_en','B — Good','color','#C09B5F'),
             jsonb_build_object('id','qg_c','value','C','label_ar','متوسط (C)','label_en','C — Fair','color','#8E4E3A'),
             jsonb_build_object('id','qg_d','value','D','label_ar','ضعيف (D)','label_en','D — Poor','color','#4A4E54')))
      || jsonb_build_object(
           'id', gen_random_uuid()::text, 'name', 'quality_breakdown',
           'label_ar', 'تفصيل درجة الجودة', 'label_en', 'Quality Breakdown',
           'type', 'table', 'required', false, 'order', 10,
           'section_id', v_sig_section_id,
           'width', 'full', 'show_in_table', false, 'read_only', true,
           -- The read-only table grid renders headers from table_columns and
           -- looks up each row's cell by column `name` — without this the
           -- breakdown rendered as an empty strip (found live 2026-07-02).
           -- Column names ARE the Arabic row keys the scoring fn emits.
           'table_columns', jsonb_build_array(
             jsonb_build_object('id','qb_dim','name','البند','type','text','label_ar','البند','label_en','Dimension'),
             jsonb_build_object('id','qb_pts','name','النقاط','type','number','label_ar','النقاط','label_en','Points'),
             jsonb_build_object('id','qb_max','name','من','type','number','label_ar','من','label_en','Out of'))));
  END IF;

  UPDATE public.models SET schema = v_schema WHERE id = v_model_id;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. THE scoring function — the single implementation of the formula.
--    Pure function of the row's data (plus now() for freshness decay).
--    Uses try_numeric/try_timestamptz so a malformed scraper value degrades
--    to "missing" instead of blocking the write.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.market_listing_quality(d jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  cls text;                 -- 'housing' | 'land' | 'mid' (buildings/istiraha)
  is_building boolean;
  core_filled int; core_expected int;
  sec_filled int; sec_expected int;
  img_full numeric; desc_full numeric; feat_full numeric;
  rating numeric; src_ts timestamptz; days numeric;
  completeness numeric; media numeric; description numeric;
  trust numeric; freshness numeric;
  score int; grade text;
BEGIN
  cls := CASE WHEN d->>'category' = 'أراضي-للبيع' THEN 'land'
              WHEN d->>'category' IN ('عمائر-للبيع','استراحة-للبيع') THEN 'mid'
              ELSE 'housing' END;
  is_building := d->>'category' = 'عمائر-للبيع';

  -- ── Completeness (30) ──
  core_filled :=
      (CASE WHEN coalesce(public.try_numeric(d->>'price'), 0) > 0 THEN 1 ELSE 0 END)
    + (CASE WHEN coalesce(public.try_numeric(d->>'area'), 0) > 0 THEN 1 ELSE 0 END)
    + (CASE WHEN coalesce(d->>'property_type','') <> '' THEN 1 ELSE 0 END)
    + (CASE WHEN coalesce(d->'location'->>'district','') <> '' THEN 1 ELSE 0 END)
    + (CASE WHEN coalesce(d->>'title','') <> '' THEN 1 ELSE 0 END)
    + (CASE WHEN cls = 'land'
            THEN (CASE WHEN coalesce(public.try_numeric(d->>'street_width'), 0) > 0 THEN 1 ELSE 0 END)
               + (CASE WHEN coalesce(d->>'frontage','') <> '' THEN 1 ELSE 0 END)
            WHEN is_building THEN 0
            ELSE (CASE WHEN coalesce(d->>'bedrooms','') <> '' THEN 1 ELSE 0 END)
               + (CASE WHEN coalesce(d->>'bathrooms','') <> '' THEN 1 ELSE 0 END)
       END);
  core_expected := CASE WHEN is_building THEN 5 ELSE 7 END;

  IF cls = 'land' THEN
    sec_filled :=
        (CASE WHEN coalesce(d->>'street_name','') <> '' THEN 1 ELSE 0 END)
      + (CASE WHEN d->>'latitude' IS NOT NULL THEN 1 ELSE 0 END);
    sec_expected := 2;
  ELSIF is_building THEN
    sec_filled :=
        (CASE WHEN coalesce(d->>'age','') <> '' THEN 1 ELSE 0 END)
      + (CASE WHEN coalesce(d->>'street_name','') <> '' THEN 1 ELSE 0 END)
      + (CASE WHEN coalesce(d->>'frontage','') <> '' THEN 1 ELSE 0 END)
      + (CASE WHEN coalesce(d->>'floors_count','') <> '' THEN 1 ELSE 0 END)
      + (CASE WHEN d->>'latitude' IS NOT NULL THEN 1 ELSE 0 END);
    sec_expected := 5;
  ELSE
    sec_filled :=
        (CASE WHEN coalesce(d->>'age','') <> '' THEN 1 ELSE 0 END)
      + (CASE WHEN coalesce(d->>'street_name','') <> '' THEN 1 ELSE 0 END)
      + (CASE WHEN coalesce(d->>'frontage','') <> '' THEN 1 ELSE 0 END)
      + (CASE WHEN coalesce(d->>'living_rooms','') <> '' THEN 1 ELSE 0 END)
      + (CASE WHEN coalesce(d->>'floors_count','') <> '' THEN 1 ELSE 0 END)
      + (CASE WHEN d->>'latitude' IS NOT NULL THEN 1 ELSE 0 END);
    sec_expected := 6;
  END IF;

  completeness := 21.0 * core_filled / core_expected
                +  9.0 * sec_filled / sec_expected;

  -- ── Media (25) ──
  img_full := CASE cls WHEN 'land' THEN 3 WHEN 'mid' THEN 5 ELSE 10 END;
  media := 20.0 * least(1.0, sqrt(coalesce(public.try_numeric(d->>'image_count'), 0) / img_full))
         + (CASE WHEN coalesce(public.try_numeric(d->>'video_count'), 0) > 0 THEN 5.0 ELSE 0 END);

  -- ── Description (20) ──
  desc_full := CASE cls WHEN 'land' THEN 250 WHEN 'mid' THEN 300 ELSE 400 END;
  feat_full := CASE cls WHEN 'housing' THEN 5 ELSE 3 END;
  description := 14.0 * least(1.0, coalesce(public.try_numeric(d->>'description_char_count'), 0) / desc_full)
               +  6.0 * least(1.0, coalesce(public.try_numeric(d->>'feature_count'), 0) / feat_full);

  -- ── Trust (15) ──
  rating := public.try_numeric(d->>'advertiser_rating');
  trust := (CASE WHEN coalesce(d->>'ad_license_number','') <> '' THEN 7.5 ELSE 0 END)
         + (CASE WHEN coalesce(d->>'deed_number','') <> '' THEN 4.5 ELSE 0 END)
         + 3.0 * (CASE WHEN rating IS NULL OR rating = 4 THEN 0.5
                       ELSE greatest(0.0, least(1.0, (rating - 3) / 2)) END);

  -- ── Freshness (10) ──
  src_ts := public.try_timestamptz(d->>'source_last_updated_at');
  IF src_ts IS NULL THEN
    freshness := 5.0;
  ELSE
    days := extract(epoch FROM now() - src_ts) / 86400.0;
    freshness := 10.0 * (CASE WHEN days <= 7 THEN 1.0
                              WHEN days >= 90 THEN 0.0
                              ELSE 1.0 - (days - 7) / 83.0 END);
  END IF;

  score := round(completeness + media + description + trust + freshness)::int;
  score := greatest(0, least(100, score));
  grade := CASE WHEN score >= 92 THEN 'A'
                WHEN score >= 83 THEN 'B'
                WHEN score >= 70 THEN 'C'
                ELSE 'D' END;

  RETURN jsonb_build_object(
    'quality_score', score,
    'quality_grade', grade,
    'quality_breakdown', jsonb_build_array(
      jsonb_build_object('البند', 'اكتمال البيانات', 'النقاط', round(completeness, 1), 'من', 30),
      jsonb_build_object('البند', 'الوسائط (صور وفيديو)', 'النقاط', round(media, 1), 'من', 25),
      jsonb_build_object('البند', 'الوصف والمميزات', 'النقاط', round(description, 1), 'من', 20),
      jsonb_build_object('البند', 'الموثوقية والترخيص', 'النقاط', round(trust, 1), 'من', 15),
      jsonb_build_object('البند', 'حداثة الإعلان', 'النقاط', round(freshness, 1), 'من', 10)));
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Extend the market-listings BEFORE trigger: derive extras first (so
--    deed/street_width from THIS write count), then score. Quality is
--    computed on EVERY write, extras or not.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fill_market_listing_extras_signals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  patch jsonb;
BEGIN
  IF jsonb_typeof(NEW.data->'scraped_extras') = 'array' THEN
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
  END IF;

  NEW.data := NEW.data || public.market_listing_quality(NEW.data);
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Slim-store wiring: add score + grade to the summary projection.
--    HARD-SYNCED PAIR with SUMMARY_DATA_KEYS.market_listings in
--    src/lib/lazyModels.ts — updated in the same commit.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.market_listings_summary
WITH (security_invoker = true) AS
SELECT
  id, model_id, created_by_user_id, created_at, updated_at,
  jsonb_build_object(
    'external_id', data->'external_id', 'source', data->'source', 'title', data->'title',
    'listing_type', data->'listing_type', 'category', data->'category', 'property_type', data->'property_type',
    'price', data->'price', 'price_per_m2', data->'price_per_m2', 'area', data->'area',
    'bedrooms', data->'bedrooms', 'bathrooms', data->'bathrooms',
    'location', data->'location',
    'latitude', data->'latitude', 'longitude', data->'longitude',
    'is_active', data->'is_active', 'main_image_url', data->'main_image_url',
    'advertiser_name', data->'advertiser_name', 'image_count', data->'image_count', 'video_count', data->'video_count',
    'advertiser_phone', data->'advertiser_phone',
    'rega_lookup_status', data->'rega_lookup_status',
    'rega_lookup_error', data->'rega_lookup_error',
    'rega_lookup_at', data->'rega_lookup_at',
    'advertiser', data->'advertiser',
    -- Quality score (2026-07-02): grade renders as the table chip column;
    -- score rides along for sorting/filtering consumers.
    'quality_score', data->'quality_score',
    'quality_grade', data->'quality_grade'
  ) AS data
FROM public.records
WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede';

GRANT SELECT ON public.market_listings_summary TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Backfill: touch every market_listings row (ALL rows, not just those
--    with extras) — the trigger computes and stores the score.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.records
SET data = data
WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede';

COMMIT;
