-- Geography ability — review surface, invocation, audit, ops. ADDITIVE.
-- Companion to 2026-09-03_geo_preference_ability.sql; the labeling tables
-- (geo_pref_calibration_batch, geo_pref_labels) live in 2026-09-03b, not here.
-- auto_write_enabled stays false. No ALTER of any non-geo_pref object.
-- Applied to wassell-prod 2026-09-03 (geo_preference_review_and_ops + a schema
-- reconcile that moved the labeling tables to 2026-09-03b's richer shape).

BEGIN;

-- 1. Proposals: audit + versioning + rep edits.
ALTER TABLE public.geo_pref_proposals DROP CONSTRAINT IF EXISTS geo_pref_proposals_status_check;
ALTER TABLE public.geo_pref_proposals ADD CONSTRAINT geo_pref_proposals_status_check
  CHECK (status IN ('pending','confirmed','rejected','applied','must_confirm','superseded','edited'));
ALTER TABLE public.geo_pref_proposals ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE public.geo_pref_proposals ADD COLUMN IF NOT EXISTS superseded_by uuid;
ALTER TABLE public.geo_pref_proposals ADD COLUMN IF NOT EXISTS source_evidence_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.geo_pref_proposals ADD COLUMN IF NOT EXISTS final_expression jsonb;
ALTER TABLE public.geo_pref_proposals ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE public.geo_pref_proposals ADD COLUMN IF NOT EXISTS reviewer_note text;

-- 2. Append-only review audit trail.
CREATE TABLE IF NOT EXISTS public.geo_pref_review_audit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id  uuid NOT NULL REFERENCES public.geo_pref_proposals(id) ON DELETE CASCADE,
  reviewer     uuid,
  action       text NOT NULL CHECK (action IN ('confirm','edit','reject','must_confirm','apply')),
  before_state jsonb,
  after_state  jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_pref_review_audit_prop_idx ON public.geo_pref_review_audit(proposal_id, at);

-- 3. Backfill jobs — idempotent, resumable, per-client isolation, dedup.
CREATE TABLE IF NOT EXISTS public.geo_pref_backfill_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      text NOT NULL,
  client_id   uuid NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')),
  attempts    int  NOT NULL DEFAULT 0,
  last_error  text,
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, client_id)
);
CREATE INDEX IF NOT EXISTS geo_pref_backfill_status_idx ON public.geo_pref_backfill_jobs(run_id, status);

-- 4. Per-phenomenon always_confirm policy.
CREATE TABLE IF NOT EXISTS public.geo_pref_phenomenon_policy (
  phenomenon        text PRIMARY KEY,
  policy            text NOT NULL CHECK (policy IN ('always_confirm','validatable','thin')),
  distinct_clients  int,
  definition        text,
  query_logic       text,
  manually_verified boolean NOT NULL DEFAULT false,
  notes             text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 5. Gold split — strata + inclusion probabilities for correct reweighting.
ALTER TABLE public.geo_pref_gold_split ADD COLUMN IF NOT EXISTS stratum text;
ALTER TABLE public.geo_pref_gold_split ADD COLUMN IF NOT EXISTS inclusion_probability numeric;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['geo_pref_review_audit','geo_pref_backfill_jobs','geo_pref_phenomenon_policy'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
  END LOOP;
END $$;

COMMIT;
