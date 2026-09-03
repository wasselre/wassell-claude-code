-- ────────────────────────────────────────────────────────────────────────────
-- Geography Understanding Ability — core schema (v7). ADDITIVE ONLY.
--
-- New tables, no ALTER of any existing/frozen model or view → this migration
-- does NOT trigger the frozen-model view-chain unwind. Mirrors the TS contract
-- in api/_lib/geoPreference/ontology.ts (keep the two in sync).
--
-- SAFETY: nothing here writes to a client's active preferences. These tables
-- hold the ability's OWN evidence/relations/checkpoints/gold + review-first
-- proposals. Auto-write to client records stays OFF until the frozen-TEST gate
-- clears (enforced in application code + gate config, not here).
--
-- NOT applied to prod until the subsystem is coherent and verified end-to-end.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Runtime + gold share the same shapes; `origin` distinguishes them.
-- origin: 'model' (Stage-A output), 'gold' (human label), 'adjudicated' (final key input).
CREATE TYPE geo_pref_origin AS ENUM ('model', 'gold', 'adjudicated');

-- 1. Evidence — one row per location mention. Grammar + semantics as columns.
CREATE TABLE IF NOT EXISTS public.geo_pref_evidence (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin                   geo_pref_origin NOT NULL,
  conversation_id          text NOT NULL,           -- chat_wid or phone_calls record id
  client_id                uuid,                    -- resolved client record, when known
  mention_span             text NOT NULL,
  anchors                  jsonb NOT NULL DEFAULT '[]',   -- AnchorToken[]

  speaker                  text NOT NULL CHECK (speaker IN ('client','agent','unknown')),
  preference_holder        text NOT NULL CHECK (preference_holder IN ('client','other_person','unknown')),
  holder_role              text NOT NULL CHECK (holder_role IN ('buyer','co_decision_maker','beneficiary_occupant','influencer','unrelated_third_party','unknown')),
  quoted_speaker           text NOT NULL DEFAULT 'none' CHECK (quoted_speaker IN ('client','agent','third_party','none','unknown')),

  dialogue_act             text NOT NULL CHECK (dialogue_act IN ('statement','question','request','answer')),
  conditionality           text NOT NULL CHECK (conditionality IN ('asserted','hypothetical','conditional','unknown')),
  temporal_reference       text NOT NULL CHECK (temporal_reference IN ('present','past','future','none_explicit')),
  preference_applicability text NOT NULL CHECK (preference_applicability IN ('active','exploratory','counterfactual','unclear')),

  preference_role          text NOT NULL CHECK (preference_role IN ('positive','negative','exploratory','none')),
  commitment               text NOT NULL CHECK (commitment IN ('required','preferred','acceptable','considered','unknown')),
  hardness_evidence        text NOT NULL DEFAULT 'none' CHECK (hardness_evidence IN ('explicit_force','implied','none')),
  modality                 text NOT NULL DEFAULT 'explicit' CHECK (modality IN ('explicit','inferred')),

  annotator_certainty      text CHECK (annotator_certainty IN ('clear','ambiguous','insufficient_context')),
  interpretation_confidence numeric,               -- MODEL only; must be NULL for origin='gold'

  source_channel           text NOT NULL CHECK (source_channel IN ('chat','call')),
  source_ref               text NOT NULL,
  source_timestamp         timestamptz NOT NULL,
  extraction_version       text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gold_has_no_model_confidence
    CHECK (origin <> 'gold' OR interpretation_confidence IS NULL)
);
CREATE INDEX IF NOT EXISTS geo_pref_evidence_conv_idx ON public.geo_pref_evidence(conversation_id, source_timestamp);
CREATE INDEX IF NOT EXISTS geo_pref_evidence_client_idx ON public.geo_pref_evidence(client_id);

-- 2. Relations — typed DAG over evidence/relation nodes.
CREATE TABLE IF NOT EXISTS public.geo_pref_relations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin         geo_pref_origin NOT NULL,
  conversation_id text NOT NULL,
  relation       text NOT NULL CHECK (relation IN ('any_of','all_of','ranked_alternative','exception','comparison')),
  members        jsonb NOT NULL,        -- RelationMemberRef[]
  ordering       jsonb,                 -- RelationMemberRef[] (ranked_alternative)
  target         jsonb,                 -- RelationMemberRef (exception)
  source_span    text NOT NULL,
  explicit_or_inferred text NOT NULL CHECK (explicit_or_inferred IN ('explicit','inferred')),
  interpretation_confidence numeric,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_pref_relations_conv_idx ON public.geo_pref_relations(conversation_id);

