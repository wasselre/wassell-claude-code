-- The client's stage and status follow the milestone RECORDS, whoever saves
-- them (operator, 2026-10-08: "the client stage and status should be automatic
-- based on the actions and records and results").
--
-- Why: the stage/status moves for appointments, visits, offers, reservations,
-- financing and ownership transfer live in workflows that only fire when the
-- record is saved IN A BROWSER (appointments / visits / offers… are not enrolled
-- in the server workflow runner). When the AI books a visit, records a visit
-- the customer mentions, or any server process saves one, nothing moved:
-- measured 2026-10-08 — Ibrahim and Razane (visits booked by the AI) still at
-- «الاتصال لحجز موعد», Saud and Lolo (visits the AI recorded) the same.
--
-- Results (follow-up outcomes) already move the client on every path: the
-- followups model IS enrolled in the server runner, so a result recorded by a
-- person, by the chat outcome reader or by outcomeAutoApply fires the same
-- workflows. This trigger covers the other half — the records.
--
-- The rule is the SAME table the workflows encode (docs/prd/workflows/*):
--   appointment booked              → موعد زيارة   / تم حجز موعد
--   appointment confirmed           → موعد زيارة   / تم تأكيد الحضور
--   appointment rescheduled         → موعد زيارة   / تمت إعادة الجدولة
--   appointment cancelled           →  (stage kept) / تم إلغاء الموعد
--   appointment no-show             →  (stage kept) / لم يحضر الموعد
--   visit recorded                  → زيارة        /  (status kept)
--   offer created                   → عرض سعر      / تم إرسال عرض السعر
--   reservation created             → تمويل        / تم الحجز
--   financing → bank / valuation    →  (stage kept) / البنك / التقييم
--   financing → completed           → الإفراغ      / تم الحجز
--   ownership transfer → completed  → مغلق ناجح    / تم الإفراغ
-- Guards:
--   * The stage only moves FORWARD on the ladder (جديد … مغلق ناجح). A client
--     out of the ladder (غير مؤهل / خاسر / يريد إيجار / طلب غير مجاب / empty) is
--     pulled back in by a new milestone — exactly what the workflows do.
--   * A status-only event (cancelled / no-show / bank / valuation) never touches
--     a client who is past that point on the ladder or out of it.
--   * Idempotent: writes only when the value changes, so the browser workflow
--     writing the same values afterwards is a no-op diff.
--   * Never fails the milestone save: a failure is RAISE WARNING'd (the
--     appointment / visit itself must persist), the same posture as the other
--     records side-effect triggers.
-- Workflow tasks (calls, messages) are untouched — this moves stage and status only.

CREATE OR REPLACE FUNCTION public._client_stage_rank(p_stage text)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_stage
    WHEN 'جديد' THEN 0
    WHEN 'الاتصال لحجز موعد' THEN 1
    WHEN 'موعد زيارة' THEN 2
    WHEN 'زيارة' THEN 3
    WHEN 'متابعة بعد الزيارة' THEN 4
    WHEN 'عرض سعر' THEN 5
    WHEN 'حجز' THEN 6
    WHEN 'تمويل' THEN 7
    WHEN 'الإفراغ' THEN 8
    WHEN 'مغلق ناجح' THEN 9
    ELSE -1   -- out of the ladder: غير مؤهل / خاسر / يريد إيجار / طلب غير مجاب / empty
  END
$$;

-- Apply one milestone to one client.
--   p_stage     the stage the milestone implies (NULL = status-only event)
--   p_status    the status it implies (NULL = keep)
--   p_home_rank for a status-only event: the ladder rank it belongs to; it is
--               applied only while the client is on the ladder at or before it.
-- Returns true when the client was changed.
CREATE OR REPLACE FUNCTION public._client_apply_milestone(p_client uuid, p_stage text, p_status text, p_home_rank int DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cur   text;
  v_rank  int;
  v_patch jsonb := '{}'::jsonb;
  v_n     int;
BEGIN
  IF p_client IS NULL THEN RETURN false; END IF;
  SELECT data->>'client_stage' INTO v_cur
    FROM public.records WHERE id = p_client AND model_id = public._sales_clients_model_id();
  IF NOT FOUND THEN RETURN false; END IF;
  v_rank := public._client_stage_rank(v_cur);

  IF p_stage IS NOT NULL THEN
    IF public._client_stage_rank(p_stage) < v_rank THEN RETURN false; END IF;   -- never backwards
    IF v_cur IS DISTINCT FROM p_stage THEN v_patch := v_patch || jsonb_build_object('client_stage', p_stage); END IF;
  ELSE
    -- Status-only: only on the ladder, at or before the event's own point.
    IF v_rank < 0 OR v_rank > COALESCE(p_home_rank, 9) THEN RETURN false; END IF;
  END IF;
  IF p_status IS NOT NULL THEN v_patch := v_patch || jsonb_build_object('client_status', p_status); END IF;
  IF v_patch = '{}'::jsonb THEN RETURN false; END IF;

  UPDATE public.records
     SET data = data || v_patch
   WHERE id = p_client AND model_id = public._sales_clients_model_id()
     AND (data || v_patch) IS DISTINCT FROM data;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_records_client_stage_from_milestone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_name   text;
  v_client uuid;
  v_new    text;
  v_old    text;
BEGIN
  SELECT name INTO v_name FROM public.models WHERE id = NEW.model_id
     AND name IN ('appointments', 'visits', 'offer_prices', 'reservations', 'financing', 'ownership_transfer');
  IF v_name IS NULL THEN RETURN NEW; END IF;

  BEGIN
    v_client := NULLIF(NEW.data->>'client_id', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE WARNING 'client stage from milestone: % % has a client_id that is not a uuid (%)', v_name, NEW.id, NEW.data->>'client_id';
    RETURN NEW;
  END;
  IF v_client IS NULL THEN RETURN NEW; END IF;

  BEGIN
    IF v_name = 'appointments' THEN
      v_new := COALESCE(NULLIF(NEW.data->>'appointment_status', ''), 'scheduled');
      IF TG_OP = 'UPDATE' THEN
        v_old := COALESCE(NULLIF(OLD.data->>'appointment_status', ''), 'scheduled');
        IF v_old = v_new THEN RETURN NEW; END IF;
      ELSIF v_new NOT IN ('scheduled', 'confirmed') THEN
        RETURN NEW;   -- an appointment saved already closed (import / history): no move
      END IF;
      IF v_new = 'scheduled' THEN PERFORM public._client_apply_milestone(v_client, 'موعد زيارة', 'تم حجز موعد');
      ELSIF v_new = 'confirmed' THEN PERFORM public._client_apply_milestone(v_client, 'موعد زيارة', 'تم تأكيد الحضور');
      ELSIF v_new = 'rescheduled' THEN PERFORM public._client_apply_milestone(v_client, 'موعد زيارة', 'تمت إعادة الجدولة');
      ELSIF v_new = 'cancelled' THEN PERFORM public._client_apply_milestone(v_client, NULL, 'تم إلغاء الموعد', 2);
      ELSIF v_new = 'no_show' THEN PERFORM public._client_apply_milestone(v_client, NULL, 'لم يحضر الموعد', 2);
      END IF;   -- 'completed' = the visit trigger closed it; the visit itself moved the client

    ELSIF v_name = 'visits' THEN
      IF TG_OP = 'INSERT' THEN PERFORM public._client_apply_milestone(v_client, 'زيارة', NULL); END IF;

    ELSIF v_name = 'offer_prices' THEN
      IF TG_OP = 'INSERT' THEN PERFORM public._client_apply_milestone(v_client, 'عرض سعر', 'تم إرسال عرض السعر'); END IF;

    ELSIF v_name = 'reservations' THEN
      IF TG_OP = 'INSERT' THEN PERFORM public._client_apply_milestone(v_client, 'تمويل', 'تم الحجز'); END IF;

    ELSIF v_name = 'financing' THEN
      v_new := NEW.data->>'financing_status';
      v_old := CASE WHEN TG_OP = 'UPDATE' THEN OLD.data->>'financing_status' END;
      IF v_new IS NOT DISTINCT FROM v_old THEN RETURN NEW; END IF;
      IF v_new = 'bank_submitted' THEN PERFORM public._client_apply_milestone(v_client, NULL, 'البنك', 7);
      ELSIF v_new = 'valuation' THEN PERFORM public._client_apply_milestone(v_client, NULL, 'التقييم', 7);
      ELSIF v_new = 'completed' THEN PERFORM public._client_apply_milestone(v_client, 'الإفراغ', 'تم الحجز');
      END IF;

    ELSIF v_name = 'ownership_transfer' THEN
      v_new := NEW.data->>'transfer_status';
      v_old := CASE WHEN TG_OP = 'UPDATE' THEN OLD.data->>'transfer_status' END;
      IF v_new = 'completed' AND v_old IS DISTINCT FROM 'completed' THEN
        PERFORM public._client_apply_milestone(v_client, 'مغلق ناجح', 'تم الإفراغ');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- The milestone record itself must persist; a failed client move is logged
    -- loudly (Postgres log) and the workflow / a person can still move it.
    RAISE WARNING 'client stage from milestone failed for % % (client %): % %', v_name, NEW.id, v_client, SQLSTATE, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS records_client_stage_from_milestone ON public.records;
CREATE TRIGGER records_client_stage_from_milestone
  AFTER INSERT OR UPDATE OF data ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.tg_records_client_stage_from_milestone();

-- One-time catch-up: the milestones saved by the server (the AI) in the last
-- 30 days that never moved their client. Open appointments still ahead, and
-- every recorded visit — oldest first, through the same rule (forward-only).
DO $backfill$
DECLARE r record; v_moved int := 0;
BEGIN
  FOR r IN
    SELECT (data->>'client_id')::uuid AS cid, 'appointment' AS kind, data->>'appointment_status' AS st, created_at
      FROM public.records
     WHERE model_id = (SELECT id FROM public.models WHERE name = 'appointments')
       AND created_by_user_id IS NULL AND created_at > now() - interval '30 days'
       AND COALESCE(NULLIF(data->>'appointment_status', ''), 'scheduled') IN ('scheduled', 'confirmed')
       AND public.try_timestamptz(data->>'appointment_date') >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh'
       AND (data->>'client_id') ~ '^[0-9a-f-]{36}$'
    UNION ALL
    SELECT (data->>'client_id')::uuid, 'visit', NULL, created_at
      FROM public.records
     WHERE model_id = (SELECT id FROM public.models WHERE name = 'visits')
       AND created_by_user_id IS NULL AND created_at > now() - interval '30 days'
       AND (data->>'client_id') ~ '^[0-9a-f-]{36}$'
    ORDER BY created_at
  LOOP
    IF r.kind = 'visit' THEN
      IF public._client_apply_milestone(r.cid, 'زيارة', NULL) THEN v_moved := v_moved + 1; END IF;
    ELSIF r.st = 'confirmed' THEN
      IF public._client_apply_milestone(r.cid, 'موعد زيارة', 'تم تأكيد الحضور') THEN v_moved := v_moved + 1; END IF;
    ELSE
      IF public._client_apply_milestone(r.cid, 'موعد زيارة', 'تم حجز موعد') THEN v_moved := v_moved + 1; END IF;
    END IF;
  END LOOP;
  RAISE NOTICE 'client stage catch-up: % client(s) moved', v_moved;
END $backfill$;
