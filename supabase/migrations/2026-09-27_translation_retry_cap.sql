-- Translation units: cap the retries so an impossible item cannot loop forever.
--
-- WHAT WAS HAPPENING (measured 2026-09-27). `translation_unit_finalize` cleared
-- `dirty` only for fully-resolved units and left everything else dirty with a
-- 15-minute backoff, with NO attempt ceiling anywhere in the path. Two fields
-- had been retrying since 6 September:
--
--   * all_projects «ربوة الرمز» → project_analysis — fails the protected-fact
--     guard every time because the source carries a long Supabase PDF link the
--     provider mangles. The guard is RIGHT to refuse; the retry policy was not.
--   * clients «منيرة عبدالله» → client_name — variants stuck a generation
--     behind the unit, so the CAS activation can never match.
--
-- Together they were ~95 provider calls a day (4/hour and 2/hour), forever:
-- 1,232 calls in 30 days, which made `worker/translateProvider` the app's
-- 4th-busiest AI call site while doing no useful work. The money was trivial
-- ($0.10/30 days); the damage was that the usage page ranked a bug as a feature.
--
-- WHAT THIS DOES. Each finalize that leaves a unit unresolved counts one
-- attempt. At `translation_settings.max_unit_retries` (6) the unit stops being
-- dirty and is marked BLOCKED with the last provider error — the reconcile
-- sweep then skips it, so the loop ends. It is not "resolved": the target
-- variant stays `failed`/`pending`, readers keep falling back to the source
-- text exactly as before, and the review screen still counts it under `failed`.
--
-- HOW A BLOCKED UNIT COMES BACK. Any change to the source bumps the unit's
-- generation, and the reset trigger below clears the counter — so editing the
-- field, or fixing the cause and running `translation_unit_unblock`, puts it
-- straight back in the queue. Blocked is a pause, never a tombstone.

BEGIN;

ALTER TABLE public.translation_units
  ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS blocked_at  timestamptz,
  ADD COLUMN IF NOT EXISTS block_reason text;

COMMENT ON COLUMN public.translation_units.retry_count IS
  'Consecutive finalize rounds that left this unit unresolved. Reset to 0 on success or on a generation bump.';
COMMENT ON COLUMN public.translation_units.blocked_at IS
  'Set when retry_count reached translation_settings.max_unit_retries. Blocked units are NOT dirty, so the reconcile sweep skips them.';

ALTER TABLE public.translation_settings
  ADD COLUMN IF NOT EXISTS max_unit_retries int NOT NULL DEFAULT 6;

COMMENT ON COLUMN public.translation_settings.max_unit_retries IS
  'How many consecutive failed rounds a translation unit gets before it is blocked. Raise it to be more patient; never remove the ceiling.';

-- Operator worklist: what is stuck and why, newest first.
CREATE OR REPLACE VIEW public.v_translation_blocked AS
  SELECT u.resource_kind, u.entity_id, u.model_id, m.name AS model_name, u.field_path,
         u.retry_count, u.blocked_at, u.block_reason, u.generation,
         left(u.source_excerpt, 120) AS source_excerpt
  FROM public.translation_units u
  LEFT JOIN public.models m ON m.id = u.model_id
  WHERE u.blocked_at IS NOT NULL
  ORDER BY u.blocked_at DESC;

ALTER VIEW public.v_translation_blocked SET (security_invoker = true);

-- ---------------------------------------------------------------------------
-- A new source resets the ceiling.
--
-- Every path that changes the source bumps `generation` (the capture trigger on
-- records, the human-edit / source-lang RPCs). Hooking the reset to that column
-- rather than editing the capture trigger keeps this change away from the
-- highest-blast-radius object in the schema — every record save runs that one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_translation_unit_reset_retries()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  NEW.retry_count  := 0;
  NEW.blocked_at   := NULL;
  NEW.block_reason := NULL;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS translation_units_reset_retries ON public.translation_units;
CREATE TRIGGER translation_units_reset_retries
  BEFORE UPDATE ON public.translation_units
  FOR EACH ROW
  WHEN (NEW.generation IS DISTINCT FROM OLD.generation)
  EXECUTE FUNCTION public.tg_translation_unit_reset_retries();

