-- ============================================================================
-- Market Listings — quality-scoring INPUT FIELDS (fields-only)
-- Applied to wassell-prod via the management API on 2026-07-01; recorded here.
-- Schema snapshot before change: public._backup_market_listings_schema_20260701.
-- ============================================================================
-- Phase 1 of the listing-quality work: store the raw, deterministic MEASURABLE
-- signals we will need later — NO score, NO scoring function, NO trigger, NO
-- ranking/order changes, NO change to wassell_market_candidates.
--
-- market_listings is UNFROZEN (JSONB in `records`, model_id
-- 8f06bc39-4bee-42e9-9fab-77023fb89ede) so every change here is an additive
-- JSONB schema edit + a one-time backfill. Existing readers (import, search,
-- matching, slim store) read specific keys and are untouched.
--
-- REUSE (already populated on 100% of 46,608 rows — do NOT re-add):
--   • image_count  — faithful mirror of image_urls length, BUT scraper CAPS
--                    capture at 6 (max 6; not the true photo count).
--   • video_count  — faithful mirror of video_urls length, uncapped (max 19).
--   • features / description / scraped_at / last_seen / first_seen.
--
-- NEW raw fields written by the scraper going forward:
--   • source_last_updated_at   (Aqar's own "last updated" time)
--   • advertiser_rating        (rating on the listing page)
--   • advertiser_reviews_count (review volume — context for the rating)
--
-- NEW derived counts — materialised as scalars (same pattern as image_count/
-- video_count) so later phases can rank/filter without loading the heavy
-- description/features. Backfilled deterministically from existing data now;
-- scraper maintains them going forward:
--   • description_char_count   • description_word_count   • feature_count
--   • basic_info_completed_count   • basic_info_missing_keys
--     ("basic info" = the 7 keys price / area / bedrooms / bathrooms /
--      property_type / location.district / title).
--
-- SLIM STORE NOT TOUCHED this phase: the market_listings_summary view +
-- SUMMARY_DATA_KEYS are a hard-synced pair whose only consumers are the list/
-- map/client-side ranking. With no ranking yet there is no consumer, so we
-- leave them alone (record FORM visibility works via the full-record load).
-- Wire slim in the scoring phase, together, when a consumer exists. The
-- auto-generated v_market_listings BI view picks up the new columns for free.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Raw scraped fields. Advertiser section = sections[4] (Advertiser),
--    Tracking = sections[5]. section_id read from the live schema. read_only
--    (scraper-owned; user edits would be overwritten on next scrape).
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.models
SET schema = jsonb_set(
  jsonb_set(
    schema,
    '{sections,4,fields}',
    (schema->'sections'->4->'fields')
      || jsonb_build_object(
           'id', gen_random_uuid()::text, 'name', 'advertiser_rating',
           'label_ar', 'تقييم المعلن', 'label_en', 'Advertiser Rating',
           'type', 'number', 'required', false, 'order', 90,
           'section_id', schema->'sections'->4->>'id',
           'width', 'half', 'show_in_table', false, 'read_only', true)
      || jsonb_build_object(
           'id', gen_random_uuid()::text, 'name', 'advertiser_reviews_count',
           'label_ar', 'عدد التقييمات', 'label_en', 'Advertiser Reviews',
           'type', 'number', 'required', false, 'order', 91,
           'section_id', schema->'sections'->4->>'id',
           'width', 'half', 'show_in_table', false, 'read_only', true)
  ),
  '{sections,5,fields}',
  (schema->'sections'->5->'fields')
    || jsonb_build_object(
         'id', gen_random_uuid()::text, 'name', 'source_last_updated_at',
         'label_ar', 'آخر تحديث بالمصدر', 'label_en', 'Source Last Updated',
         'type', 'datetime', 'required', false, 'order', 80,
         'section_id', schema->'sections'->5->>'id',
         'width', 'half', 'show_in_table', false, 'read_only', true)
)
WHERE name = 'market_listings';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Derived-count fields, grouped in a new non-base "Signals" section so
--    they read clearly as materialised metrics (not source data).
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.models
SET schema = jsonb_set(
  schema, '{sections}',
  (schema->'sections') || jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid()::text,
    'label_ar', 'مؤشرات مقاسة', 'label_en', 'Signals',
    'order', jsonb_array_length(schema->'sections'),
    'is_base', false, 'color', '#C09B5F',
    'fields', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'name', 'description_char_count',
        'label_ar', 'عدد أحرف الوصف', 'label_en', 'Description Chars',
        'type', 'number', 'required', false, 'order', 0,
        'section_id', '', 'width', 'third', 'show_in_table', false, 'read_only', true),
      jsonb_build_object('id', gen_random_uuid()::text, 'name', 'description_word_count',
        'label_ar', 'عدد كلمات الوصف', 'label_en', 'Description Words',
        'type', 'number', 'required', false, 'order', 1,
        'section_id', '', 'width', 'third', 'show_in_table', false, 'read_only', true),
      jsonb_build_object('id', gen_random_uuid()::text, 'name', 'feature_count',
        'label_ar', 'عدد المميزات', 'label_en', 'Feature Count',
        'type', 'number', 'required', false, 'order', 2,
        'section_id', '', 'width', 'third', 'show_in_table', false, 'read_only', true),
      -- Basic-info completeness. "Basic info" = the 7 keys: price, area,
      -- bedrooms, bathrooms, property_type, location.district, title.
      jsonb_build_object('id', gen_random_uuid()::text, 'name', 'basic_info_completed_count',
        'label_ar', 'عدد الحقول الأساسية المكتملة', 'label_en', 'Basic Info Completed',
        'type', 'number', 'required', false, 'order', 3,
        'section_id', '', 'width', 'third', 'show_in_table', false, 'read_only', true),
      jsonb_build_object('id', gen_random_uuid()::text, 'name', 'basic_info_missing_keys',
        'label_ar', 'الحقول الأساسية الناقصة', 'label_en', 'Basic Info Missing',
        'type', 'multiselect', 'required', false, 'order', 4,
        'section_id', '', 'width', 'full', 'show_in_table', false, 'read_only', true,
        'options', jsonb_build_array(
          jsonb_build_object('id','b_price','value','price','label_ar','السعر','label_en','Price','color','#B8734F'),
          jsonb_build_object('id','b_area','value','area','label_ar','المساحة','label_en','Area','color','#C09B5F'),
          jsonb_build_object('id','b_bedrooms','value','bedrooms','label_ar','غرف النوم','label_en','Bedrooms','color','#8E4E3A'),
          jsonb_build_object('id','b_bathrooms','value','bathrooms','label_ar','دورات المياه','label_en','Bathrooms','color','#4A2C2A'),
          jsonb_build_object('id','b_ptype','value','property_type','label_ar','نوع العقار','label_en','Property Type','color','#4A4E54'),
          jsonb_build_object('id','b_district','value','district','label_ar','الحي','label_en','District','color','#D4B896'),
          jsonb_build_object('id','b_title','value','title','label_ar','العنوان','label_en','Title','color','#C09B5F'))))
  ))
)
WHERE name = 'market_listings';

