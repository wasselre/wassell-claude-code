-- ============================================================================
-- ARCHIVED / OBSOLETE — DO NOT EXECUTE
-- ----------------------------------------------------------------------------
-- This migration assumes the pre-freeze architecture: an UNFROZEN market_listings
-- model, writes/reads via public.records, and the now-retired market_listing_merge.
-- It is SUPERSEDED by the Phase-1 forward reconciliation (2026-09-03_01…): its only
-- still-valid content (source dropdown options + the UAE fields, and market_permit_key)
-- is folded there; its records-based v_market_properties is replaced by the
-- unified_records-based, security-fixed view. Preserved here for forensic/history
-- purposes ONLY. Moved out of supabase/migrations so it can never be applied.
-- Original-content sha256 recorded in the Gate A checksum list.
-- ============================================================================

-- UAE portals (Bayut / Dubizzle / Property Finder) + cross-platform de-duplication.
--
-- market_listings is UNFROZEN (JSONB in `records`), so this does NOT ALTER TABLE — it
-- (1) adds the three portal options to the `source` dropdown,
-- (2) appends the new normalized fields to the model schema (idempotent, by slug) so the
--     Builder renders them and the auto-generated `v_market_listings` typed view exposes
--     them, and
-- (3) adds the permit-normalization function + the canonical-property view used to show
--     de-duplicated inventory (one row per dupe_group_id).
--
-- The writer is the scraper's existing `market_listing_merge(id, patch)` RPC (source-agnostic
-- `data = data || jsonb_strip_nulls(patch)`), which preserves enrichment-owned keys
-- (permit_number, image_mirror_map, dupe_group_id) across re-scans. No new write path needed.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1 + 2. Extend the market_listings model schema (source options + new fields)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_schema   jsonb;
  v_sections jsonb;
  v_base_ix  int;
  v_base     jsonb;
  v_fields   jsonb;
  v_opts     jsonb;
  v_new_field jsonb;
  v_max_order int;
  f record;
BEGIN
  SELECT schema INTO v_schema FROM public.models WHERE name = 'market_listings';
  IF v_schema IS NULL THEN RAISE NOTICE 'market_listings model not found — skipping'; RETURN; END IF;
  v_sections := v_schema->'sections';

  -- locate the base section (is_base = true), else section 0
  v_base_ix := 0;
  FOR i IN 0 .. jsonb_array_length(v_sections) - 1 LOOP
    IF COALESCE((v_sections->i->>'is_base')::boolean, false) THEN v_base_ix := i; EXIT; END IF;
  END LOOP;
  v_base   := v_sections->v_base_ix;
  v_fields := COALESCE(v_base->'fields', '[]'::jsonb);

  SELECT COALESCE(MAX((elem->>'order')::int), 0) INTO v_max_order
  FROM jsonb_array_elements(v_fields) elem;

  -- 1. add the three portal options to the `source` dropdown (idempotent by value)
  FOR i IN 0 .. jsonb_array_length(v_fields) - 1 LOOP
    IF v_fields->i->>'name' = 'source' THEN
      v_opts := COALESCE(v_fields->i->'options', '[]'::jsonb);
      FOR f IN SELECT * FROM (VALUES
        ('bayut','Bayut','بيوت'),
        ('dubizzle','Dubizzle','دوبيزل'),
        ('propertyfinder','Property Finder','بروبرتي فايندر')
      ) AS t(val, en, ar) LOOP
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_opts) o WHERE o->>'value' = f.val) THEN
          v_opts := v_opts || jsonb_build_object(
            'id', gen_random_uuid()::text, 'value', f.val,
            'label_en', f.en, 'label_ar', f.ar, 'color', '#B8734F');
        END IF;
      END LOOP;
      v_fields := jsonb_set(v_fields, ARRAY[i::text, 'options'], v_opts);
    END IF;
  END LOOP;

  -- 2. append ONLY genuinely-new fields (existing slugs like area/bedrooms/bathrooms/
  --    latitude/longitude/advertiser_name/advertiser_phone/ad_license_number/image_urls/
  --    image_count/video_urls/is_active/first_seen/last_seen/scraped_at are reused as-is).
  FOR f IN SELECT * FROM (VALUES
    ('title_ar',          'Title (AR)',            'العنوان (عربي)',        'text'),
    ('description_ar',    'Description (AR)',       'الوصف (عربي)',          'textarea'),
    ('plot_area',         'Plot Area (m²)',         'مساحة الأرض (م²)',      'number'),
    ('furnished',         'Furnishing',             'التأثيث',               'text'),
    ('completion_status', 'Completion Status',      'حالة الإنجاز',          'text'),
    ('emirate',           'Emirate',                'الإمارة',               'text'),
    ('community',         'Community',              'المجتمع',               'text'),
    ('building',          'Building / Tower',       'المبنى / البرج',        'text'),
    ('permit_number',     'Permit / RERA No.',      'رقم التصريح / ريرا',    'text'),
    ('permit_key',        'Permit Key (normalized)','مفتاح التصريح',         'text'),
    ('reference_number',  'Reference No.',          'الرقم المرجعي',         'text'),
    ('agency_name',       'Agency',                 'الوكالة',               'text'),
    ('agent_whatsapp',    'Agent WhatsApp',         'واتساب المُعلِن',       'text'),
    ('is_verified',       'Verified',               'موثّق',                 'checkbox'),
    ('listed_at',         'Listed At',              'تاريخ النشر',           'datetime'),
    ('dupe_group_id',     'Property Cluster ID',    'معرّف العقار الموحّد',   'text'),
    ('dupe_role',         'Duplicate Role',         'دور التكرار',           'text'),
    ('source_payload',    'Raw Source Payload',     'البيانات الخام',        'notes')
  ) AS t(slug, en, ar, ftype) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_fields) el WHERE el->>'name' = f.slug) THEN
      v_max_order := v_max_order + 1;
      v_new_field := jsonb_build_object(
        'id', gen_random_uuid()::text,
        'name', f.slug,
        'label_en', f.en,
        'label_ar', f.ar,
        'type', f.ftype,
        'required', false,
        'order', v_max_order,
        'section_id', v_base->>'id',
        'width', 'half',
        'show_in_table', false
      );
      v_fields := v_fields || v_new_field;
    END IF;
  END LOOP;

  v_sections := jsonb_set(v_sections, ARRAY[v_base_ix::text, 'fields'], v_fields);
  v_schema   := jsonb_set(v_schema, '{sections}', v_sections);
  UPDATE public.models SET schema = v_schema WHERE name = 'market_listings';
  -- the models_view_sync trigger regenerates v_market_listings with the new typed columns.
