-- ============================================================================
-- Marketing OS — asset pixel dimensions (width × height)
--
-- WHAT THIS ADDS, AND WHY
-- Library material now records its pixel size — the creative's width × height,
-- e.g. 1080×1920 for a story/reel or 1080×1080 for a square post. It is
-- auto-detected in the browser from the image/video at upload time and is
-- editable per file in the bulk-intake table (screen 23), so a batch of 200
-- files off a card lands with each row's real dimensions instead of nothing.
--
-- Byte size (mos_assets.size_bytes, the "50 MB" already shown) is a DIFFERENT
-- fact and stays as it is; these two columns are the pixel geometry.
--
-- Two typed integer columns rather than one text "1080x1920": anything the app
-- can filter, sort or report on is a real column — the same rule the rest of
-- mos_assets follows (mos_domain_batch section D). Both nullable: audio, PDFs,
-- design source files and un-probeable formats simply have no pixel size.
--
-- Idempotent: re-running is a no-op.
-- ============================================================================
BEGIN;

ALTER TABLE public.mos_assets ADD COLUMN IF NOT EXISTS width_px  integer;
ALTER TABLE public.mos_assets ADD COLUMN IF NOT EXISTS height_px integer;

COMMIT;
