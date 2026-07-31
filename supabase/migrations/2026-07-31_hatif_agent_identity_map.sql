-- ============================================================================
-- Make "who made this call?" answerable.
--
-- THE PROBLEM
--   `phone_calls.agent_name` (an assignee field holding a CRM users.id) is
--   EMPTY on every call ever logged, so the CRM cannot say which rep phoned a
--   client. `findAgentUserId` in api/webhook/hatif-call.ts tries email, then
--   name, against the ACTIVE user roster. Both paths fail, for three reasons
--   that compound:
--
--     1. Hatif sends no email. Enumerated across the last 200 raw_event
--        payloads, the only agent fields present are `userId` and `userName` —
--        there is no userEmail / agentEmail / userPrincipalName to match on.
--     2. The name is a first name. Hatif sends «فهد»; the roster holds
--        «فهد عبدالعزيز». normalizeName() cannot bridge that.
--     3. The two highest-volume callers are DEACTIVATED users, and the lookup
--        only ever considered `is_active = true` — so they were not even
--        candidates:
--             فهد عبدالعزيز   830 calls, 1,894 follow-ups, is_active = false
--             صالح العبدالسلام  46 calls,   135 follow-ups, is_active = false
--
-- THE FIX
--   Hatif's `userId` IS stable and always present — 4 distinct values across
--   1,071 calls, one per agent. Map it once to a CRM user and the backend
--   matches on a durable identity forever, while the UI keeps showing whatever
--   name the CRM holds. Names and Hatif labels can drift without breaking it.
--
--   Anchored on EMAIL, per the operator's instruction: the seed below resolves
--   each Hatif agent to a CRM user by their email address, so re-running it
--   against a restored database maps the same humans even if user ids differ.
--
-- DECISIONS RECORDED (operator, 2026-07-31)
--   • Hatif «ريان معاذ» → r.abanumay@wassel.re (the work account, 147 open
--     follow-ups) — NOT the rayan.abanumay@gmail.com account.
--   • مشعل عبدالرحمن ال عبود (127 calls) is deliberately LEFT UNMAPPED: he has
--     no CRM account and genuinely is not a user of the app. His calls keep
--     showing the raw Hatif name and resolve to no CRM user. Last call
--     2026-06-18.
--   • Deactivated users ARE matched (so history attributes correctly) but are
--     never ROUTED to — see the enqueue guard at the bottom. A confirmation
--     popup addressed to an account nobody signs into is a task that silently
--     never gets confirmed.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

BEGIN;

-- ── 1. the mapping column ───────────────────────────────────────────────────

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS hatif_user_id text;

COMMENT ON COLUMN public.users.hatif_user_id IS
  'Hatif''s own user id for this person (raw_event.userId). The stable join key '
  'from a call to a CRM user — Hatif sends no email and only a first name. '
  'Set once per agent; see 2026-07-31_hatif_agent_identity_map.sql.';

-- One Hatif identity cannot belong to two CRM users.
CREATE UNIQUE INDEX IF NOT EXISTS users_hatif_user_id_idx
  ON public.users (hatif_user_id) WHERE hatif_user_id IS NOT NULL;

-- ── 2. seed the mapping, keyed on email ─────────────────────────────────────

UPDATE public.users u
SET hatif_user_id = m.hatif_id
FROM (VALUES
  ('fahad.m@wassel.re',            '3a21fc37-eda6-5e53-017b-222f8f67843c'),  -- فهد            830 calls
  ('s.al-abdulsalam@wassel.re',    '3a22023a-7ce9-eee7-5c47-f54c48b97c66'),  -- صالح            46 calls
  ('r.abanumay@wassel.re',         '3a208b6d-1304-b7fc-5d20-3a8a146d69fb')   -- ريان معاذ       68 calls
  -- 3a20a4cf-42f6-71b1-bf3a-09d1f2963109  مشعل عبدالرحمن ال عبود  127 calls — no CRM account, left unmapped by decision.
) AS m(email, hatif_id)
WHERE lower(trim(u.email)) = lower(trim(m.email))
  AND u.hatif_user_id IS DISTINCT FROM m.hatif_id;

