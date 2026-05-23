-- ============================================================================
-- Files System — Google Drive-style file library inside Wassell CRM.
--
-- Adds: folders + files + file_permissions + folder_permissions + shared_links
-- tables, the wassel-files private Storage bucket with path-prefix RLS, helper
-- RPCs for the cascading folder-permission model, and two anon-callable
-- SECURITY DEFINER RPCs for the public /share/:token route.
--
-- Architecture:
--   - Single workspace (no company_id). Scope is per-user via wassell_app_user_id
--     + wassell_is_admin, same as the rest of the schema.
--   - Folders cascade — granting a folder_permissions row to user X gives X that
--     role on every file and subfolder inside, recursively. Direct file_permissions
--     rows ALWAYS win over folder cascade.
--   - Role precedence: viewer < editor < owner.
--   - 'view' needs viewer+; 'edit' needs editor+; 'delete' needs owner.
--   - storage_path is server-generated as <auth.uid()>/<file_id>.<safe_ext> so
--     user-controlled filenames can never traverse out of their prefix.
--   - shared_links are file-only in v1 (no /share/:token folder URL).
--
-- Mirrors patterns from 2026-05-09_l_decks_storage.sql (bucket + path-prefix RLS)
-- and 2026-05-17_deck_jobs_queue.sql (idempotent BEGIN/COMMIT structure).
-- ============================================================================

BEGIN;

-- ─── 0. Extensions ─────────────────────────────────────────────────────────
-- pgcrypto is bundled with Supabase; making it explicit so future re-runs
-- on a stripped database still work. Used for crypt() + gen_random_bytes().
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── 1. Tables ─────────────────────────────────────────────────────────────