-- ---------------------------------------------------------------------------
-- finalize: same clearing rule, now with a ceiling on the deferral.
--
-- The "cleared" predicate is UNCHANGED from the pre-2026-09-27 definition — a
-- unit resolves when no machine-owned target variant is left pending or failed.
-- What is new is the second statement: a unit that did not resolve counts an
-- attempt, and at the cap it stops being dirty instead of being deferred again.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.translation_unit_finalize(p_kind text, p_entity uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_cleared int := 0;
  v_cap     int;
BEGIN
  SELECT COALESCE(max_unit_retries, 6) INTO v_cap FROM translation_settings WHERE id;
  -- A cap of 0 would block every unit on its first miss, including the ordinary
  -- "the provider was busy, try again" case. One is the lowest honest value.
  v_cap := GREATEST(COALESCE(v_cap, 6), 1);

  WITH cleared AS (
    UPDATE translation_units u
       SET dirty = false, next_retry_at = NULL, updated_at = now(),
           retry_count = 0, blocked_at = NULL, block_reason = NULL
     WHERE u.resource_kind = p_kind AND u.entity_id = p_entity AND u.dirty
       AND NOT EXISTS (
         SELECT 1 FROM translation_variants v
          WHERE v.resource_kind = u.resource_kind AND v.entity_id = u.entity_id
            AND v.field_path = u.field_path AND v.role = 'target' AND v.machine_owned
            AND v.state IN ('pending','failed'))
    RETURNING 1
  )
  SELECT count(*) INTO v_cleared FROM cleared;

  -- Whatever is still dirty failed this round.
  UPDATE translation_units u
     SET retry_count = u.retry_count + 1,
         dirty         = (u.retry_count + 1) < v_cap,
         next_retry_at = CASE WHEN (u.retry_count + 1) < v_cap
                              THEN now() + interval '15 minutes' END,
         blocked_at    = CASE WHEN (u.retry_count + 1) >= v_cap THEN now() END,
         block_reason  = CASE WHEN (u.retry_count + 1) >= v_cap THEN COALESCE(
                           (SELECT v.last_error FROM translation_variants v
                             WHERE v.resource_kind = u.resource_kind AND v.entity_id = u.entity_id
                               AND v.field_path = u.field_path AND v.role = 'target'
                               AND v.last_error IS NOT NULL
                             ORDER BY v.updated_at DESC LIMIT 1),
                           'stopped after ' || (u.retry_count + 1) || ' rounds with no variant resolved') END,
         updated_at = now()
   WHERE u.resource_kind = p_kind AND u.entity_id = p_entity AND u.dirty;

  RETURN v_cleared;
END $$;

-- ---------------------------------------------------------------------------
-- reconcile: skip blocked units explicitly.
--
-- `dirty = false` already excludes them, so this clause is belt-and-braces: it
-- states the intent in the query, so a future edit that revives `dirty` for a
-- blocked unit cannot silently restart the loop. Re-emitted verbatim from the
-- live definition with that ONE clause added.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.translation_reconcile(p_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  IF NOT COALESCE((SELECT is_enabled FROM translation_settings WHERE id), false) THEN
    RETURN 0;
  END IF;
  FOR r IN
    SELECT DISTINCT u.resource_kind, u.entity_id, u.model_id
    FROM translation_units u
    JOIN translation_resources tr ON tr.resource_kind = u.resource_kind AND tr.enabled
    WHERE u.dirty AND u.blocked_at IS NULL AND COALESCE(u.next_retry_at, now()) <= now()
      AND NOT EXISTS (SELECT 1 FROM translation_jobs j
                      WHERE j.resource_kind = u.resource_kind AND j.entity_id = u.entity_id
                        AND j.status IN ('queued','running'))
    LIMIT p_limit
  LOOP
    INSERT INTO translation_jobs (resource_kind, entity_id, model_id, changed_paths, run_after)
    VALUES (r.resource_kind, r.entity_id, r.model_id, '{}', now())
    ON CONFLICT (resource_kind, entity_id) WHERE status = 'queued' DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- ---------------------------------------------------------------------------
-- Unblock: put a blocked unit back in the queue after its cause is fixed.
-- Admin-only, same posture as the other translation lifecycle RPCs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.translation_unit_unblock(
  p_kind text, p_entity uuid, p_path text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n int;
BEGIN
  -- Who may unblock: an admin through the app, or a server-side caller
  -- (service_role / postgres) running maintenance. `wassell_is_admin` takes the
  -- caller's uid — there is no zero-argument overload (same shape as
  -- translation_can_edit). Checking `auth.uid() IS NULL` instead of the role
  -- name would be a hole: an ANON PostgREST request also has a null uid.
  IF NOT (current_user IN ('postgres', 'service_role')
          OR public.wassell_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  UPDATE translation_units u
     SET blocked_at = NULL, block_reason = NULL, retry_count = 0,
         dirty = true, next_retry_at = now(), updated_at = now()
   WHERE u.resource_kind = p_kind AND u.entity_id = p_entity
     AND (p_path IS NULL OR u.field_path = p_path)
     AND u.blocked_at IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.translation_unit_unblock(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.translation_unit_unblock(text, uuid, text) TO authenticated, service_role;

COMMIT;
