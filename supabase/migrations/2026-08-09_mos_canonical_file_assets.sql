-- ============================================================================
-- Marketing library — canonical file-backed assets (Phase 0b)
--
-- WHAT CHANGES
-- New library uploads stop writing a SECOND physical copy under
-- `marketing-assets/mos/`. Bytes land once in the private `wassel-files`
-- bucket with a real `files` row, and the `mos_assets` row REFERENCES it
-- through `file_id` (url / thumb_url / file_path stay NULL).
--
-- That makes the library's bytes private, so library readers need a way to
-- view a file they neither uploaded nor hold a file_permissions grant on.
-- This migration adds exactly that reach — and closes the two paths that would
-- otherwise turn it into privilege escalation.
--
-- THE ESCALATION THIS GUARDS AGAINST
-- Granting "view any file that is a library asset" makes `mos_assets.file_id`
-- an ACCESS GRANT. Before this migration, two paths could point that column at
-- an arbitrary file:
--
--   1. public.mos_register_record_file(uuid) — SECURITY DEFINER and granted to
--      `authenticated`, with NO check on the caller. Any signed-in user could
--      register any project image/PDF into the library.
--   2. The `mos_assets_write` RLS policy gated only on the `manage_assets`
--      capability, so a marketer could INSERT/UPDATE a row with any files.id.
--
-- Both are harmless while file_id grants nothing; both become escalation the
-- moment section 4 lands. So the invariant enforced here is:
--
--      A file may become library-reachable only through a path that has
--      already verified the actor may VIEW that file.
--
-- For a fresh upload the actor IS the uploader, so they pass on ownership.
-- For an existing file the check is explicit. Note the deliberate ordering:
-- at INSERT time the asset row does not exist yet, so section 4's clause
-- cannot vouch for it — access must come from real file rights. Once the row
-- exists the file is already library-reachable, so a second reference to it
-- grants nothing new (and the unique index forbids one anyway).
--
-- SECTION 1 IS DRIFT RECONCILIATION, NOT NEW DESIGN
-- `mos_asset_record_links`, `mos_register_record_file`, the unique index and
-- the `files_autoregister_library` trigger are ALREADY LIVE in production —
-- they were applied from branch `claude/library-link-project-media`, which was
-- never merged, so `main` has no migration for them. Re-declaring them
-- idempotently makes this file replayable on a fresh database and puts the
-- repository back in sync with prod. On prod every statement in section 1 is a
-- no-op except the hardened function body.
--
-- Idempotent. Backward-compatible: it only ADDS reach for library readers and
-- TIGHTENS who may create the link. No existing asset, file or object is
-- touched, and legacy public-URL assets are entirely unaffected.
--
-- ROLLBACK — see the block at the foot of this file.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Drift reconciliation — objects already live in prod, declared for replay
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mos_asset_record_links (
  asset_id   uuid NOT NULL REFERENCES public.mos_assets(id) ON DELETE CASCADE,
  model_id   uuid,
  record_id  uuid NOT NULL,
  role       text NOT NULL DEFAULT 'source',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mos_asset_record_links_role_check
    CHECK (role = ANY (ARRAY['source'::text, 'final'::text, 'reference'::text])),
  CONSTRAINT mos_asset_record_links_pkey PRIMARY KEY (asset_id, record_id)
);

CREATE INDEX IF NOT EXISTS mos_asset_record_links_record_idx
  ON public.mos_asset_record_links (record_id);

ALTER TABLE public.mos_asset_record_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mos_asset_record_links_select ON public.mos_asset_record_links;
CREATE POLICY mos_asset_record_links_select
  ON public.mos_asset_record_links FOR SELECT
  TO authenticated
  USING (true);

-- One library asset per underlying file. Section 3's WITH CHECK leans on this:
-- with the index in place, "already referenced" is unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS mos_assets_file_id_uidx
  ON public.mos_assets (file_id) WHERE file_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Close escalation path #1 — mos_register_record_file
