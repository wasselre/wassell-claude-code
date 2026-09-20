-- «طلب غير مجاب» — WORKFLOW CONVERGENCE (migration 3 of 3)
--
-- ONE convergence point. Both entry points create ONLY the request record; a
-- workflow on the request's CREATE does everything else. That removes the
-- second automation path (a UI surface moving the client itself) and guarantees
-- the follow-up outcome and the Options-page button produce identical state.
--
--   Follow-up outcome  ──┐
--                        ├──▶ create unanswered_request ──▶ [A] move client
--   Options-page modal ──┘                                      + open first search task
--
--   [B] search task completed ──▶ still_searching → next task +7d
--                                 found          → close request, resume sales
--                                 client_dropped → close request, disqualify
--
-- Depth budget: follow-up update (d0) → create request (d1) → move client +
-- create task (d2). MAX_DEPTH is 3 (src/lib/workflowEngine.ts). A future
-- workflow triggering on the client stage change would be d3 and hit the cap.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Remove the broken branch on the booking-call workflow
-- ---------------------------------------------------------------------------
-- Branch d50958d7 fired on this outcome and was wrong twice over: it wrote the
-- raw English slug 'unanswered_request' into client_status (which stores Arabic
-- strings and had no such option — it would have rendered raw and been invisible
-- to every filter), and it created a WhatsApp escalation task cloned from a
-- no-answer branch, label and escalation_reason included. It never fired: no rep
-- could select the outcome. Request creation now belongs to workflow 28dae81e
-- alone — leaving both would create TWO requests per outcome.
UPDATE public.workflows
SET branches = (
      SELECT COALESCE(jsonb_agg(b ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(branches) WITH ORDINALITY AS t(b, ord)
      WHERE b->>'id' <> 'd50958d7-fb4f-492d-8218-b0efa2780368'),
    updated_at = now()
WHERE id = 'd997425a-0c8d-48c4-afef-b5792792cfae';

-- ---------------------------------------------------------------------------
-- 2. Fix the request-creating workflow
-- ---------------------------------------------------------------------------
-- Was: no only_on_change (so every later edit of the same completed follow-up
-- created ANOTHER request), request_status written as an empty string, and the
-- rep's notes — the actual description of what the client wants — dropped.
UPDATE public.workflows
SET branches = jsonb_build_array(jsonb_build_object(
      'id', 'e718ea74-10b3-4026-95d6-0fd3b6ab2547',
      'label_ar', 'فتح طلب غير مجاب', 'label_en', 'Open Unanswered Request',
      'condition_mode', 'all',
      'conditions', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'field_id', 'call_result',
          'operator', 'equals', 'value', 'unanswered_request', 'only_on_change', true),
        jsonb_build_object('id', gen_random_uuid()::text, 'field_id', 'actual_datetime',
          'operator', 'is_not_empty', 'value', '')),
      'actions', jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid()::text, 'type', 'create_record',
        'target_model_id', 'da920a2c-43c2-4b82-9c39-ac36c4602e51',
        'skip_if_exists', false,
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field',
            'trigger_field_id', 'client_id', 'static_value', '', 'target_field_id', 'client_id'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static',
            'trigger_field_id', '', 'static_value', 'received', 'target_field_id', 'request_status'),
          -- The rep's own words about what the client asked for. This is the
          -- whole content of the search file; dropping it made the request blank.
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field',
            'trigger_field_id', 'outcome_notes', 'static_value', '', 'target_field_id', 'request_notes'),
          -- Seed the sourcing owner with the rep who took the call, so the
          -- request is never ownerless. A sourcing lead can reassign it; the
          -- client's own relationship owner (client_owner) is untouched.
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field',
            'trigger_field_id', 'sales_rep', 'static_value', '', 'target_field_id', 'assigned_to')))))),
    updated_at = now()
WHERE id = '28dae81e-4aa2-4d2c-b71e-e1c1052d1c2d';

