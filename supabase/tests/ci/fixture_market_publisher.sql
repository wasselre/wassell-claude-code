-- Publisher test fixture — a MINIMAL market_listings (+ pgcrypto) so the
-- provenance/outbox migration (_06) and the publisher (_02) can apply and be
-- exercised. This is deliberately SEPARATE from fixture_market_ingest.sql, which
-- must never stub market_listings (that would falsely claim fresh-vs-prod parity).
-- This fixture makes NO parity claim — it exists only to test the publisher.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.market_listings (
  id                      uuid PRIMARY KEY,
  source                  text,
  external_id             text,
  title                   text,
  description             text,
  price                   numeric,
  area                    numeric,
  bedrooms                numeric,
  bathrooms               numeric,
  living_rooms            numeric,
  property_type           text,
  category                text,
  listing_type            text,
  latitude                numeric,
  longitude               numeric,
  image_urls              jsonb,
  video_urls              jsonb,
  main_image_url          text,
  image_count             numeric,
  video_count             numeric,
  feature_count           numeric,
  street_name             text,
  source_url              text,
  source_last_updated_at  timestamptz,
  source_payload          jsonb,
  version                 integer,
  created_by_user_id      uuid,
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ml_source_ext ON public.market_listings (source, external_id);

-- Supabase default privileges reproduced for market_listings too (ACL realism).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
GRANT ALL ON public.market_listings TO anon, authenticated, service_role;
