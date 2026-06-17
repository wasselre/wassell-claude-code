-- ============================================================================
-- Client derived fields — extend the next-action trigger to also maintain
-- last_activity_at, lifecycle_health, lost_at, lost_reason.
--
-- Per the user: these four should "act like the next action" — DB-derived and
-- NOT editable. This supersedes 2026-06-17_client_next_action.sql's
-- recalc_client_next_action_data with recalc_client_derived_data, which returns
-- the FULL 7-field patch, and broadens the activity touch to fire on calls and
-- chats too (so last_activity_at stays fresh). Same proven pattern as the
-- all_projects rollups + the next-action trio.
--
-- Derivation:
--   • next_followup_id / next_action_type / next_action_due_at — earliest OPEN
--     follow-up (unchanged).
--   • last_activity_at — most recent of {completed follow-up actual_datetime,
--     phone_calls.call_time, chats.last_message_at} for the client.
--   • lifecycle_health — closed (terminal stage خاسر/غير مؤهل/مغلق ناجح) →
--     no_next_action (no open follow-up) → overdue (next due < now) → on_track.
--   • lost_at / lost_reason — only in a LOST stage (خاسر/غير مؤهل): reason from
--     the most recent follow-up that recorded one; date from that follow-up,
--     falling back to the last completed follow-up's actual_datetime. Cleared
--     when not lost.
--
-- All four are marked read_only in the clients schema. Both clients/followups/
-- phone_calls/chats are UNFROZEN (records JSONB). Idempotent.
-- ============================================================================

-- Client-link extractor for the phone_calls / chats `client_link` slug
-- (scalar, or first element of an array). Mirrors _followup_client_id_of.
CREATE OR REPLACE FUNCTION public._link_client_id_of(d jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN d IS NULL THEN NULL
    WHEN jsonb_typeof(d->'client_link') = 'array' THEN nullif(d->'client_link'->>0, '')
    ELSE nullif(d->>'client_link', '')
  END;
$fn$;

-- The full derived-field patch for one client. p_stage lets the BEFORE-fill
-- pass NEW's stage (so an in-place stage change computes against the NEW stage,
-- not the pre-update row); NULL → read the committed stage from the table.
CREATE OR REPLACE FUNCTION public.recalc_client_derived_data(p_client_id uuid, p_stage text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
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
BEGIN
  IF v_followups IS NULL OR v_clients IS NULL THEN RETURN '{}'::jsonb; END IF;

  IF v_stage IS NULL THEN
    SELECT data->>'client_stage' INTO v_stage FROM public.records WHERE id = p_client_id;
  END IF;
  v_terminal := v_stage IN ('خاسر', 'غير مؤهل', 'مغلق ناجح');
  v_lost     := v_stage IN ('خاسر', 'غير مؤهل');

  -- NEXT ACTION — earliest open follow-up.
  SELECT f.id, f.data->>'scheduled_datetime' AS due, public._followup_next_action_type(f.data) AS nat
  INTO v_na
  FROM public.records f
  WHERE f.model_id = v_followups
    AND public._followup_client_id_of(f.data) = v_cid
    AND COALESCE(f.data->>'followup_status', '') IN ('open', 'in_progress')
  ORDER BY public.try_timestamptz(f.data->>'scheduled_datetime') ASC NULLS LAST, f.created_at ASC
  LIMIT 1;
  IF v_na.id IS NOT NULL THEN
    v_next_id := v_na.id::text; v_next_type := v_na.nat; v_next_due := v_na.due;
  END IF;

  -- LAST ACTIVITY — most recent completed follow-up / call / chat message.
  SELECT GREATEST(
    (SELECT max(public.try_timestamptz(f.data->>'actual_datetime')) FROM public.records f
       WHERE f.model_id = v_followups AND public._followup_client_id_of(f.data) = v_cid),
    (SELECT max(public.try_timestamptz(c.data->>'call_time')) FROM public.records c
       WHERE v_calls IS NOT NULL AND c.model_id = v_calls AND public._link_client_id_of(c.data) = v_cid),
    (SELECT max(public.try_timestamptz(ch.data->>'last_message_at')) FROM public.records ch
       WHERE v_chats IS NOT NULL AND ch.model_id = v_chats AND public._link_client_id_of(ch.data) = v_cid)
  ) INTO v_last;

  -- LOST — only when in a lost stage.
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
      -- Fallback: the last completed follow-up's actual_datetime (best-available
      -- "lost date" for a legacy lost client with no recorded loss reason).
      SELECT f.data->>'actual_datetime' INTO v_lost_at
      FROM public.records f
      WHERE f.model_id = v_followups
        AND public._followup_client_id_of(f.data) = v_cid
        AND nullif(f.data->>'actual_datetime','') IS NOT NULL
      ORDER BY public.try_timestamptz(f.data->>'actual_datetime') DESC
      LIMIT 1;
    END IF;
  END IF;

  -- LIFECYCLE HEALTH.
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
  );