-- ── 3. backfill the historical calls ────────────────────────────────────────
--
-- `phone_calls.agent_name` is an assignee field storing the CRM users.id as a
-- bare string (that is what the webhook writes). Fill it wherever the call's
-- Hatif id now maps to a user.
--
-- SAFE AGAINST THE ANALYSIS TRIGGER: records_enqueue_call_analysis skips an
-- UPDATE unless `status`, `transcription_text` or `client_link` changed. This
-- touches only `agent_name`, so it will not enqueue ~1,300 analysis jobs.

UPDATE public.records r
SET data = r.data || jsonb_build_object('agent_name', u.id::text)
FROM public.call_logs cl
JOIN public.users u ON u.hatif_user_id = cl.agent_user_id::text
WHERE r.id = cl.id
  AND r.model_id = public._sales_phone_calls_model_id()
  AND NULLIF(r.data->>'agent_name', '') IS DISTINCT FROM u.id::text;

-- ── 4. never route a confirmation popup to a deactivated user ───────────────
--
-- Replaces the enqueue from 2026-07-30_call_result_suggestions_route_by_task_owner,
-- adding an is_active gate on the resolved rep. Currently a no-op in practice —
-- the two deactivated reps own zero OPEN follow-ups — but it is the guard that
-- keeps that true when someone is offboarded mid-pipeline.

CREATE OR REPLACE FUNCTION public.call_result_suggestion_enqueue(p_call_record_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_calls   uuid := public._sales_phone_calls_model_id();
  v_rec     public.records%ROWTYPE;
  v_client  uuid;
  v_rep     uuid;
  v_when    timestamptz;
  v_match   uuid;
  v_ftype   text;
  v_id      uuid;
BEGIN
  SELECT * INTO v_rec FROM public.records WHERE id = p_call_record_id;
  IF NOT FOUND OR v_rec.model_id IS DISTINCT FROM v_calls THEN RETURN NULL; END IF;
  IF v_rec.data->>'direction' IS DISTINCT FROM 'outbound' THEN RETURN NULL; END IF;

  v_client := NULLIF(v_rec.data->>'client_link', '')::uuid;
  IF v_client IS NULL THEN RETURN NULL; END IF;

  v_when  := COALESCE(public.try_timestamptz(v_rec.data->>'call_time'), v_rec.created_at, now());
  v_match := public._crs_match_open_followup(v_client, v_when, NULL);

  IF v_match IS NOT NULL THEN
    SELECT COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type'),
           NULLIF(COALESCE(f.data->'sales_rep'->>0, f.data->>'sales_rep'), '')::uuid
      INTO v_ftype, v_rep
      FROM public.records f WHERE f.id = v_match;
  END IF;

  IF v_rep IS NULL THEN
    SELECT NULLIF(COALESCE(c.data->'client_owner'->>0, c.data->>'client_owner'), '')::uuid
      INTO v_rep
      FROM public.records c WHERE c.id = v_client;
  END IF;

  -- A deactivated owner cannot sign in to confirm, so the suggestion would sit
  -- unread forever. Treat them as "no rep" rather than queue invisible work.
  IF v_rep IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = v_rep AND is_active
  ) THEN
    v_rep := NULL;
  END IF;

  IF v_rep IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.call_result_suggestions
    (call_record_id, call_log_id, client_id, rep_user_id, followup_id, followup_type, kind)
  VALUES
    (p_call_record_id, p_call_record_id, v_client, v_rep, v_match, v_ftype,
     CASE WHEN v_match IS NULL THEN 'log_interaction' ELSE 'confirm_followup' END)
  ON CONFLICT (call_record_id) WHERE status IN ('queued','running','ready') DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

COMMIT;