-- 3. Compiled geometry + provenance recipe (never store only the polygon).
CREATE TABLE IF NOT EXISTS public.geo_pref_geometry (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  geom                 geometry(Geometry, 4326),
  operation            text NOT NULL,
  source_anchors       jsonb NOT NULL DEFAULT '[]',
  resolved_element_ids text[] NOT NULL DEFAULT '{}',
  radius_or_band_m     numeric,
  universe_source      text CHECK (universe_source IN ('explicit','established_context','organizational_default','unknown')),
  geo_data_version     text NOT NULL,
  resolver_version     text NOT NULL,
  validation_status    text NOT NULL DEFAULT 'ok' CHECK (validation_status IN ('ok','needs_review')),
  compiled_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_pref_geometry_gix ON public.geo_pref_geometry USING gist (geom);

-- 4. Checkpoints — turn-level; lifecycle + both compiled/canonical expressions.
CREATE TABLE IF NOT EXISTS public.geo_pref_checkpoints (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id             text NOT NULL,
  client_id                   uuid,
  turn_id                     text NOT NULL,
  as_of_timestamp             timestamptz NOT NULL,
  member_message_ids          text[] NOT NULL DEFAULT '{}',
  expected_processing         text NOT NULL CHECK (expected_processing IN ('evaluate_now','wait_for_continuation')),
  evidence_visible_so_far     uuid[] NOT NULL DEFAULT '{}',
  lifecycle_by_mention        jsonb NOT NULL DEFAULT '{}',
  actual_compiler_output      jsonb,   -- production compiler (under test)
  canonical_expected_expression jsonb, -- INDEPENDENT answer key (v7 #3)
  required_handling           text CHECK (required_handling IN ('no_profile_effect','resolvable_without_customer','customer_confirmation_required','human_geo_review_required')),
  maximum_safe_action         text CHECK (maximum_safe_action IN ('ignore','retain_as_candidate','propose','write_soft','write_hard','supersede')),
  universe_source             text CHECK (universe_source IN ('explicit','established_context','organizational_default','unknown')),
  -- origin_tag lets gold + model checkpoints coexist for the same turn.
  origin_tag                  geo_pref_origin NOT NULL DEFAULT 'model',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, turn_id, origin_tag)
);
CREATE INDEX IF NOT EXISTS geo_pref_checkpoints_conv_idx ON public.geo_pref_checkpoints(conversation_id, as_of_timestamp);

-- 5. Leakage-safe gold split — client-level DEV/TEST/drift (deterministic).
CREATE TABLE IF NOT EXISTS public.geo_pref_gold_split (
  client_id     uuid PRIMARY KEY,
  split         text NOT NULL CHECK (split IN ('dev','test','drift_holdout')),
  frame         text NOT NULL CHECK (frame IN ('proxy_positive','proxy_negative')),
  assigned_at   timestamptz NOT NULL DEFAULT now()
);

-- 6. Challenge-phenomenon tags — mined labels for capability suites.
CREATE TABLE IF NOT EXISTS public.geo_pref_challenge_tags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  phenomenon      text NOT NULL,   -- namesake|exception|ranked_alternative|supersession|road|landmark|pin|macro_area|conditional_active|decision_maker|no_preference
  evidence_ref    uuid,
  detected_by     text NOT NULL DEFAULT 'mining',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_pref_challenge_phen_idx ON public.geo_pref_challenge_tags(phenomenon);

-- 7. Gate config — thresholds tuned on DEV only. Review-first defaults (all high).
CREATE TABLE IF NOT EXISTS public.geo_pref_gate_config (
  id                       boolean PRIMARY KEY DEFAULT true CHECK (id),
  auto_write_enabled       boolean NOT NULL DEFAULT false,  -- MASTER off until gate cleared
  t_lexical_margin         numeric NOT NULL DEFAULT 0.9,
  t_geo_margin             numeric NOT NULL DEFAULT 0.9,
  t_source_quality         numeric NOT NULL DEFAULT 0.9,
  min_action_assurance     jsonb NOT NULL DEFAULT '{"write_soft":0.9,"write_hard":0.98,"supersede":0.99}',
  updated_at               timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.geo_pref_gate_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- 8. Review-first proposals — what the ability would write, awaiting human confirm.
CREATE TABLE IF NOT EXISTS public.geo_pref_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL,
  checkpoint_id   uuid REFERENCES public.geo_pref_checkpoints(id) ON DELETE SET NULL,
  proposed_action text NOT NULL CHECK (proposed_action IN ('write_soft','write_hard','supersede','confirm','human_review')),
  proposed_expression jsonb NOT NULL,   -- GeoPreference delta
  gate_signals    jsonb,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected','applied')),
  reviewed_by     uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_pref_proposals_client_idx ON public.geo_pref_proposals(client_id, status);

-- RLS: authenticated read; writes service-role/SQL (labeling + runtime are server-side).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['geo_pref_evidence','geo_pref_relations','geo_pref_geometry',
    'geo_pref_checkpoints','geo_pref_gold_split','geo_pref_challenge_tags',
    'geo_pref_gate_config','geo_pref_proposals'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_select ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
  END LOOP;
END $$;

COMMIT;
