-- ============================================================================
-- 2026-06-11: document_comments — threaded comments on Wassel documents
-- ----------------------------------------------------------------------------
-- Google-Docs-style comments (Files & Documents upgrade, Part 2 §1). A
-- comment thread = one root row (parent_id NULL) + reply rows pointing at it.
-- The ANCHOR lives in the document content itself as a TipTap `comment` mark
-- (`<span data-comment-id>`), so it moves with edits; this table holds the
-- conversation. anchor_text is a snapshot of the commented text so a thread
-- whose anchor was deleted ("orphaned") can still show what it referred to.
--
-- Access model (mirrors document_links):
--   read     — anyone who can VIEW the file
--   write    — anyone who can VIEW the file (replies + resolve are
--              collaboration, not document edits; note that CREATING a root
--              comment effectively needs edit access anyway because the
--              anchor mark must be saved into the document body)
--   delete   — the comment's author, or a file OWNER ('delete' kind)
--
-- The UPDATE policy is deliberately broad (resolve/reopen by any viewer,
-- Google-Docs posture). A BEFORE UPDATE trigger keeps it honest: only the
-- author may change body; file_id/parent_id/author_id are frozen.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.document_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  -- NULL = thread root. Replies cascade away with their root.
  parent_id uuid REFERENCES public.document_comments(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  -- Snapshot of the commented text at creation (roots only) — orphan display.
  anchor_text text,
  resolved boolean NOT NULL DEFAULT false,
  resolved_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_comments_file ON public.document_comments(file_id);
CREATE INDEX IF NOT EXISTS idx_document_comments_parent ON public.document_comments(parent_id);

-- ─── Shape guards ───────────────────────────────────────────────────────────

-- Replies: parent must exist, live on the same file, and itself be a root
-- (single-level threads). Replies never carry anchor/resolved state of their
-- own. SECURITY DEFINER so the parent lookup isn't subject to the inserting
-- user's RLS (they can see the file anyway — this is belt-and-braces).
CREATE OR REPLACE FUNCTION public.document_comments_validate_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  parent_file uuid;
  parent_parent uuid;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT file_id, parent_id INTO parent_file, parent_parent
      FROM public.document_comments WHERE id = NEW.parent_id;
    IF parent_file IS NULL THEN
      RAISE EXCEPTION 'document_comments: parent % not found', NEW.parent_id;
    END IF;
    IF parent_file <> NEW.file_id THEN
      RAISE EXCEPTION 'document_comments: reply file_id must match parent';
    END IF;
    IF parent_parent IS NOT NULL THEN
      RAISE EXCEPTION 'document_comments: replies cannot nest (parent is itself a reply)';
    END IF;
    NEW.anchor_text := NULL;
    NEW.resolved := false;
    NEW.resolved_by_user_id := NULL;
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS document_comments_validate_insert ON public.document_comments;
CREATE TRIGGER document_comments_validate_insert
  BEFORE INSERT ON public.document_comments
  FOR EACH ROW EXECUTE FUNCTION public.document_comments_validate_insert();

-- Updates: the broad UPDATE policy exists for resolve/reopen. Freeze identity
-- + structure columns, and restrict body edits to the author. Runs as the
-- INVOKING user (no SECURITY DEFINER needed — only NEW/OLD comparisons).
CREATE OR REPLACE FUNCTION public.document_comments_guard_update()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.file_id <> OLD.file_id
     OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.author_id <> OLD.author_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'document_comments: file_id/parent_id/author_id/created_at are immutable';
  END IF;
  IF NEW.body <> OLD.body
     AND public.wassell_app_user_id((SELECT auth.uid())) IS DISTINCT FROM OLD.author_id THEN
    RAISE EXCEPTION 'document_comments: only the author may edit a comment body';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS document_comments_guard_update ON public.document_comments;
CREATE TRIGGER document_comments_guard_update
  BEFORE UPDATE ON public.document_comments
  FOR EACH ROW EXECUTE FUNCTION public.document_comments_guard_update();

-- ─── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.document_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_comments_select ON public.document_comments;
CREATE POLICY document_comments_select ON public.document_comments FOR SELECT TO authenticated
  USING ( public.wassell_can_access_file(file_id, 'view') );

DROP POLICY IF EXISTS document_comments_insert ON public.document_comments;
CREATE POLICY document_comments_insert ON public.document_comments FOR INSERT TO authenticated
  WITH CHECK (
    public.wassell_can_access_file(file_id, 'view')
    AND author_id = public.wassell_app_user_id((SELECT auth.uid()))
  );

DROP POLICY IF EXISTS document_comments_update ON public.document_comments;
CREATE POLICY document_comments_update ON public.document_comments FOR UPDATE TO authenticated
  USING ( public.wassell_can_access_file(file_id, 'view') )
  WITH CHECK ( public.wassell_can_access_file(file_id, 'view') );

DROP POLICY IF EXISTS document_comments_delete ON public.document_comments;
CREATE POLICY document_comments_delete ON public.document_comments FOR DELETE TO authenticated
  USING (
    author_id = public.wassell_app_user_id((SELECT auth.uid()))
    OR public.wassell_can_access_file(file_id, 'delete')
  );

COMMIT;
