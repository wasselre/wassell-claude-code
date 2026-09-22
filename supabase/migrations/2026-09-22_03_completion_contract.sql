-- ============================================================================
-- Plan-driven task assignment — 3/5: THE COMPLETION CONTRACT.
-- 2026-09-22. Plan v9 §5 (request-bound events, immutable evidence, effects)
-- + 07-decisions.md D4 (no caption approval: the final approval launches the
-- ad with the writer's confirmed caption; a paid creative cannot be approved
-- at the launch step without a confirmed caption).
--
-- Signatures GROW with defaulted parameters, so the deployed API keeps working
-- unchanged. The old overloads are dropped first: PostgREST cannot pick between
-- two functions that both accept the same named arguments.
-- No function here raises SQLSTATE 40001/40P01.
-- ============================================================================

BEGIN;

-- ── replay lookup shared by every bound operation ───────────────────────────
-- (a) a different actor learns nothing (403); (b) the same actor with a
-- different operation/task/request is refused (WS409 → 409); (c) an exact
-- replay returns the stored outcome and writes nothing.
CREATE OR REPLACE FUNCTION public.mos_completion_replay(p_event_id uuid, p_operation text, p_task_id uuid,
                                                        p_request_hash text, p_actor uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ev public.mos_completion_events%ROWTYPE;
BEGIN
  IF p_event_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_ev FROM public.mos_completion_events WHERE event_id = p_event_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_ev.actor_user_id IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'MOS:EVENT_OWNER_MISMATCH' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_ev.operation IS DISTINCT FROM p_operation
     OR v_ev.task_id IS DISTINCT FROM p_task_id
     OR v_ev.request_hash IS DISTINCT FROM COALESCE(p_request_hash, '') THEN
    RAISE EXCEPTION 'MOS:EVENT_MISMATCH' USING ERRCODE = 'WS409',
      DETAIL = jsonb_build_object('event_id', p_event_id, 'stored_operation', v_ev.operation,
                                  'stored_task_id', v_ev.task_id)::text;
  END IF;
  RETURN v_ev.outcome || jsonb_build_object('replayed', true, 'event_id', p_event_id,
                                            'side_effects', v_ev.side_effects);
END $$;

/** Cheap precheck for the API (definer read; same-actor only). NULL when the event is new. */
CREATE OR REPLACE FUNCTION public.mos_completion_event_peek(p_event_id uuid)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object('operation', e.operation, 'task_id', e.task_id, 'outcome', e.outcome,
                            'side_effects', e.side_effects, 'created_at', e.created_at)
    FROM public.mos_completion_events e
   WHERE e.event_id = p_event_id
     AND (auth.uid() IS NULL OR e.actor_user_id = public.wassell_app_user_id(auth.uid()));
$$;

/** Flip ONE manifest element. `done` only after the caller confirmed the effect; never on "the call returned". */
CREATE OR REPLACE FUNCTION public.mos_completion_effect_done(p_event_id uuid, p_kind text, p_ref text,
                                                             p_outcome text, p_error text DEFAULT NULL,
                                                             p_detail jsonb DEFAULT NULL)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_eff jsonb; v_out jsonb := '[]'::jsonb; e jsonb; v_hit boolean := false;
BEGIN
  IF p_outcome NOT IN ('done','failed','superseded','pending') THEN
    RAISE EXCEPTION 'MOS:BAD_EFFECT_OUTCOME %', p_outcome USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT side_effects INTO v_eff FROM public.mos_completion_events WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(v_eff) LOOP
    IF e ->> 'kind' = p_kind AND (p_ref IS NULL OR e ->> 'ref' = p_ref) AND NOT v_hit THEN
      v_hit := true;
      e := e || jsonb_build_object('status', p_outcome,
                                   'attempts', COALESCE((e ->> 'attempts')::int, 0) + 1,
                                   'last_error', p_error,
                                   'detail', COALESCE(p_detail, e -> 'detail'),
                                   'updated_at', now());
      IF p_outcome = 'done' THEN e := e || jsonb_build_object('done_at', now()); END IF;
    END IF;
    v_out := v_out || jsonb_build_array(e);
  END LOOP;
  IF v_hit THEN
    UPDATE public.mos_completion_events SET side_effects = v_out WHERE event_id = p_event_id;
  END IF;
  RETURN v_hit;
END $$;

/** Recovery worklist: pending effects older than p_min_age. Service only. */
CREATE OR REPLACE FUNCTION public.mos_completion_pending_effects(p_min_age interval DEFAULT interval '2 minutes',
                                                                 p_limit integer DEFAULT 50)
 RETURNS TABLE(event_id uuid, operation text, subject_table text, subject_id uuid, actor_user_id uuid,
               side_effects jsonb, created_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT e.event_id, e.operation, e.subject_table, e.subject_id, e.actor_user_id, e.side_effects, e.created_at
    FROM public.mos_completion_events e
   WHERE auth.uid() IS NULL
     AND e.side_effects @> '[{"status":"pending"}]'::jsonb
     AND e.created_at < now() - p_min_age
   ORDER BY e.created_at
   LIMIT p_limit;
$$;

-- ── notify_emit + p_dedupe_key (§5f): exactly-once per (event, kind, recipient) ─
DROP FUNCTION IF EXISTS public.notify_emit(text, text, text[], uuid[], text, text, text, text, text, text[]);
CREATE OR REPLACE FUNCTION public.notify_emit(p_workspace text, p_event text, p_role_keys text[], p_user_ids uuid[],
                                              p_title_ar text, p_title_en text, p_body_ar text, p_body_en text,
                                              p_url text, p_channels text[] DEFAULT NULL::text[],
                                              p_dedupe_key text DEFAULT NULL)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_external    boolean;
  v_uid         uuid;
  v_nid         uuid;
  v_count       integer := 0;
  v_role_ids    uuid[];
  v_grid_inapp  boolean;
  v_grid_push   boolean;
  v_grid_wa     boolean;
  v_wa_pref     boolean;
  v_fire_inapp  boolean;
  v_fire_push   boolean;
  v_fire_wa     boolean;
  v_allow_inapp boolean := (p_channels IS NULL) OR ('inapp'    = ANY(p_channels));
  v_allow_push  boolean := (p_channels IS NULL) OR ('push'     = ANY(p_channels));
  v_allow_wa    boolean := (p_channels IS NULL) OR ('whatsapp' = ANY(p_channels));
BEGIN
  v_external := COALESCE(
    (SELECT (value->>'enabled')::boolean FROM public.mos_settings WHERE key = 'external_effects'),
    true);

  FOR v_uid IN
    SELECT DISTINCT s.uid
      FROM (
        SELECT unnest(p_user_ids) AS uid
        UNION
        SELECT u.id
          FROM public.users u
         WHERE u.is_active
           AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e
               JOIN public.roles r ON r.id::text = e->>'role_id'
              WHERE r.key = ANY(p_role_keys))
      ) s
     WHERE s.uid IS NOT NULL
  LOOP
    SELECT array_agg((e->>'role_id')::uuid)
      INTO v_role_ids
      FROM public.users u,
           jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e
     WHERE u.id = v_uid;

    SELECT COALESCE(bool_or(nr.enabled), false) INTO v_grid_push
      FROM public.notification_rules nr
     WHERE nr.event = p_event AND nr.channel = 'push'
       AND nr.role_id = ANY(COALESCE(v_role_ids, '{}'));

    SELECT COALESCE(bool_or(nr.enabled), false) INTO v_grid_wa
      FROM public.notification_rules nr
     WHERE nr.event = p_event AND nr.channel = 'whatsapp'
       AND nr.role_id = ANY(COALESCE(v_role_ids, '{}'));

    IF p_channels IS NULL THEN
      v_fire_inapp := true;
    ELSE
      SELECT COALESCE(bool_or(nr.enabled), false) INTO v_grid_inapp
        FROM public.notification_rules nr
       WHERE nr.event = p_event AND nr.channel = 'inapp'
         AND nr.role_id = ANY(COALESCE(v_role_ids, '{}'));
      v_fire_inapp := v_allow_inapp AND v_grid_inapp;
    END IF;

    v_fire_push := v_allow_push AND v_grid_push;
    v_fire_wa   := v_allow_wa   AND v_grid_wa;

    IF NOT (v_fire_inapp OR v_fire_push OR v_fire_wa) THEN
      CONTINUE;
    END IF;

    -- exactly-once: a conflict on the per-recipient key means this emission
    -- already happened — skip the notification AND its push/WhatsApp legs.
    v_nid := NULL;
    INSERT INTO public.notifications
      (user_id, workspace, kind, title_ar, title_en, body_ar, body_en, url, read_at, dedupe_key)
    VALUES
      (v_uid, p_workspace, p_event, p_title_ar, p_title_en, p_body_ar, p_body_en, p_url,
       CASE WHEN v_fire_inapp THEN NULL ELSE now() END,
       CASE WHEN p_dedupe_key IS NULL THEN NULL ELSE p_dedupe_key || ':' || v_uid::text END)
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id INTO v_nid;
    IF v_nid IS NULL THEN
      CONTINUE;
    END IF;
    v_count := v_count + 1;

    IF v_fire_push THEN
      IF v_external THEN
        INSERT INTO public.push_outbox (user_id, kind, title, body, url, tag, dedupe_key)
        VALUES (
          v_uid,
          'notify:' || p_event,
          COALESCE(p_title_ar, p_title_en),
          COALESCE(p_body_ar, p_body_en, ''),
          p_url,
          'ntf-' || p_event,
          'ntf:' || v_nid || ':' || v_uid
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
      ELSE
        RAISE NOTICE 'notify_emit: push skipped (external_effects off) event=% user=%', p_event, v_uid;
      END IF;
    END IF;

    IF v_fire_wa THEN
      SELECT p.whatsapp_enabled INTO v_wa_pref
        FROM public.notification_prefs p WHERE p.user_id = v_uid;
      v_wa_pref := COALESCE(v_wa_pref, true);

      IF v_external AND v_wa_pref THEN
        INSERT INTO public.notification_deliveries (notification_id, channel)
        VALUES (v_nid, 'whatsapp');
      ELSIF NOT v_external AND v_wa_pref THEN
        INSERT INTO public.notification_deliveries (notification_id, channel, status, last_error)
        VALUES (v_nid, 'whatsapp', 'skipped', 'external-effects-off');
      END IF;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- ── Meta job ids (built-in md5, no extension) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_meta_job_id(p_event_id uuid)
 RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('meta-ad:' || p_event_id::text)::uuid $$;
CREATE OR REPLACE FUNCTION public.mos_meta_ad_row_id(p_event_id uuid)
 RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('meta-ad-row:' || p_event_id::text)::uuid $$;

-- ── workflow_advance_role_path: bound events, in-RPC evidence, no dispatch ──
DROP FUNCTION IF EXISTS public.workflow_advance_role_path(text, uuid, text, text, jsonb, boolean, text);
CREATE OR REPLACE FUNCTION public.workflow_advance_role_path(
  p_subject_table text, p_subject_id uuid, p_result text, p_note text DEFAULT NULL::text,
  p_targets jsonb DEFAULT '[]'::jsonb, p_finish boolean DEFAULT false, p_return_to text DEFAULT NULL::text,
  p_task_id uuid DEFAULT NULL, p_event_id uuid DEFAULT NULL, p_operation text DEFAULT NULL,
  p_request_hash text DEFAULT NULL, p_request_snapshot jsonb DEFAULT NULL,
  p_meta_target jsonb DEFAULT NULL, p_submission_snapshot jsonb DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_task      public.workflow_role_tasks%ROWTYPE;
  v_roles     text[];
  v_steps     jsonb;
  v_version   uuid;
  v_idx       integer;
  v_next      jsonb;
  v_new_id    uuid;
  v_round     integer;
  v_closed_by uuid;
  v_step      jsonb;
  v_missing   text[];
  v_ret_idx   integer;
  v_is_row    boolean;
  v_members   integer;
  v_m         record;
  v_m_missing text[];
  v_paid      boolean := false;
  v_replay    jsonb;
  v_operation text := COALESCE(p_operation, CASE WHEN p_subject_table = 'mos_content_rows' THEN 'row.complete' ELSE 'content.complete' END);
  v_effects   jsonb := '[]'::jsonb;
  v_outcome   jsonb;
  v_caption   text; v_chash text;
  snap        jsonb;
BEGIN
  PERFORM public.mos_ledger_lock();

  IF p_subject_table NOT IN ('mos_content', 'mos_content_rows') THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table USING ERRCODE = 'feature_not_supported';
  END IF;
  v_is_row := p_subject_table = 'mos_content_rows';
  v_closed_by := public.wassell_app_user_id(auth.uid());

  -- (1) replay, first
  v_replay := public.mos_completion_replay(p_event_id, v_operation, p_task_id, p_request_hash, v_closed_by);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  -- (2) the SPECIFIC task when named; the subject's open task otherwise (legacy callers)
  IF p_task_id IS NOT NULL THEN
    SELECT * INTO v_task FROM public.workflow_role_tasks
     WHERE id = p_task_id AND subject_table = p_subject_table AND subject_id = p_subject_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MOS:TASK_NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_task.status <> 'open' THEN
      RAISE EXCEPTION 'MOS:TASK_ALREADY_CLOSED' USING ERRCODE = 'WS409',
        DETAIL = jsonb_build_object('task_id', p_task_id, 'status', v_task.status, 'result', v_task.result)::text;
    END IF;
  ELSE
    SELECT * INTO v_task FROM public.workflow_role_tasks
     WHERE subject_table = p_subject_table AND subject_id = p_subject_id AND status = 'open' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MOS:NO_OPEN_TASK'; END IF;
  END IF;

  v_roles := public.wassell_mos_roles(auth.uid());
  IF NOT (
       'administrator'     = ANY(v_roles)
    OR 'marketing_manager' = ANY(v_roles)
    OR v_task.role_key     = ANY(v_roles)
    OR COALESCE(v_task.assignee_user_id = v_closed_by, false)
  ) THEN
    RAISE EXCEPTION 'MOS:NOT_YOUR_TASK' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_result NOT IN ('submitted','approved','changes_requested') THEN
    RAISE EXCEPTION 'MOS:BAD_RESULT %', p_result;
  END IF;
  IF p_result = 'changes_requested' AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED';
  END IF;

  IF v_is_row THEN
    SELECT r.workflow_version_id, v.definition->'metadata'->'steps' INTO v_version, v_steps
      FROM public.mos_content_rows r LEFT JOIN public.workflow_versions v ON v.id = r.workflow_version_id
     WHERE r.id = p_subject_id;
    SELECT count(*) INTO v_members FROM public.mos_content c WHERE c.row_id = p_subject_id;
    IF v_members = 0 THEN
      RAISE EXCEPTION 'MOS:ROW_EMPTY % (no posts belong to this row)', p_subject_id USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSE
    SELECT c.workflow_version_id, v.definition->'metadata'->'steps', (c.purpose IN ('paid','both'))
      INTO v_version, v_steps, v_paid
      FROM public.mos_content c LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
     WHERE c.id = p_subject_id;
  END IF;

  SELECT e.elem INTO v_step FROM jsonb_array_elements(COALESCE(v_steps, '[]'::jsonb)) e(elem)
   WHERE e.elem ->> 'key' = v_task.step_key LIMIT 1;

  -- (3) server-enforced requirements, per member
  IF p_result IN ('submitted','approved') AND v_steps IS NOT NULL AND jsonb_typeof(v_steps) = 'array' THEN
    v_missing := ARRAY[]::text[];
    FOR v_m IN
      SELECT c.id, COALESCE(NULLIF(btrim(c.ref), ''), NULLIF(btrim(c.title), ''), c.id::text) AS label
        FROM public.mos_content c
       WHERE (v_is_row AND c.row_id = p_subject_id) OR (NOT v_is_row AND c.id = p_subject_id)
       ORDER BY c.row_order NULLS LAST, c.created_at
    LOOP
      v_m_missing := ARRAY[]::text[];
      SELECT COALESCE(v_m_missing || array_agg(q.k), v_m_missing) INTO v_m_missing
        FROM (SELECT COALESCE(f ->> 'key', f #>> '{}') AS k
                FROM jsonb_array_elements(COALESCE(v_step -> 'required_fields', '[]'::jsonb)) f) q
       WHERE q.k IS NOT NULL
         AND NULLIF(btrim(COALESCE((SELECT c.data ->> q.k FROM public.mos_content c WHERE c.id = v_m.id), '')), '') IS NULL;
      SELECT COALESCE(v_m_missing || array_agg(q.k), v_m_missing) INTO v_m_missing
        FROM (SELECT COALESCE(f ->> 'role', f #>> '{}') AS k
                FROM jsonb_array_elements(COALESCE(v_step -> 'required_files', '[]'::jsonb)) f) q
       WHERE q.k IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.mos_asset_links al
                          WHERE al.content_id = v_m.id AND al.role = q.k AND al.superseded_at IS NULL);
      -- the writer's caption must be CONFIRMED where the step requires the caption
      -- (writing), and — D4 — at the LAUNCH step of a paid creative: the final
      -- approval launches the ad with exactly this caption, so there is nothing
      -- to approve later.
      IF (EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_step -> 'required_fields', '[]'::jsonb)) f
                   WHERE COALESCE(f ->> 'key', f #>> '{}') = 'caption')
          OR (p_result = 'approved' AND v_paid AND COALESCE((v_step ->> 'auto_meta_ad')::boolean, false)))
         AND NOT EXISTS (SELECT 1 FROM public.mos_content c
                          WHERE c.id = v_m.id
                            AND NULLIF(btrim(COALESCE(c.data ->> 'caption', '')), '') IS NOT NULL
                            AND c.data ->> 'caption_confirmed_text' IS NOT NULL
                            AND c.data ->> 'caption_confirmed_text' = c.data ->> 'caption') THEN
        v_m_missing := v_m_missing || 'caption_confirmed'::text;
      END IF;
      IF COALESCE(array_length(v_m_missing, 1), 0) > 0 THEN
        IF v_is_row THEN
          SELECT COALESCE(v_missing || array_agg(v_m.label || ' — ' || u.k ORDER BY u.ord), v_missing)
            INTO v_missing FROM unnest(v_m_missing) WITH ORDINALITY AS u(k, ord);
        ELSE
          v_missing := v_missing || v_m_missing;
        END IF;
      END IF;
    END LOOP;
    IF COALESCE(array_length(v_missing, 1), 0) > 0 THEN
      RAISE EXCEPTION 'MOS:REQUIREMENTS_MISSING %', array_to_string(v_missing, ', ')
        USING ERRCODE = 'invalid_parameter_value', DETAIL = to_jsonb(v_missing)::text;
    END IF;
  END IF;

  -- (4) immutable evidence, inside the transition (§5c): only for a FRESH
  -- 'submitted' of the LOCKED round; the reject note on the round being rejected.
  IF p_result = 'submitted' AND p_submission_snapshot IS NOT NULL AND jsonb_typeof(p_submission_snapshot) = 'array' THEN
    FOR snap IN SELECT * FROM jsonb_array_elements(p_submission_snapshot) LOOP
      INSERT INTO public.mos_content_versions (content_id, round, data, scenes, submitted_by_user_id)
      VALUES ((snap ->> 'content_id')::uuid, v_task.round, COALESCE(snap -> 'data', '{}'::jsonb),
              COALESCE(snap -> 'scenes', '[]'::jsonb), v_closed_by)
      ON CONFLICT (content_id, round) DO UPDATE
        SET data = EXCLUDED.data, scenes = EXCLUDED.scenes, submitted_by_user_id = EXCLUDED.submitted_by_user_id;
    END LOOP;
  END IF;
  IF p_result = 'changes_requested' THEN
    UPDATE public.mos_content_versions cv SET rejected_note = p_note
     WHERE cv.round = v_task.round
       AND cv.content_id IN (SELECT c.id FROM public.mos_content c
                              WHERE (v_is_row AND c.row_id = p_subject_id) OR (NOT v_is_row AND c.id = p_subject_id));
  END IF;

  -- (5) the transition
  UPDATE public.workflow_role_tasks
     SET status = 'done', result = p_result, note = p_note,
         revision_targets = COALESCE(p_targets, '[]'::jsonb),
         closed_at = now(), closed_by_user_id = v_closed_by,
         offered_to_user_id = NULL, offered_at = NULL
   WHERE id = v_task.id;

  IF p_result = 'approved' THEN
    INSERT INTO public.mos_content_approvals
      (content_id, step_key, round, approved_by_user_id, approved_at, writing_hash, design_hash, caption_hash, package_hash)
    SELECT c.id, v_task.step_key, v_task.round, v_closed_by, now(),
           public.mos_content_writing_hash(c.id), public.mos_content_design_hash(c.id),
           public.mos_caption_hash(c.data ->> 'caption'), public.mos_content_package_hash(c.id)
      FROM public.mos_content c
     WHERE (v_is_row AND c.row_id = p_subject_id) OR (NOT v_is_row AND c.id = p_subject_id)
    ON CONFLICT (content_id, step_key, round) DO UPDATE
      SET approved_by_user_id = EXCLUDED.approved_by_user_id, approved_at = EXCLUDED.approved_at,
          writing_hash = EXCLUDED.writing_hash, design_hash = EXCLUDED.design_hash,
          caption_hash = EXCLUDED.caption_hash, package_hash = EXCLUDED.package_hash;

    IF COALESCE((v_step ->> 'auto_meta_ad')::boolean, false) THEN
      UPDATE public.mos_content
         SET data = CASE WHEN data ? 'revision' THEN jsonb_set(data, '{revision,closed_at}', to_jsonb(now())) ELSE data END
       WHERE (v_is_row AND row_id = p_subject_id) OR (NOT v_is_row AND id = p_subject_id);

      -- the side-effects manifest (§5e): the approved payload is the writer's
      -- confirmed caption, hashed by the database, snapshotted HERE.
      IF NOT v_is_row THEN
        SELECT c.data ->> 'caption', public.mos_caption_hash(c.data ->> 'caption') INTO v_caption, v_chash
          FROM public.mos_content c WHERE c.id = p_subject_id;
        v_effects := v_effects || jsonb_build_array(jsonb_build_object(
          'kind', 'promote_asset', 'ref', p_subject_id::text, 'status', 'pending', 'attempts', 0));
        IF p_meta_target IS NOT NULL AND p_meta_target ->> 'kind' = 'target' THEN
          v_effects := v_effects || jsonb_build_array(jsonb_build_object(
            'kind', 'meta_ad', 'ref', p_subject_id::text, 'status', 'pending', 'attempts', 0,
            'phase', 'create',
            'job_id', CASE WHEN p_event_id IS NULL THEN NULL ELSE public.mos_meta_job_id(p_event_id) END,
            'target', p_meta_target,
            'approved_caption', jsonb_build_object('text', v_caption, 'hash', v_chash, 'source', 'writer',
                                                   'approved_at', now(), 'approved_by', v_closed_by)));
        END IF;
      END IF;
    END IF;
  END IF;

  -- (6) what opens next
  IF v_steps IS NULL OR jsonb_typeof(v_steps) <> 'array' OR jsonb_array_length(v_steps) = 0
     OR (p_finish AND p_result = 'approved') THEN
    v_next := NULL; v_round := v_task.round;
  ELSE
    SELECT ord - 1 INTO v_idx FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
     WHERE elem->>'key' = v_task.step_key;
    IF p_result = 'changes_requested' THEN
      IF NULLIF(btrim(COALESCE(p_return_to, '')), '') IS NOT NULL THEN
        SELECT ord - 1, elem INTO v_ret_idx, v_next FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
         WHERE elem->>'key' = p_return_to LIMIT 1;
        IF v_next IS NULL THEN
          RAISE EXCEPTION 'MOS:BAD_RETURN_TO % (not a step in this workflow)', p_return_to USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_ret_idx >= COALESCE(v_idx, 0) THEN
          RAISE EXCEPTION 'MOS:BAD_RETURN_TO % (not a prior step)', p_return_to USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF NOT COALESCE((v_next->>'creates_revision')::boolean, false) THEN
          RAISE EXCEPTION 'MOS:BAD_RETURN_TO % (does not create a revision)', p_return_to USING ERRCODE = 'invalid_parameter_value';
        END IF;
      ELSE
        SELECT elem INTO v_next FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
         WHERE ord - 1 < COALESCE(v_idx, 0) AND COALESCE((elem->>'creates_revision')::boolean, false)
         ORDER BY ord DESC LIMIT 1;
        IF v_next IS NULL THEN v_next := v_steps -> 0; END IF;
      END IF;
      v_round := v_task.round + 1;
    ELSE
      IF v_idx IS NOT NULL AND v_idx < jsonb_array_length(v_steps) - 1 THEN
        v_next := v_steps -> (v_idx + 1);
      ELSE
        v_next := NULL;
      END IF;
      v_round := v_task.round;
    END IF;
    IF v_next IS NOT NULL THEN
      v_new_id := public.mos_task_open_step(p_subject_table, p_subject_id, v_version, v_next, v_round);
    END IF;
  END IF;

  v_outcome := jsonb_build_object(
    'closed_task_id', v_task.id, 'opened_task_id', v_new_id,
    'next_step_key', CASE WHEN v_next IS NULL THEN NULL ELSE v_next->>'key' END,
    'round', v_round, 'done', v_next IS NULL, 'event_id', p_event_id);

  -- (7) the event, LAST (rollback removes event and transition together)
  IF p_event_id IS NOT NULL THEN
    INSERT INTO public.mos_completion_events
      (event_id, operation, task_id, subject_table, subject_id, actor_user_id, request_hash,
       request_snapshot, outcome, side_effects)
    VALUES (p_event_id, v_operation, v_task.id, p_subject_table, p_subject_id, v_closed_by,
            COALESCE(p_request_hash, ''), COALESCE(p_request_snapshot, '{}'::jsonb), v_outcome, v_effects);
  END IF;

  -- (8) the decider runs for the next holder's role — immediacy without recursion
  IF v_new_id IS NOT NULL THEN
    PERFORM public.mos_refill_request(ARRAY[v_next ->> 'role_key']);
  ELSE
    PERFORM public.mos_refill_request(ARRAY[v_task.role_key]);
  END IF;

  RETURN v_outcome || jsonb_build_object('side_effects', v_effects);
END $function$;

-- ── content_revise: the lock + the bind; a replay never opens a second round ─
DROP FUNCTION IF EXISTS public.content_revise(uuid, text[], text);
CREATE OR REPLACE FUNCTION public.content_revise(p_content_id uuid, p_scope text[], p_note text,
                                                 p_event_id uuid DEFAULT NULL, p_request_hash text DEFAULT NULL,
                                                 p_request_snapshot jsonb DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_c      public.mos_content%ROWTYPE;
  v_last   public.mos_content_approvals%ROWTYPE;
  v_scope  text[] := ARRAY[]::text[];
  v_next   text;
  v_round  int;
  v_actor  uuid := public.wassell_app_user_id(auth.uid());
  v_wh     text; v_dh text; v_ch text;
  v_ver    uuid; v_new uuid; v_step jsonb; v_replay jsonb; v_out jsonb;
BEGIN
  PERFORM public.mos_ledger_lock();
  IF NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('revise_approved_content') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_replay := public.mos_completion_replay(p_event_id, 'content.revise', NULL, p_request_hash, v_actor);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT * INTO v_c FROM public.mos_content WHERE id = p_content_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:CONTENT_NOT_FOUND %', p_content_id USING ERRCODE = 'no_data_found';
  END IF;

  v_wh := public.mos_content_writing_hash(p_content_id);
  v_dh := public.mos_content_design_hash(p_content_id);
  v_ch := public.mos_caption_hash(v_c.data ->> 'caption');

  SELECT * INTO v_last FROM public.mos_content_approvals WHERE content_id = p_content_id ORDER BY approved_at DESC LIMIT 1;
  IF v_last.id IS NOT NULL THEN
    IF v_last.writing_hash IS DISTINCT FROM v_wh THEN v_scope := v_scope || 'writing'::text; END IF;
    IF v_last.design_hash  IS DISTINCT FROM v_dh THEN v_scope := v_scope || 'design'::text;  END IF;
    IF v_last.caption_hash IS DISTINCT FROM v_ch THEN v_scope := v_scope || 'caption'::text; END IF;
  END IF;
  IF p_scope IS NOT NULL THEN
    SELECT array_agg(DISTINCT s) INTO v_scope FROM unnest(COALESCE(v_scope, ARRAY[]::text[]) || p_scope) s WHERE s IS NOT NULL;
  END IF;
  IF COALESCE(array_length(v_scope, 1), 0) = 0 THEN v_scope := ARRAY['caption']; END IF;

  IF 'writing' = ANY (v_scope)
     AND EXISTS (SELECT 1 FROM public.mos_content_types ct
                  WHERE ct.id = v_c.content_type_id AND COALESCE(array_length(ct.design_fields,1),0) > 0)
     AND NOT ('design' = ANY (v_scope)) THEN
    v_scope := v_scope || 'design_affecting'::text;
  END IF;

  v_next := CASE
    WHEN 'writing' = ANY (v_scope) OR 'design_affecting' = ANY (v_scope) OR 'caption' = ANY (v_scope) THEN 'writing_review'
    WHEN 'design' = ANY (v_scope) THEN 'design_writer_review'
    ELSE 'writing_review' END;

  IF 'caption' = ANY (v_scope) THEN
    UPDATE public.mos_content
       SET data = ((((data - 'caption_confirmed_text') - 'caption_confirmed_at') - 'caption_confirmed_hash') - 'caption_confirmed_by_writer_at')
     WHERE id = p_content_id;
  END IF;

  v_round := COALESCE((SELECT max(round) FROM public.workflow_role_tasks
                        WHERE subject_table = 'mos_content' AND subject_id = p_content_id), 0) + 1;

  UPDATE public.mos_content
     SET data = data || jsonb_build_object('revision', jsonb_build_object(
                  'round', v_round, 'scope', to_jsonb(v_scope), 'note', p_note, 'opened_at', now(),
                  'skip_steps', CASE WHEN v_scope = ARRAY['caption'] THEN jsonb_build_array('design','design_writer_review') ELSE '[]'::jsonb END)),
         on_hold_at = NULL, rejected_at = NULL
   WHERE id = p_content_id;

  INSERT INTO public.mos_content_events (content_id, kind, actor_user_id, detail)
  VALUES (p_content_id, 'revision_opened', v_actor,
          jsonb_build_object('scope', to_jsonb(v_scope), 'note', p_note, 'round', v_round,
                             'writing_hash', v_wh, 'design_hash', v_dh, 'caption_hash', v_ch));

  SELECT t.id INTO v_new FROM public.workflow_role_tasks t
   WHERE t.subject_table = 'mos_content' AND t.subject_id = p_content_id
     AND t.status = 'open' AND t.step_key = v_next AND t.round = v_round LIMIT 1;

  IF v_new IS NULL THEN
    UPDATE public.workflow_role_tasks
       SET status = 'done', result = 'changes_requested', note = p_note,
           closed_at = now(), closed_by_user_id = v_actor, offered_to_user_id = NULL, offered_at = NULL
     WHERE subject_table = 'mos_content' AND subject_id = p_content_id AND status = 'open';

    SELECT c.workflow_version_id INTO v_ver FROM public.mos_content c WHERE c.id = p_content_id;
    SELECT e.elem INTO v_step
      FROM public.workflow_versions v, LATERAL jsonb_array_elements(v.definition -> 'metadata' -> 'steps') e(elem)
     WHERE v.id = v_ver AND e.elem ->> 'key' = v_next LIMIT 1;
    IF v_step IS NOT NULL THEN
      v_new := public.mos_task_open_step('mos_content', p_content_id, v_ver, v_step, v_round);
    END IF;
  END IF;

  v_out := jsonb_build_object('scope', to_jsonb(v_scope), 'next_step', v_next, 'round', v_round,
                              'opened_task_id', v_new, 'event_id', p_event_id);
  IF p_event_id IS NOT NULL THEN
    INSERT INTO public.mos_completion_events
      (event_id, operation, task_id, subject_table, subject_id, actor_user_id, request_hash, request_snapshot, outcome)
    VALUES (p_event_id, 'content.revise', NULL, 'mos_content', p_content_id, v_actor,
            COALESCE(p_request_hash, ''), COALESCE(p_request_snapshot, '{}'::jsonb), v_out);
  END IF;
  IF v_step IS NOT NULL THEN PERFORM public.mos_refill_request(ARRAY[v_step ->> 'role_key']); END IF;
  RETURN v_out;
END $function$;

-- ── workflow_role_task_transfer: bound; a replay stacks no note ─────────────
DROP FUNCTION IF EXISTS public.workflow_role_task_transfer(uuid, uuid);
CREATE OR REPLACE FUNCTION public.workflow_role_task_transfer(p_task_id uuid, p_to_user_id uuid,
                                                              p_event_id uuid DEFAULT NULL,
                                                              p_request_hash text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_task public.workflow_role_tasks%ROWTYPE; v_actor uuid := public.wassell_app_user_id(auth.uid());
        v_replay jsonb; v_out jsonb;
BEGIN
  PERFORM public.mos_ledger_lock();
  IF NOT (public.wassell_mos_can('manage_roles') OR public.wassell_mos_can('assign')) THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_replay := public.mos_completion_replay(p_event_id, 'task.transfer', p_task_id, p_request_hash, v_actor);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT * INTO v_task FROM public.workflow_role_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MOS:TASK_NOT_FOUND' USING ERRCODE = 'no_data_found'; END IF;
  IF v_task.status <> 'open' THEN RAISE EXCEPTION 'MOS:TASK_NOT_OPEN' USING ERRCODE = 'WS409'; END IF;

  UPDATE public.workflow_role_tasks
     SET assignee_user_id = p_to_user_id,
         assigned_at = COALESCE(assigned_at, now()),
         offered_to_user_id = NULL, offered_at = NULL,
         note = COALESCE(note, '') || E'\ntransferred by ' || COALESCE(v_actor::text, 'system') || ' at ' || now()::text,
         updated_at = now()
   WHERE id = p_task_id;
  -- the booking follows the person: bound → consumed if it was still offered/unassigned
  UPDATE public.mos_task_reservations SET status = 'consumed', updated_at = now()
   WHERE consumed_task_id = p_task_id AND status = 'bound';

  v_out := jsonb_build_object('task_id', p_task_id, 'assignee_user_id', p_to_user_id, 'event_id', p_event_id);
  IF p_event_id IS NOT NULL THEN
    INSERT INTO public.mos_completion_events
      (event_id, operation, task_id, subject_table, subject_id, actor_user_id, request_hash, outcome)
    VALUES (p_event_id, 'task.transfer', p_task_id, v_task.subject_table, v_task.subject_id, v_actor,
            COALESCE(p_request_hash, ''), v_out);
  END IF;
  RETURN v_out;
END $function$;

COMMIT;
