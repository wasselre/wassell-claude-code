-- 2026-10-06: the first visual-reference companies (operator list): brands
-- outside real estate followed ONLY to learn from their visual design.
-- Type 'visual_reference' (2026-10-06_02): collected, media stored, videos to
-- shots, images design-read — never read for content or matched to projects.
--
-- Every handle was checked on the platform itself on 2026-10-06 (name,
-- verification badge, audience): Instagram from the profile page, TikTok from
-- its profile data, YouTube by resolving the @handle to its channel id.
-- Deliberately NOT added:
--   * Rolls-Royce TikTok — the brand has no official account; every match is a
--     fan/squatter account (20-70 followers).
--   * Audi TikTok — @audi is verified but shows 0 videos; nothing to collect.
--   * SEVEN = Saudi Entertainment Ventures (Qiddiya); the other "seven"
--     accounts (a Jeddah PR agency, a clothing brand) are unrelated.
-- Idempotent: companies match on name_en, accounts on (platform, handle).
BEGIN;

WITH brands(name_ar, name_en, website) AS (VALUES
  ('مرسيدس-بنز', 'Mercedes-Benz', 'https://www.mercedes-benz.com'),
  ('رولز رويس', 'Rolls-Royce Motor Cars', 'https://www.rolls-roycemotorcars.com'),
  ('فيراري', 'Ferrari', 'https://www.ferrari.com'),
  ('سڤن', 'SEVEN (Saudi Entertainment Ventures)', 'https://www.seven.sa'),
  ('رينج روفر', 'Range Rover', 'https://www.rangerover.com'),
  ('بورش', 'Porsche', 'https://www.porsche.com'),
  ('أودي', 'Audi', 'https://www.audi.com'),
  ('مازيراتي', 'Maserati', 'https://www.maserati.com'))
INSERT INTO public.mkt_organizations (name_ar, name_en, org_type, website, status, metadata)
SELECT b.name_ar, b.name_en, 'visual_reference', b.website, 'active',
       jsonb_build_object('visual_reference', jsonb_build_object('added', '2026-10-06', 'why', 'design learning — not a competitor'))
  FROM brands b
 WHERE NOT EXISTS (SELECT 1 FROM public.mkt_organizations o WHERE o.name_en = b.name_en);

WITH acc(name_en, platform, handle, provider, external_id, profile_url) AS (VALUES
  ('Mercedes-Benz', 'instagram', 'mercedesbenz', 'apify', NULL, 'https://www.instagram.com/mercedesbenz/'),
  ('Mercedes-Benz', 'tiktok', 'mercedesbenz', 'apify', NULL, 'https://www.tiktok.com/@mercedesbenz'),
  ('Mercedes-Benz', 'youtube', 'MercedesBenz', 'youtube', 'UClj0L8WZrVydk5xKOscI6-A', 'https://www.youtube.com/channel/UClj0L8WZrVydk5xKOscI6-A'),
  ('Rolls-Royce Motor Cars', 'instagram', 'rollsroycecars', 'apify', NULL, 'https://www.instagram.com/rollsroycecars/'),
  ('Rolls-Royce Motor Cars', 'youtube', 'rollsroycecars', 'youtube', 'UCXXYoChpS5hLeZrTaI2I2Mw', 'https://www.youtube.com/channel/UCXXYoChpS5hLeZrTaI2I2Mw'),
  ('Ferrari', 'instagram', 'ferrari', 'apify', NULL, 'https://www.instagram.com/ferrari/'),
  ('Ferrari', 'tiktok', 'ferrari', 'apify', NULL, 'https://www.tiktok.com/@ferrari'),
  ('Ferrari', 'youtube', 'Ferrari', 'youtube', 'UCd8iY-kEHtaB8qt8MH--zGw', 'https://www.youtube.com/channel/UCd8iY-kEHtaB8qt8MH--zGw'),
  ('SEVEN (Saudi Entertainment Ventures)', 'instagram', 'saudi_seven', 'apify', NULL, 'https://www.instagram.com/saudi_seven/'),
  ('SEVEN (Saudi Entertainment Ventures)', 'tiktok', 'saudi_seven', 'apify', NULL, 'https://www.tiktok.com/@saudi_seven'),
  ('SEVEN (Saudi Entertainment Ventures)', 'youtube', 'saudi_seven', 'youtube', 'UCmIc6nNy3AxsW3JajTAxaUg', 'https://www.youtube.com/channel/UCmIc6nNy3AxsW3JajTAxaUg'),
  ('Range Rover', 'instagram', 'rangerover', 'apify', NULL, 'https://www.instagram.com/rangerover/'),
  ('Range Rover', 'tiktok', 'rangerover', 'apify', NULL, 'https://www.tiktok.com/@rangerover'),
  ('Range Rover', 'youtube', 'rangerover', 'youtube', 'UCZANLEnWKjMbuIkCtDUOqlA', 'https://www.youtube.com/channel/UCZANLEnWKjMbuIkCtDUOqlA'),
  ('Porsche', 'instagram', 'porsche', 'apify', NULL, 'https://www.instagram.com/porsche/'),
  ('Porsche', 'tiktok', 'porsche', 'apify', NULL, 'https://www.tiktok.com/@porsche'),
  ('Porsche', 'youtube', 'Porsche', 'youtube', 'UC_BaxRhNREI_V0DVXjXDALA', 'https://www.youtube.com/channel/UC_BaxRhNREI_V0DVXjXDALA'),
  ('Audi', 'instagram', 'audi', 'apify', NULL, 'https://www.instagram.com/audi/'),
  ('Audi', 'youtube', 'Audi', 'youtube', 'UCO5ujNeWRIwP4DbCZqZWcLw', 'https://www.youtube.com/channel/UCO5ujNeWRIwP4DbCZqZWcLw'),
  ('Maserati', 'instagram', 'maserati', 'apify', NULL, 'https://www.instagram.com/maserati/'),
  ('Maserati', 'tiktok', 'maserati', 'apify', NULL, 'https://www.tiktok.com/@maserati'),
  ('Maserati', 'youtube', 'Maserati', 'youtube', 'UCrragB5FbqfGKWyXoD-UAEg', 'https://www.youtube.com/channel/UCrragB5FbqfGKWyXoD-UAEg'))
INSERT INTO public.mkt_social_accounts (organization_id, platform, handle, provider, external_account_id, profile_url, collection_enabled)
SELECT o.id, a.platform, a.handle, a.provider, a.external_id, a.profile_url, true
  FROM acc a
  JOIN public.mkt_organizations o ON o.name_en = a.name_en AND o.org_type = 'visual_reference'
 WHERE NOT EXISTS (SELECT 1 FROM public.mkt_social_accounts s WHERE s.platform = a.platform AND lower(s.handle) = lower(a.handle));

COMMIT;
