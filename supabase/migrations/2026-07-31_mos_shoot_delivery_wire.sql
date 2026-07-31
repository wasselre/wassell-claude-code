-- The wire that makes this NOT Drive (screens 23 + 42). Applied to prod as
-- `mos_shoot_delivery_wire` on 2026-07-31 (additive/inert until code ships):
-- an upload batch linked to a shoot request marks the scenes that were
-- waiting as covered and stamps the request delivered.

ALTER TABLE public.mos_assets
  ADD COLUMN IF NOT EXISTS shoot_request_id uuid
    REFERENCES public.mos_shoot_requests(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_mos_assets_shoot ON public.mos_assets(shoot_request_id);

ALTER TABLE public.mos_shoot_requests
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- Footage status is ASSET-side truth: intake must be able to flip a scene to
-- "have" when its files arrive. Scene INSERT/DELETE stay write_content —
-- creating and cutting scenes is authorship; marking coverage is asset work.
DROP POLICY IF EXISTS mos_scenes_upd ON public.mos_scenes;
CREATE POLICY mos_scenes_upd ON public.mos_scenes
  FOR UPDATE TO authenticated
  USING (public.wassell_mos_can('write_content') OR public.wassell_mos_can('manage_assets'))
  WITH CHECK (public.wassell_mos_can('write_content') OR public.wassell_mos_can('manage_assets'));
