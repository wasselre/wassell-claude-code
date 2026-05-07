-- ============================================================
-- Phase A.3 — Records-table query indexes
-- ============================================================
-- Adds three indexes to the records table that unlock the scaling
-- improvements in later phases:
--
--   idx_records_model_id_created_at — composite (model_id, created_at DESC, id)
--     Powers cursor pagination via record_search (Phase E.1) without
--     a Sort node. Without this, "give me page 5 of records for
--     model X ordered newest-first" requires a full sort.
--
--   idx_records_updated_at — single-column (updated_at DESC)
--     Powers stale-while-revalidate refetch on window focus / reconnect
--     (Phase D.3). Without this, "fetch rows changed since timestamp"
--     is a sequential scan.
--
--   idx_records_data_gin — GIN over data column with jsonb_path_ops
--     Powers field-level filters (data @> '{...}'::jsonb) with O(log N)
--     lookup instead of seq scan. jsonb_path_ops is the smaller, faster
--     GIN flavor; supports @> only, which is what the app uses.
--
-- Plain CREATE INDEX (not CONCURRENTLY) since MCP wraps in tx.
-- At ~2,600 rows the build is sub-second; at 1M+ this would need
-- a separate --no-transaction migration with CONCURRENTLY.
--
-- Verification:
--   EXPLAIN (ANALYZE) SELECT * FROM records WHERE model_id = '<uuid>'
--     ORDER BY created_at DESC, id LIMIT 50;
--   → Index Scan using idx_records_model_id_created_at, no Sort node.
--   EXPLAIN SELECT * FROM records WHERE data @> '{"city":"Riyadh"}'::jsonb;
--   → Bitmap Index Scan on idx_records_data_gin.
--
-- Rollback:
--   DROP INDEX IF EXISTS public.idx_records_model_id_created_at;
--   DROP INDEX IF EXISTS public.idx_records_updated_at;
--   DROP INDEX IF EXISTS public.idx_records_data_gin;
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_records_model_id_created_at
  ON public.records (model_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_records_updated_at
  ON public.records (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_records_data_gin
  ON public.records USING gin (data jsonb_path_ops);