-- Point the three new fields' section_id at the "Signals" section we appended.
UPDATE public.models m
SET schema = jsonb_set(
  schema,
  ('{sections,' || (jsonb_array_length(schema->'sections') - 1) || ',fields}')::text[],
  (
    SELECT jsonb_agg(f || jsonb_build_object('section_id', sec_id))
    FROM (SELECT (schema->'sections'->(jsonb_array_length(schema->'sections')-1)->>'id') AS sec_id) s,
         jsonb_array_elements(schema->'sections'->(jsonb_array_length(schema->'sections')-1)->'fields') f
  )
)
WHERE name = 'market_listings';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. One-time backfill of ALL derived counts from EXISTING data in a SINGLE
--    pass (one Realtime fan-out). Deterministic; no trigger, no scraper
--    dependency for existing rows. The scraper maintains these going forward.
--    Basic-info "present & valid" rules:
--      price/area → numeric > 0 ;  bedrooms/bathrooms/property_type/title →
--      non-empty ;  district → location.district non-empty.
--    missing_keys = the subset absent; completed_count = 7 − |missing|.
-- ─────────────────────────────────────────────────────────────────────────
WITH bi AS (
  SELECT r.id,
    array_remove(ARRAY[
      CASE WHEN NOT (coalesce(public.try_numeric(r.data->>'price'), 0) > 0) THEN 'price' END,
      CASE WHEN NOT (coalesce(public.try_numeric(r.data->>'area'),  0) > 0) THEN 'area'  END,
      CASE WHEN coalesce(r.data->>'bedrooms','')          = '' THEN 'bedrooms'      END,
      CASE WHEN coalesce(r.data->>'bathrooms','')         = '' THEN 'bathrooms'     END,
      CASE WHEN coalesce(r.data->>'property_type','')     = '' THEN 'property_type' END,
      CASE WHEN coalesce(r.data->'location'->>'district','') = '' THEN 'district'   END,
      CASE WHEN coalesce(r.data->>'title','')             = '' THEN 'title'         END
    ], NULL) AS missing
  FROM public.records r
  WHERE r.model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid
)
UPDATE public.records r
SET data = r.data || jsonb_build_object(
  'description_char_count',
    to_jsonb(coalesce(char_length(r.data->>'description'), 0)),
  'description_word_count',
    to_jsonb(
      CASE WHEN coalesce(btrim(r.data->>'description'), '') = '' THEN 0
           ELSE coalesce(array_length(
                  regexp_split_to_array(btrim(r.data->>'description'), '\s+'), 1), 0)
      END),
  'feature_count',
    to_jsonb(
      CASE WHEN jsonb_typeof(r.data->'features') = 'array'
           THEN jsonb_array_length(r.data->'features') ELSE 0 END),
  'basic_info_missing_keys', to_jsonb(bi.missing),
  'basic_info_completed_count', to_jsonb(7 - coalesce(array_length(bi.missing, 1), 0))
)
FROM bi
WHERE r.id = bi.id;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. OPTIONAL — visible read-only catch-all for unmapped scraped details
--    (traceability only; NOT tied to any score). Delete this block if you
--    prefer the flat-JSONB pattern (rega_* precedent) — flat keys store fine
--    but DON'T render in the form. This `table` field renders as a read-only
--    grid and is auto-excluded from the slim store.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.models
SET schema = jsonb_set(
  schema, '{sections}',
  (schema->'sections') || jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid()::text,
    'label_ar', 'تفاصيل مستخرجة إضافية', 'label_en', 'Scraped Extras',
    'order', jsonb_array_length(schema->'sections'),
    'is_base', false, 'color', '#8E4E3A',
    'fields', jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text, 'name', 'scraped_extras',
      'label_ar', 'عناصر مستخرجة', 'label_en', 'Scraped Elements',
      'type', 'table', 'required', false, 'order', 0,
      'section_id', '',
      'width', 'full', 'show_in_table', false, 'read_only', true,
      'table_columns', jsonb_build_array(
        jsonb_build_object('id','c_element','name','element',
          'label_ar','النوع','label_en','Element','type','dropdown',
          'options', jsonb_build_array(
            jsonb_build_object('id','o_info','value','info','label_ar','معلومة','label_en','Info','color','#B8734F'),
            jsonb_build_object('id','o_feature','value','feature','label_ar','ميزة','label_en','Feature','color','#C09B5F'),
            jsonb_build_object('id','o_license','value','license','label_ar','ترخيص','label_en','License','color','#8E4E3A'),
            jsonb_build_object('id','o_advertiser','value','advertiser','label_ar','معلن','label_en','Advertiser','color','#4A2C2A'),
            jsonb_build_object('id','o_location','value','location','label_ar','موقع','label_en','Location','color','#4A4E54'),
            jsonb_build_object('id','o_nearby','value','nearby','label_ar','قريب','label_en','Nearby','color','#D4B896'),
            jsonb_build_object('id','o_pricing','value','pricing','label_ar','تسعير','label_en','Pricing','color','#B8734F'),
            jsonb_build_object('id','o_utility','value','utility','label_ar','خدمة','label_en','Utility','color','#C09B5F'),
            jsonb_build_object('id','o_media','value','media','label_ar','وسائط','label_en','Media','color','#8E4E3A'),
            jsonb_build_object('id','o_other','value','other','label_ar','أخرى','label_en','Other','color','#4A4E54'))),
        jsonb_build_object('id','c_raw_label','name','raw_label',
          'label_ar','التسمية الأصلية','label_en','Raw Label','type','text'),
        jsonb_build_object('id','c_details','name','details',
          'label_ar','التفاصيل','label_en','Details','type','textarea'),
        jsonb_build_object('id','c_source_section','name','source_section',
          'label_ar','قسم المصدر','label_en','Source Section','type','dropdown',
          'options', jsonb_build_array(
            jsonb_build_object('id','s_ad','value','ad_details','label_ar','تفاصيل الإعلان','label_en','Ad Details','color','#B8734F'),
            jsonb_build_object('id','s_feat','value','features','label_ar','المميزات','label_en','Features','color','#C09B5F'),
            jsonb_build_object('id','s_desc','value','description','label_ar','الوصف','label_en','Description','color','#8E4E3A'),
            jsonb_build_object('id','s_lic','value','license','label_ar','الترخيص','label_en','License','color','#4A2C2A'),
            jsonb_build_object('id','s_adv','value','advertiser','label_ar','المعلن','label_en','Advertiser','color','#4A4E54'),
            jsonb_build_object('id','s_loc','value','location','label_ar','الموقع','label_en','Location','color','#D4B896'))))
    ))
  ))
)
WHERE name = 'market_listings';

-- Point the extras table field's section_id at the section just appended.
UPDATE public.models
SET schema = jsonb_set(
  schema,
  ('{sections,' || (jsonb_array_length(schema->'sections') - 1) || ',fields,0,section_id}')::text[],
  to_jsonb((schema->'sections'->(jsonb_array_length(schema->'sections')-1)->>'id'))
)
WHERE name = 'market_listings';

COMMIT;
