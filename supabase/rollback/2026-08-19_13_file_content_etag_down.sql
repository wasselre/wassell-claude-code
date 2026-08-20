-- ============================================================================
-- Rollback for supabase/migrations/2026-08-19_13_file_content_etag.sql
--
-- Restores business_files_search's duplicate FILTER and health FACET to
-- checksum_sha256, and drops files.content_etag.
--
-- WHAT THIS COSTS: duplicate detection stops working entirely. Not "gets
-- weaker" — stops. checksum_sha256 is NULL for every row in the database
-- (B1 said so deliberately: back-computing it means downloading 6.6 GB), so
-- after this the filter and the facet answer ZERO against 2,975 files that
-- really are byte-identical copies. That is the state the migration existed to
-- leave behind.
--
-- Run it only to unwind a genuine regression, not for tidiness.
--
-- The rewrite is done by regex on the LIVE definition rather than by pasting a
-- function body, for the reason recorded in the migration: this repository's
-- .sql files carry CRLF line endings, so a multi-line literal silently fails to
-- match a stored body that uses LF. Every step is guarded separately, because a
-- single end-guard cannot tell "all of them applied" from "one of them did".
--
-- Idempotent.
-- ============================================================================

BEGIN;

DO $fn$
DECLARE v_src text; v_new text; v_step text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='business_files_search';
  IF v_src IS NULL OR position('content_etag' in v_src) = 0 THEN
    RAISE NOTICE 'B7 rollback: business_files_search does not use content_etag; nothing to undo';
    RETURN;
  END IF;

  v_new := regexp_replace(v_src,
    'NOT v_dupe OR \(fi\.content_etag IS NOT NULL AND EXISTS \(\s*SELECT 1 FROM public\.files d\s*WHERE d\.content_etag = fi\.content_etag\s*AND d\.size_bytes = fi\.size_bytes AND d\.id <> fi\.id\)\)',
    'NOT v_dupe OR (fi.checksum_sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM public.files d WHERE d.checksum_sha256 = fi.checksum_sha256 AND d.id <> fi.id))',
    'g');
  IF v_new = v_src THEN
    RAISE EXCEPTION 'B7 rollback: could not restore the duplicate FILTER predicate';
  END IF;

  v_step := v_new;
  v_new := regexp_replace(v_new,
    'WHERE b7\.content_etag IS NOT NULL\s*AND EXISTS \(SELECT 1 FROM public\.files d\s*WHERE d\.content_etag = b7\.content_etag\s*AND d\.size_bytes = b7\.size_bytes AND d\.id <> b7\.id\)',
    'WHERE b7.checksum_sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM public.files d WHERE d.checksum_sha256 = b7.checksum_sha256 AND d.id <> b7.id)',
    'g');
  IF v_new = v_step THEN
    RAISE EXCEPTION 'B7 rollback: could not restore the duplicate health FACET';
  END IF;

  v_step := v_new;
  v_new := replace(v_new,
    'fi.archived_at, fi.checksum_sha256, fi.content_etag,',
    'fi.archived_at, fi.checksum_sha256,');
  IF v_new = v_step THEN
    RAISE EXCEPTION 'B7 rollback: could not remove content_etag from the base CTE';
  END IF;

  EXECUTE v_new;
END $fn$;

DROP INDEX IF EXISTS public.idx_files_content_etag;
ALTER TABLE public.files DROP COLUMN IF EXISTS content_etag;

COMMIT;
