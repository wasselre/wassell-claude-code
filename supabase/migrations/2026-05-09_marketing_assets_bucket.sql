-- ──────────────────────────────────────────────────────────────────────
-- 2026-05-09: marketing-assets storage bucket
-- ──────────────────────────────────────────────────────────────────────
-- Storage bucket for the template-driven marketing-operations rebuild
-- (P3 of the 2026-05-09 rebuild). Stores raw uploaded photos, the
-- cleanup-phase output, the design-phase output, and template
-- reference images. Public read so the record form, table cells, and
-- shared dashboards can embed the URL directly without signing.
--
-- Path layout (enforced by `src/lib/imageUpload.ts`):
--   raw/<uuid>.{png,jpg,webp}
--   cleaned/<uuid>.{png,jpg,webp}
--   final/<uuid>.{png,jpg,webp}
--   reference/<uuid>.{png,jpg,webp}
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public)
VALUES ('marketing-assets', 'marketing-assets', true)
ON CONFLICT (id) DO NOTHING;

-- RLS policies on storage.objects scoped to this bucket.

DROP POLICY IF EXISTS "marketing_assets_public_read" ON storage.objects;
CREATE POLICY "marketing_assets_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'marketing-assets');

DROP POLICY IF EXISTS "marketing_assets_authenticated_insert" ON storage.objects;
CREATE POLICY "marketing_assets_authenticated_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'marketing-assets');

DROP POLICY IF EXISTS "marketing_assets_authenticated_update" ON storage.objects;
CREATE POLICY "marketing_assets_authenticated_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'marketing-assets')
  WITH CHECK (bucket_id = 'marketing-assets');

DROP POLICY IF EXISTS "marketing_assets_authenticated_delete" ON storage.objects;
CREATE POLICY "marketing_assets_authenticated_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'marketing-assets');