END $$;

-- ---------------------------------------------------------------------------
-- 3a. Permit / RERA normalization — the Tier-0 exact cross-platform key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.market_permit_key(raw text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN raw IS NULL THEN ''
    WHEN length(regexp_replace(upper(raw), '[^A-Z0-9]', '', 'g')) < 5 THEN ''
    WHEN regexp_replace(upper(raw), '[^A-Z0-9]', '', 'g') ~ '^(0+|NA|NONE|NULL)$' THEN ''
    ELSE regexp_replace(upper(raw), '[^A-Z0-9]', '', 'g')
  END;
$$;

-- ---------------------------------------------------------------------------
-- 3b. Canonical-property view — one row per dupe_group_id (the de-duplicated
--     inventory). Listings with no cluster id are their own group. Reads the
--     summary-shape unified view; dupe_group_id/dupe_role are written by the
--     dedup worker lane. `sources` shows which portals carry the same unit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_market_properties AS
WITH ml AS (
  SELECT
    r.id,
    r.data,
    COALESCE(NULLIF(r.data->>'dupe_group_id',''), r.id::text) AS group_id,
    (r.data->>'dupe_role') AS role
  FROM public.records r
  JOIN public.models m ON m.id = r.model_id AND m.name = 'market_listings'
  WHERE COALESCE((r.data->>'is_active')::boolean, true)
),
grp AS (
  SELECT
    group_id,
    count(*)                                        AS ad_count,
    array_agg(DISTINCT data->>'source')             AS sources,
    min((data->>'price')::numeric)                  AS min_price,
    max((data->>'price')::numeric)                  AS max_price
  FROM ml GROUP BY group_id
)
SELECT DISTINCT ON (ml.group_id)
  ml.group_id                       AS dupe_group_id,
  ml.id                             AS canonical_record_id,
  grp.ad_count,
  grp.sources,
  (array_length(grp.sources, 1) > 1) AS cross_platform,
  grp.min_price,
  grp.max_price,
  ml.data
FROM ml
JOIN grp USING (group_id)
ORDER BY ml.group_id,
         (ml.role = 'canonical') DESC,          -- prefer the chosen canonical ad
         (ml.data->>'is_verified')::boolean DESC NULLS LAST,
         COALESCE((ml.data->>'image_count')::int, 0) DESC;

COMMIT;
