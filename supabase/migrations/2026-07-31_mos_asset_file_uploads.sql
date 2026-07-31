-- Screen 23: real file intake for the Marketing OS asset library.
-- Applied to prod as `mos_asset_file_uploads` on 2026-07-31 (additive/inert;
-- the UI that uses it ships with the batched parity deploy).
--
-- Files upload DIRECTLY from the browser to the public marketing-assets
-- bucket under the mos/ prefix. Marketing material exists to be published, so
-- public URLs are the point: thumbnails and video previews render with no
-- signed-URL machinery — the same posture as the generated images already in
-- that bucket. The mos_assets row carries the file's identity so duplicate
-- detection compares name+size at intake.

ALTER TABLE public.mos_assets
  ADD COLUMN IF NOT EXISTS file_path text,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS size_bytes bigint,
  ADD COLUMN IF NOT EXISTS original_name text,
  ADD COLUMN IF NOT EXISTS usage_rights text;

DROP POLICY IF EXISTS mos_assets_upload ON storage.objects;
CREATE POLICY mos_assets_upload ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'marketing-assets'
    AND name LIKE 'mos/%'
    AND public.wassell_mos_can('manage_assets')
  );

DROP POLICY IF EXISTS mos_assets_remove ON storage.objects;
CREATE POLICY mos_assets_remove ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'marketing-assets'
    AND name LIKE 'mos/%'
    AND public.wassell_mos_can('manage_assets')
  );
