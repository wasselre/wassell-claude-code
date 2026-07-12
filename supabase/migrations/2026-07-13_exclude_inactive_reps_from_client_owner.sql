-- client_owner (Sales Consultant) derivation must IGNORE follow-ups whose
-- sales_rep is a DEACTIVATED user (users.is_active = false).
--
-- Why: when a salesperson leaves (e.g. fahad.m@wassel.re, deactivated
-- 2026-07-13), their client book is reassigned to another consultant. But
-- client_owner is auto-derived from the most-recently-created follow-up that
-- carries a sales_rep (2026-06-30_client_owner_sales_consultant_auto.sql) —
-- so for any client whose latest rep-bearing follow-up is a CLOSED one by the
-- departed rep, every recompute (any client write, any follow-up/call/chat
-- touch) would silently revert ownership back to the deactivated rep,
-- clobbering the reassignment. Rewriting historical follow-ups' sales_rep to
-- fix that would falsify who actually did the work.
--
-- Fix: exclude reps that match an INACTIVE user from the v_owner candidate
-- set. Consequences:
--   * Closed follow-up history stays attributed to the departed rep
--     (analytics/valuations untouched).
--   * A directly-set client_owner now STICKS for clients whose only rep
--     history is a deactivated rep (v_owner comes back NULL -> the merge in
--     tg_records_fill_client_next_action keeps the stored value).
--   * Unknown/drifted sales_rep values (not matching any user row) keep the
--     old behavior — only a positive is_active = false match is excluded.
--
-- Everything below is identical to the 2026-06-30 definition except the
-- NOT EXISTS guard inside the v_owner SELECT.
--
-- Applied to wassell-prod 2026-07-13 via MCP
-- (migration: exclude_inactive_reps_from_client_owner_derivation), together
-- with the one-time data reassignment (98 open follow-ups + 481 clients,
-- Fahad -> Rayyan; pre-change rows snapshotted in
-- public._backup_fahad_reassign_20260713).

BEGIN;

CREATE OR REPLACE FUNCTION public.recalc_client_derived_data(p_client_id uuid, p_stage text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_followups uuid := public._sales_followups_model_id();
  v_clients   uuid := public._sales_clients_model_id();
  v_calls     uuid := (SELECT id FROM public.models WHERE name = 'phone_calls' LIMIT 1);
  v_chats     uuid := (SELECT id FROM public.models WHERE name = 'chats' LIMIT 1);
  v_cid  text := p_client_id::text;
  v_stage text := p_stage;
  v_na   record;
  v_next_id text; v_next_type text; v_next_due text;
  v_last timestamptz;
  v_lost_reason text; v_lost_at text;
  v_lifecycle text;
  v_terminal boolean;
  v_lost boolean;
  v_owner text;
BEGIN
  IF v_followups IS NULL OR v_clients IS NULL THEN RETURN '{}'::jsonb; END IF;

  IF v_stage IS NULL THEN
    SELECT data->>'client_stage' INTO v_stage FROM public.records WHERE id = p_client_id;
  END IF;
  v_terminal := v_stage IN ('خاسر', 'غير مؤهل', 'مغلق ناجح');
  v_lost     := v_stage IN ('خاسر', 'غير مؤهل');

  SELECT f.id, f.data->>'scheduled_datetime' AS due, public._followup_next_action_type(f.data) AS nat
  INTO v_na
  FROM public.records f
  WHERE f.model_id = v_followups
    AND public._followup_client_id_of(f.data) = v_cid
    AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
  ORDER BY public.try_timestamptz(f.data->>'scheduled_datetime') ASC NULLS LAST, f.created_at ASC
  LIMIT 1;
  IF v_na.id IS NOT NULL THEN
    v_next_id := v_na.id::text; v_next_type := v_na.nat; v_next_due := v_na.due;
  END IF;

  SELECT GREATEST(
    (SELECT max(public.try_timestamptz(f.data->>'actual_datetime')) FROM public.records f
       WHERE f.model_id = v_followups AND public._followup_client_id_of(f.data) = v_cid),
    (SELECT max(public.try_timestamptz(c.data->>'call_time')) FROM public.records c
       WHERE v_calls IS NOT NULL AND c.model_id = v_calls AND public._link_client_id_of(c.data) = v_cid),
    (SELECT max(public.try_timestamptz(ch.data->>'last_message_at')) FROM public.records ch
       WHERE v_chats IS NOT NULL AND ch.model_id = v_chats AND public._link_client_id_of(ch.data) = v_cid)
  ) INTO v_last;

  SELECT CASE WHEN jsonb_typeof(f.data->'sales_rep') = 'array'
              THEN nullif(f.data->'sales_rep'->>0, '')
              ELSE nullif(f.data->>'sales_rep', '') END
  INTO v_owner
  FROM public.records f
  WHERE f.model_id = v_followups
    AND public._followup_client_id_of(f.data) = v_cid
    AND (CASE WHEN jsonb_typeof(f.data->'sales_rep') = 'array'
              THEN nullif(f.data->'sales_rep'->>0, '')
              ELSE nullif(f.data->>'sales_rep', '') END) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id::text = (CASE WHEN jsonb_typeof(f.data->'sales_rep') = 'array'
                               THEN nullif(f.data->'sales_rep'->>0, '')
                               ELSE nullif(f.data->>'sales_rep', '') END)
        AND u.is_active = false
    )
  ORDER BY f.created_at DESC, public.try_timestamptz(f.data->>'scheduled_datetime') DESC NULLS LAST
  LIMIT 1;

  IF v_lost THEN
    SELECT f.data->>'lost_reason',
           COALESCE(nullif(f.data->>'actual_datetime',''), to_char(f.created_at, 'YYYY-MM-DD"T"HH24:MI:SS'))
    INTO v_lost_reason, v_lost_at
    FROM public.records f
    WHERE f.model_id = v_followups
      AND public._followup_client_id_of(f.data) = v_cid
      AND nullif(f.data->>'lost_reason','') IS NOT NULL
    ORDER BY public.try_timestamptz(COALESCE(nullif(f.data->>'actual_datetime',''), f.created_at::text)) DESC NULLS LAST,
             f.created_at DESC
    LIMIT 1;

    IF v_lost_at IS NULL THEN
      SELECT f.data->>'actual_datetime' INTO v_lost_at
      FROM public.records f
      WHERE f.model_id = v_followups
        AND public._followup_client_id_of(f.data) = v_cid
        AND nullif(f.data->>'actual_datetime','') IS NOT NULL
      ORDER BY public.try_timestamptz(f.data->>'actual_datetime') DESC
      LIMIT 1;
    END IF;
  END IF;

  IF v_terminal THEN
    v_lifecycle := 'closed';
  ELSIF v_next_id IS NULL THEN
    v_lifecycle := 'no_next_action';
  ELSIF public.try_timestamptz(v_next_due) IS NOT NULL AND public.try_timestamptz(v_next_due) < now() THEN
    v_lifecycle := 'overdue';
  ELSE
    v_lifecycle := 'on_track';
  END IF;

  RETURN jsonb_build_object(
    'next_followup_id',   v_next_id,
    'next_action_type',   v_next_type,
    'next_action_due_at', v_next_due,
    'last_activity_at',   to_jsonb(v_last),
    'lifecycle_health',   v_lifecycle,
    'lost_reason',        v_lost_reason,
    'lost_at',            v_lost_at
  )
  || CASE WHEN v_owner IS NOT NULL
          THEN jsonb_build_object('client_owner', v_owner)
          ELSE '{}'::jsonb END;
END;
$function$;

COMMIT;