-- ---------------------------------------------------------------------------
-- 3. [A] Request created → park the client + open the first search task
-- ---------------------------------------------------------------------------
INSERT INTO public.workflows (id, label_ar, label_en, trigger_model_id, trigger_event, is_active, group_id, conditions, actions, branches)
VALUES (
  '5a1e7a50-0000-4000-8000-0000000000aa',
  'فتح بحث لطلب غير مجاب', 'Open Search for Unanswered Request',
  'da920a2c-43c2-4b82-9c39-ac36c4602e51', 'create', true,
  (SELECT group_id FROM public.workflows WHERE id = 'd997425a-0c8d-48c4-afef-b5792792cfae'),
  '[]'::jsonb, '[]'::jsonb,
  jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid()::text,
    'label_ar', 'تحويل العميل إلى وضع البحث', 'label_en', 'Move client into searching',
    'condition_mode', 'all',
    'conditions', '[]'::jsonb,
    'actions', jsonb_build_array(
      -- (a) park the client
      jsonb_build_object(
        'id', gen_random_uuid()::text, 'type', 'update_record',
        'target_model_id', '2e86f197-385f-4853-908f-b4cb7237f7d8',
        'filter_field_id', 'id', 'filter_value', '',
        'filter_value_source', 'trigger_field', 'filter_trigger_field_id', 'client_id',
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static',
            'trigger_field_id', '', 'static_value', 'طلب غير مجاب', 'target_field_id', 'client_stage'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static',
            'trigger_field_id', '', 'static_value', 'يتم البحث', 'target_field_id', 'client_status'))),
      -- (b) open the first search task, due in 7 days
      jsonb_build_object(
        'id', gen_random_uuid()::text, 'type', 'create_record',
        'target_model_id', '5a1e7a50-0000-4000-8000-000000000001',
        'skip_if_exists', false,
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static',
            'trigger_field_id', '', 'static_value', 'تحديث حالة البحث', 'target_field_id', 'title'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static',
            'trigger_field_id', '', 'static_value', 'search_update', 'target_field_id', 'task_kind'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static',
            'trigger_field_id', '', 'static_value', 'open', 'target_field_id', 'task_status'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'date_expression',
            'date_base', 'current_date', 'date_expression', '+7d',
            'trigger_field_id', '', 'static_value', '', 'target_field_id', 'due_date'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field',
            'trigger_field_id', 'client_id', 'static_value', '', 'target_field_id', 'client_id'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'record_id',
            'trigger_field_id', '', 'static_value', '', 'target_field_id', 'request_id'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field',
            'trigger_field_id', 'assigned_to', 'static_value', '', 'target_field_id', 'assignee'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static',
            'trigger_field_id', '', 'static_value', 'unanswered_request_open', 'target_field_id', 'creation_source')))))))
ON CONFLICT (id) DO UPDATE
  SET branches = EXCLUDED.branches, is_active = true, updated_at = now();

