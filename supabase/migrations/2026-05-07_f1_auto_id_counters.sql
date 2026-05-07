-- ============================================================
-- Phase F.1 — Server-side auto_id counter (atomic, race-safe)
-- ============================================================
-- Today's auto_id assignment is a client-side read-modify-write
-- on `model.schema.auto_id_counters` JSONB:
--
--   const next = counters[scopeKey] ?? start;
--   counters[scopeKey] = next + 1;        // ← race condition
--   workingData[field.name] = formatAutoId(field, next);
--
-- Two simultaneous saves both read N, both write N+1, both produce
-- ID-N. CLAUDE.md acknowledges this as "still unfixed."
--
-- The fix: a database-side counter table with `INSERT ... ON CONFLICT
-- ... DO UPDATE ... RETURNING` semantics. Postgres serializes the
-- statement, so concurrent calls from any number of clients produce
-- strictly increasing distinct values.
--
-- Backfill: existing JSONB counters are read and inserted into the
-- new table (the JSONB stays for historical record — we never delete).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.auto_id_counters (
  model_id      uuid NOT NULL,
  field_id      uuid NOT NULL,
  scope_key     text NOT NULL,
  -- The most recent value returned by the RPC for this counter.
  -- First call inserts with current_value = p_start and returns it.
  -- Subsequent calls increment and return the new value.
  current_value bigint NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, field_id, scope_key)
);

-- RLS: only admins read; the RPC (SECURITY DEFINER) writes.
ALTER TABLE public.auto_id_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auto_id_counters_admin_read ON public.auto_id_counters;
CREATE POLICY auto_id_counters_admin_read ON public.auto_id_counters FOR SELECT TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

-- The atomic counter RPC.
CREATE OR REPLACE FUNCTION public.record_assign_auto_id(
  p_model_id  uuid,
  p_field_id  uuid,
  p_scope_key text,
  p_start     bigint DEFAULT 1
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_value bigint;
BEGIN
  -- Insert (current_value = p_start) on first call; on conflict
  -- increment by 1. Postgres serializes the row-level operation.
  INSERT INTO public.auto_id_counters (model_id, field_id, scope_key, current_value)
  VALUES (p_model_id, p_field_id, p_scope_key, p_start)
  ON CONFLICT (model_id, field_id, scope_key) DO UPDATE
    SET current_value = public.auto_id_counters.current_value + 1,
        updated_at = now()
  RETURNING current_value INTO v_value;
  RETURN v_value;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, bigint) TO service_role;

-- Backfill from existing JSONB counters. Existing JSONB stores
-- "the next value to assign", so we insert (next - 1) — the next
-- RPC call will increment back to `next` and return it. The
-- ON CONFLICT DO NOTHING makes re-runs safe.
DO $do$
DECLARE
  v_model     record;
  v_section   jsonb;
  v_field     jsonb;
  v_field_id  uuid;
  v_counters  jsonb;
  v_scope     text;
  v_next_str  text;
  v_next      bigint;
  v_inserted  int := 0;
BEGIN
  FOR v_model IN SELECT id, schema FROM public.models WHERE schema IS NOT NULL LOOP
    FOR v_section IN SELECT jsonb_array_elements(v_model.schema->'sections') LOOP
      FOR v_field IN SELECT jsonb_array_elements(v_section->'fields') LOOP
        IF v_field->>'type' = 'auto_id' THEN
          v_field_id := (v_field->>'id')::uuid;
          v_counters := v_field->'auto_id_counters';
          IF v_counters IS NOT NULL AND jsonb_typeof(v_counters) = 'object' THEN
            FOR v_scope, v_next_str IN SELECT key, value FROM jsonb_each_text(v_counters) LOOP
              v_next := v_next_str::bigint;
              IF v_next > 1 THEN
                INSERT INTO public.auto_id_counters (model_id, field_id, scope_key, current_value)
                VALUES (v_model.id, v_field_id, v_scope, v_next - 1)
                ON CONFLICT (model_id, field_id, scope_key) DO NOTHING;
                v_inserted := v_inserted + 1;
              END IF;
            END LOOP;
          END IF;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'Backfilled % auto_id counters from JSONB schema', v_inserted;
END
$do$;
