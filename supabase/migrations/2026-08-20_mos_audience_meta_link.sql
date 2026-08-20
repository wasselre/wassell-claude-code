-- Option B: link a Wassel audience (mos_audiences) to a Meta Saved Audience, so
-- the ad set's targeting can be pushed from the campaign's own audience field
-- instead of defaulting to KSA. We store the Saved Audience id + a cached copy
-- of its full targeting spec (sent verbatim as the ad set `targeting` on push).
-- Backward-compatible: both columns nullable; unlinked audiences behave as before.
ALTER TABLE public.mos_audiences
  ADD COLUMN IF NOT EXISTS meta_saved_audience_id text,
  ADD COLUMN IF NOT EXISTS meta_targeting jsonb;

COMMENT ON COLUMN public.mos_audiences.meta_saved_audience_id IS
  'Meta Saved Audience id this Wassel audience is linked to (Option B). NULL = not linked.';
COMMENT ON COLUMN public.mos_audiences.meta_targeting IS
  'Cached Meta targeting spec from the linked Saved Audience; sent as the ad set targeting on push.';
