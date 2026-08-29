-- ─────────────────────────────────────────────────────────────────────────
-- Enrichment claim index: exclude exhausted ("poison") rows
-- ─────────────────────────────────────────────────────────────────────────
-- market_enrich_claim() claims the oldest un-enriched market_listings rows:
--
--   WHERE source = ? AND detail_enriched_at IS NULL
--     AND (enrich_status IS DISTINCT FROM 'running' OR enrich_attempts >= 3)
--     AND enrich_attempts < 4
--   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT ?
--
-- The supporting partial index was scoped only `WHERE detail_enriched_at IS NULL`,
-- so it still contained ~79,000 EXHAUSTED rows (enrich_attempts >= 4) that can
-- never be claimed. Because those rows are the OLDEST (most-retried), they sit at
-- the front of the created_at ordering, so every claim call scanned past all of
-- them (via the heap filter `enrich_attempts < 4`) before reaching a claimable
-- row. Measured: this claim path was ~22.7% of total DB time (mean 319 ms/call,
-- 200k calls), and the market_listings table was read 229 GB off disk in the
-- pg_stat window — evicting the app's hot data (clients/projects) from cache and
-- making even cheap boot queries queue behind it.
--
-- Fix: add `enrich_attempts < 4` to the partial-index PREDICATE so the dead rows
-- fall out of the index entirely. No data is mutated; the claim function is
-- unchanged (the enrich_attempts filter it already applies is now satisfied by
-- the index, not the heap). Measured after: the inner claim scan for the worst
-- source (dubizzle) dropped from ~319 ms to ~1.6 ms (127 buffers, 75 residual
-- rows removed by the enrich_status filter).
--
-- PROD was migrated live with CREATE/DROP INDEX CONCURRENTLY (zero lock on the
-- 4.5 GB frozen table). This file is the source-of-truth record for CI and fresh
-- installs, made a safe no-op on any DB that already has the tightened index.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  -- market_listings is a FROZEN physical table; the CI ephemeral DB / minimal
  -- fixtures may not have it. Skip entirely when absent (same posture as other
  -- frozen-table guards in this repo).
  IF to_regclass('public.market_listings') IS NULL THEN
    RAISE NOTICE 'market_listings absent — skipping enrich-pending index rebuild';
    RETURN;
  END IF;

  -- No-op if the correctly-scoped index already exists (prod, applied live via
  -- CONCURRENTLY). Only rebuild where the predicate is still the old one
  -- (CI / fresh installs whose earlier migration created the wide index).
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname  = 'idx_ml_enrich_pending'
      AND indexdef ILIKE '%enrich_attempts < 4%'
  ) THEN
    RAISE NOTICE 'idx_ml_enrich_pending already excludes poison rows — nothing to do';
    RETURN;
  END IF;

  DROP INDEX IF EXISTS public.idx_ml_enrich_pending;
  CREATE INDEX idx_ml_enrich_pending
    ON public.market_listings USING btree (source, created_at)
    WHERE detail_enriched_at IS NULL AND enrich_attempts < 4;
END $$;
