-- Per-stage reach tracking for the recruitment experience (2026-09-20)
-- ============================================================================
-- Until now we only knew "started" (experience_confirmed_at) and "finished"
-- (experience_decided_at). These three stamp the first time a candidate reaches
-- each intermediate page — the video, the practical task, the offer — so the
-- funnel can show where a candidate stalled, not just that they stalled.
-- First-reach wins (the endpoint only stamps a NULL column). Backward-compatible
-- nullable columns; candidates who finished before this shipped simply have NULLs
-- and the UI treats a later milestone as implying the earlier stages.
-- ============================================================================

ALTER TABLE public.job_applications
  ADD COLUMN IF NOT EXISTS experience_video_at timestamptz,
  ADD COLUMN IF NOT EXISTS experience_task_at  timestamptz,
  ADD COLUMN IF NOT EXISTS experience_offer_at timestamptz;

COMMENT ON COLUMN public.job_applications.experience_video_at IS 'First time the candidate reached the video stage of the experience link.';
COMMENT ON COLUMN public.job_applications.experience_task_at  IS 'First time the candidate reached the practical-task stage.';
COMMENT ON COLUMN public.job_applications.experience_offer_at IS 'First time the candidate reached the offer stage.';
