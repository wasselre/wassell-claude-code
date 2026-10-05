-- project_update_changes can record a DELETE, and project_update_revert puts
-- the row back (2026-10-05).
--
-- Needed for automatic unlisting: when Riva drops a project it markets (from
-- BOTH its broker portal and its public list) and the developer has no source
-- of its own, the weekly Riva run removes the project's Our Projects row
-- (operator rule 2026-10-05). Hard rule 1 of the lane: every write is logged
-- and revertable — so the removal is logged with the full row in `before`
-- and its model id in `after` ({"model_id": "<uuid>"}).
--
-- Revert of a delete: re-insert the row with its original id, model and data
-- unless a row with that id exists again. Everything else in the function is
-- unchanged from 2026-10-05_01.

BEGIN;

ALTER TABLE public.project_update_changes DROP CONSTRAINT IF EXISTS project_update_changes_action_check;
ALTER TABLE public.project_update_changes
  ADD CONSTRAINT project_update_changes_action_check CHECK (action = ANY (ARRAY['update'::text, 'create'::text, 'delete'::text]));

CREATE OR REPLACE FUNCTION public.project_update_revert(p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c record; v_cur jsonb; v_key text; v_match boolean; v_new jsonb; v_kept text[];
  n_rev int := 0; n_skip int := 0; n_part int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.project_update_runs WHERE id = p_run_id) THEN
    RAISE EXCEPTION 'project_update_revert: run % not found', p_run_id USING ERRCODE = 'WS404';
  END IF;
  FOR c IN SELECT * FROM public.project_update_changes
            WHERE run_id = p_run_id AND reverted_at IS NULL ORDER BY id DESC
  LOOP
    IF c.action = 'delete' THEN
      IF EXISTS (SELECT 1 FROM public.records WHERE id = c.record_id) THEN
        UPDATE public.project_update_changes SET revert_note = 'skipped: the row exists again' WHERE id = c.id;
        n_skip := n_skip + 1;
      ELSIF c.before IS NULL OR (c.after ->> 'model_id') IS NULL THEN
        UPDATE public.project_update_changes SET revert_note = 'skipped: no saved row to restore' WHERE id = c.id;
        n_skip := n_skip + 1;
      ELSE
        INSERT INTO public.records (id, model_id, data) VALUES (c.record_id, (c.after ->> 'model_id')::uuid, c.before);
        UPDATE public.project_update_changes SET reverted_at = now(), revert_note = 'restored' WHERE id = c.id;
        n_rev := n_rev + 1;
      END IF;
      CONTINUE;
    END IF;
    SELECT data INTO v_cur FROM public.records WHERE id = c.record_id FOR UPDATE;
    IF NOT FOUND THEN
      UPDATE public.project_update_changes SET reverted_at = now(), revert_note = 'record no longer exists' WHERE id = c.id;
      n_skip := n_skip + 1; CONTINUE;
    END IF;
    IF c.action = 'create' THEN
      v_match := true;
      FOR v_key IN SELECT jsonb_object_keys(c.after) LOOP
        IF (v_cur -> v_key) IS DISTINCT FROM (c.after -> v_key) THEN v_match := false; END IF;
      END LOOP;
      IF v_match THEN
        DELETE FROM public.records WHERE id = c.record_id;
        UPDATE public.project_update_changes SET reverted_at = now(), revert_note = 'deleted' WHERE id = c.id;
        n_rev := n_rev + 1;
      ELSE
        UPDATE public.project_update_changes SET revert_note = 'skipped: edited since creation' WHERE id = c.id;
        n_skip := n_skip + 1;
      END IF;
      CONTINUE;
    END IF;
    v_new := v_cur; v_match := false; v_kept := ARRAY[]::text[];
    FOR v_key IN SELECT jsonb_object_keys(c.after) LOOP
      IF (v_cur -> v_key) IS NOT DISTINCT FROM (c.after -> v_key) THEN
        v_match := true;
        IF c.before -> v_key IS NULL OR jsonb_typeof(c.before -> v_key) = 'null' THEN
          v_new := v_new - v_key;
        ELSE
          v_new := jsonb_set(v_new, ARRAY[v_key], c.before -> v_key);
        END IF;
      ELSE
        v_kept := v_kept || v_key;
      END IF;
    END LOOP;
    IF v_match THEN
      UPDATE public.records SET data = v_new WHERE id = c.record_id;
      IF cardinality(v_kept) = 0 THEN
        UPDATE public.project_update_changes SET reverted_at = now(), revert_note = 'reverted' WHERE id = c.id;
        n_rev := n_rev + 1;
      ELSE
        UPDATE public.project_update_changes
           SET reverted_at = now(), revert_note = 'partly reverted — edited since: ' || array_to_string(v_kept, ', ')
         WHERE id = c.id;
        n_part := n_part + 1;
      END IF;
    ELSE
      UPDATE public.project_update_changes SET revert_note = 'skipped: edited since' WHERE id = c.id;
      n_skip := n_skip + 1;
    END IF;
  END LOOP;
  UPDATE public.project_update_runs SET reverted_at = now() WHERE id = p_run_id;
  RETURN jsonb_build_object('reverted', n_rev, 'partial', n_part, 'skipped', n_skip);
END $function$;

COMMIT;
