-- ============================================================================
-- 2026-06-11: document_links — link a file/document to CRM records (multi)
-- ----------------------------------------------------------------------------
-- "Document relationships" (Files & Documents upgrade, Part 2 §15): a Wassel
-- document (or any file) can be linked to MANY records — clients, projects,
-- units, deals... — and automatically appears inside those records.
--
-- Why a new table instead of files.model_id/record_id: that pair is the
-- single record-ATTACHMENT pointer written by Drive-backed record fields
-- (image/multi_image/file/multi_file/attachment) at upload time. Overloading
-- it would (a) cap relationships at one and (b) tangle attachment semantics
-- with relationship semantics. document_links is additive and many-to-many.
--
-- record_id is a SOFT pointer (no FK) because frozen models live in dedicated
-- tables outside public.records — same posture as files.record_id.
--
-- RLS gates BOTH directions by FILE access (wassell_can_access_file):
-- a user who can't open the document shouldn't see it listed on a record,
-- and listing links from the doc side needs view on that same doc. Write
-- (insert/delete) needs edit on the file.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES public.models(id) ON DELETE CASCADE,
  -- Soft pointer; may reference a frozen-model row outside public.records.
  record_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, model_id, record_id)
);

CREATE INDEX IF NOT EXISTS idx_document_links_file ON public.document_links(file_id);
CREATE INDEX IF NOT EXISTS idx_document_links_record ON public.document_links(model_id, record_id);

ALTER TABLE public.document_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_links_select ON public.document_links;
CREATE POLICY document_links_select ON public.document_links FOR SELECT TO authenticated
  USING ( public.wassell_can_access_file(file_id, 'view') );

DROP POLICY IF EXISTS document_links_insert ON public.document_links;
CREATE POLICY document_links_insert ON public.document_links FOR INSERT TO authenticated
  WITH CHECK (
    public.wassell_can_access_file(file_id, 'edit')
    AND created_by_user_id = public.wassell_app_user_id((SELECT auth.uid()))
  );

DROP POLICY IF EXISTS document_links_delete ON public.document_links;
CREATE POLICY document_links_delete ON public.document_links FOR DELETE TO authenticated
  USING ( public.wassell_can_access_file(file_id, 'edit') );

COMMIT;