-- ---------------------------------------------------------------------------
-- 4. [B] Search task completed → what the result actually DOES
-- ---------------------------------------------------------------------------
-- Ending recurrence is not the same as resolving the client. `found` and
-- `client_dropped` both close the request AND move the client out of
-- «طلب غير مجاب» — neither may leave a client parked forever.
INSERT INTO public.workflows (id, label_ar, label_en, trigger_model_id, trigger_event, is_active, group_id, conditions, actions, branches)
VALUES (
  '5a1e7a50-0000-4000-8000-0000000000bb',
  'إكمال مهمة البحث', 'Search Task Completed',
  '5a1e7a50-0000-4000-8000-000000000001', 'update', true,
  (SELECT group_id FROM public.workflows WHERE id = 'd997425a-0c8d-48c4-afef-b5792792cfae'),
  '[]'::jsonb, '[]'::jsonb,
  jsonb_build_array(
    -- Branch 1 — still searching: open the next checkpoint, +7d from completion.
    jsonb_build_object(
      'id', gen_random_uuid()::text,
      'label_ar', 'ما زلنا نبحث', 'label_en', 'Still Searching',
      'condition_mode', 'all',
      'conditions', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'field_id', 'task_kind', 'operator', 'equals', 'value', 'search_update'),
        jsonb_build_object('id', gen_random_uuid()::text, 'field_id', 'task_status', 'operator', 'equals', 'value', 'completed', 'only_on_change', true),
        jsonb_build_object('id', gen_random_uuid()::text, 'field_id', 'task_result', 'operator', 'equals', 'value', 'still_searching')),
      'actions', jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid()::text, 'type', 'create_record',
        'target_model_id', '5a1e7a50-0000-4000-8000-000000000001',
        'skip_if_exists', false,
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'trigger_field_id', '', 'static_value', 'تحديث حالة البحث', 'target_field_id', 'title'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'trigger_field_id', '', 'static_value', 'search_update', 'target_field_id', 'task_kind'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'trigger_field_id', '', 'static_value', 'open', 'target_field_id', 'task_status'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'date_expression', 'date_base', 'current_date', 'date_expression', '+7d', 'trigger_field_id', '', 'static_value', '', 'target_field_id', 'due_date'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field', 'trigger_field_id', 'client_id', 'static_value', '', 'target_field_id', 'client_id'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field', 'trigger_field_id', 'request_id', 'static_value', '', 'target_field_id', 'request_id'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field', 'trigger_field_id', 'assignee', 'static_value', '', 'target_field_id', 'assignee'),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'trigger_field_id', '', 'static_value', 'search_recurrence', 'target_field_id', 'creation_source'))))),

    -- Branch 2 — found: close the request, return the client to ordinary sales
    -- work, and create the follow-up that actually tells them.
    jsonb_build_object(
      'id', gen_random_uuid()::text,
      'label_ar', 'وجدنا خياراً', 'label_en', 'Option Found',
      'condition_mode', 'all',
      'conditions', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'field_id', 'task_kind', 'operator', 'equals', 'value', 'search_update'),
        jsonb_build_object('id', gen_random_uuid()::text, 'field_id', 'task_status', 'operator', 'equals', 'value', 'completed', 'only_on_change', true),
        jsonb_build_object('id', gen_random_uuid()::text, 'field_id', 'task_result', 'operator', 'equals', 'value', 'found')),
      'actions', jsonb_build_array(
        jsonb_build_object(
          'id', gen_random_uuid()::text, 'type', 'update_record',
          'target_model_id', 'da920a2c-43c2-4b82-9c39-ac36c4602e51',
          'filter_field_id', 'id', 'filter_value', '',
          'filter_value_source', 'trigger_field', 'filter_trigger_field_id', 'request_id',
          'field_mappings', jsonb_build_array(
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'trigger_field_id', '', 'static_value', 'fulfilled', 'target_field_id', 'request_status'),
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'date_expression', 'date_base', 'current_date', 'date_expression', '+0d', 'trigger_field_id', '', 'static_value', '', 'target_field_id', 'closed_at'),
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field', 'trigger_field_id', 'found_option', 'static_value', '', 'target_field_id', 'found_option'))),
        jsonb_build_object(
          'id', gen_random_uuid()::text, 'type', 'update_record',
          'target_model_id', '2e86f197-385f-4853-908f-b4cb7237f7d8',
          'filter_field_id', 'id', 'filter_value', '',
          'filter_value_source', 'trigger_field', 'filter_trigger_field_id', 'client_id',
          'field_mappings', jsonb_build_array(
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'trigger_field_id', '', 'static_value', 'الاتصال لحجز موعد', 'target_field_id', 'client_stage'),
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'trigger_field_id', '', 'static_value', 'مهتم', 'target_field_id', 'client_status'))),
        jsonb_build_object(
          'id', gen_random_uuid()::text, 'type', 'create_record',
          'target_model_id', '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63',
          'skip_if_exists', false,
          'field_mappings', jsonb_build_array(
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field', 'trigger_field_id', 'client_id', 'static_value', '', 'target_field_id', 'client_id'),
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'trigger_field_id', '', 'static_value', jsonb_build_array('whatsapp_follow_up'), 'target_field_id', 'followup_type'),
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'trigger_field_id', '', 'static_value', 'open', 'target_field_id', 'followup_status'),
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'date_expression', 'date_base', 'current_date', 'date_expression', '+0d', 'trigger_field_id', '', 'static_value', '', 'target_field_id', 'scheduled_datetime'),
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'trigger_field', 'trigger_field_id', 'assignee', 'static_value', '', 'target_field_id', 'sales_rep'))))),

    -- Branch 3 — client dropped: close the request and disqualify. Without this
    -- the client would sit at «طلب غير مجاب» forever with no task and no owner.
    jsonb_build_object(
      'id', gen_random_uuid()::text,
      'label_ar', 'انسحب العميل', 'label_en', 'Client Dropped',
      'condition_mode', 'all',
      'conditions', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'field_id', 'task_kind', 'operator', 'equals', 'value', 'search_update'),
        jsonb_build_object('id', gen_random_uuid()::text, 'field_id', 'task_status', 'operator', 'equals', 'value', 'completed', 'only_on_change', true),
        jsonb_build_object('id', gen_random_uuid()::text, 'field_id', 'task_result', 'operator', 'equals', 'value', 'client_dropped')),
      'actions', jsonb_build_array(
        jsonb_build_object(
          'id', gen_random_uuid()::text, 'type', 'update_record',
          'target_model_id', 'da920a2c-43c2-4b82-9c39-ac36c4602e51',
          'filter_field_id', 'id', 'filter_value', '',
          'filter_value_source', 'trigger_field', 'filter_trigger_field_id', 'request_id',
          'field_mappings', jsonb_build_array(
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'trigger_field_id', '', 'static_value', 'client_dropped', 'target_field_id', 'request_status'),
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'date_expression', 'date_base', 'current_date', 'date_expression', '+0d', 'trigger_field_id', '', 'static_value', '', 'target_field_id', 'closed_at'))),
        jsonb_build_object(
          'id', gen_random_uuid()::text, 'type', 'update_record',
          'target_model_id', '2e86f197-385f-4853-908f-b4cb7237f7d8',
          'filter_field_id', 'id', 'filter_value', '',
          'filter_value_source', 'trigger_field', 'filter_trigger_field_id', 'client_id',
          'field_mappings', jsonb_build_array(
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'trigger_field_id', '', 'static_value', 'غير مؤهل', 'target_field_id', 'client_stage'),
            jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'trigger_field_id', '', 'static_value', 'غير مهتم', 'target_field_id', 'client_status')))))))
