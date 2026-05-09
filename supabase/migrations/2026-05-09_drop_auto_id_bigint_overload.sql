-- ──────────────────────────────────────────────────────────────────────
-- 2026-05-09: drop record_assign_auto_id(uuid, uuid, text, bigint)
-- ──────────────────────────────────────────────────────────────────────
-- Bug: F.1 (2026-05-07_f1_auto_id_counters.sql) created the function
-- with `p_start bigint`. H-audit (2026-05-07_h_audit_followups.sql)
-- intended to REPLACE it with a permission-checked version, but
-- accidentally declared `p_start int` instead — different signature, so
-- Postgres treated it as a new overload rather than a replacement.
-- Both overloads coexisted; PostgREST got 'Could not choose the best
-- candidate function' on every save attempt that included an auto_id
-- field, blocking record creation.
--
-- Fix: drop the bigint overload. The int overload from H-audit already
-- handles every call (its body INSERTs into auto_id_counters, whose
-- current_value column is bigint — int → bigint is an implicit
-- widening cast, so no behavior change).
-- ──────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.record_assign_auto_id(uuid, uuid, text, bigint);

-- Belt-and-suspenders: ensure the int overload exists and has the same
-- shape H-audit defined. Idempotent — CREATE OR REPLACE on an existing
-- function with the same signature is a no-op when the body matches.
CREATE OR REPLACE FUNCTION public.record_assign_auto_id(
  p_model_id  uuid,
  p_field_id  uuid,
  p_scope_key text,
  p_start     int  DEFAULT 1
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_value int;
BEGIN
  IF NOT public.wassell_user_has_action((SELECT auth.uid()), p_model_id, 'create') THEN
    RAISE EXCEPTION 'record_assign_auto_id: caller lacks create permission on model %', p_model_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.auto_id_counters (model_id, field_id, scope_key, current_value)
  VALUES (p_model_id, p_field_id, p_scope_key, p_start)
  ON CONFLICT (model_id, field_id, scope_key)
  DO UPDATE SET current_value = auto_id_counters.current_value + 1
  RETURNING current_value INTO v_value;

  RETURN v_value;
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, int) TO authenticated;