END;
$fn$;

-- BEFORE-fill now computes the FULL derived patch, passing NEW's stage.
CREATE OR REPLACE FUNCTION public.tg_records_fill_client_next_action()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.model_id = public._sales_clients_model_id() THEN
    NEW.data := COALESCE(NEW.data, '{}'::jsonb)
                || public.recalc_client_derived_data(NEW.id, NEW.data->>'client_stage');
  END IF;
  RETURN NEW;
END;
$fn$;

-- Broaden the activity touch: recompute a client when its follow-ups, calls,
-- OR chats change (so last_activity_at + lifecycle stay fresh). Replaces the
-- followups-only touch.
CREATE OR REPLACE FUNCTION public.tg_records_touch_client_on_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_followups uuid := public._sales_followups_model_id();
  v_calls uuid := (SELECT id FROM public.models WHERE name = 'phone_calls' LIMIT 1);
  v_chats uuid := (SELECT id FROM public.models WHERE name = 'chats' LIMIT 1);
  v_mid uuid;
  v_old text; v_new text;
BEGIN
  v_mid := CASE WHEN TG_OP = 'DELETE' THEN OLD.model_id ELSE NEW.model_id END;
  IF v_mid IS DISTINCT FROM v_followups
     AND v_mid IS DISTINCT FROM v_calls
     AND v_mid IS DISTINCT FROM v_chats THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- For a chats UPDATE that didn't change last_message_at, skip (avoids touching
  -- the client on unread_count / label churn — keeps last_activity_at writes lean).
  IF TG_OP = 'UPDATE' AND v_mid = v_chats
     AND (OLD.data->>'last_message_at') IS NOT DISTINCT FROM (NEW.data->>'last_message_at') THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    v_old := CASE WHEN OLD.model_id = v_followups THEN public._followup_client_id_of(OLD.data)
                  ELSE public._link_client_id_of(OLD.data) END;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new := CASE WHEN NEW.model_id = v_followups THEN public._followup_client_id_of(NEW.data)
                  ELSE public._link_client_id_of(NEW.data) END;
  END IF;

  IF v_new IS NOT NULL THEN PERFORM public._touch_client(v_new); END IF;
  IF v_old IS NOT NULL AND v_old IS DISTINCT FROM v_new THEN PERFORM public._touch_client(v_old); END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

DROP TRIGGER IF EXISTS records_touch_client_on_followup_change ON public.records;
DROP TRIGGER IF EXISTS records_touch_client_on_activity ON public.records;
CREATE TRIGGER records_touch_client_on_activity
AFTER INSERT OR UPDATE OR DELETE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_records_touch_client_on_activity();

-- Mark the four newly-derived fields read_only (the trio already is).
DO $ro$
DECLARE
  v_id uuid; v_schema jsonb; s int; f int; v_name text;
BEGIN
  SELECT id, schema INTO v_id, v_schema FROM public.models WHERE name = 'clients';
  IF v_id IS NULL THEN RETURN; END IF;
  FOR s IN 0 .. jsonb_array_length(v_schema->'sections') - 1 LOOP
    FOR f IN 0 .. jsonb_array_length(v_schema->'sections'->s->'fields') - 1 LOOP
      v_name := v_schema #>> ARRAY['sections', s::text, 'fields', f::text, 'name'];
      IF v_name IN ('last_activity_at', 'lifecycle_health', 'lost_at', 'lost_reason') THEN
        v_schema := jsonb_set(v_schema, ARRAY['sections', s::text, 'fields', f::text, 'read_only'], 'true'::jsonb, true);
      END IF;
    END LOOP;
  END LOOP;
  UPDATE public.models SET schema = v_schema, updated_at = now() WHERE id = v_id;
END $ro$;

-- The old next-action-only recalc is now unreferenced (trigger calls the new
-- recalc_client_derived_data). Drop it.
DROP FUNCTION IF EXISTS public.recalc_client_next_action_data(uuid);

-- Backfill all clients.
UPDATE public.records
SET data = data
WHERE model_id = public._sales_clients_model_id();