ON CONFLICT (id) DO UPDATE
  SET branches = EXCLUDED.branches, is_active = true, updated_at = now();

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  n int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.workflows w, jsonb_array_elements(w.branches) b
             WHERE w.id = 'd997425a-0c8d-48c4-afef-b5792792cfae' AND b->>'id' = 'd50958d7-fb4f-492d-8218-b0efa2780368') THEN
    RAISE EXCEPTION 'the broken unanswered_request branch is still on the booking-call workflow';
  END IF;

  -- Exactly ONE workflow may create a request on this outcome, or every rep
  -- action produces two search files.
  SELECT count(*) INTO n
  FROM public.workflows w, jsonb_array_elements(w.branches) b, jsonb_array_elements(b->'actions') a
  WHERE w.is_active AND a->>'type' = 'create_record'
    AND a->>'target_model_id' = 'da920a2c-43c2-4b82-9c39-ac36c4602e51';
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 active request-creating action, found %', n; END IF;

  SELECT count(*) INTO n FROM public.workflows
  WHERE id IN ('5a1e7a50-0000-4000-8000-0000000000aa', '5a1e7a50-0000-4000-8000-0000000000bb') AND is_active;
  IF n <> 2 THEN RAISE EXCEPTION 'expected both new workflows active, got %', n; END IF;

  SELECT count(*) INTO n FROM public.workflows w, jsonb_array_elements(w.branches) b
  WHERE w.id = '5a1e7a50-0000-4000-8000-0000000000bb';
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 result branches on the completion workflow, got %', n; END IF;
END
$do$;

COMMIT;
