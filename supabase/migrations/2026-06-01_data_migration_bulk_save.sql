-- ============================================================================
-- 2026-06-01: Data Migration — bulk insert + batch auto-id reservation
-- ----------------------------------------------------------------------------
-- Backs the "Migrate" step of the Data Migration wizard (the data_migration
-- custom-UI model). The wizard builds N record `data` objects client-side
-- (via mapImportedRows + the approved value-standardization decisions +
-- client-side formula snapshots), then inserts them in chunks.
--
-- Two RPCs:
--
--   1. records_bulk_save(model_id, rows, created_by)
--      Inserts many records in ONE round-trip by looping public.record_save
--      server-side. record_save already dispatches frozen vs unfrozen and
--      stamps created_by (COALESCE-preserved), so a frozen target model Just
--      Works. Each row runs in its own subtransaction: a row that violates a
--      constraint is captured into the returned `errors` array instead of
--      aborting the whole batch — surfaced loudly to the user (CLAUDE.md
--      "fail loudly, never silently drop data"). Workflows are intentionally
--      NOT fired (a 5,000-row import must not trigger 5,000 automations) —
--      record_save persists only; the client-side saveRecord path that runs
--      create-workflows is bypassed by design.
--
--   2. record_reserve_auto_ids(model_id, field_id, scope_key, count, start)
--      Atomically reserves a CONTIGUOUS BLOCK of `count` auto-id numbers in a
--      single statement (reusing the public.auto_id_counters table from the
--      Phase F.1 race fix). Returns the FIRST reserved value; the caller owns
--      [first, first + count - 1]. One round-trip for a whole bulk import,
--      and — like record_assign_auto_id — immune to the concurrent-save race
--      because Postgres serializes the row-level UPDATE.
--
-- Both are SECURITY DEFINER and granted to authenticated + service_role,
-- mirroring record_save / record_assign_auto_id.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: records_bulk_save
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.records_bulk_save(
  p_model_id   uuid,
  p_rows       jsonb,             -- JSON array of { id?, data, created_by? }
  p_created_by uuid DEFAULT NULL  -- fallback owner when a row omits created_by
)
RETURNS jsonb                     -- { inserted: int, errors: [{ id, error }] }
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_elem     jsonb;
  v_id       uuid;
  v_inserted int   := 0;
  v_errors   jsonb := '[]'::jsonb;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'records_bulk_save: p_rows must be a JSON array (got %)',
      COALESCE(jsonb_typeof(p_rows), 'null');
  END IF;

  FOR v_elem IN SELECT jsonb_array_elements(p_rows) LOOP
    -- Per-row subtransaction: one bad row is captured, not fatal to the batch.
    BEGIN
      v_id := COALESCE(NULLIF(v_elem->>'id', '')::uuid, gen_random_uuid());
      PERFORM public.record_save(
        p_model_id,
        v_id,
        COALESCE(v_elem->'data', '{}'::jsonb),
        COALESCE(NULLIF(v_elem->>'created_by', '')::uuid, p_created_by),
        NULL  -- new records → no optimistic-version check
      );
      v_inserted := v_inserted + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object(
        'id',    v_elem->>'id',
        'error', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'errors', v_errors);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.records_bulk_save(uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.records_bulk_save(uuid, jsonb, uuid) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.records_bulk_save(uuid, jsonb, uuid) TO service_role;

-- ────────────────────────────────────────────────────────────────────────
-- RPC: record_reserve_auto_ids
-- ----------------------------------------------------------------------
-- Reserve a contiguous block of `p_count` numbers for one auto-id counter.
-- Returns the FIRST reserved value; caller uses [first, first+count-1].
--
-- First call for a (model, field, scope): inserts current_value = the LAST
-- value of the block (start + count - 1) and returns `start`.
-- Subsequent calls: bump current_value by count and return old+1.
-- Postgres serializes the row UPDATE → no two callers ever overlap.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_reserve_auto_ids(
  p_model_id  uuid,
  p_field_id  uuid,
  p_scope_key text,
  p_count     int,
  p_start     bigint DEFAULT 1
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_last bigint;
BEGIN
  IF p_count < 1 THEN
    RAISE EXCEPTION 'record_reserve_auto_ids: p_count must be >= 1 (got %)', p_count;
  END IF;

  INSERT INTO public.auto_id_counters (model_id, field_id, scope_key, current_value)
  VALUES (p_model_id, p_field_id, p_scope_key, p_start + p_count - 1)
  ON CONFLICT (model_id, field_id, scope_key) DO UPDATE
    SET current_value = public.auto_id_counters.current_value + p_count,
        updated_at    = now()
  RETURNING current_value INTO v_last;  -- v_last is the LAST number in the block

  RETURN v_last - p_count + 1;          -- → the FIRST number in the block
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.record_reserve_auto_ids(uuid, uuid, text, int, bigint) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.record_reserve_auto_ids(uuid, uuid, text, int, bigint) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.record_reserve_auto_ids(uuid, uuid, text, int, bigint) TO service_role;

COMMIT;
