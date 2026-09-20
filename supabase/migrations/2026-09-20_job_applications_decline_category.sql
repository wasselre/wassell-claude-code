-- Structured decline reason for the recruitment experience (2026-09-20)
-- ============================================================================
-- When a candidate picks "العرض غير مناسب لي", we now ask a first multiple-choice
-- question — salary / commission / something else — then a follow-up. The chosen
-- category is stored here; the follow-up answer (desired salary, desired
-- commission, or the free-text reason) continues to live in
-- experience_decline_reason. Backward-compatible: new nullable column + CHECK.
-- ============================================================================

ALTER TABLE public.job_applications
  ADD COLUMN IF NOT EXISTS experience_decline_category text;

ALTER TABLE public.job_applications
  DROP CONSTRAINT IF EXISTS job_applications_experience_decline_category_chk;
ALTER TABLE public.job_applications
  ADD CONSTRAINT job_applications_experience_decline_category_chk
  CHECK (experience_decline_category IS NULL OR experience_decline_category IN ('salary','commission','other'));

COMMENT ON COLUMN public.job_applications.experience_decline_category IS
  'Why the candidate declined the experience offer: salary | commission | other. The follow-up detail is in experience_decline_reason.';
