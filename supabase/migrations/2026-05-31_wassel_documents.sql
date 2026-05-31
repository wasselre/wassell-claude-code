-- ============================================================================
-- Wassel Documents — Google Docs-style native rich-text documents inside Files.
--
-- A Wassel document is a first-class file (so it lives in /files, supports
-- folders, permissions, sharing, rename, delete via the existing Files system)
-- but its body is rich-text JSON stored in its own per-file row instead of an
-- object in the wassel-files Storage bucket. That keeps file listings fast and
-- lets autosave write small JSON updates instead of round-tripping to Storage.
--
-- Storage shape:
--   - files row: kind='wassel_doc', mime_type='application/vnd.wassel.document+json',
--     size_bytes=0, storage_path='doc:<file_id>' (sentinel — no Storage object
--     actually exists; the path is just there to satisfy the NOT NULL UNIQUE).
--     Existing folder/permission/share infra cascades to wassel_docs unchanged.
--   - wassel_documents row: 1:1 with files via file_id PK + FK ON DELETE CASCADE.
--     Holds TipTap JSON (content_json), an HTML render of it (content_html, used
--     for previews/exports), version (for future optimistic concurrency), and
--     last_edited_by tracking.
--
-- The Wassel CRM frontend never calls Storage signing for wassel_docs — the
-- FileCard click intercepts kind='wassel_doc' and routes to /files/doc/:id.
-- ============================================================================

BEGIN;

-- ─── 1. Extend the files.kind CHECK to include 'wassel_doc' ────────────────
-- The original constraint (set in 2026-05-23_files_system.sql:65) covered
-- only the upload-derived kinds. wassel_doc is a sibling that maps to no MIME
-- and is only ever created via the documents client lib, never via uploadFile.

ALTER TABLE public.files DROP CONSTRAINT IF EXISTS files_kind_check;
ALTER TABLE public.files ADD CONSTRAINT files_kind_check
  CHECK (kind IN ('image','pdf','video','audio','document','wassel_doc','archive','other'));

-- ─── 2. wassel_documents — per-file rich-text body ─────────────────────────
-- Separate table (not a column on files) so:
--   1. File listings stay slim (folder grids never load doc bodies).
--   2. RLS on wassel_documents.SELECT gates body reads independently of the
--      files row visibility (defense in depth).
--   3. Future version_history can be a sibling table without touching files.

CREATE TABLE IF NOT EXISTS public.wassel_documents (
  file_id uuid PRIMARY KEY REFERENCES public.files(id) ON DELETE CASCADE,
  -- TipTap JSON document state. Editor reads/writes this directly.
  content_json jsonb NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb,
  -- HTML render of content_json. Used by preview/export paths that can't
  -- run TipTap (e.g. server-side PDF export later). Kept in sync on every save.
  content_html text NOT NULL DEFAULT '',
  -- Monotonic; bumped on every save. Reserved for optimistic concurrency once
  -- multi-user editing arrives — v1 just increments and ignores conflicts
  -- (single-editor session is the only supported flow).
  version integer NOT NULL DEFAULT 1,
  last_edited_by_user_id uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS wassel_documents_set_updated_at ON public.wassel_documents;
CREATE TRIGGER wassel_documents_set_updated_at BEFORE UPDATE ON public.wassel_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 3. RLS — mirror the files-table cascade rules ─────────────────────────
-- view = anyone who can view the parent file
-- insert/update/delete = anyone who can edit the parent file
-- delete is also covered by ON DELETE CASCADE when the parent file is deleted,
-- so the DELETE policy is mostly belt-and-suspenders.

ALTER TABLE public.wassel_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wassel_documents_select ON public.wassel_documents;
CREATE POLICY wassel_documents_select ON public.wassel_documents FOR SELECT TO authenticated
  USING ( public.wassell_can_access_file(file_id, 'view') );

DROP POLICY IF EXISTS wassel_documents_insert ON public.wassel_documents;
CREATE POLICY wassel_documents_insert ON public.wassel_documents FOR INSERT TO authenticated
  WITH CHECK ( public.wassell_can_access_file(file_id, 'edit') );

DROP POLICY IF EXISTS wassel_documents_update ON public.wassel_documents;
CREATE POLICY wassel_documents_update ON public.wassel_documents FOR UPDATE TO authenticated
  USING ( public.wassell_can_access_file(file_id, 'edit') )
  WITH CHECK ( public.wassell_can_access_file(file_id, 'edit') );

DROP POLICY IF EXISTS wassel_documents_delete ON public.wassel_documents;
CREATE POLICY wassel_documents_delete ON public.wassel_documents FOR DELETE TO authenticated
  USING ( public.wassell_can_access_file(file_id, 'edit') );

COMMIT;
