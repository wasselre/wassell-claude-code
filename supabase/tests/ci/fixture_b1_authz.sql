-- Authorization surface for the B1 equivalence test.
--
-- Applied AFTER the Phase 1/2 migrations and BEFORE B1, in B1's own database.
-- It reproduces the SHAPE of the production file authorization model closely
-- enough that "reach is unchanged" is a measurement rather than a claim:
--
--   wassell_can_access_file(file_id, kind) := admin
--                                          | uploader
--                                          | explicit file_permissions grant
--                                          | folder cascade
--
-- The production function also carries a marketing view-only clause and the
-- record-derived branch is what B4 will add; neither is exercised here because
-- B1 must not touch either. What matters is that the SAME predicate, over the
-- SAME rows, returns the SAME answer before and after B1 — if B1 accidentally
-- changed a grant, a policy, or a column the predicate reads, this diverges.
--
-- NOTE: this deliberately REPLACES the one-line `test.visible_files` stub that
-- fixture_file_links.sql installs for wassell_can_access_file. That stub is
-- enough for the Phase 1 projection smoke (which only needs "visible or not")
-- but it reads none of the columns B1 adds and none of the tables B1 could
-- disturb, so it cannot detect a reach regression. This file runs only in B1's
-- own database, so the Phase 1 and Phase 2 smokes keep their stub untouched.

CREATE TABLE IF NOT EXISTS public.file_permissions (
  file_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role    text NOT NULL,
  PRIMARY KEY (file_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.folder_permissions (
  folder_id uuid NOT NULL,
  user_id   uuid NOT NULL,
  role      text NOT NULL,
  PRIMARY KEY (folder_id, user_id)
);

-- Mirrors production: viewer < editor < owner.
CREATE OR REPLACE FUNCTION public.wassell_role_satisfies(p_role text, p_kind text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_role IS NULL THEN false
    WHEN p_kind = 'view'   THEN p_role IN ('viewer','editor','owner')
    WHEN p_kind = 'edit'   THEN p_role IN ('editor','owner')
    WHEN p_kind = 'delete' THEN p_role = 'owner'
    ELSE false END
$$;

CREATE OR REPLACE FUNCTION public.wassell_app_user_id(p_auth uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT p_auth $$;

CREATE OR REPLACE FUNCTION public.wassell_is_admin(p_auth uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_auth = '99999999-9999-9999-9999-999999999999'::uuid
$$;

CREATE OR REPLACE FUNCTION public.wassell_can_access_file(p_file_id uuid, p_kind text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public','pg_temp' AS $$
DECLARE app_uid uuid := public.wassell_app_user_id((SELECT auth.uid()));
        uploader uuid; fld uuid; direct_role text; fld_role text;
BEGIN
  IF public.wassell_is_admin((SELECT auth.uid())) THEN RETURN true; END IF;
  IF app_uid IS NULL OR p_file_id IS NULL THEN RETURN false; END IF;
  SELECT uploaded_by_user_id, folder_id INTO uploader, fld FROM public.files WHERE id = p_file_id;
  IF uploader IS NULL THEN RETURN false; END IF;
  IF uploader = app_uid THEN RETURN true; END IF;
  SELECT role INTO direct_role FROM public.file_permissions WHERE file_id=p_file_id AND user_id=app_uid;
  IF direct_role IS NOT NULL AND public.wassell_role_satisfies(direct_role, p_kind) THEN RETURN true; END IF;
  IF fld IS NOT NULL THEN
    SELECT role INTO fld_role FROM public.folder_permissions WHERE folder_id=fld AND user_id=app_uid;
    RETURN public.wassell_role_satisfies(fld_role, p_kind);
  END IF;
  RETURN false;
END $$;

ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.files TO authenticated;

DROP POLICY IF EXISTS files_select ON public.files;
CREATE POLICY files_select ON public.files FOR SELECT TO authenticated
  USING (uploaded_by_user_id = public.wassell_app_user_id((SELECT auth.uid()))
         OR public.wassell_can_access_file(id, 'view'));
DROP POLICY IF EXISTS files_update ON public.files;
CREATE POLICY files_update ON public.files FOR UPDATE TO authenticated
  USING (public.wassell_can_access_file(id, 'edit'));
DROP POLICY IF EXISTS files_delete ON public.files;
CREATE POLICY files_delete ON public.files FOR DELETE TO authenticated
  USING (public.wassell_can_access_file(id, 'delete'));

-- Sharing is gated by 'edit' in production; mirror that.
ALTER TABLE public.file_permissions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.file_permissions TO authenticated;
DROP POLICY IF EXISTS file_permissions_write ON public.file_permissions;
CREATE POLICY file_permissions_write ON public.file_permissions FOR ALL TO authenticated
  USING (public.wassell_can_access_file(file_id, 'edit'));

-- A folder with a cascade grant, and one explicit file grant, so the
-- non-uploader paths are actually exercised rather than trivially false.
INSERT INTO public.folders (id, name) VALUES
  ('f0000000-0000-0000-0000-0000000000f1','مجلد المشاريع') ON CONFLICT (id) DO NOTHING;
UPDATE public.files SET folder_id='f0000000-0000-0000-0000-0000000000f1'
 WHERE id IN ('b1000000-0000-0000-0000-0000000000a1','b1000000-0000-0000-0000-0000000000a2');
INSERT INTO public.folder_permissions (folder_id, user_id, role) VALUES
  ('f0000000-0000-0000-0000-0000000000f1','33333333-3333-3333-3333-333333333333','viewer')
ON CONFLICT DO NOTHING;
INSERT INTO public.file_permissions (file_id, user_id, role) VALUES
  ('b1000000-0000-0000-0000-0000000000a4','33333333-3333-3333-3333-333333333333','editor')
ON CONFLICT DO NOTHING;
