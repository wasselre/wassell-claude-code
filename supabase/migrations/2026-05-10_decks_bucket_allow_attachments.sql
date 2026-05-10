-- ============================================================================
-- Wassel decks — expand the `wassel-decks` bucket to also accept user-uploaded
-- attachments (Excel, PDF, PowerPoint, Word, images, CSV/text), in addition
-- to the existing .pptx output mime type.
--
-- Background: The brief form on /model/decks lets a user drop reference
-- files (e.g. property data spreadsheets, brochure PDFs, photos) so Claude
-- can inspect them inside the sandbox before designing the deck. Files
-- land in the same bucket under `<auth.uid()>/<deck_id>/uploads/<...>` —
-- same path-prefix RLS as the .pptx output, so a user can only see /
-- write under their own auth.uid() prefix.
--
-- Per-attachment cap is enforced client-side at 32 MB (matches the
-- Anthropic Files API limit). Bucket-wide file_size_limit stays at 100 MB
-- to leave headroom for image-heavy generated decks.
--
-- Bucket-level RLS policies are unchanged — see
-- 2026-05-09_l_decks_storage.sql.
-- ============================================================================

BEGIN;

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  -- Generated outputs (existing)
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  -- User attachments
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'text/csv',
  'text/plain'
]
WHERE id = 'wassel-decks';

COMMIT;
