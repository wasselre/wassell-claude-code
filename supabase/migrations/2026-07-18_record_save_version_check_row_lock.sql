-- record_save: close the optimistic-version-check race (TOCTOU lost update).
--
-- INCIDENT (2026-07-18, listing e4106640 / draft d0602087): 22 clean-text jobs
-- finished within ~40 s (FLUX.2 klein is ~3 s/photo vs gpt's ~3 min, so writes
-- that used to be naturally staggered now collide). One photo's SUCCESSFULLY
-- COMMITTED cleaning fill vanished: its entry stayed 'queued' while its job —
-- and 20 others — reported success.
--
-- ROOT CAUSE: the version check read the row WITHOUT a lock:
--
--     SELECT version INTO v_existing_version FROM records WHERE id = p_id;
--     IF ... <> p_expected_version THEN RAISE serialization_failure
--     INSERT ... ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
--
-- Under READ COMMITTED two writers can BOTH pass the check on version N; the
-- second one's UPSERT then waits on the first's row lock and, when it commits,
-- proceeds to overwrite the first writer's data with its own (stale-merged)
-- payload — no 40001 raised, the lost update is silent. The entire optimistic-
-- concurrency contract (image_chats hard rule 3, clean-text fills, the SPA's
-- stale-tab bounce) assumes this window does not exist.
--
-- FIX: SELECT ... FOR UPDATE. The check now takes the row lock FIRST, so
-- concurrent writers serialize on the check itself and re-validate against the
-- committed version — the loser gets its version_mismatch and re-reads, exactly
-- as the retry contract expects. For a not-yet-existing row FOR UPDATE locks
-- nothing and the following INSERT ... ON CONFLICT handles the insert race as
-- before.
--
-- Body is otherwise IDENTICAL to the live function (incl. the 2026-06-24 'noop'
-- block modes + conflict-storm breakers + v2 conflict logging).

CREATE OR REPLACE FUNCTION public.record_save(p_model_id uuid, p_id uuid, p_data jsonb, p_created_by uuid DEFAULT NULL::uuid, p_expected_version integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_model record; v_table text; v_existing_version int; v_user uuid; v_headers jsonb; v_claims jsonb; v_session text; v_block_mode text;
BEGIN
  BEGIN v_claims := nullif(current_setting('request.jwt.claims', true),'')::jsonb; EXCEPTION WHEN others THEN v_claims := NULL; END;
  v_session := v_claims->>'session_id';
  IF v_session IS NOT NULL THEN
    SELECT s.mode INTO v_block_mode FROM public.session_save_blocks s WHERE s.session_id = v_session AND s.blocked_until > now();
    IF FOUND THEN
      -- 'noop' mode: return success WITHOUT writing, to break a runaway client's retry
      -- loop cheaply (incident 2026-06-24). Safe: a blocked session's write is stale by
      -- definition. 'reject' (default) preserves the original conflict-storm breaker.
      IF v_block_mode = 'noop' THEN RETURN p_id; END IF;
      RAISE EXCEPTION 'conflict_storm_blocked: this session is rate-limited after repeated version conflicts'
        USING ERRCODE='serialization_failure', HINT='reload the page to continue';
    END IF;
  END IF;
  SELECT b.mode INTO v_block_mode FROM public.record_save_blocks b WHERE b.record_id = p_id AND b.blocked_until > now();
  IF FOUND THEN
    -- same 'noop' lever for a per-record block (e.g. a rogue hammering a dead draft):
    -- return success so the caller stops, instead of a reject-storm. 'reject' default unchanged.
    IF v_block_mode = 'noop' THEN RETURN p_id; END IF;
    RAISE EXCEPTION 'conflict_storm_blocked: saves to record % are temporarily blocked after a retry storm', p_id
      USING ERRCODE='serialization_failure', HINT='reload the record; the block clears automatically';
  END IF;
  SELECT id, name, is_hardcoded INTO v_model FROM models WHERE id = p_model_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'model % not found', p_model_id; END IF;
  IF v_model.is_hardcoded THEN
    v_table := public.freeze_safe_ident(v_model.name);
    EXECUTE format('INSERT INTO public.%I (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', v_table) USING p_id;
    PERFORM public.freeze_apply_row(p_model_id, p_id, p_data, p_created_by, p_expected_version);
  ELSE
    IF p_expected_version IS NOT NULL THEN
      -- FOR UPDATE (2026-07-18): lock the row BEFORE the version check so
      -- check+write are atomic. Without it, two writers could both pass the
      -- check and the second silently overwrote the first's committed data.
      SELECT version INTO v_existing_version FROM records WHERE id = p_id FOR UPDATE;
      IF FOUND AND v_existing_version <> p_expected_version THEN
        v_user := auth.uid();
        BEGIN v_headers := nullif(current_setting('request.headers', true),'')::jsonb; EXCEPTION WHEN others THEN v_headers := NULL; END;
        RAISE LOG 'record_save_conflict v2 record=% model=% user=% session=% role=% tab=% build=% expected=% current=% ip=% client=% referer=% path=% ua=%',
          p_id, p_model_id, v_user, v_session, v_claims->>'role', v_headers->>'x-wassel-tab', v_headers->>'x-wassel-build',
          p_expected_version, v_existing_version, coalesce(v_headers->>'x-forwarded-for',v_headers->>'x-real-ip',v_headers->>'cf-connecting-ip'),
          v_headers->>'x-client-info', v_headers->>'referer', current_setting('request.path', true), v_headers->>'user-agent';
        RAISE EXCEPTION 'version_mismatch: record was edited by another user (loaded v%, current v%) [record=% model=% user=% session=% role=%]',
          p_expected_version, v_existing_version, p_id, p_model_id, v_user, v_session, v_claims->>'role'
          USING ERRCODE='serialization_failure', HINT='reload the record to see latest changes';
      END IF;
    END IF;
    INSERT INTO records (id, model_id, data, created_by_user_id) VALUES (p_id, p_model_id, p_data, p_created_by)
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data,
      created_by_user_id = COALESCE(records.created_by_user_id, EXCLUDED.created_by_user_id), updated_at = now();
  END IF;
  RETURN p_id;
END;
$function$;
