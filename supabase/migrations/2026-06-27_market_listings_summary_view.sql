-- Slim "summary" projection of market_listings for the client to load ALL ~46k
-- rows cheaply (browse/search/map/match) without the heavy per-listing fields
-- (description ~605B, image_urls ~272B, video_urls) that make the full record
-- ~2,383B of JSON. This view is ~459-670B/row → ~31MB JSON total (~6MB gzipped)
-- vs 105MB for the full set. The SPA background-loads this after boot into the
-- in-memory records store (model_id keyed), so all 46k are always available with
-- no pagination; the heavy fields load on-demand when a single listing is opened
-- (RecordFormPage fetches the full row by id from unified_records).
--
-- security_invoker = the querying rep's RLS on `records` applies (market_listings
-- has no per-profile scope today → all authenticated see all rows). Keyset-paged
-- by id like every other boot load.
--
-- Applied to wassell-prod via the management API on 2026-06-27; recorded here.
CREATE OR REPLACE VIEW public.market_listings_summary
WITH (security_invoker = true) AS
SELECT
  id, model_id, created_by_user_id, created_at, updated_at,
  jsonb_build_object(
    'external_id', data->'external_id', 'source', data->'source', 'title', data->'title',
    'listing_type', data->'listing_type', 'category', data->'category', 'property_type', data->'property_type',
    'price', data->'price', 'price_per_m2', data->'price_per_m2', 'area', data->'area',
    'bedrooms', data->'bedrooms', 'bathrooms', data->'bathrooms', 'city', data->'city',
    'region', data->'region', 'district', data->'district', 'district_lookup', data->'district_lookup',
    'city_lookup', data->'city_lookup', 'latitude', data->'latitude', 'longitude', data->'longitude',
    'is_active', data->'is_active', 'main_image_url', data->'main_image_url',
    'advertiser_name', data->'advertiser_name', 'image_count', data->'image_count', 'video_count', data->'video_count'
  ) AS data
FROM public.records
WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede';

GRANT SELECT ON public.market_listings_summary TO authenticated;
