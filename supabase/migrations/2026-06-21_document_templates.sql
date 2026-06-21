-- ============================================================================
-- 2026-06-21: document_templates — the document-generation template registry
-- ----------------------------------------------------------------------------
-- A "document template" is just an ordinary Wassel document (kind='wassel_doc')
-- authored/edited/versioned IN-APP with the existing Documents editor — it
-- already supports A4 page settings, header/footer, an embedded logo image,
-- {{token}} placeholders, terms, and signature sections. This table BINDS such
-- a document to a target record model so a record's "Generate document" action
-- can find the official template(s) for its type.
--
-- This is the foundation of ONE reusable document-generation engine for the
-- whole platform: today Reservations + Offer Prices, tomorrow financing / deed
-- transfer / contracts / brochures — each is just another row here pointing at
-- another authored template, with ZERO engine changes.
--
-- Why a new table (not document_links, not files.model_id/record_id):
--   - document_links binds a file to a specific RECORD (instance). A template
--     binds to a MODEL (class) and carries key/label/default metadata.
--   - Generated PDFs are the things that link to records; the template is the
--     blank form they're stamped from. It must NOT appear in record document
--     panels.
--
-- RLS: SELECT is open to every authenticated user — templates are non-sensitive
-- company forms and the record-side Generate panel must list them for ALL roles
-- (a salesperson generating a reservation needs to see which templates exist).
-- Writes (authoring / binding / default) are an ADMIN concern, same posture as
-- models / workflows / profiles writes. The template DOCUMENT itself is still
-- gated by normal file RLS in the editor.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.document_templates (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The wassel_doc that IS the template. CASCADE: deleting the doc removes the
  -- binding (the doc is the template; without it the binding is meaningless).
  file_id            uuid        NOT NULL REFERENCES public.files(id)  ON DELETE CASCADE,
  -- The record model this template generates documents for.
  model_id           uuid        NOT NULL REFERENCES public.models(id) ON DELETE CASCADE,
  -- Stable, human-readable key for this template within the model
  -- (e.g. 'reservation_form', 'offer_letter'). Unique per model.
  template_key       text        NOT NULL,
  label_ar           text        NOT NULL,
  label_en           text        NOT NULL,
  -- Pre-selected in the Generate menu; at most one active default per model.
  is_default         boolean     NOT NULL DEFAULT false,
  -- Soft-archive instead of delete so existing generated PDFs keep their lineage.
  is_active          boolean     NOT NULL DEFAULT true,
  created_by_user_id uuid        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, template_key)
);

-- The record-panel discovery hot path: active templates for a model.
CREATE INDEX IF NOT EXISTS document_templates_model_idx
  ON public.document_templates (model_id)
  WHERE is_active;

-- At most one default template per model (only counting active ones).
CREATE UNIQUE INDEX IF NOT EXISTS document_templates_one_default_idx
  ON public.document_templates (model_id)
  WHERE is_default AND is_active;

ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;

-- SELECT — any authenticated user sees ACTIVE templates (company forms). Admins
-- additionally see archived ones for the management page.
DROP POLICY IF EXISTS document_templates_select ON public.document_templates;
CREATE POLICY document_templates_select ON public.document_templates FOR SELECT TO authenticated
  USING ( is_active = true OR public.wassell_is_admin((SELECT auth.uid())) );

-- INSERT / UPDATE / DELETE — admin only (matches models/workflows write posture).
DROP POLICY IF EXISTS document_templates_insert ON public.document_templates;
CREATE POLICY document_templates_insert ON public.document_templates FOR INSERT TO authenticated
  WITH CHECK (
    public.wassell_is_admin((SELECT auth.uid()))
    AND created_by_user_id = public.wassell_app_user_id((SELECT auth.uid()))
  );

DROP POLICY IF EXISTS document_templates_update ON public.document_templates;
CREATE POLICY document_templates_update ON public.document_templates FOR UPDATE TO authenticated
  USING ( public.wassell_is_admin((SELECT auth.uid())) )
  WITH CHECK ( public.wassell_is_admin((SELECT auth.uid())) );

DROP POLICY IF EXISTS document_templates_delete ON public.document_templates;
CREATE POLICY document_templates_delete ON public.document_templates FOR DELETE TO authenticated
  USING ( public.wassell_is_admin((SELECT auth.uid())) );

COMMIT;
