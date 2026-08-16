-- ============================================================================
-- Rollback for Phase 3 · B2 — business_files_search
--
-- Returns the database to its post-B1 / pre-B2 structure. Safe at any time
-- while B2 is dark: nothing calls the function and nothing reads search_text.
-- It becomes unsafe once B5's Library UI is live — from then on the rollback
-- boundary is the feature flag, not this file.
--
-- Dropping `search_text` implicitly drops the trigram index defined on it.
-- B1's objects are untouched.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.business_files_search(text, jsonb, text, integer, integer);

DROP INDEX IF EXISTS public.idx_files_kind;
DROP INDEX IF EXISTS public.idx_files_created_at;
DROP INDEX IF EXISTS public.idx_file_links_role;

ALTER TABLE public.files DROP COLUMN IF EXISTS search_text;

-- Dropped only after the column that depends on it.
DROP FUNCTION IF EXISTS public.wassell_tags_text(text[]);

COMMIT;
