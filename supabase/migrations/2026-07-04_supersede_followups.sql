-- ============================================================================
-- Phase B — deterministic supersede layer for sales follow-ups.
--
-- When a client moves to a stronger lifecycle event (appointment / visit /
-- offer / reservation / financing / ownership transfer / closed-won / lost),
-- the OLD open/in-progress follow-ups that no longer make sense are CANCELLED
-- (never deleted). The follow-up the new stage's workflow creates is a
-- DIFFERENT type and is created AFTER the event insert, so it is never caught.
--
-- Lives on public.records (all these models are unfrozen JSONB rows) so it
-- covers every write path — UI store, API endpoints, record_save RPC — not
-- just browser workflows (which can't bulk-cancel).
--
-- Confirmed facts (prod, 2026-07-04):
--   - client_id is a SCALAR string on every lifecycle model + followups.
--   - followup_type is a JSONB ARRAY on followups.
--   - open predicate: COALESCE(NULLIF(followup_status,''),'open') IN ('open','in_progress').
--   - the valuation-review trigger only fires on followup_status='completed',
--     so cancelling (='cancelled') never spawns reviews.
--   - rating_request timers use followup_status='scheduled' (not open) → untouched.
-- ============================================================================

-- 1. The reconciler ---------------------------------------------------------
-- Cancels a client's OPEN/IN_PROGRESS follow-ups whose type is superseded by
-- the event. Idempotent (open-only predicate). SECURITY DEFINER so it can
-- cancel all of a client's tasks regardless of the writer's RLS.
--
-- The cancel-type sets here are the SQL half of the SINGLE-SOURCE policy in
-- src/lib/salesProcess/supersede.ts — KEEP THE TWO IN SYNC.

CREATE OR REPLACE FUNCTION public.reconcile_superseded_followups(
  p_client_id uuid,
  p_event_type text,
  p_event_id   uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_model_id uuid;
  v_types    text[];
  v_all      boolean := false;
  v_count    integer;
BEGIN
  IF p_client_id IS NULL THEN RETURN 0; END IF;
  SELECT id INTO v_model_id FROM models WHERE name = 'followups' LIMIT 1;
  IF v_model_id IS NULL THEN RETURN 0; END IF;

  CASE p_event_type
    WHEN 'appointment_created' THEN
      v_types := ARRAY['appointment_booking_call','whatsapp_follow_up','no_show_recovery_call'];
    WHEN 'visit_created' THEN
      v_types := ARRAY['appointment_booking_call','whatsapp_follow_up','no_show_recovery_call',
                       'appointment_confirmation_call','same_day_appointment_confirmation'];
    WHEN 'offer_created' THEN
      v_types := ARRAY['appointment_booking_call','whatsapp_follow_up','no_show_recovery_call',
                       'appointment_confirmation_call','same_day_appointment_confirmation',
                       'follow_up_call_after_visit'];
    WHEN 'reservation_created' THEN
      v_types := ARRAY['appointment_booking_call','whatsapp_follow_up','no_show_recovery_call',
                       'appointment_confirmation_call','same_day_appointment_confirmation',
                       'follow_up_call_after_visit','offer_follow_up'];
    WHEN 'financing_advanced' THEN
      v_types := ARRAY['appointment_booking_call','whatsapp_follow_up','no_show_recovery_call',
                       'appointment_confirmation_call','same_day_appointment_confirmation',
                       'follow_up_call_after_visit','offer_follow_up','reservation_payment_follow_up'];
    WHEN 'transfer_started' THEN
      v_types := ARRAY['appointment_booking_call','whatsapp_follow_up','no_show_recovery_call',
                       'appointment_confirmation_call','same_day_appointment_confirmation',
                       'follow_up_call_after_visit','offer_follow_up','reservation_payment_follow_up',
                       'financing_follow_up'];
    WHEN 'transfer_completed' THEN v_all := true;
    WHEN 'client_closed_won'  THEN v_all := true;
    WHEN 'client_lost'        THEN v_all := true;
    ELSE
      RETURN 0;  -- unknown event → no-op (idempotent/safe)
  END CASE;

  UPDATE records r
  SET data = (r.data - 'whatsapp_state')   -- clear Phase A conversation state on cancel
    || jsonb_build_object(
         'followup_status',          'cancelled',
         'cancel_reason',            'superseded_by_' || p_event_type,
         'cancelled_at',             to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         'cancelled_by_event_type',  p_event_type,
         'cancelled_by_event_id',    COALESCE(p_event_id::text, ''),
         'cancelled_by_system',      true)
  WHERE r.model_id = v_model_id
    AND r.data->>'client_id' = p_client_id::text
    AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open','in_progress')
    AND (
      v_all
      OR (jsonb_typeof(r.data->'followup_type') = 'array'  AND r.data->'followup_type' ?| v_types)
      OR (jsonb_typeof(r.data->'followup_type') = 'string' AND (r.data->>'followup_type') = ANY(v_types))
    );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.reconcile_superseded_followups(uuid, text, uuid) IS
  'Phase B: cancel a client''s open follow-ups superseded by a stronger lifecycle event. Idempotent. Mirrors src/lib/salesProcess/supersede.ts.';

-- 2. The dispatch trigger ----------------------------------------------------
-- One AFTER trigger on records; resolves the model, decides the event, and
-- calls the reconciler. No-ops on non-event models (incl. followups writes)
-- so cancelling follow-ups can't recurse. Terminal client detection keys off a
-- client_stage TRANSITION so the touch-trigger's data=data re-write can't re-fire it.

CREATE OR REPLACE FUNCTION public.tg_records_supersede_followups()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name    text;
  v_event   text;
  v_client  uuid;
  v_terminal text[] := ARRAY['مغلق ناجح','خاسر','غير مؤهل'];
BEGIN
  SELECT name INTO v_name FROM models WHERE id = NEW.model_id;
  IF v_name IS NULL THEN RETURN NEW; END IF;

  IF v_name = 'appointments' THEN
    IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
    v_event := 'appointment_created';
    v_client := NULLIF(NEW.data->>'client_id','')::uuid;

  ELSIF v_name = 'visits' THEN
    IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
    v_event := 'visit_created';
    v_client := NULLIF(NEW.data->>'client_id','')::uuid;

  ELSIF v_name = 'offer_prices' THEN
    IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
    v_event := 'offer_created';
    v_client := NULLIF(NEW.data->>'client_id','')::uuid;

  ELSIF v_name = 'reservations' THEN
    IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;
    v_event := 'reservation_created';
    v_client := NULLIF(NEW.data->>'client_id','')::uuid;

  ELSIF v_name = 'financing' THEN
    IF TG_OP = 'INSERT' THEN
      -- fire on start
      NULL;
    ELSIF TG_OP = 'UPDATE' AND (OLD.data->>'financing_status') IS DISTINCT FROM (NEW.data->>'financing_status') THEN
      -- fire on status advance
      NULL;
    ELSE
      RETURN NEW;
    END IF;
    IF NEW.data->>'financing_status' = 'completed' THEN
      v_event := 'transfer_started';   -- financing done → transfer tier (cancel financing_follow_up too)
    ELSE
      v_event := 'financing_advanced';
    END IF;
    v_client := NULLIF(NEW.data->>'client_id','')::uuid;

  ELSIF v_name = 'ownership_transfer' THEN
    IF TG_OP = 'INSERT' THEN
      v_event := 'transfer_started';
      v_client := NULLIF(NEW.data->>'client_id','')::uuid;
    ELSIF TG_OP = 'UPDATE'
          AND (OLD.data->>'transfer_status') IS DISTINCT FROM (NEW.data->>'transfer_status')
          AND NEW.data->>'transfer_status' = 'completed' THEN
      v_event := 'transfer_completed';   -- cancel ALL open
      v_client := NULLIF(NEW.data->>'client_id','')::uuid;
    ELSE
      RETURN NEW;
    END IF;

  ELSIF v_name = 'clients' THEN
    IF TG_OP = 'UPDATE'
       AND (NEW.data->>'client_stage') = ANY(v_terminal)
       AND (OLD.data->>'client_stage') IS DISTINCT FROM (NEW.data->>'client_stage') THEN
      v_event := CASE WHEN NEW.data->>'client_stage' = 'مغلق ناجح' THEN 'client_closed_won' ELSE 'client_lost' END;
      v_client := NEW.id;
    ELSE
      RETURN NEW;
    END IF;

  ELSE
    RETURN NEW;  -- not a lifecycle model
  END IF;

  IF v_client IS NOT NULL THEN
    PERFORM public.reconcile_superseded_followups(v_client, v_event, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS records_supersede_followups ON public.records;
CREATE TRIGGER records_supersede_followups
  AFTER INSERT OR UPDATE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.tg_records_supersede_followups();

-- 3. Audit metadata fields on the followups model schema --------------------
-- Read-only, system-managed. followups is unfrozen (JSONB) so this is a pure
-- schema-JSONB edit; the models_view_sync trigger regenerates v_followups.
-- Follow-up Result section id = adb3a7a4-d266-49cc-8d0b-8a01ced8375c (index 2).

UPDATE public.models
SET schema = jsonb_set(
  schema, '{sections,2,fields}',
  (schema->'sections'->2->'fields') || jsonb_build_array(
    jsonb_build_object('id',gen_random_uuid()::text,'name','cancel_reason','label_ar','سبب الإلغاء','label_en','Cancel reason','type','text','required',false,'order',90,'section_id','adb3a7a4-d266-49cc-8d0b-8a01ced8375c','width','half','read_only',true,'show_in_table',false),
    jsonb_build_object('id',gen_random_uuid()::text,'name','cancelled_at','label_ar','تاريخ الإلغاء','label_en','Cancelled at','type','datetime','required',false,'order',91,'section_id','adb3a7a4-d266-49cc-8d0b-8a01ced8375c','width','half','read_only',true,'show_in_table',false),
    jsonb_build_object('id',gen_random_uuid()::text,'name','cancelled_by_event_type','label_ar','نوع الحدث المُلغِي','label_en','Cancelled by event','type','text','required',false,'order',92,'section_id','adb3a7a4-d266-49cc-8d0b-8a01ced8375c','width','half','read_only',true,'show_in_table',false),
    jsonb_build_object('id',gen_random_uuid()::text,'name','cancelled_by_event_id','label_ar','معرّف الحدث المُلغِي','label_en','Cancelled by event id','type','text','required',false,'order',93,'section_id','adb3a7a4-d266-49cc-8d0b-8a01ced8375c','width','half','read_only',true,'show_in_table',false),
    jsonb_build_object('id',gen_random_uuid()::text,'name','cancelled_by_system','label_ar','ألغي آلياً','label_en','Cancelled by system','type','checkbox','required',false,'order',94,'section_id','adb3a7a4-d266-49cc-8d0b-8a01ced8375c','width','half','read_only',true,'show_in_table',false)
  ))
WHERE name = 'followups'
  -- idempotent: only add if not already present
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(schema->'sections'->2->'fields') f WHERE f->>'name' = 'cancel_reason'
  );
