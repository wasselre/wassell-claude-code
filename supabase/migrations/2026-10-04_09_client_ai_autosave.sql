-- The client profile fills itself in (operator, 2026-10-04: "no one needs to
-- approve the product preference, location preference … After the AI reads it,
-- it just adds the preference to the client profile", and "I want AI to select
-- the results without me needing to confirm").
--
--  1. ai_automation_settings: four switches/knobs for the automatic paths.
--  2. client_ai_changes: one row per value the AI wrote onto a client (a
--     preference field, places added, a follow-up result recorded) — the
--     "what the AI changed" trail the chat card lists, and what Undo reverses.
--     Rows that the AI decided NOT to write (a rep's own value kept, a place
--     the checker doubted) are logged too, with applied=false, so the rep can
--     see what was heard.
--  3. chat_outcome_suggestions.auto_applied: the result was recorded by the AI
--     (confirmed_by stays NULL) — keeps the accuracy ledger honest.
--  4. chat_outcome_suggestion_fail: a failed reading is retried (2 more
--     attempts, 2 minutes apart) instead of being final — 14 of 57 readings
--     failed between 27 Sep and 3 Oct, each leaving its chat with no result.
--
-- No 40001/40P01. client_ai_changes is service-role only (read through
-- /api/client-ai-changes, which checks the caller can see the client).

BEGIN;

ALTER TABLE public.ai_automation_settings
  ADD COLUMN IF NOT EXISTS auto_save_profile boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_apply_outcomes boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS outcome_auto_min_confidence integer NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS outcome_quiet_minutes integer NOT NULL DEFAULT 15;

CREATE TABLE IF NOT EXISTS public.client_ai_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('pref', 'place', 'outcome')),
  field        text,
  before_value jsonb,
  after_value  jsonb,
  -- Sets / places: exactly what was ADDED (Undo removes only these).
  added        jsonb,
  applied      boolean NOT NULL DEFAULT true,
  note         text,
  source       text NOT NULL CHECK (source IN ('chat', 'call', 'agent')),
  source_ref   text,
  proposal_id  uuid,
  quote        text,
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  undone_at    timestamptz,
  undone_by    uuid
);
CREATE INDEX IF NOT EXISTS client_ai_changes_client_idx ON public.client_ai_changes (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS client_ai_changes_proposal_idx ON public.client_ai_changes (proposal_id);

ALTER TABLE public.client_ai_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_ai_changes FROM anon, authenticated;
GRANT ALL ON public.client_ai_changes TO service_role;

ALTER TABLE public.chat_outcome_suggestions
  ADD COLUMN IF NOT EXISTS auto_applied boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.chat_outcome_suggestion_fail(p_id uuid, p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_client   uuid;
  v_attempts int;
BEGIN
  SELECT client_id, attempts INTO v_client, v_attempts
    FROM public.chat_outcome_suggestions WHERE id = p_id AND status = 'running';
  IF NOT FOUND THEN RETURN false; END IF;

  -- Retry while attempts remain AND no newer reading is already waiting for
  -- this client (one queued row per client — a newer one supersedes this).
  IF v_attempts < 3 AND NOT EXISTS (
       SELECT 1 FROM public.chat_outcome_suggestions
        WHERE client_id = v_client AND status = 'queued') THEN
    UPDATE public.chat_outcome_suggestions
       SET status = 'queued', not_before = now() + interval '2 minutes',
           error = p_error, worker_id = NULL, started_at = NULL
     WHERE id = p_id AND status = 'running';
  ELSE
    UPDATE public.chat_outcome_suggestions
       SET status = 'failed', finished_at = now(), error = p_error
     WHERE id = p_id AND status = 'running';
  END IF;
  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.chat_outcome_suggestion_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_outcome_suggestion_fail(uuid, text) TO service_role;

COMMIT;