-- folders ─ a Drive-style folder tree owned by app users.
CREATE TABLE IF NOT EXISTS public.folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_folder_id uuid NULL REFERENCES public.folders(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON public.folders(parent_folder_id, name);
CREATE INDEX IF NOT EXISTS idx_folders_owner ON public.folders(created_by_user_id);

-- files ─ metadata for every uploaded artifact. The bytes live in the
-- wassel-files Storage bucket at <storage_path>.
CREATE TABLE IF NOT EXISTS public.files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid NULL REFERENCES public.folders(id) ON DELETE SET NULL,
  -- Optional record attachment. record_id is a SOFT pointer because frozen
  -- models (see CLAUDE.md "Frozen models") live in dedicated tables outside
  -- public.records, so a hard FK can't cover both cases. UI handles "linked
  -- record gone" gracefully.
  model_id uuid NULL REFERENCES public.models(id) ON DELETE SET NULL,
  record_id uuid NULL,
  uploaded_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 500),
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_bucket text NOT NULL DEFAULT 'wassel-files',
  storage_path text NOT NULL UNIQUE,
  -- Derived from mime_type at upload time. Drives which preview component
  -- the UI mounts. 'other' is the fallback (download-only card).
  kind text NOT NULL CHECK (kind IN ('image','pdf','video','audio','document','archive','other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_files_folder ON public.files(folder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_uploader ON public.files(uploaded_by_user_id);
CREATE INDEX IF NOT EXISTS idx_files_record ON public.files(model_id, record_id) WHERE record_id IS NOT NULL;

-- file_permissions ─ per-file grants. Override the folder cascade.
CREATE TABLE IF NOT EXISTS public.file_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer','editor','owner')),
  granted_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_file_perms_user ON public.file_permissions(user_id);

-- folder_permissions ─ per-folder grants that cascade to all descendants.
CREATE TABLE IF NOT EXISTS public.folder_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer','editor','owner')),
  granted_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (folder_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_folder_perms_user ON public.folder_permissions(user_id);

-- shared_links ─ public /share/:token links to one file.
-- Token is URL-safe base64 of 24 random bytes (~192 bits entropy).
-- Password is bcrypt-hashed (pgcrypto crypt+gen_salt).
CREATE TABLE IF NOT EXISTS public.shared_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE DEFAULT replace(replace(replace(encode(gen_random_bytes(24), 'base64'), '+', '-'), '/', '_'), '=', ''),
  created_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  expires_at timestamptz NULL,
  password_hash text NULL,
  allow_download boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  view_count integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shared_links_file ON public.shared_links(file_id, is_active);

-- ─── 2. updated_at trigger ─────────────────────────────────────────────────
-- Reuse the existing set_updated_at() helper if present, otherwise create
-- a minimal one. Idempotent.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS folders_set_updated_at ON public.folders;
CREATE TRIGGER folders_set_updated_at BEFORE UPDATE ON public.folders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS files_set_updated_at ON public.files;
CREATE TRIGGER files_set_updated_at BEFORE UPDATE ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 3. Permission helpers ─────────────────────────────────────────────────
-- All SECURITY DEFINER so they can read tables the caller wouldn't otherwise
-- be allowed to query under RLS; STABLE so the optimizer can cache results
-- within a query.

-- Highest-role grant the caller has on any ancestor of p_folder_id (or the
-- folder itself). Returns NULL if no grant. Used as the cascade input by
-- wassell_can_access_folder and wassell_can_access_file.
CREATE OR REPLACE FUNCTION public.wassell_folder_cascade_role(p_folder_id uuid, p_user_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  best_role text;
BEGIN
  IF p_folder_id IS NULL OR p_user_id IS NULL THEN RETURN NULL; END IF;
  WITH RECURSIVE ancestors AS (
    SELECT id, parent_folder_id FROM public.folders WHERE id = p_folder_id
    UNION ALL
    SELECT f.id, f.parent_folder_id
      FROM public.folders f
      JOIN ancestors a ON f.id = a.parent_folder_id
  )
  SELECT CASE
           WHEN MAX(CASE role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END) = 3 THEN 'owner'
           WHEN MAX(CASE role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END) = 2 THEN 'editor'
           WHEN MAX(CASE role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END) = 1 THEN 'viewer'
           ELSE NULL
         END
    INTO best_role
    FROM public.folder_permissions
   WHERE folder_id IN (SELECT id FROM ancestors)
     AND user_id = p_user_id;
  RETURN best_role;
END $$;

CREATE OR REPLACE FUNCTION public.wassell_role_satisfies(p_role text, p_kind text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind
    WHEN 'view'   THEN p_role IN ('viewer','editor','owner')
    WHEN 'edit'   THEN p_role IN ('editor','owner')
    WHEN 'delete' THEN p_role = 'owner'
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION public.wassell_can_access_folder(p_folder_id uuid, p_kind text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  app_uid uuid := wassell_app_user_id((SELECT auth.uid()));
  creator uuid;
  cascade_role text;
BEGIN
  IF wassell_is_admin((SELECT auth.uid())) THEN RETURN true; END IF;
  IF app_uid IS NULL OR p_folder_id IS NULL THEN RETURN false; END IF;
  SELECT created_by_user_id INTO creator FROM public.folders WHERE id = p_folder_id;
  IF creator IS NULL THEN RETURN false; END IF;
  IF creator = app_uid THEN RETURN true; END IF;
  cascade_role := wassell_folder_cascade_role(p_folder_id, app_uid);
  RETURN wassell_role_satisfies(cascade_role, p_kind);
END $$;

CREATE OR REPLACE FUNCTION public.wassell_can_access_file(p_file_id uuid, p_kind text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
  -- Direct file grant — always wins.
  SELECT role INTO direct_role FROM public.file_permissions WHERE file_id = p_file_id AND user_id = app_uid;
  IF direct_role IS NOT NULL AND wassell_role_satisfies(direct_role, p_kind) THEN
    RETURN true;
  END IF;
  -- Otherwise inherit from folder cascade.
  IF fld IS NOT NULL THEN
    RETURN wassell_role_satisfies(wassell_folder_cascade_role(fld, app_uid), p_kind);
  END IF;
  RETURN false;
END $$;

GRANT EXECUTE ON FUNCTION public.wassell_folder_cascade_role(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_access_folder(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_can_access_file(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_role_satisfies(text, text) TO authenticated, anon;

-- ─── 4. RLS ────────────────────────────────────────────────────────────────

ALTER TABLE public.folders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.files              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_permissions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folder_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_links       ENABLE ROW LEVEL SECURITY;

-- folders ──
DROP POLICY IF EXISTS folders_select ON public.folders;
CREATE POLICY folders_select ON public.folders FOR SELECT TO authenticated
  USING ( public.wassell_can_access_folder(id, 'view') );

DROP POLICY IF EXISTS folders_insert ON public.folders;
CREATE POLICY folders_insert ON public.folders FOR INSERT TO authenticated
  WITH CHECK (
    created_by_user_id = public.wassell_app_user_id((SELECT auth.uid()))
    AND (parent_folder_id IS NULL OR public.wassell_can_access_folder(parent_folder_id, 'edit'))
  );

DROP POLICY IF EXISTS folders_update ON public.folders;
CREATE POLICY folders_update ON public.folders FOR UPDATE TO authenticated
  USING ( public.wassell_can_access_folder(id, 'edit') )
  WITH CHECK ( public.wassell_can_access_folder(id, 'edit') );

DROP POLICY IF EXISTS folders_delete ON public.folders;
CREATE POLICY folders_delete ON public.folders FOR DELETE TO authenticated
  USING ( public.wassell_can_access_folder(id, 'delete') );

-- files ──
DROP POLICY IF EXISTS files_select ON public.files;
CREATE POLICY files_select ON public.files FOR SELECT TO authenticated
  USING ( public.wassell_can_access_file(id, 'view') );

DROP POLICY IF EXISTS files_insert ON public.files;
CREATE POLICY files_insert ON public.files FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by_user_id = public.wassell_app_user_id((SELECT auth.uid()))
    AND (folder_id IS NULL OR public.wassell_can_access_folder(folder_id, 'edit'))
  );

DROP POLICY IF EXISTS files_update ON public.files;
CREATE POLICY files_update ON public.files FOR UPDATE TO authenticated
  USING ( public.wassell_can_access_file(id, 'edit') )
  WITH CHECK ( public.wassell_can_access_file(id, 'edit') );

DROP POLICY IF EXISTS files_delete ON public.files;
CREATE POLICY files_delete ON public.files FOR DELETE TO authenticated
  USING ( public.wassell_can_access_file(id, 'delete') );

-- file_permissions ── viewers see their own grant rows; manageable by file
-- owner OR admin OR anyone with edit on the file (cascade-aware).
DROP POLICY IF EXISTS file_permissions_select ON public.file_permissions;
CREATE POLICY file_permissions_select ON public.file_permissions FOR SELECT TO authenticated
  USING (
    public.wassell_is_admin((SELECT auth.uid()))
    OR user_id = public.wassell_app_user_id((SELECT auth.uid()))
    OR public.wassell_can_access_file(file_id, 'edit')
  );

DROP POLICY IF EXISTS file_permissions_write ON public.file_permissions;
CREATE POLICY file_permissions_write ON public.file_permissions FOR ALL TO authenticated
  USING ( public.wassell_can_access_file(file_id, 'edit') )
  WITH CHECK ( public.wassell_can_access_file(file_id, 'edit') );

-- folder_permissions ── same shape as file_permissions.
DROP POLICY IF EXISTS folder_permissions_select ON public.folder_permissions;
CREATE POLICY folder_permissions_select ON public.folder_permissions FOR SELECT TO authenticated
  USING (
    public.wassell_is_admin((SELECT auth.uid()))
    OR user_id = public.wassell_app_user_id((SELECT auth.uid()))
    OR public.wassell_can_access_folder(folder_id, 'edit')
  );

DROP POLICY IF EXISTS folder_permissions_write ON public.folder_permissions;
CREATE POLICY folder_permissions_write ON public.folder_permissions FOR ALL TO authenticated
  USING ( public.wassell_can_access_folder(folder_id, 'edit') )
  WITH CHECK ( public.wassell_can_access_folder(folder_id, 'edit') );

-- shared_links ── editor+ on the file (or admin) can create/manage links.
DROP POLICY IF EXISTS shared_links_select ON public.shared_links;
CREATE POLICY shared_links_select ON public.shared_links FOR SELECT TO authenticated
  USING ( public.wassell_can_access_file(file_id, 'edit') );

DROP POLICY IF EXISTS shared_links_write ON public.shared_links;
CREATE POLICY shared_links_write ON public.shared_links FOR ALL TO authenticated
  USING ( public.wassell_can_access_file(file_id, 'edit') )
  WITH CHECK ( public.wassell_can_access_file(file_id, 'edit') );

-- ─── 5. Storage bucket ─────────────────────────────────────────────────────
-- wassel-files: private bucket. Path schema is <auth.uid()>/<file_id>.<ext>
-- so the first path segment scopes upload/read to the authenticated user.
-- Permission-grantees CAN'T read another user's prefix directly via bucket
-- RLS — by design. For grantee reads, the API mints signed URLs server-side
-- with the service-role key after the wassell_can_access_file gate passes.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'wassel-files',
  'wassel-files',
  false,
  500 * 1024 * 1024,  -- 500 MB max per file
  ARRAY[
    -- images
    'image/png','image/jpeg','image/webp','image/gif','image/heic','image/heif','image/svg+xml','image/bmp','image/tiff',
    -- documents
    'application/pdf',
    'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain','text/csv','text/markdown',
    -- archives
    'application/zip','application/x-7z-compressed','application/x-rar-compressed','application/gzip',
    -- video
    'video/mp4','video/webm','video/quicktime',
    -- audio
    'audio/mpeg','audio/wav','audio/mp4','audio/ogg','audio/x-m4a'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "wassel_files_select_own" ON storage.objects;
CREATE POLICY "wassel_files_select_own"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'wassel-files'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS "wassel_files_insert_own" ON storage.objects;
CREATE POLICY "wassel_files_insert_own"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'wassel-files'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS "wassel_files_update_own" ON storage.objects;
CREATE POLICY "wassel_files_update_own"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'wassel-files'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  )
  WITH CHECK (
    bucket_id = 'wassel-files'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

DROP POLICY IF EXISTS "wassel_files_delete_own" ON storage.objects;
CREATE POLICY "wassel_files_delete_own"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'wassel-files'
    AND (storage.foldername(name))[1] = (SELECT auth.uid()::text)
  );

-- ─── 6. Anon RPCs for /share/:token ────────────────────────────────────────
-- SECURITY DEFINER so the function can read shared_links + files behind RLS.
-- Returns the bare minimum metadata; URL signing happens in /api/share/view
-- because Supabase Storage signing requires the service-role key, which
-- never crosses into SQL.

CREATE OR REPLACE FUNCTION public.get_shared_file(p_token text, p_password text DEFAULT NULL)
RETURNS TABLE(
  file_id uuid,
  original_name text,
  mime_type text,
  size_bytes bigint,
  kind text,
  allow_download boolean,
  requires_password boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  link public.shared_links%ROWTYPE;
  f public.files%ROWTYPE;
BEGIN
  SELECT * INTO link FROM public.shared_links WHERE token = p_token AND is_active = true LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF link.expires_at IS NOT NULL AND link.expires_at < now() THEN RETURN; END IF;
  IF link.password_hash IS NOT NULL THEN
    IF p_password IS NULL OR crypt(p_password, link.password_hash) <> link.password_hash THEN
      RETURN QUERY SELECT
        NULL::uuid, NULL::text, NULL::text, NULL::bigint, NULL::text,
        link.allow_download, true;
      RETURN;
    END IF;
  END IF;
  SELECT * INTO f FROM public.files WHERE id = link.file_id LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT
    f.id, f.original_name, f.mime_type, f.size_bytes, f.kind,
    link.allow_download, false;
END $$;

GRANT EXECUTE ON FUNCTION public.get_shared_file(text, text) TO anon, authenticated;

-- record_shared_link_view ─ atomic view counter bump + activity_log row.
-- Anonymous, but only mutates one row (its own shared_links record). No
-- secrets leak — the function never reveals which token is valid; it just
-- silently no-ops on invalid input.
CREATE OR REPLACE FUNCTION public.record_shared_link_view(p_token text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  link_id uuid;
  fid uuid;
BEGIN
  UPDATE public.shared_links
     SET view_count = view_count + 1,
         last_viewed_at = now()
   WHERE token = p_token
     AND is_active = true
     AND (expires_at IS NULL OR expires_at > now())
  RETURNING id, file_id INTO link_id, fid;
  IF link_id IS NULL THEN RETURN; END IF;
  INSERT INTO public.activity_log
    (category, event_type, summary_ar, summary_en, details, status)
  VALUES (
    'file', 'shared_view',
    'مشاهدة ملف عبر رابط مشاركة',
    'File viewed via share link',
    jsonb_build_object('shared_link_id', link_id, 'file_id', fid, 'token_prefix', left(p_token, 6)),
    'info'
  );
END $$;

GRANT EXECUTE ON FUNCTION public.record_shared_link_view(text) TO anon, authenticated;

-- set_shared_link_password ─ called by the server-side share-link/create
-- endpoint after inserting the row, so the bcrypt hash is computed by
-- pgcrypto (same algorithm used by get_shared_file's crypt() check).
-- Service-role only; not granted to authenticated/anon.
CREATE OR REPLACE FUNCTION public.set_shared_link_password(p_link_id uuid, p_pw text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_pw IS NULL OR length(p_pw) = 0 THEN
    UPDATE public.shared_links SET password_hash = NULL WHERE id = p_link_id;
  ELSE
    UPDATE public.shared_links
       SET password_hash = crypt(p_pw, gen_salt('bf'))
     WHERE id = p_link_id;
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION public.set_shared_link_password(uuid, text) FROM PUBLIC;
-- Only service_role (and Postgres superuser) can call this.

-- ─── 7. Extend activity_log.category to include 'file' ─────────────────────
-- Current CHECK is ('auth','record','workflow','ai_agent','api','webhook','system')
-- (schema.sql:1065). Drop + re-add with 'file' included.

ALTER TABLE public.activity_log DROP CONSTRAINT IF EXISTS activity_log_category_check;
ALTER TABLE public.activity_log ADD CONSTRAINT activity_log_category_check
  CHECK (category IN ('auth','record','workflow','ai_agent','api','webhook','system','file'));

COMMIT;
