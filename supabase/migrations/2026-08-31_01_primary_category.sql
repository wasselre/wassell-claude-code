-- File Metadata Intelligence — Primary "Document Type" (single-select, required).
-- ============================================================================
-- Adds ONE required, mutually-exclusive top-level category per file — the "main
-- thing" a file IS. This is a NEW axis, not a repurpose: the existing subject
-- vocab (files.document_type + file_subjects) becomes the SECONDARY multi-select
-- "detailed type", and `asset_nature` / `kind` are left untouched. No existing
-- file data moves.
--
-- The nine values cut across what used to be split over kind + asset_nature +
-- document_type, on purpose — the operator wants one required handle:
--   brochure · unit_plan · design · ai_content · raw_photo
--   raw_video · ready_video · voiceover · music
--
-- Shipped dark & backward-compatible: the column is NULLABLE (7,500 existing
-- files backfill later via AI enrichment), so applying this before the code PR
-- merges changes nothing a current reader sees.
-- ============================================================================

BEGIN;

-- ── 1. The new scalar column ────────────────────────────────────────────────
-- Nullable for now: a required-in-APP field, enforced NOT NULL only AFTER the
-- corpus backfill completes (a later migration). Validated against
-- file_vocabularies(dimension='primary_category') in the app — same posture as
-- the other four axes (no composite FK).
ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS primary_category text;

COMMENT ON COLUMN public.files.primary_category IS
  'The ONE required top-level "Document Type" (brochure / unit_plan / design / ai_content / raw_photo / raw_video / ready_video / voiceover / music). Single-select, distinct from the multi-value subject (document_type + file_subjects) and from asset_nature/kind. Vocab: file_vocabularies dimension=primary_category.';

-- ── 2. Admit the new dimension into the vocabulary CHECK ─────────────────────
ALTER TABLE public.file_vocabularies
  DROP CONSTRAINT IF EXISTS file_vocabularies_dimension_chk;
ALTER TABLE public.file_vocabularies
  ADD CONSTRAINT file_vocabularies_dimension_chk
    CHECK (dimension IN ('asset_nature','acquisition_source','usage_rights',
                         'production_state','primary_category'));

-- ── 3. Seed the nine values (bilingual, editable DATA) ──────────────────────
-- applies_to_kinds scopes the picker so a PDF offers brochure/unit_plan and a
-- video offers raw_video/ready_video. Empty would mean "all kinds"; these are a
-- soft default the UI can relax, and an admin (or the AI) can edit them.
INSERT INTO public.file_vocabularies (dimension, value, label_ar, label_en, applies_to_kinds, sort) VALUES
  ('primary_category','brochure',    'كتيّب',                    'Brochure',            ARRAY['pdf','document','image'], 10),
  ('primary_category','unit_plan',   'مخطط وحدة',                'Unit plan',           ARRAY['pdf','document','image'], 20),
  ('primary_category','design',      'تصميم / محتوى مصمّم',      'Design / edited',     ARRAY['image','pdf'],            30),
  ('primary_category','ai_content',  'محتوى ذكاء اصطناعي',       'AI content',          ARRAY['image','video'],          40),
  ('primary_category','raw_photo',   'صورة خام',                 'Raw photo',           ARRAY['image'],                  50),
  ('primary_category','raw_video',   'فيديو خام',                'Raw video',           ARRAY['video'],                  60),
  ('primary_category','ready_video', 'فيديو جاهز',               'Ready video',         ARRAY['video'],                  70),
  ('primary_category','voiceover',   'تعليق صوتي',               'Voiceover',           ARRAY['audio'],                  80),
  ('primary_category','music',       'موسيقى',                   'Music',               ARRAY['audio'],                  90)
ON CONFLICT (dimension, value) DO NOTHING;

-- ── 4. Filter/facet index ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_files_primary_category
  ON public.files (primary_category) WHERE primary_category IS NOT NULL;

COMMIT;
