-- Global expiry for the recruitment-experience link (2026-09-20)
-- ============================================================================
-- After this cutoff the resolve endpoint returns `expired` and the page shows
-- «لقد انتهت صلاحية الدعوة». One global cutoff (not per-invite) — the current
-- cohort of 18 links all expire together. NULL = no expiry (the default for any
-- future re-send until an operator sets a new cutoff). Backward-compatible:
-- a nullable column; the endpoint treats NULL as "never expires".
-- ============================================================================

ALTER TABLE public.careers_settings
  ADD COLUMN IF NOT EXISTS experience_expires_at timestamptz;

COMMENT ON COLUMN public.careers_settings.experience_expires_at IS
  'Global cutoff for the recruitment experience link. When now() > this value the resolve endpoint returns expired and the page shows «لقد انتهت صلاحية الدعوة». NULL = no expiry.';
