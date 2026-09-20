-- Per-candidate recruitment-experience link (2026-09-17)
-- ============================================================================
-- Ties the private recruitment experience (/careers/experience/<token>) to a
-- real job_applications row. An admin "sends the experience link" → we mint a
-- per-candidate secret token and set status='offer_sent'. The candidate opens
-- the link, confirms their name/phone, goes through intro → video → task →
-- offer, and picks interested / not-interested at the end — which flips the
-- status to offer_accepted / offer_rejected and (for a decline) stores the
-- reason.
--
-- The statuses already exist (2026-09-08 offer stage): 'offer_sent',
-- 'offer_accepted', 'offer_rejected'. This migration only adds the columns the
-- link + decision need. Fully backward-compatible: all new columns are
-- nullable, no CHECK is tightened, existing rows are untouched.
--
-- Access posture (unchanged): the browser never touches this table. The public
-- confirm/decision goes through the rate-limited, token-authed service-role
-- endpoint `api/careers/experience`; admins read/update via their JWT + the
-- existing `wassell_is_admin` RLS; the admin send goes through
-- `api/careers/send-experience` (admin-gated by the same RLS read).
-- ============================================================================

ALTER TABLE public.job_applications
  ADD COLUMN IF NOT EXISTS invite_token             text,         -- per-candidate secret in the link
  ADD COLUMN IF NOT EXISTS experience_confirmed_at  timestamptz,  -- when they confirmed name/phone at entry
  ADD COLUMN IF NOT EXISTS experience_decided_at    timestamptz,  -- when they chose interested / declined
  ADD COLUMN IF NOT EXISTS experience_decision      text,         -- 'interested' | 'declined'
  ADD COLUMN IF NOT EXISTS experience_decline_reason text;        -- free text (only when declined)

ALTER TABLE public.job_applications
  DROP CONSTRAINT IF EXISTS job_applications_experience_decision_chk;
ALTER TABLE public.job_applications
  ADD CONSTRAINT job_applications_experience_decision_chk
  CHECK (experience_decision IS NULL OR experience_decision IN ('interested','declined'));

-- The token is the only credential on the public link, so it must be unique and
-- is looked up on every open. Partial unique index (nulls allowed for rows that
-- never had a link sent).
CREATE UNIQUE INDEX IF NOT EXISTS job_applications_invite_token_uidx
  ON public.job_applications (invite_token)
  WHERE invite_token IS NOT NULL;

COMMENT ON COLUMN public.job_applications.invite_token IS
  'Per-candidate secret token for the private recruitment experience link (/careers/experience/<token>). Minted when the admin sends the link.';
COMMENT ON COLUMN public.job_applications.experience_decision IS
  'The candidate''s own decision at the end of the experience: interested | declined. Distinct from the admin status.';
