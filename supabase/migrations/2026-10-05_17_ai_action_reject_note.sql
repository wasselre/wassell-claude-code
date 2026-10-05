-- Rejecting an AI-drafted message needs a note (operator, 2026-10-05): why the
-- draft was wrong, so the drafts can be reviewed and improved. Written only by
-- /api/ai-actions (service role) on reject.
ALTER TABLE public.ai_actions ADD COLUMN IF NOT EXISTS reject_note text;
