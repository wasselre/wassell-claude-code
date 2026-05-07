-- ============================================================
-- Phase E.1 — record_search RPC (server-side cursor pagination)
-- ============================================================
-- The frontend's records pages currently load every row of every
-- model into memory at boot (`SELECT * FROM unified_records`).
-- That's ~2,600 rows today; at 1M+ rows the browser would freeze.
--
-- record_search() is the server-side replacement: ask for one page
-- at a time with optional JSONB filters and a free-text query, get
-- back up to N rows + a `has_more` flag. Cursor pagination uses
-- (created_at DESC, id DESC) keyset so it works correctly even
-- when rows are concurrently inserted/deleted.
--
-- Routing logic:
--   * Reads from `unified_records` — the existing UNION view that
--     already handles unfrozen records (JSONB) and frozen models
--     (typed columns wrapped as JSONB). One code path covers both.
--   * Phase E.4 will add a frozen-model fast path that bypasses the
--     UNION view for typed-column index efficiency. For now: same
--     correctness, slightly slower on frozen tables.
--
-- Indexing:
--   The composite index `idx_records_model_id_created_at` (Phase A.3,
--   `(model_id, created_at DESC, id)`) supports the ORDER BY +
--   keyset cursor with no Sort node. The GIN index on `records.data`
--   accelerates `data @> p_filters`.
--
-- Security:
--   * SECURITY INVOKER — runs as the calling user, RLS applies.
--     The `unified_records` view is `security_invoker = true` so
--     `records_view` policy gates each row.
--   * SET search_path = public, pg_temp — closes search-path attack.
--   * GRANT EXECUTE TO authenticated only (NOT anon).
--
-- Safety:
--   * p_limit clamped to [1, 500] — caller can't request unbounded.
--   * p_search_text uses ILIKE with the pattern bracketed by %
--     (so `%search%`); user input is parameterised, no injection.
--   * Cursor is jsonb with two keys ('created_at', 'id'); cast at
--     the boundary.
--
-- Test:
--   SELECT * FROM record_search(
--     '<model_id>'::uuid,    -- p_model_id
--     '{}'::jsonb,           -- p_filters
--     NULL,                  -- p_cursor (first page)
--     50,                    -- p_limit
--     NULL                   -- p_search_text
--   );
--
-- Verification:
--   * Authenticated user: returns rows their RLS scope allows.
--   * Anon: returns no rows (RLS denies).
--   * EXPLAIN: Index Scan on idx_records_model_id_created_at,
--     no Sort node.
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_search(
  p_model_id uuid,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_cursor jsonb DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_search_text text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  model_id uuid,
  data jsonb,
  created_by_user_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  has_more boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_cursor_created_at timestamptz;
  v_cursor_id uuid;
  v_lim int;
BEGIN
  -- Clamp limit to a sane range; caller can't ask for more than 500.
  v_lim := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);

  -- Decode the cursor. NULL cursor = first page.
  IF p_cursor IS NOT NULL AND p_cursor ? 'created_at' AND p_cursor ? 'id' THEN
    v_cursor_created_at := (p_cursor->>'created_at')::timestamptz;
    v_cursor_id := (p_cursor->>'id')::uuid;
  END IF;

  RETURN QUERY
  WITH page_plus AS (
    -- Fetch up to v_lim + 1 rows. The +1 lets us know if there are
    -- more rows beyond this page without a separate count query.
    SELECT
      r.id,
      r.model_id,
      r.data,
      r.created_by_user_id,
      r.created_at,
      r.updated_at,
      row_number() OVER (ORDER BY r.created_at DESC, r.id DESC) AS rn
    FROM public.unified_records r
    WHERE r.model_id = p_model_id
      AND (p_filters = '{}'::jsonb OR r.data @> p_filters)
      AND (
        p_search_text IS NULL
        OR p_search_text = ''
        OR r.data::text ILIKE '%' || p_search_text || '%'
      )
      AND (
        v_cursor_created_at IS NULL
        OR (r.created_at, r.id) < (v_cursor_created_at, v_cursor_id)
      )
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT v_lim + 1
  )
  SELECT
    p.id,
    p.model_id,
    p.data,
    p.created_by_user_id,
    p.created_at,
    p.updated_at,
    -- has_more = a row beyond v_lim exists in this batch.
    EXISTS(SELECT 1 FROM page_plus WHERE rn > v_lim) AS has_more
  FROM page_plus p
  WHERE p.rn <= v_lim
  ORDER BY p.created_at DESC, p.id DESC;
END;
$fn$;

-- Grants: authenticated users (frontend) + service_role (Vercel API
-- routes). Anon stays revoked — public dashboards have their own
-- public read function, not this one.
REVOKE EXECUTE ON FUNCTION public.record_search(uuid, jsonb, jsonb, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_search(uuid, jsonb, jsonb, int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_search(uuid, jsonb, jsonb, int, text) TO service_role;
