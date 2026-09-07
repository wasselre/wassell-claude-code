-- CI guard (2026-09-07): no function in `public` may raise SQLSTATE 40001 or
-- 40P01, by code OR by condition name. PostgREST runs every request inside
-- hasql-transaction, which re-runs a transaction that aborts with either code
-- FOREVER — no backoff, no attempt cap. That is the mechanism behind every
-- record_save "conflict storm" from 2026-06 to 2026-09-07 (one stale save from
-- one browser tab became ~1,200 server-side rollbacks/sec for 52 hours).
-- Optimistic-concurrency conflicts use WS409; rate-limit blocks use WS429.
-- See supabase/migrations/2026-09-07_never_raise_sqlstate_40001.sql.
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
    RAISE EXCEPTION 'assert_no_retryable_sqlstate: these functions raise a PostgREST-retryable SQLSTATE (40001/40P01): %', v_bad;
  END IF;
  RAISE NOTICE 'assert_no_retryable_sqlstate: OK — no public function raises 40001/40P01';
END $$;
