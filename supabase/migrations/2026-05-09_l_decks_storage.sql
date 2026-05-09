-- ============================================================================
-- Wassel decks — private Supabase Storage bucket for AI-generated .pptx files.
--
-- Used by /api/generate-deck.ts: after Claude (with the wassel-general-ppt
-- skill loaded via the Anthropic API) produces a .pptx in its code-execution
-- sandbox, the endpoint downloads the file from Anthropic's Files API and
-- uploads it here under the path
--   {auth.uid()}/{record_id}/{filename}
-- then issues a signed URL for the client to download.
--
-- Bucket is PRIVATE (no anon SELECT). Authenticated users only see / upload
-- files whose first path segment matches their own auth.uid(). The API
-- endpoint runs with the user's JWT (via withAuth), so the same path-prefix
-- policy gates both the upload (INSERT) and any subsequent direct read.
-- service_role bypasses RLS as usual.
--
-- (SELECT auth.uid()::text) wrapping uses the same initplan pattern as
-- migration 2026-05-06_a1_rls_initplan_wrap.sql to keep the policy fast.
-- ============================================================================

BEGIN;

-- ─── 1. Create the bucket (idempotent) ────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'wassel-decks',
  'wassel-decks',
  false,
  100 * 1024 * 1024,  -- 100 MB max per .pptx
  ARRAY['application/vnd.openxmlformats-officedocument.presentationml.presentation']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ─── 2. RLS policies on storage.objects (path-prefix scoped) ──────────────

DROP POLICY IF EXISTS "wassel_decks_select_own" ON storage.objects;
CREATE POLICY "wassel_decks_select_own"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'wassel-decks'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS "wassel_decks_insert_own" ON storage.objects;
CREATE POLICY "wassel_decks_insert_own"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'wassel-decks'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS "wassel_decks_update_own" ON storage.objects;
CREATE POLICY "wassel_decks_update_own"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'wassel-decks'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  )
  WITH CHECK (
    bucket_id = 'wassel-decks'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS "wassel_decks_delete_own" ON storage.objects;
CREATE POLICY "wassel_decks_delete_own"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'wassel-decks'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

COMMIT;
