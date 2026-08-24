-- Automatic (deterministic, no-AI) media fields on files.
--
-- duration_seconds / width_px / height_px already exist (Phase A). This adds the
-- snapped display ratio (16:9, 9:16, 1:1 …), derived from width/height at upload
-- by a browser-side probe — never AI, never hand-entered. Length (duration) and
-- dimensions are captured by the same probe into the existing columns.

ALTER TABLE public.files ADD COLUMN IF NOT EXISTS aspect_ratio text;

COMMENT ON COLUMN public.files.aspect_ratio IS
  'Snapped display ratio (16:9 / 9:16 / 1:1 …) derived from width/height at upload. Deterministic, no AI, no human.';

CREATE INDEX IF NOT EXISTS idx_files_aspect_ratio ON public.files (aspect_ratio) WHERE aspect_ratio IS NOT NULL;
