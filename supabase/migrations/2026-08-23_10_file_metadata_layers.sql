-- File Metadata Intelligence — Phase A (schema, shipped dark)
--
-- Adds the new metadata LAYERS from docs/files-metadata-intelligence-plan.md,
-- WITHOUT the AI enrichment (that is a later phase). Everything here is nullable
-- or defaulted, so applying it before the code PR merges is safe.
--
-- Naming discipline (hard rule): the existing `origin` (how it arrived),
-- `status` (lifecycle) and `confidentiality` (who sees it) are LEFT ALONE. The
-- new axes get NEW names so nobody conflates them:
--   asset_nature       — real / ai_generated / cgi_render / screenshot / ...
--   acquisition_source — developer / competitor / client / ...
--   usage_rights       — approved / do_not_use / needs_review / ...
--   production_state    — raw / edited / final / published
--
-- `files` is a physical registry table (NOT a JSONB model in `records`), so there
-- is no unified_records / frozen-view chain to unwind here.

BEGIN;

-- ── 1. New scalar axes + AI/technical columns on files ──────────────────────
-- All nullable: a file with none of these set is still a valid file. The 4 axis
-- columns are validated against file_vocabularies in the app (no composite FK —
-- same posture as `tags`, which is also vocabulary-free at the DB level).
ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS asset_nature        text,
  ADD COLUMN IF NOT EXISTS acquisition_source  text,
  ADD COLUMN IF NOT EXISTS usage_rights        text,
  ADD COLUMN IF NOT EXISTS production_state     text,
  ADD COLUMN IF NOT EXISTS ai_description      text,       -- filled by the later AI phase
  ADD COLUMN IF NOT EXISTS ai_suggestions      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- staging for AI (unused until AI phase)
  ADD COLUMN IF NOT EXISTS width_px            integer,
  ADD COLUMN IF NOT EXISTS height_px           integer,
  ADD COLUMN IF NOT EXISTS duration_seconds    numeric,
  ADD COLUMN IF NOT EXISTS page_count          integer;

COMMENT ON COLUMN public.files.asset_nature       IS 'What the asset IS by nature (real / ai_generated / cgi_render / screenshot ...). Distinct from origin (how it arrived).';
COMMENT ON COLUMN public.files.acquisition_source IS 'Where we obtained it (developer / competitor / client ...). Distinct from asset_nature and origin.';
COMMENT ON COLUMN public.files.usage_rights       IS 'What we may DO with it (approved / do_not_use / needs_review ...). Distinct from confidentiality (who may SEE it).';
COMMENT ON COLUMN public.files.production_state    IS 'How ready the asset is (raw / edited / final / published). Distinct from status (lifecycle).';
COMMENT ON COLUMN public.files.ai_description     IS 'Short AI summary of contents. NULL until the AI enrichment phase.';
COMMENT ON COLUMN public.files.ai_suggestions     IS 'Staging area for AI-proposed metadata pending human approval. Unused until the AI enrichment phase.';

-- ── 2. Data-driven vocabulary for the 4 new axes ────────────────────────────
-- One generic table (dimension, value) → the business edits the picklists as
-- DATA, exactly like file_document_types does for subjects. Bilingual.
CREATE TABLE IF NOT EXISTS public.file_vocabularies (
  dimension        text    NOT NULL,   -- asset_nature | acquisition_source | usage_rights | production_state
  value            text    NOT NULL,
  label_ar         text    NOT NULL,
  label_en         text    NOT NULL,
  applies_to_kinds text[]  NOT NULL DEFAULT '{}',  -- empty = all kinds
  sort             integer NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  PRIMARY KEY (dimension, value),
  CONSTRAINT file_vocabularies_dimension_chk
    CHECK (dimension IN ('asset_nature','acquisition_source','usage_rights','production_state'))
);

ALTER TABLE public.file_vocabularies ENABLE ROW LEVEL SECURITY;
-- Readable by any authenticated user (the pickers need it everywhere); writes
-- are admin-only and go through the (later) vocab-admin surface / migrations.
DROP POLICY IF EXISTS file_vocabularies_read ON public.file_vocabularies;
CREATE POLICY file_vocabularies_read ON public.file_vocabularies
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS file_vocabularies_admin_write ON public.file_vocabularies;
CREATE POLICY file_vocabularies_admin_write ON public.file_vocabularies
  FOR ALL TO authenticated
  USING (public.wassell_is_admin(auth.uid()))
  WITH CHECK (public.wassell_is_admin(auth.uid()));

