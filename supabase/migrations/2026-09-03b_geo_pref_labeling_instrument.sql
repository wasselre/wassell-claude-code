-- ────────────────────────────────────────────────────────────────────────────
-- Geography Understanding Ability — the LABELING INSTRUMENT tables. ADDITIVE.
--
-- Companion to 2026-09-03_geo_preference_ability.sql. Adds the two tables the
-- gold-set labeling workflow needs on top of the evidence/relations/checkpoints
-- already defined there:
--
--   geo_pref_calibration_batch — a named set of subjects assigned to a set of
--     annotators, each holding a role (meaning | geo_operator | adjudicator).
--     Subjects + assignments live inline as jsonb so a batch is one row.
--   geo_pref_labels — one row per (annotator, subject, field, round). BLIND
--     rounds are independent: an annotator never reads another's blind label
--     until `adjudication_open` flips on the batch (enforced in api/geo-preference
--     /labeling.ts; RLS here is coarse authenticated-read, same as the base subsystem).
--
-- SAFETY: like the base subsystem, nothing here writes to a client's active
-- preferences. This is the answer-sheet capture surface only. NOT applied to prod
-- until the subsystem is coherent and verified end-to-end.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Reuse the base subsystem's split enum values via CHECK (no new enum type needed).

-- 1. Calibration batch — the unit of work. Subjects + assignments inline.
CREATE TABLE IF NOT EXISTS public.geo_pref_calibration_batch (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label            text NOT NULL,
  -- Which frozen partition the batch's subjects belong to. TEST/holdout gold is
  -- NEVER exported while the auto-write gate is closed (tuning) — see labeling.ts.
  split            text NOT NULL DEFAULT 'dev' CHECK (split IN ('dev','test','drift_holdout')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','labeling','adjudication','closed')),
  -- Blindness gate: while false, blind-round labels are private to their author.
  -- Flipping true lets adjudicators (and the agreement view) see all blind labels.
  adjudication_open boolean NOT NULL DEFAULT false,
  -- Once a TEST batch is adjudicated its answers are FROZEN — the export guard
  -- refuses to emit them during tuning regardless of any include_test request.
  frozen           boolean NOT NULL DEFAULT false,
  -- Subjects: [{ subject_kind, subject_ref, conversation_id?, client_id? }]
  subjects         jsonb NOT NULL DEFAULT '[]',
  -- Assignments: [{ annotator_id, role }]  role ∈ meaning|geo_operator|adjudicator
  assignments      jsonb NOT NULL DEFAULT '[]',
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- 2. Labels — blind independent + adjudication rows. The instrument's output.
CREATE TABLE IF NOT EXISTS public.geo_pref_labels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL REFERENCES public.geo_pref_calibration_batch(id) ON DELETE CASCADE,
  subject_kind  text NOT NULL CHECK (subject_kind IN ('evidence','anchor','relation','checkpoint')),
  subject_ref   text NOT NULL,        -- evidence/relation/checkpoint id; anchor = '<evidenceId>#<idx>'
  field         text NOT NULL,        -- qualified field name, e.g. 'evidence.holder_role'
  value         text,                 -- chosen enum value / free text / escape token
  is_escape     boolean NOT NULL DEFAULT false,  -- value is one of unknown|insufficient_context|must_confirm
  annotator_id  uuid NOT NULL,
  role          text NOT NULL CHECK (role IN ('meaning','geo_operator','adjudicator')),
  round         text NOT NULL CHECK (round IN ('blind','adjudication')),
  certainty     text CHECK (certainty IN ('clear','ambiguous','insufficient_context')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- One label per (batch, subject, field, annotator, round): re-submitting edits.
  UNIQUE (batch_id, subject_ref, field, annotator_id, round)
);
CREATE INDEX IF NOT EXISTS geo_pref_labels_batch_idx    ON public.geo_pref_labels(batch_id, round);
CREATE INDEX IF NOT EXISTS geo_pref_labels_subject_idx  ON public.geo_pref_labels(batch_id, subject_ref, field);
CREATE INDEX IF NOT EXISTS geo_pref_labels_annotator_idx ON public.geo_pref_labels(annotator_id);

-- Only ONE adjudication (canonical) label may exist per (batch, subject, field).
CREATE UNIQUE INDEX IF NOT EXISTS geo_pref_labels_one_adjudication
  ON public.geo_pref_labels(batch_id, subject_ref, field)
  WHERE round = 'adjudication';

-- RLS: authenticated read (blindness is enforced in the endpoint, not RLS — the
-- endpoint filters other annotators' blind rows before they leave the server).
-- Writes are service-role only (the endpoint uses makeServiceClient after a JWT
-- + assignment check), same posture as the base subsystem.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['geo_pref_calibration_batch','geo_pref_labels'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
  END LOOP;
END $$;

COMMIT;
