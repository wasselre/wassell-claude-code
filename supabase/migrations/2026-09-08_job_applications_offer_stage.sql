-- Job applications — offer stage + reviewer notes (2026-09-08)
-- ============================================================================
-- Extends the recruiting lifecycle past the interview with an explicit OFFER
-- stage, stores the offer the admin intends to submit on the application row,
-- and adds a free-text reviewer-impression field.
--
-- Status lifecycle (canonical english keys; Arabic labels live in the UI):
--   new → reviewing → interview → offer_pending → offer_sent
--                                             → offer_accepted → hired
--                                             → offer_rejected
--   rejected (terminal, any point)
--
-- Backward-compatible: the CHECK is only widened, new columns are nullable,
-- existing rows are untouched. Admins already hold an unrestricted UPDATE
-- policy on this table, so no RLS change is needed.
-- ============================================================================

ALTER TABLE public.job_applications
  DROP CONSTRAINT IF EXISTS job_applications_status_chk;

ALTER TABLE public.job_applications
  ADD CONSTRAINT job_applications_status_chk
  CHECK (status IN (
    'new','reviewing','interview',
    'offer_pending','offer_sent','offer_accepted','offer_rejected',
    'rejected','hired'
  ));

ALTER TABLE public.job_applications
  ADD COLUMN IF NOT EXISTS offer_salary     numeric,      -- base salary offered (SAR / month)
  ADD COLUMN IF NOT EXISTS offer_commission text,         -- commission offered (free text, e.g. "1.5%")
  ADD COLUMN IF NOT EXISTS offer_details    text,         -- the rest of the offer (bonuses, start date, terms…)
  ADD COLUMN IF NOT EXISTS offer_sent_at    timestamptz,  -- stamped by the UI when status flips to offer_sent
  ADD COLUMN IF NOT EXISTS review_notes     text;         -- reviewer's impression of the candidate

COMMENT ON COLUMN public.job_applications.offer_salary     IS 'Base monthly salary (SAR) in the offer the admin intends to / did submit.';
COMMENT ON COLUMN public.job_applications.offer_commission IS 'Commission in the offer (free text, e.g. "1.5%").';
COMMENT ON COLUMN public.job_applications.offer_details    IS 'Remaining offer terms: bonuses, start date, probation, etc.';
COMMENT ON COLUMN public.job_applications.offer_sent_at    IS 'When the status first moved to offer_sent (set by the UI).';
COMMENT ON COLUMN public.job_applications.review_notes     IS 'Internal reviewer impression / notes. Never shown to the applicant.';
