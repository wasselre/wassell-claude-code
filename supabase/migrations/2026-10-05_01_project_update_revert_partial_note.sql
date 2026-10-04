-- project_update_revert: say when a change was only PARTLY undone (2026-10-05).
--
-- Found by testing the undo on the live Almajdiah run: a change that set
-- {total_price, unit_status} on a unit whose status a person edited afterwards
-- was correctly undone key-by-key (price restored, the person's status kept),
-- but was noted 'reverted' and not counted anywhere — the summary read as if
-- the whole change had been undone. Now: 'partly reverted — edited since: <keys>'
-- and a `partial` count. Behaviour is unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.project_update_revert(p_run_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

REVOKE ALL ON FUNCTION public.project_update_revert(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_update_revert(uuid) TO service_role;

COMMIT;