--
-- Body re-emitted VERBATIM from the live definition with two changes, marked
-- TRUSTED-LINK below:
--   a. the caller must already be allowed to view the file;
--   b. EXECUTE is revoked from `authenticated` (nothing in the app calls it
--      directly — the trigger reaches it as the definer regardless).
--
-- A service-role / worker INSERT has no auth.uid(), so the check fails closed
-- and registration is skipped rather than silently trusted. That is the safe
-- direction and costs nothing today: mos_asset_record_links holds 0 rows, so
-- this trigger has never actually registered anything in production.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mos_register_record_file(p_file_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f            record;
  v_model_name text;
  v_asset_id   uuid;
  v_kind       text;
  v_project    uuid;
  v_title      text;
BEGIN
  SELECT id, model_id, record_id, kind, mime_type, original_name, size_bytes,
         uploaded_by_user_id
    INTO f
    FROM public.files
   WHERE id = p_file_id;
  IF NOT FOUND OR f.record_id IS NULL OR f.model_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- TRUSTED-LINK: registering a file into the library makes it viewable by
  -- every library reader, so the caller must already be able to view it.
  -- The uploader of a just-attached file passes on ownership.
  IF NOT public.wassell_can_access_file(p_file_id, 'view') THEN
    RETURN NULL;
  END IF;

  -- Only project photos and brochures (images + PDFs on the project models).
  IF f.kind NOT IN ('image', 'pdf') THEN
    RETURN NULL;
  END IF;
  SELECT name INTO v_model_name FROM public.models WHERE id = f.model_id;
  IF v_model_name IS NULL
     OR v_model_name NOT IN ('all_projects', 'our_projects', 'targeted_projects') THEN
    RETURN NULL;
  END IF;

  v_kind := CASE WHEN f.kind = 'pdf' THEN 'document' ELSE 'photo' END;
  v_project := CASE WHEN v_model_name = 'all_projects' THEN f.record_id ELSE NULL END;
  v_title := regexp_replace(COALESCE(f.original_name, 'ملف'), '\.[^.]+$', '');

  SELECT id INTO v_asset_id FROM public.mos_assets WHERE file_id = p_file_id;
  IF v_asset_id IS NULL THEN
    INSERT INTO public.mos_assets
      (title, kind, source, project_id, file_id, size_bytes, mime_type, original_name,
       created_by_user_id)
    VALUES
      (v_title, v_kind, 'developer', v_project, f.id, f.size_bytes, f.mime_type, f.original_name,
       f.uploaded_by_user_id)
    ON CONFLICT (file_id) WHERE file_id IS NOT NULL DO NOTHING
    RETURNING id INTO v_asset_id;
    -- Lost the race to a concurrent writer → read the winner's row.
    IF v_asset_id IS NULL THEN
      SELECT id INTO v_asset_id FROM public.mos_assets WHERE file_id = p_file_id;
    END IF;
  END IF;

  INSERT INTO public.mos_asset_record_links (asset_id, model_id, record_id, role)
  VALUES (v_asset_id, f.model_id, f.record_id, 'source')
  ON CONFLICT (asset_id, record_id) DO NOTHING;

  RETURN v_asset_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_files_autoregister_library()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.mos_register_record_file(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS files_autoregister_library ON public.files;
CREATE TRIGGER files_autoregister_library
  AFTER INSERT OR UPDATE OF record_id, model_id, kind ON public.files
  FOR EACH ROW
  WHEN (NEW.record_id IS NOT NULL)
  EXECUTE FUNCTION public.tg_files_autoregister_library();

-- Direct invocation is no longer a supported entry point: nothing in the app
-- calls it, and leaving it callable would re-open the escalation path for any
-- signed-in user. The trigger runs it as the definer (postgres owns it and
-- keeps EXECUTE implicitly), so auto-registration is unaffected.
--
-- REVOKING FROM `authenticated` ALONE IS NOT ENOUGH. Postgres grants EXECUTE on
-- every new function to PUBLIC by default, and `authenticated` inherits that —
-- so without the PUBLIC revoke the role still passes
-- has_function_privilege(...,'EXECUTE') and the escalation path stays open.
-- (Caught by the local RLS test; the in-function caller check in section 2 is
-- the second line of defence, not a substitute for this.)
REVOKE EXECUTE ON FUNCTION public.mos_register_record_file(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mos_register_record_file(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mos_register_record_file(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Close escalation path #2 — mos_assets writes must prove file access
--
-- USING is unchanged (manage_assets still decides WHICH rows are writable).
-- WITH CHECK gains the trusted-link requirement on the resulting row.
-- Every mos_* role that holds manage_assets also holds read, so this never
-- blocks an ordinary edit of an already-linked asset.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS mos_assets_write ON public.mos_assets;
CREATE POLICY mos_assets_write ON public.mos_assets
  AS PERMISSIVE FOR ALL TO authenticated
  USING (public.wassell_mos_can('manage_assets'))
  WITH CHECK (
    public.wassell_mos_can('manage_assets')
    AND (
      file_id IS NULL
      OR public.wassell_can_access_file(file_id, 'view')
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Library reach — a file that IS a library asset is viewable by readers
--
-- Body re-emitted VERBATIM from the live definition with ONE inserted block.
-- Placement matters: it sits AFTER the direct-grant check and BEFORE the
-- folder-cascade branch, because that branch RETURNS unconditionally and would
-- otherwise shadow this clause for any file that lives in a folder.
--
-- Scope of the grant:
--   * 'view' ONLY. 'edit' and 'delete' still require real file rights, so a
--     library reader can never rename, replace or destroy the underlying file.
--   * Download rides on 'view' by design — /api/files/sign-download-url gates
--     on wassell_can_access_file(id,'view'), the same as viewing. That matches
--     the behaviour being replaced: today these bytes sit in a PUBLIC bucket
--     where any library reader can already save them. This is a tightening,
--     not a widening.
--   * Archived assets still grant view. Un-archiving is a one-click action for
--     any manage_assets holder, so excluding them would add no security while
--     breaking the archive screens.
--
-- No RLS recursion: this function is SECURITY DEFINER owned by the table
-- owner and `mos_assets` does not FORCE row security, so the EXISTS probe does
-- not re-enter mos_assets_read (which would call back into the MOS capability
-- check). Verified: relforcerowsecurity = false on files and mos_assets.
--
-- Cost: the EXISTS is an index probe on mos_assets_file_id_uidx and is
-- evaluated FIRST, so non-library files (the overwhelming majority) pay one
-- indexed lookup and never reach the capability check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wassell_can_access_file(p_file_id uuid, p_kind text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  app_uid uuid := wassell_app_user_id((SELECT auth.uid()));
  uploader uuid;
  fld uuid;
  direct_role text;
BEGIN
  IF wassell_is_admin((SELECT auth.uid())) THEN RETURN true; END IF;
  IF app_uid IS NULL OR p_file_id IS NULL THEN RETURN false; END IF;
  SELECT uploaded_by_user_id, folder_id INTO uploader, fld FROM public.files WHERE id = p_file_id;
  IF uploader IS NULL THEN RETURN false; END IF;
  IF uploader = app_uid THEN RETURN true; END IF;
  SELECT role INTO direct_role FROM public.file_permissions WHERE file_id = p_file_id AND user_id = app_uid;
  IF direct_role IS NOT NULL AND wassell_role_satisfies(direct_role, p_kind) THEN
    RETURN true;
  END IF;

  -- ── Marketing library reach (2026-08-09) ────────────────────────────────
  IF p_kind = 'view'
     AND EXISTS (SELECT 1 FROM public.mos_assets WHERE file_id = p_file_id)
     AND public.wassell_mos_can('read')
  THEN
    RETURN true;
  END IF;
  -- ────────────────────────────────────────────────────────────────────────

  IF fld IS NOT NULL THEN
    RETURN wassell_role_satisfies(wassell_folder_cascade_role(fld, app_uid), p_kind);
  END IF;
  RETURN false;
END $function$;

COMMIT;

-- ============================================================================
-- ROLLBACK
--
-- Sections 2–4 are the behavioural change; section 1 is inert on prod (the
-- objects predate this file) so it is deliberately NOT dropped — dropping
-- mos_asset_record_links would destroy data this migration did not create.
--
-- BEGIN;
--
-- -- 4. Drop the library reach (restores the pre-2026-08-09 resolution order:
-- --    admin → uploader → file_permissions → folder cascade).
-- CREATE OR REPLACE FUNCTION public.wassell_can_access_file(p_file_id uuid, p_kind text)
-- RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
-- SET search_path TO 'public', 'pg_temp' AS $function$
-- DECLARE
--   app_uid uuid := wassell_app_user_id((SELECT auth.uid()));
--   uploader uuid; fld uuid; direct_role text;
-- BEGIN
--   IF wassell_is_admin((SELECT auth.uid())) THEN RETURN true; END IF;
--   IF app_uid IS NULL OR p_file_id IS NULL THEN RETURN false; END IF;
--   SELECT uploaded_by_user_id, folder_id INTO uploader, fld FROM public.files WHERE id = p_file_id;
--   IF uploader IS NULL THEN RETURN false; END IF;
--   IF uploader = app_uid THEN RETURN true; END IF;
--   SELECT role INTO direct_role FROM public.file_permissions WHERE file_id = p_file_id AND user_id = app_uid;
--   IF direct_role IS NOT NULL AND wassell_role_satisfies(direct_role, p_kind) THEN RETURN true; END IF;
--   IF fld IS NOT NULL THEN
--     RETURN wassell_role_satisfies(wassell_folder_cascade_role(fld, app_uid), p_kind);
--   END IF;
--   RETURN false;
-- END $function$;
--
-- -- 3. Restore the capability-only write policy.
-- DROP POLICY IF EXISTS mos_assets_write ON public.mos_assets;
-- CREATE POLICY mos_assets_write ON public.mos_assets
--   AS PERMISSIVE FOR ALL TO authenticated
--   USING (public.wassell_mos_can('manage_assets'))
--   WITH CHECK (public.wassell_mos_can('manage_assets'));
--
-- -- 2. Restore direct EXECUTE (only needed if something starts calling it).
-- GRANT EXECUTE ON FUNCTION public.mos_register_record_file(uuid) TO authenticated;
--
-- COMMIT;
--
-- NOTE: rolling back section 4 while canonical (file_id-only) assets exist
-- leaves those assets viewable ONLY by their uploader and admins. Roll back
-- the application's upload path at the same time, or the library will show
-- broken tiles for anyone else.
-- ============================================================================
