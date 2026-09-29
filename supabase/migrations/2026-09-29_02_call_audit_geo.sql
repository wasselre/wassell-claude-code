-- ============================================================================
-- Call audit, part 2: PLACES (geography) from calls.
-- ============================================================================
-- Operator request 2026-09-29 ("do places from calls"): the call audit
-- (2026-09-29_01) proposed only the six preference fields and dropped
-- geography. It now also runs the geography pipeline on the call — with the
-- SAME never-overwrite posture: places are proposed ONLY for a client with NO
-- places, and the save (api/geo-preference/review.ts) refuses when places
-- appeared since.
--
-- 1. call_pref_audit gains the geo pass's own result: geo_status, geo_reason,
--    geo_proposal_id (the geo_pref_proposals row the audit minted — the card
--    shows ONLY these, never older calibration proposals on the same call),
--    geo_attempts.
-- 2. call_audit_candidates (DROP + CREATE — RETURNS TABLE changes) also lists
--    a call whose preference audit is terminal (done / skipped) but whose geo
--    pass never ran or failed (< 3 attempts), and says which passes are due:
--    needs_prefs, needs_geo. Every existing condition is kept.
-- 3. call_audit_geo_claim — the lease for a GEO-ONLY pass (the preference audit
--    is already terminal). It re-uses the row's single lease_until, so a
--    geo-only pass and a preference pass can never run on one call at once.
-- 4. call_audit_geo_finish — records the geo pass.
--
-- THE LEASE, both passes (race-safe with the same lease):
--   • preference pass (fresh / failed / crashed call): call_audit_claim sets
--     status='running' + lease_until (unchanged). The geo pass runs INSIDE that
--     lease; call_audit_geo_finish records it while status is still 'running'
--     (and bumps geo_attempts), then call_audit_finish clears the lease.
--   • geo-only pass (status done / skipped): call_audit_geo_claim sets
--     lease_until (+ geo_attempts) ONLY when no lease is live — the loser of a
--     race re-evaluates the WHERE against the winner's committed row and
--     updates nothing. call_audit_geo_finish clears the lease. status / reason /
--     proposal_id / missed_fields (the preference result) are never touched.
--   call_audit_claim only ever takes a 'failed' or lease-expired 'running' row,
--   and call_audit_geo_claim only a 'done' / 'skipped' row — disjoint sets, so
--   the existing preference claim / finish contract is unchanged.
--
-- geo_attempts counts geo passes STARTED: bumped by call_audit_geo_claim for a
-- geo-only pass, and by call_audit_geo_finish for a pass that ran inside the
-- preference lease. So a geo pass that crashes every time is still capped at 3
-- (a crash inside the preference lease is capped by `attempts`).
--
-- BACKWARD-COMPATIBLE with the currently deployed code: the old cron reads
-- call_id / client_id / hangup_time only; a geo-only candidate it sees fails
-- call_audit_claim (status is terminal) and is reported as skipped/not_claimed
-- — no write. APPLY THIS BEFORE deploying the code that reads the new columns.
--
-- No function here may raise SQLSTATE 40001/40P01 (CLAUDE.md): plain UPDATE …
-- WHERE under READ COMMITTED never does.
-- ============================================================================
BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. The geo pass's columns
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.call_pref_audit
  ADD COLUMN IF NOT EXISTS geo_status      text,
  ADD COLUMN IF NOT EXISTS geo_reason      text,
  ADD COLUMN IF NOT EXISTS geo_proposal_id uuid,
  ADD COLUMN IF NOT EXISTS geo_attempts    int NOT NULL DEFAULT 0;

ALTER TABLE public.call_pref_audit DROP CONSTRAINT IF EXISTS call_pref_audit_geo_status_check;
ALTER TABLE public.call_pref_audit
  ADD CONSTRAINT call_pref_audit_geo_status_check CHECK (geo_status IN ('done', 'skipped', 'failed'));

