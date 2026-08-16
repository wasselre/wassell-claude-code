-- ============================================================================
-- Rollback for Phase 3 · B1 — Business-file metadata foundation
--
-- Returns the database to its exact pre-B1 structure. Safe at any time during
-- B1: nothing reads these columns (B1 ships dark), so dropping them cannot
-- break a running deployment. It becomes unsafe once B2's search RPC or B5's
-- Library UI is live — from then on the rollback boundary is the feature flag,
-- not this file.
--
-- Dropping the `files` columns implicitly drops every index, CHECK and FK
-- defined on them, so those are not listed separately. `file_document_types`
-- is dropped last because both `files.document_type` and `document_links.role`
-- reference it.
--
-- Run with:  psql "$PGURL" -v ON_ERROR_STOP=1 -f <this file>
-- ============================================================================

BEGIN;

DROP TRIGGER  IF EXISTS files_fill_business_metadata ON public.files;
DROP FUNCTION IF EXISTS public.tg_files_fill_business_metadata();

ALTER TABLE public.files
  DROP COLUMN IF EXISTS title,
  DROP COLUMN IF EXISTS document_type,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS tags,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS owner_user_id,
  DROP COLUMN IF EXISTS origin,
  DROP COLUMN IF EXISTS file_class,
  DROP COLUMN IF EXISTS checksum_sha256,
  DROP COLUMN IF EXISTS valid_from,
  DROP COLUMN IF EXISTS valid_until,
  DROP COLUMN IF EXISTS confidentiality,
  DROP COLUMN IF EXISTS archived_at;

ALTER TABLE public.document_links DROP COLUMN IF EXISTS role;

DROP TABLE IF EXISTS public.file_document_types;

COMMIT;
