-- Rename the clients "Client Owner" (مالك العميل) field to "Sales Consultant"
-- (مستشار المبيعات) and make it AUTO-maintained: it always reflects the
-- sales_rep of the client's most-recently-created follow-up — even if that
-- follow-up is only assigned and not yet completed.
--
-- The clients model is UNFROZEN (JSONB in `records`), so no DDL on a typed
-- table is needed. The value is computed inside recalc_client_derived_data(),
-- whose JSONB patch is merged into the client row by the existing
-- BEFORE INSERT/UPDATE trigger (tg_records_fill_client_next_action) and is
-- re-driven on every follow-up change via _touch_client → the client UPDATE.
--
-- The field is also flagged read_only so the record form renders it disabled
-- (permissions.isComputedField honors read_only) — a manual edit would be
-- clobbered on the next recompute, so it's not offered.

BEGIN;

-- 1. Recompute function: add the auto sales-consultant (client_owner).
--    Identical to the live definition plus the v_owner block + the conditional
--    'client_owner' key. The key is included ONLY when some follow-up of the
--    client carries a sales_rep — so a client with no assigned follow-ups keeps
--    whatever owner it already had (never blanked).
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

  -- Sales consultant (client_owner): the assigned sales_rep of the client's
  -- most-recently-created follow-up that actually has a rep. Counts assigned
  -- follow-ups regardless of completion ("even if just assigned"). Handles the
  -- scalar (live shape) and array assignee encodings.
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

-- 2. Update the clients model JSONB schema: rename the field label to
--    "Sales Consultant" / "مستشار المبيعات" and mark it read_only (auto-managed).
--    Slug stays `client_owner` so existing references keep resolving.
UPDATE public.models m
SET schema = jsonb_set(
  m.schema,
  '{sections}',
  (
    SELECT jsonb_agg(
      CASE WHEN sec ? 'fields' THEN
        jsonb_set(sec, '{fields}', (
          SELECT jsonb_agg(
            CASE WHEN fld->>'name' = 'client_owner'
              THEN fld || jsonb_build_object(
                'label_ar', 'مستشار المبيعات',
                'label_en', 'Sales Consultant',
                'read_only', true
              )
              ELSE fld END
          )
          FROM jsonb_array_elements(sec->'fields') fld
        ))
      ELSE sec END
    )
    FROM jsonb_array_elements(m.schema->'sections') sec
  )
)
WHERE m.name = 'clients';

-- 3. Backfill: recompute every existing client whose auto sales-consultant
--    (or any other derived field) would change. The BEFORE-fill trigger applies
--    the patch; the WHERE gate avoids touching rows that wouldn't change.
UPDATE public.records r
SET data = data
WHERE r.model_id = public._sales_clients_model_id()
  AND (r.data || public.recalc_client_derived_data(r.id, r.data->>'client_stage')) IS DISTINCT FROM r.data;

COMMIT;