-- The geo save looks a proposal up by this id ("did the call audit mint it?"),
-- and the card lists a client's audit-minted proposals.
CREATE INDEX IF NOT EXISTS call_pref_audit_geo_proposal_idx
  ON public.call_pref_audit (geo_proposal_id) WHERE geo_proposal_id IS NOT NULL;

COMMENT ON COLUMN public.call_pref_audit.geo_status IS
  'The PLACES (geography) pass: NULL = never ran (calls audited before 2026-09-29_02), done (geo_proposal_id set when places were proposed), skipped (has_places / unlabelled / no_transcript / client_missing — terminal), failed (retried while geo_attempts < 3).';
COMMENT ON COLUMN public.call_pref_audit.geo_proposal_id IS
  'The geo_pref_proposals row the call audit minted. The chat card shows ONLY these, and the geo save treats them as fill-empty-only (refused when the client has places).';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. call_audit_candidates — + geo-only candidates, + needs_prefs / needs_geo
-- ────────────────────────────────────────────────────────────────────────────
-- RETURNS TABLE changes ⇒ DROP + CREATE (CREATE OR REPLACE cannot change it).
DROP FUNCTION IF EXISTS public.call_audit_candidates(timestamptz, interval, interval, int);

CREATE FUNCTION public.call_audit_candidates(
  p_now    timestamptz DEFAULT now(),
  p_grace  interval    DEFAULT '60 minutes',
  p_window interval    DEFAULT '60 days',
  p_limit  int         DEFAULT 20
)
RETURNS TABLE (
  call_id          uuid,
  client_id        uuid,
  hangup_time      timestamptz,
  duration_seconds int,
  needs_prefs      boolean,
  needs_geo        boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
  WITH calls AS (
    SELECT l.id, l.hangup_time, l.duration_seconds
    FROM public.call_logs l
    WHERE l.duration_seconds > 20
      AND l.transcription ? 'words'
      AND l.hangup_time IS NOT NULL
      AND l.hangup_time <= p_now - p_grace
      AND l.created_at  >  p_now - p_window
  ),
  linked AS (
    SELECT c.id AS call_id, c.hangup_time, c.duration_seconds,
           CASE WHEN lk.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN lk.v::uuid END AS client_id
    FROM calls c
    JOIN public.records r ON r.id = c.id
    JOIN public.models  m ON m.id = r.model_id AND m.name = 'phone_calls'
    CROSS JOIN LATERAL (
      SELECT CASE jsonb_typeof(r.data->'client_link')
               WHEN 'array'  THEN r.data->'client_link'->>0
               WHEN 'string' THEN r.data->>'client_link'
             END AS v
    ) lk
  ),
  state AS (
    SELECT k.call_id, k.client_id, k.hangup_time, k.duration_seconds,
           a.status AS a_status,
           -- The preference pass is due exactly when 2026-09-29_01's NOT EXISTS
           -- said so: no ledger row, or one that is not terminal, not leased,
           -- not exhausted.
           (a.call_id IS NULL OR NOT (
                a.status IN ('done', 'skipped')
             OR (a.status = 'running' AND a.lease_until IS NOT NULL AND a.lease_until > p_now)
             OR (a.status IN ('failed', 'running') AND a.attempts >= 3)
           )) AS needs_prefs,
           -- The geo pass is due when it never finished (NULL) or failed, while
           -- fewer than 3 geo passes have started.
           (a.call_id IS NULL OR (
                (a.geo_status IS NULL OR a.geo_status = 'failed') AND a.geo_attempts < 3
           )) AS needs_geo,
           (a.call_id IS NULL OR a.lease_until IS NULL OR a.lease_until <= p_now) AS lease_free
    FROM linked k
    LEFT JOIN public.call_pref_audit a ON a.call_id = k.call_id
    WHERE k.client_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.records c
        JOIN public.models clm ON clm.id = c.model_id AND clm.name = 'clients'
        WHERE c.id = k.client_id
      )
  )
  SELECT s.call_id, s.client_id, s.hangup_time, s.duration_seconds, s.needs_prefs, s.needs_geo
  FROM state s
  WHERE s.needs_prefs
     -- Geo-only: the preference audit is terminal, the geo pass is due, and
     -- nobody holds the call.
     OR (s.a_status IN ('done', 'skipped') AND s.needs_geo AND s.lease_free)
  ORDER BY s.hangup_time ASC, s.call_id
  LIMIT greatest(coalesce(p_limit, 20), 1);
