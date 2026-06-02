-- ============================================================================
-- Wassel data-migration uploads — private Supabase Storage bucket.
--
-- Holds the raw developer files a user uploads into the Data Migration wizard
-- (Excel / CSV / PDF / screenshots / images) under the path
--   {auth.uid()}/{migration_record_id}/uploads/{filename}
--
-- The wizard parses Excel/CSV client-side (never hits the AI). For PDF /
-- image files it mints a short-lived SIGNED URL (RLS lets the owner read)
-- and passes that to POST /api/migrate (action=extract), which fetches the
-- bytes and sends them to Claude vision. No service-role anywhere in this
-- feature — the path-prefix policy gates upload + signed-read by owner.
--
-- Bucket is PRIVATE. 32 MB per file matches the Anthropic per-file limit so
-- we never accept something extraction can't forward. mime types are left
-- unrestricted (HEIC, odd screenshot formats, etc.) — size is the guardrail.
-- ============================================================================

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES (
  'wassel-migrations',
  'wassel-migrations',
  false,
  32 * 1024 * 1024
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS "wassel_migrations_select_own" ON storage.objects;
CREATE POLICY "wassel_migrations_select_own"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'wassel-migrations'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS "wassel_migrations_insert_own" ON storage.objects;
CREATE POLICY "wassel_migrations_insert_own"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'wassel-migrations'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS "wassel_migrations_delete_own" ON storage.objects;
CREATE POLICY "wassel_migrations_delete_own"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'wassel-migrations'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

COMMIT;
