-- ============================================================================
-- 2026-08-03 — REGRESSION FIX: restore the 'whatsapp_reply' job kind.
--
-- The 2026-08-01 campaign-summaries migration rewrote `claude_jobs_kind_check`
-- with DROP CONSTRAINT + ADD CONSTRAINT, listing only the kinds this vertical
-- knew about. A concurrently-developed feature (the WhatsApp AI agent, whose
-- `whatsapp_ai_enqueue` inserts `kind = 'whatsapp_reply'`) had already added its
-- kind — so that rewrite silently dropped it, and any inbound WhatsApp reply
-- enqueue would have failed the CHECK.
--
-- Measured impact: NONE. `whatsapp_ai_settings.is_enabled` was false for the
-- whole window, and that feature is fail-closed — `whatsapp_ai_should_reply`
-- returns false and `whatsapp_ai_enqueue` returns NULL before reaching the
-- INSERT. There are zero `whatsapp_reply` rows in the table, before or after.
-- It would have broken the moment the feature was switched on.
--
-- LESSON — do not repeat: **never DROP + ADD a shared CHECK constraint from a
-- single feature's migration.** `claude_jobs.kind` is a shared enumeration owned
-- by several verticals at once. Adding a kind must be ADDITIVE: read the current
-- definition, append, and re-create with everything that was already there.
-- ============================================================================
ALTER TABLE public.claude_jobs DROP CONSTRAINT IF EXISTS claude_jobs_kind_check;
ALTER TABLE public.claude_jobs ADD CONSTRAINT claude_jobs_kind_check
  CHECK (kind = ANY (ARRAY[
    'ping','client_study','mkt_content_enrichment','mkt_campaign_summary',
    'whatsapp_reply'
  ]));