$fn$;

COMMENT ON FUNCTION public.call_audit_candidates(timestamptz, interval, interval, int) IS
  'Finished Hatif calls due for the call audit, oldest hang-up first. needs_prefs = run the preference pass (call_audit_claim); needs_prefs=false ⇒ a GEO-ONLY pass (call_audit_geo_claim) — the preference result is terminal and must not be re-run. needs_geo = run the places pass.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. call_audit_geo_claim — the lease for a geo-only pass
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.call_audit_geo_claim(
  p_call_id uuid, p_lease_seconds int
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_call_id IS NULL THEN
    RAISE EXCEPTION 'call_audit_geo_claim: call_id is required';
  END IF;
  UPDATE public.call_pref_audit a
     SET lease_until  = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 30)),
         geo_attempts = a.geo_attempts + 1,
         updated_at   = now()
   WHERE a.call_id = p_call_id
     AND a.status IN ('done', 'skipped')
     AND (a.lease_until IS NULL OR a.lease_until < now())
     AND (a.geo_status IS NULL OR a.geo_status = 'failed')
     AND a.geo_attempts < 3;
  RETURN FOUND;
END
$fn$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. call_audit_geo_finish — record the geo pass
-- ────────────────────────────────────────────────────────────────────────────
-- Inside the preference lease (status 'running'): record + bump geo_attempts,
-- leave the lease for call_audit_finish. In a geo-only pass (status done /
-- skipped with a lease): record + clear the lease (geo_attempts was bumped by
-- the claim). Anything else ⇒ this runner no longer holds the call ⇒ false.
CREATE OR REPLACE FUNCTION public.call_audit_geo_finish(
  p_call_id uuid, p_status text, p_reason text, p_proposal_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('done', 'skipped', 'failed') THEN
    RAISE EXCEPTION 'call_audit_geo_finish: status must be done|skipped|failed, got %', p_status;
  END IF;
  UPDATE public.call_pref_audit a
     SET geo_status      = p_status,
         geo_reason      = left(p_reason, 2000),
         geo_proposal_id = p_proposal_id,
         geo_attempts    = a.geo_attempts + CASE WHEN a.status = 'running' THEN 1 ELSE 0 END,
         lease_until     = CASE WHEN a.status = 'running' THEN a.lease_until ELSE NULL END,
         updated_at      = now()
   WHERE a.call_id = p_call_id
     AND (a.status = 'running'
          OR (a.status IN ('done', 'skipped') AND a.lease_until IS NOT NULL));
  RETURN FOUND;
END
$fn$;

-- ────────────────────────────────────────────────────────────────────────────
-- Grants — service role only (a re-created function gets Supabase's default
-- EXECUTE for anon / authenticated, so REVOKE after CREATE).
-- ────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.call_audit_candidates(timestamptz, interval, interval, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_audit_geo_claim(uuid, int)                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_audit_geo_finish(uuid, text, text, uuid)             FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.call_audit_candidates(timestamptz, interval, interval, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.call_audit_geo_claim(uuid, int)                           TO service_role;
GRANT EXECUTE ON FUNCTION public.call_audit_geo_finish(uuid, text, text, uuid)             TO service_role;

-- Assert the grants landed (a public EXECUTE here would let any signed-in user
-- steal a call's lease).
DO $assert$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.call_audit_candidates(timestamptz, interval, interval, int)',
    'public.call_audit_geo_claim(uuid, int)',
    'public.call_audit_geo_finish(uuid, text, text, uuid)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'CALL_AUDIT_GRANT_LEAK % is executable by anon/authenticated', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'CALL_AUDIT_GRANT_MISSING % is not executable by service_role', f;
    END IF;
  END LOOP;
END $assert$;

COMMIT;
