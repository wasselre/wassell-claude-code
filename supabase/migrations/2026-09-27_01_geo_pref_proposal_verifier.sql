-- Geo-preference VERIFIER (2026-09-27): a second AI re-reads the conversation
-- next to the finished map and says, per mention, "right / wrong because ...".
-- ADVISORY ONLY: it never changes the proposal, the gate, or any client record.
-- These columns hold its latest result on the proposal row it checked.
-- Additive + nullable ⇒ backward-compatible with the currently deployed code.

ALTER TABLE public.geo_pref_proposals ADD COLUMN IF NOT EXISTS verifier jsonb;
ALTER TABLE public.geo_pref_proposals ADD COLUMN IF NOT EXISTS verifier_version text;
ALTER TABLE public.geo_pref_proposals ADD COLUMN IF NOT EXISTS verified_at timestamptz;

COMMENT ON COLUMN public.geo_pref_proposals.verifier IS
  'Advisory verifier result (api/_lib/geoPreference/verifier.ts): {status ok|error, overall agree|doubt|unknown, mentions[{evidence_id, verdict, reason}], missed[{span, reason}], error?, model?}. NULL = never verified. status=error / overall=unknown means the check did not run — never read it as agreement. Never gates or changes the proposal.';
COMMENT ON COLUMN public.geo_pref_proposals.verifier_version IS
  'VERIFIER_VERSION of the verifier that produced `verifier` (e.g. geo-verify/v1). NULL = never verified.';
COMMENT ON COLUMN public.geo_pref_proposals.verified_at IS
  'When `verifier` was last written. NULL = never verified.';
