-- ============================================================
-- Phase F.2 — Optimistic-concurrency version column on records
-- ============================================================
-- Today's save flow is last-write-wins: two users editing the same
-- record at the same time → whoever saves second silently overwrites
-- the first. This migration lays the DB foundation for concurrent-
-- edit detection:
--
--   1. records.version int NOT NULL DEFAULT 1
--   2. BEFORE UPDATE trigger that auto-increments version
--   3. record_save RPC accepts optional p_expected_version; on
--      mismatch raises 'serialization_failure' with a clear hint
--
-- Frontend adoption is phased — supabaseRecordUpsert continues to
-- pass p_expected_version=NULL (backward-compat) until a follow-up
-- pass updates it to read the loaded version and pass it through.
-- The trigger keeps the column accurate from day one so when the
-- frontend opts in, every existing record already has a valid
-- version and the check is meaningful.
--
-- Frozen models intentionally NOT covered here: their data lives
-- in dedicated per-model tables, each of which would need its own
-- version column + trigger. Phase F.2.1 (future) can extend the
-- regenerate_frozen_model_artifacts machinery to add it.
--
-- Verification:
--   * SELECT version FROM records LIMIT 5; — every row has version 1.
--   * UPDATE records SET data=data WHERE id='<x>' RETURNING version;
--     — version increments to 2.
--   * SELECT record_save('<m>'::uuid, '<x>'::uuid, '{}'::jsonb, NULL, 99);
--     — raises serialization_failure (99 doesn't match current version).
-- ============================================================

ALTER TABLE public.records ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.records_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- Increment version on every UPDATE. The OLD.version = NEW.version
  -- guard lets a migration explicitly set version (rare; mostly for
  -- backfill or rollback) without the trigger double-bumping.
  IF OLD.version = NEW.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS records_bump_version_trigger ON public.records;
CREATE TRIGGER records_bump_version_trigger
  BEFORE UPDATE ON public.records
  FOR EACH ROW
  EXECUTE FUNCTION public.records_bump_version();

-- record_save with optional version check. Unfrozen models go through
-- the records-table path with the new check; frozen models keep the
-- existing freeze_apply_row dispatch unchanged.
CREATE OR REPLACE FUNCTION public.record_save(
  p_model_id        uuid,
  p_id              uuid,
  p_data            jsonb,
  p_created_by      uuid DEFAULT NULL,
  p_expected_version int DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_model record;
  v_table text;
  v_existing_version int;
BEGIN
  SELECT id, name, is_hardcoded INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'model % not found', p_model_id;
  END IF;

  IF v_model.is_hardcoded THEN
    -- Frozen models: no version semantics yet. p_expected_version is
    -- ignored. Phase F.2.1 (future) extends regenerate_frozen_model_artifacts
    -- to add per-frozen-table version columns.
    v_table := public.freeze_safe_ident(v_model.name);
    EXECUTE format(
      'INSERT INTO public.%I (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      v_table
    ) USING p_id;
    PERFORM public.freeze_apply_row(p_model_id, p_id, p_data, p_created_by);
  ELSE
    -- Optimistic-concurrency check on UPDATE.
    -- p_expected_version IS NULL → backward-compat (no check). This is
    -- the path taken by the current frontend until it opts into
    -- version tracking.
    IF p_expected_version IS NOT NULL THEN
      SELECT version INTO v_existing_version FROM records WHERE id = p_id;
      IF FOUND AND v_existing_version <> p_expected_version THEN
        RAISE EXCEPTION
          'version_mismatch: record was edited by another user (loaded v%, current v%)',
          p_expected_version, v_existing_version
        USING ERRCODE = 'serialization_failure',
              HINT = 'reload the record to see latest changes';
      END IF;
    END IF;

    INSERT INTO records (id, model_id, data, created_by_user_id)
    VALUES (p_id, p_model_id, p_data, p_created_by)
    ON CONFLICT (id) DO UPDATE SET
      data = EXCLUDED.data,
      created_by_user_id = COALESCE(records.created_by_user_id, EXCLUDED.created_by_user_id),
      updated_at = now();
  END IF;
  RETURN p_id;
END;
$fn$;

-- Re-grant: signature changed (added optional 5th arg), so the existing
-- grants still apply but be explicit. Anon was revoked in B.1+B.2 and
-- patched again in F.1; ensure that sticks for the new signature too.
REVOKE EXECUTE ON FUNCTION public.record_save(uuid, uuid, jsonb, uuid, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_save(uuid, uuid, jsonb, uuid, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_save(uuid, uuid, jsonb, uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_save(uuid, uuid, jsonb, uuid, int) TO service_role;
