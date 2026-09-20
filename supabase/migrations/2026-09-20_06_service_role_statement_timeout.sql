-- ============================================================================
-- The month confirm gets the time it legitimately needs. 2026-09-20.
--
-- «canceling statement due to statement timeout — nothing committed» on
-- «اعتماد الشهر» for September–October. The rollback was clean — the commit is
-- one transaction by design, so there was no half-written month — but the
-- operator could not approve at all.
--
-- MEASURED, not guessed:
--
--   · `authenticator` (the role PostgREST logs in as) carries
--     `statement_timeout=8s`, and `service_role` had no override, so every
--     server-side API call inherited 8 seconds.
--   · `mos_campaign_plan_commit_month` writes a whole month in ONE statement
--     and must: its own comment records that four sequential commits "could
--     leave a month half-reserved … and nothing to roll back to". A normal
--     month peaked at 2.3 s in pg_stat_statements. September–October is a
--     STRETCHED month — eight weeks, 23 organic batches, 81 creatives, 150
--     items and their stage reservations — and crossed 8 s.
--
-- WHY THE FIX IS AT ROLE LEVEL AND NOT INSIDE THE FUNCTION. `statement_timeout`
-- is armed when the top-level statement STARTS; raising it afterwards does not
-- re-arm the timer. Proven on this database before writing this migration: a
-- function that did `set_config('statement_timeout','20000',true)` and then
-- slept 3 s was still cancelled at the ambient 1 s. So a `SET LOCAL` inside
-- `mos_campaign_plan_commit_month` would read as a fix and do nothing —
-- exactly the kind of silent no-op this codebase keeps getting bitten by.
--
-- 60 s is a CEILING, not a licence. It is bounded, it applies only to
-- `service_role` (server-side: the API's service client, the Fly worker, the
-- crons — never a browser), and the browser-facing `authenticated` role keeps
-- its 8 s. If a server query ever needs more than a minute, that query is the
-- bug; do not raise this number to hide it.
--
-- REQUIRES A POSTGREST CONFIG RELOAD. PostgREST caches per-role settings, so
-- the ALTER alone changes nothing for live requests — verified: the API still
-- reported 8s until `NOTIFY pgrst, 'reload config'` ran, after which it
-- reported 1min. The notify is part of the migration for that reason.
-- ============================================================================

BEGIN;

ALTER ROLE service_role SET statement_timeout = '60s';

COMMIT;

-- Outside the transaction: PostgREST must re-read the role settings or every
-- pooled connection keeps serving the old 8 s.
NOTIFY pgrst, 'reload config';

DO $$
DECLARE v text;
BEGIN
  SELECT array_to_string(rolconfig, ',') INTO v FROM pg_roles WHERE rolname = 'service_role';
  IF v IS NULL OR v NOT LIKE '%statement_timeout=60s%' THEN
    RAISE EXCEPTION 'MOS:SERVICE_ROLE_TIMEOUT_NOT_SET got %', v;
  END IF;
  -- The browser-facing role must NOT have been widened by this.
  SELECT array_to_string(rolconfig, ',') INTO v FROM pg_roles WHERE rolname = 'authenticated';
  IF v IS NULL OR v NOT LIKE '%statement_timeout=8s%' THEN
    RAISE EXCEPTION 'MOS:AUTHENTICATED_TIMEOUT_CHANGED got %', v;
  END IF;
END $$;
