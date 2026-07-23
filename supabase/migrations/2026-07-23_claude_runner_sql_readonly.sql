-- 2026-07-23 — read-only SQL escape hatch for headless Claude Code runner
-- sessions (client studies). The interactive Supabase MCP needs a claude.ai
-- OAuth flow a headless session cannot complete; this RPC gives the runner's
-- sessions the same READ capability through the service-role key already on
-- the runner machine (used by .claude/skills/client-study/assets/db_query.mjs).
-- Forced read-only + 30s statement timeout; service_role execute only.
CREATE OR REPLACE FUNCTION public.claude_runner_sql(p_sql text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('transaction_read_only', 'on', true);
  PERFORM set_config('statement_timeout', '30000', true);
  EXECUTE format('SELECT COALESCE(jsonb_agg(t), ''[]''::jsonb) FROM (%s) t', p_sql) INTO v;
  RETURN v;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.claude_runner_sql(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claude_runner_sql(text) TO service_role;
