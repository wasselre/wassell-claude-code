-- ============================================================================
-- 2026-06-11: document_versions + approval workflow columns
-- ----------------------------------------------------------------------------
-- Part 2 §Version history + §Approval workflow of the Files & Documents
-- upgrade.
--
-- VERSIONS: immutable snapshots of a document's content. Capture points
-- (client-driven): every ~10 min of active editing ('auto'), explicit "save
-- version" ('manual', labeled), approval-status transitions ('approval'),
-- and just before a restore ('restore' — the safety net). Auto snapshots are
-- pruned client-side to the most recent 30; manual/approval/restore rows are
-- kept forever. Snapshots are IMMUTABLE — no UPDATE policy at all.
--
-- APPROVAL: a lightweight status on the document body row
-- (draft → review → approved → published). Transitions are UPDATEs through
-- the existing edit-gated policy; the owner-only gate for approve/publish is
-- a UI rule in v1 (same internal-tool posture as comment resolve). Editing
-- the CONTENT of an approved/published doc auto-demotes it to draft
-- (client-side, on save) so a stamp never silently covers newer text.
-- ============================================================================

BEGIN;

-- ─── 1. document_versions ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  -- wassel_documents.version at snapshot time (display + ordering aid).
  doc_version integer NOT NULL DEFAULT 0,
  kind text NOT NULL DEFAULT 'auto' CHECK (kind IN ('auto','manual','approval','restore')),
  label text,
  content_json jsonb NOT NULL,
  content_html text NOT NULL DEFAULT '',
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_versions_file ON public.document_versions(file_id, created_at DESC);

ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_versions_select ON public.document_versions;
CREATE POLICY document_versions_select ON public.document_versions FOR SELECT TO authenticated
  USING ( public.wassell_can_access_file(file_id, 'view') );

DROP POLICY IF EXISTS document_versions_insert ON public.document_versions;
CREATE POLICY document_versions_insert ON public.document_versions FOR INSERT TO authenticated
  WITH CHECK (
    public.wassell_can_access_file(file_id, 'edit')
    AND (created_by_user_id IS NULL OR created_by_user_id = public.wassell_app_user_id((SELECT auth.uid())))
  );

-- Pruning: editors may clear 'auto' rows (retention); file owners may delete
-- anything (cleanup). Manual/approval/restore snapshots are protected from
-- non-owners.
DROP POLICY IF EXISTS document_versions_delete ON public.document_versions;
CREATE POLICY document_versions_delete ON public.document_versions FOR DELETE TO authenticated
  USING (
    (kind = 'auto' AND public.wassell_can_access_file(file_id, 'edit'))
    OR public.wassell_can_access_file(file_id, 'delete')
  );

-- ─── 2. Approval workflow columns ───────────────────────────────────────────

ALTER TABLE public.wassel_documents
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS approval_updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approval_updated_at timestamptz;

ALTER TABLE public.wassel_documents DROP CONSTRAINT IF EXISTS wassel_documents_approval_status_check;
ALTER TABLE public.wassel_documents ADD CONSTRAINT wassel_documents_approval_status_check
  CHECK (approval_status IN ('draft','review','approved','published'));

COMMIT;
