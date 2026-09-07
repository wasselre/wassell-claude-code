-- 2026-09-07 — ROOT CAUSE of every record_save "conflict storm" since June:
-- PostgREST retries SQLSTATE 40001 FOREVER. Stop raising it.
-- =============================================================================
--
-- WHAT WAS HAPPENING (measured live 2026-09-07, wassell-prod CPU pinned at 100%
-- for ~52 h at ~1,200 rolled-back record_save calls/sec):
--
--   PostgREST executes every request inside hasql-transaction's `transaction`,
--   which — by library design — re-runs the whole transaction, with NO backoff
--   and NO attempt limit, whenever it aborts with SQLSTATE 40001
--   (serialization_failure) or 40P01 (deadlock_detected). Our RPCs raised
--   `version_mismatch`, `conflict_storm_blocked`, `source_changed` and
--   `revision_mismatch` with ERRCODE 40001. So ONE stale save from ONE browser
--   tab became an unbounded server-side loop: PostgREST re-ran record_save
--   thousands of times per second on the SAME frozen payload until something
--   made it stop failing. The client never saw a single error (its request was
--   still held open), so no client-side breaker, cap, or telemetry could ever
--   fire; closing the tab or revoking the session did nothing (the loop lives in
--   PostgREST, not the browser); and the only thing that ever ended a storm was
--   a `noop`/`noop_stale` block that turned the failure into a success.
--
--   Proof: a single `curl` with p_expected_version=-1 on record 2fab456f produced
--   several `version_mismatch` Postgres log lines within 17 ms, the sweep saw
--   that row's xmax 57,578 transactions ahead of every other row, auto-blocked it,
--   and only THEN did the curl receive HTTP 200 (the noop_stale success).
--
-- THE FIX: never raise a SQLSTATE that PostgREST treats as retryable.
--   - WS409  optimistic-concurrency conflict (version_mismatch, source_changed,
--            revision_mismatch). PostgREST maps an unknown SQLSTATE to HTTP 400,
--            the request completes immediately, the caller sees the error ONCE.
--   - WS429  conflict_storm_blocked (a record/session rate-limit block; also a
--            single terminal reject now instead of a server-side loop).
--   Messages and HINTs are unchanged, so every consumer that classifies by
--   message keeps working; the code-matching consumers were updated in the
--   same commit (appStore, api/_lib + worker/src/lib recordSaveRetry,
--   workflowSweeper, smoke_translation.sql).
--
-- HOW: rewrite each affected function from its LIVE definition
-- (pg_get_functiondef) changing ONLY the ERRCODE token — no re-typed bodies,
-- no drift. CREATE OR REPLACE keeps owner, grants, SECURITY DEFINER and
-- search_path. Idempotent: a second run finds nothing to rewrite.
--
-- HARD RULE (also in CLAUDE.md): no function in this database may raise
-- SQLSTATE 40001 or 40P01 (by code or by condition name). The assertion at the
-- end of this file enforces it, and supabase/tests/ci/assert_no_retryable_sqlstate.sql
-- re-checks it in CI.

BEGIN;

DO $$
DECLARE
  r      record;
  v_def  text;
  v_new  text;
  v_done int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.prosrc ~ 'ERRCODE\s*=\s*''(serialization_failure|40001|deadlock_detected|40P01)'''
    ORDER BY p.proname
  LOOP
    v_def := pg_get_functiondef(r.oid);

    -- 1) The storm-block rejects become WS429 (rate-limited, terminal).
    v_new := regexp_replace(
      v_def,
      '(RAISE\s+EXCEPTION\s+''conflict_storm_blocked[^;]*?ERRCODE\s*=\s*'')(serialization_failure|40001)(''.*?;)',
      '\1WS429\3',
      'g');

    -- 2) Every remaining retryable code becomes WS409 (concurrency conflict).
    v_new := regexp_replace(
      v_new,
      '(ERRCODE\s*=\s*'')(serialization_failure|40001|deadlock_detected|40P01)('')',
      '\1WS409\3',
      'g');

    IF v_new = v_def THEN
      RAISE EXCEPTION 'never_raise_40001: % matched but no ERRCODE token was rewritten — inspect its source', r.proname;
    END IF;

    EXECUTE v_new;
    v_done := v_done + 1;
    RAISE NOTICE 'never_raise_40001: rewrote %', r.proname;
  END LOOP;

  RAISE NOTICE 'never_raise_40001: % function(s) rewritten', v_done;
END $$;

-- Enforce the rule for the whole public schema (functions, procedures, trigger
-- functions). Fails the migration if anything still raises a retryable code.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND (
      p.prosrc ~ 'ERRCODE\s*=\s*''(serialization_failure|40001|deadlock_detected|40P01)'''
      OR p.prosrc ~ 'SQLSTATE\s*''(40001|40P01)'''
    );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'never_raise_40001: these functions still raise a PostgREST-retryable SQLSTATE: %', v_bad;
  END IF;
END $$;

-- record_save belongs to the frozen-model infrastructure, which the translation
-- CI fixture does not create — so guard this (cosmetic) COMMENT the same way the
-- rewrite loop above is guarded (it only touches functions that actually exist).
-- In prod record_save exists and the comment is set; in CI it is skipped.
DO $$
BEGIN
  IF to_regprocedure('public.record_save(uuid, uuid, jsonb, uuid, integer)') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON FUNCTION public.record_save(uuid, uuid, jsonb, uuid, integer) IS
      'Dispatching record write (records JSONB vs frozen table) with optimistic concurrency. '
      'Raises version_mismatch as SQLSTATE WS409 and conflict_storm_blocked as WS429 — NEVER 40001/40P01: '
      'PostgREST (hasql-transaction) retries those forever with no backoff, which was the root cause of every '
      'conflict storm from 2026-06 to 2026-09-07. See supabase/migrations/2026-09-07_never_raise_sqlstate_40001.sql.'$c$;
  END IF;
END $$;

COMMIT;
