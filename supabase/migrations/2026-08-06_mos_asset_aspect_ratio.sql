-- Marketing library assets: chosen pixel shape.
--
-- A photo or video is used at a specific aspect ratio (9:16 for a reel, 1:1 for
-- a square post, 16:9 for landscape). The library stored size in bytes and video
-- runtime but never the pixel SHAPE — the one spec a marketer picks material by.
-- Free-form text (like usage_rights) rather than a CHECK: the canonical choices
-- live in ASSET_ASPECT_RATIOS (src/lib/marketingOS/client.ts) but a one-off
-- ratio must never be rejected at the door.
ALTER TABLE public.mos_assets ADD COLUMN IF NOT EXISTS aspect_ratio text;
