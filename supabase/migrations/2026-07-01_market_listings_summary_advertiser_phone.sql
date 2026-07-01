-- Add the advertiser-contact enrichment fields to the market_listings summary
-- projection so the slim in-memory store (background-loaded on boot + kept in
-- sync via Realtime) carries the REGA-scraped advertiser phone + lookup status.
-- Without this, the "التواصل مع المعلن" (ContactAdvertiserPanel) can never see a
-- cached advertiser_phone on load, and the Fly worker's write (slimmed on the
-- Realtime path via SUMMARY_DATA_KEYS) never reaches the panel — the button
-- would spin forever. MUST stay in sync with SUMMARY_DATA_KEYS.market_listings
-- in src/lib/lazyModels.ts. The added fields are null for ~all rows → negligible
-- size on the ~31MB slim set.
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
    -- Advertiser-contact enrichment (REGA lookup, 2026-07-01).
    'advertiser_phone', data->'advertiser_phone',
    'rega_lookup_status', data->'rega_lookup_status',
    'rega_lookup_error', data->'rega_lookup_error',
    'rega_lookup_at', data->'rega_lookup_at'
  ) AS data
FROM public.records
WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede';

GRANT SELECT ON public.market_listings_summary TO authenticated;
