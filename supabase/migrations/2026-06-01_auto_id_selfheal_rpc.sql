-- ============================================================
-- 2026-06-01 — record_assign_auto_id self-heal
-- ============================================================
-- BUG (observed in prod 2026-06-01): two clients shared id `ع218`, and
-- all_projects had 12 colliding `م ش…` ids. Root cause is NOT the atomic
-- counter racing with itself — Phase F.1 already serializes that. It is the
-- counter drifting BELOW the ids actually in use:
--
--   * The F.1 backfill seeded auto_id_counters from the legacy JSONB
--     "next value", NOT from MAX(existing id). clients started 21 short
--     (counter 218 vs real max 239).
--   * Records created with the auto_id ALREADY set — bulk import, the
--     "duplicate record" path, find_or_create_record prefill, the
--     WhatsApp→client link — never call this RPC (assignAutoIds skips a
--     field that already has a value), so the counter never learns about
--     those ids.
--
-- Either way, the next "fresh" assignment hands out a number that is already
-- in use. The fix: for the GLOBAL scope, never return a value at or below the
-- highest numeric id already present in the model's records (read via the
-- unified_records view so it covers frozen + unfrozen models). Scoped
-- counters (auto_id_scope_field_id set) are intentionally skipped — deriving
-- each row's scope key in SQL would mean duplicating the client-side slugify,
-- and every auto_id field in the app today is global scope.
--
-- Signature MUST stay (uuid, uuid, text, int) RETURNS int to match the M13
-- permission-checked overload (see 2026-05-07_h_audit_followups.sql); a
-- mismatched signature creates a second overload and PostgREST then fails
-- every auto_id save with "Could not choose the best candidate function".
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.record_assign_auto_id(
  p_model_id  uuid,
  p_field_id  uuid,
  p_scope_key text,
  p_start     int DEFAULT 1
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_value        int;
  v_field_name   text;
  v_max_existing bigint;
BEGIN
  -- M13 (unchanged): gate behind the same model-level 'create' permission
  -- that gates record creation, so a low-privilege user can't inflate
  -- counters for a model they can't create on.
  IF NOT public.wassell_user_has_action((SELECT auth.uid()), p_model_id, 'create') THEN
    RAISE EXCEPTION 'record_assign_auto_id: caller lacks create permission on model %', p_model_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Atomic increment (unchanged): Postgres serializes the row-level op so two
  -- concurrent callers can never read the same value.
  INSERT INTO public.auto_id_counters (model_id, field_id, scope_key, current_value)
  VALUES (p_model_id, p_field_id, COALESCE(p_scope_key, ''), GREATEST(p_start, 1))
  ON CONFLICT (model_id, field_id, scope_key)
  DO UPDATE SET current_value = public.auto_id_counters.current_value + 1,
                updated_at    = now()
  RETURNING current_value INTO v_value;

  -- SELF-HEAL. The atomic counter only stops two SIMULTANEOUS saves from
  -- colliding with each other; it does NOT stop the counter from drifting
  -- below ids already in use (import / duplicate / pre-filled saves never
  -- call this RPC). For the GLOBAL scope, never return a value at or below
  -- the highest numeric id already present in the model's records.
  IF COALESCE(p_scope_key, '') IN ('', '__global__') THEN
    SELECT (f->>'name') INTO v_field_name
    FROM public.models m
    CROSS JOIN LATERAL jsonb_array_elements(m.schema->'sections') s
    CROSS JOIN LATERAL jsonb_array_elements(s->'fields') f
    WHERE m.id = p_model_id AND (f->>'id') = p_field_id::text
    LIMIT 1;

    IF v_field_name IS NOT NULL THEN
      -- Highest numeric id across BOTH storage shapes via the unified view.
      -- Non-numeric / empty values parse to NULL and are ignored. Runs as the
      -- definer so RLS can't hide rows and make us under-count the max.
      SELECT MAX(NULLIF(regexp_replace(ur.data->>v_field_name, '\D', '', 'g'), '')::bigint)
        INTO v_max_existing
      FROM public.unified_records ur
      WHERE ur.model_id = p_model_id;

      IF v_max_existing IS NOT NULL AND v_max_existing >= v_value THEN
        v_value := (v_max_existing + 1)::int;
        UPDATE public.auto_id_counters
           SET current_value = v_value, updated_at = now()
         WHERE model_id = p_model_id
           AND field_id = p_field_id
           AND scope_key = COALESCE(p_scope_key, '');
      END IF;
    END IF;
  END IF;

  RETURN v_value;
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_assign_auto_id(uuid, uuid, text, int) TO service_role;

COMMIT;
