-- ============================================================
-- Phase A.2 — Covering indexes for unindexed foreign keys
-- ============================================================
-- Adds BTREE indexes on the 11 FK columns flagged by Supabase
-- advisor lint `unindexed_foreign_keys`. Without these, a parent-row
-- DELETE/UPDATE forces a full sequential scan of the child table to
-- check for orphans — fine at 4 users + 2,600 records, catastrophic
-- at any meaningful scale.
--
-- Plain CREATE INDEX (not CONCURRENTLY) is used here because:
--   (a) Supabase MCP apply_migration wraps each migration in a
--       transaction, and CONCURRENTLY cannot run inside a tx block.
--   (b) At current row counts (max 5,701 in any table), a plain
--       index build takes <100ms with a brief ACCESS EXCLUSIVE lock —
--       imperceptible to users.
--
-- AT SCALE (1M+ rows in records, ~10M+ in activity_log), this same
-- migration MUST be re-run with CREATE INDEX CONCURRENTLY in single
-- statements via supabase db push --no-verify or psql with
-- --no-transaction. Document this when records grows past 100k rows.
--
-- Verification:
--   mcp__supabase__get_advisors({type:"performance"})
--   → expect unindexed_foreign_keys count: 11 → 0
--
-- Rollback:
--   DROP INDEX IF EXISTS public.idx_<each>_<col>;
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_competitors_created_by
  ON public.competitors(created_by);

CREATE INDEX IF NOT EXISTS idx_marketing_operations_created_by_user_id
  ON public.marketing_operations(created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_models_group_id
  ON public.models(group_id);

CREATE INDEX IF NOT EXISTS idx_records_created_by_user_id
  ON public.records(created_by_user_id);

CREATE INDEX IF NOT EXISTS idx_research_questions_answered_by
  ON public.research_questions(answered_by);

CREATE INDEX IF NOT EXISTS idx_users_profile_id
  ON public.users(profile_id);

CREATE INDEX IF NOT EXISTS idx_webhook_payloads_consumed_by
  ON public.webhook_payloads(consumed_by);

CREATE INDEX IF NOT EXISTS idx_webhook_payloads_slug_id
  ON public.webhook_payloads(slug_id);

CREATE INDEX IF NOT EXISTS idx_webhook_slugs_created_by
  ON public.webhook_slugs(created_by);

CREATE INDEX IF NOT EXISTS idx_workflows_group_id
  ON public.workflows(group_id);

CREATE INDEX IF NOT EXISTS idx_workflows_trigger_model_id
  ON public.workflows(trigger_model_id);