-- Seed with the plan's defaults (editable later — this is DATA).
INSERT INTO public.file_vocabularies (dimension, value, label_ar, label_en, sort) VALUES
  ('asset_nature','real',            'أصلي',                         'Real / original',  10),
  ('asset_nature','ai_generated',    'مُولّد بالذكاء الاصطناعي',      'AI-generated',     20),
  ('asset_nature','ai_edited',       'مُعدّل بالذكاء الاصطناعي',      'AI-edited',        30),
  ('asset_nature','cgi_render',      'تصميم ثلاثي الأبعاد / CGI',    'CGI / render',     40),
  ('asset_nature','graphic_design',  'تصميم جرافيك',                 'Graphic design',   50),
  ('asset_nature','screenshot',      'لقطة شاشة',                    'Screenshot',       60),

  ('acquisition_source','developer', 'المطوّر',                      'Developer',        10),
  ('acquisition_source','internal',  'فريقنا',                       'Internal team',    20),
  ('acquisition_source','competitor','منافس',                       'Competitor',       30),
  ('acquisition_source','client',    'عميل',                         'Client',           40),
  ('acquisition_source','partner',   'شريك',                         'Partner',          50),
  ('acquisition_source','public',    'مصدر عام / تواصل اجتماعي',      'Public / social',  60),
  ('acquisition_source','unknown',   'غير معروف',                    'Unknown',          70),

  ('usage_rights','approved',            'معتمد للاستخدام',          'Approved for use',       10),
  ('usage_rights','use_after_edit',      'قابل للاستخدام بعد التعديل','Use after modification', 20),
  ('usage_rights','attribution_required','يتطلب الإسناد',            'Attribution required',   30),
  ('usage_rights','internal_only',       'للاستخدام الداخلي فقط',    'Internal use only',      40),
  ('usage_rights','restricted',          'مقيّد',                    'Restricted',             50),
  ('usage_rights','do_not_use',          'ممنوع الاستخدام',          'Do not use',             60),
  ('usage_rights','needs_review',        'يحتاج مراجعة',             'Needs review',           70),

  ('production_state','raw',       'خام',            'Raw',              10),
  ('production_state','edited',    'مُعدّل',          'Edited',           20),
  ('production_state','final',     'نهائي / جاهز',   'Final / ready',    30),
  ('production_state','published', 'منشور',          'Published',        40)
ON CONFLICT (dimension, value) DO NOTHING;

-- ── 3. Multi-value subject (classification) ─────────────────────────────────
-- files.document_type stays as the PRIMARY subject (existing FK + search + all
-- current readers keep working). This junction holds the FULL set. A file's
-- primary subject is also mirrored in here so the junction is the complete list.
CREATE TABLE IF NOT EXISTS public.file_subjects (
  file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  subject text NOT NULL REFERENCES public.file_document_types(value) ON UPDATE CASCADE,
  PRIMARY KEY (file_id, subject)
);
CREATE INDEX IF NOT EXISTS idx_file_subjects_subject ON public.file_subjects (subject);

ALTER TABLE public.file_subjects ENABLE ROW LEVEL SECURITY;
-- Reach is gated by the PARENT file's access (same posture as frozen junctions).
DROP POLICY IF EXISTS file_subjects_view ON public.file_subjects;
CREATE POLICY file_subjects_view ON public.file_subjects
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.files f WHERE f.id = file_id
                 AND public.wassell_can_access_file(f.id, 'view')));
DROP POLICY IF EXISTS file_subjects_write ON public.file_subjects;
CREATE POLICY file_subjects_write ON public.file_subjects
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.files f WHERE f.id = file_id
                 AND public.wassell_can_access_file(f.id, 'edit')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.files f WHERE f.id = file_id
                 AND public.wassell_can_access_file(f.id, 'edit')));

-- Backfill: every file's current document_type becomes its first subject row.
INSERT INTO public.file_subjects (file_id, subject)
SELECT id, document_type FROM public.files WHERE document_type IS NOT NULL
ON CONFLICT (file_id, subject) DO NOTHING;

-- ── 4. Per-field provenance (scaffolding for the AI phase) ───────────────────
-- Records, per metadata field, whether the value is AI-suggested, human-approved
-- or human-modified. Mirrors the translation system's proposed→confirmed idea.
-- Populated lightly by manual edits now; fully exercised once AI lands.
CREATE TABLE IF NOT EXISTS public.file_metadata_provenance (
  file_id     uuid        NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  field_path  text        NOT NULL,   -- 'asset_nature' | 'tags' | 'ai_description' | 'subject:<value>' ...
  state       text        NOT NULL,   -- ai_suggested | human_approved | human_modified
  model       text,                    -- which model produced a suggestion (null for pure-human)
  confidence  numeric,
  decided_by  uuid,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, field_path),
  CONSTRAINT file_metadata_provenance_state_chk
    CHECK (state IN ('ai_suggested','human_approved','human_modified'))
);

ALTER TABLE public.file_metadata_provenance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS file_metadata_provenance_view ON public.file_metadata_provenance;
CREATE POLICY file_metadata_provenance_view ON public.file_metadata_provenance
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.files f WHERE f.id = file_id
                 AND public.wassell_can_access_file(f.id, 'view')));
DROP POLICY IF EXISTS file_metadata_provenance_write ON public.file_metadata_provenance;
CREATE POLICY file_metadata_provenance_write ON public.file_metadata_provenance
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.files f WHERE f.id = file_id
                 AND public.wassell_can_access_file(f.id, 'edit')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.files f WHERE f.id = file_id
                 AND public.wassell_can_access_file(f.id, 'edit')));

-- ── 5. Indexes for facet/filter on the new scalar axes ──────────────────────
CREATE INDEX IF NOT EXISTS idx_files_asset_nature       ON public.files (asset_nature)       WHERE asset_nature       IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_acquisition_source ON public.files (acquisition_source) WHERE acquisition_source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_usage_rights       ON public.files (usage_rights)       WHERE usage_rights       IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_production_state     ON public.files (production_state)     WHERE production_state     IS NOT NULL;

COMMIT;
