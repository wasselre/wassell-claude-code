-- ============================================================================
-- 2026-06-11: per-document page settings (wassel_documents.settings)
-- ----------------------------------------------------------------------------
-- Stores the document's page geometry + header/footer config as JSONB:
--   { page_size: 'a4'|'letter'|'legal', orientation: 'portrait'|'landscape',
--     margin: 'normal'|'narrow'|'wide', header_text, footer_text,
--     show_page_numbers: bool, different_first_page: bool }
-- Defaults are applied client-side ({} = all defaults), so existing docs
-- need no backfill. Written through the existing wassel_documents UPDATE
-- policies (same RLS as content edits).
-- ============================================================================

ALTER TABLE public.wassel_documents
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
