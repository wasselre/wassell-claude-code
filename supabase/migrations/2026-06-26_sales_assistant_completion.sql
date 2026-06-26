-- ============================================================================
-- 2026-06-26: Sales Assistant — Product Completion
-- ----------------------------------------------------------------------------
-- Two small PHYSICAL tables backing the "Suggested Projects" completion phase:
--
--   1. assistant_recommendation_runs — a lightweight audit log of every
--      deterministic recommendation run (one row per /api/suggest-projects call).
--      Stores the input prefs + a result SUMMARY + the recommended project ids +
--      the draft/legacy flags — NOT the full payload. Physical (not records-backed)
--      because it grows unbounded and must never bloat the SPA's boot load.
--
--   2. feature_flags — a singleton key/enabled table. Seeds
--      `sales_assistant_enabled = true`. The SPA reads it (fail-open) to gate the
--      Follow-up Sales Assistant panel + Suggested Projects modal. Rollback for the
--      whole feature = flip this row, NOT a schema rollback.
--
-- Both are owner/role gated by RLS. Additive + idempotent.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- 1. assistant_recommendation_runs (audit log)
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assistant_recommendation_runs (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             uuid,                              -- the lead, when known
  followup_id           uuid,                              -- the follow-up record, when run from one
  input_preferences     jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- the MatchRequirements used
  result_summary        jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- per-group counts + metadata (NOT full results)
  result_project_ids    text[]      NOT NULL DEFAULT '{}',         -- the recommended all_projects ids
  used_draft_values     boolean     NOT NULL DEFAULT false,        -- ran against unsaved follow-up edits
  used_legacy_fallback  boolean     NOT NULL DEFAULT false,        -- district unresolved / text-matched
  -- Owner = auth.uid() of the salesperson who ran it (matches the api auth model:
  -- withAuth returns the auth.users id, and the endpoint uses the caller's JWT).
  created_by            uuid        NOT NULL DEFAULT auth.uid(),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_rec_runs_owner_idx
  ON public.assistant_recommendation_runs (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS assistant_rec_runs_client_idx
  ON public.assistant_recommendation_runs (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS assistant_rec_runs_followup_idx
  ON public.assistant_recommendation_runs (followup_id, created_at DESC);

ALTER TABLE public.assistant_recommendation_runs ENABLE ROW LEVEL SECURITY;

-- The salesperson may insert their OWN runs (created_by must equal their uid) and
-- read their OWN runs. The endpoint inserts via the caller's JWT, so auth.uid()
-- is the salesperson — owner gating works without service-role.
DROP POLICY IF EXISTS "assistant_rec_runs_owner_insert" ON public.assistant_recommendation_runs;
CREATE POLICY "assistant_rec_runs_owner_insert"
  ON public.assistant_recommendation_runs FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "assistant_rec_runs_owner_select" ON public.assistant_recommendation_runs;
CREATE POLICY "assistant_rec_runs_owner_select"
  ON public.assistant_recommendation_runs FOR SELECT
  TO authenticated
  USING (created_by = auth.uid());

-- ────────────────────────────────────────────────────────────────────────
-- 2. feature_flags (runtime kill switches)
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.feature_flags (
  key         text        PRIMARY KEY,
  enabled     boolean     NOT NULL DEFAULT true,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed the Sales Assistant flag ON. ON CONFLICT DO NOTHING so re-running the
-- migration never re-enables a flag an operator deliberately turned off.
INSERT INTO public.feature_flags (key, enabled, description)
VALUES ('sales_assistant_enabled', true,
        'Follow-up Sales Assistant panel + Suggested Projects modal. Set false to hide the whole feature (rollback without schema change).')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

-- Everyone authenticated can READ flags (the SPA gates UI on them). Writes are
-- intentionally NOT granted to authenticated — flip flags via SQL / service role.
DROP POLICY IF EXISTS "feature_flags_read" ON public.feature_flags;
CREATE POLICY "feature_flags_read"
  ON public.feature_flags FOR SELECT
  TO authenticated
  USING (true);

COMMIT;
