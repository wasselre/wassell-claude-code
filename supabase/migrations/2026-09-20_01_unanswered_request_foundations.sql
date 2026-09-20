-- «طلب غير مجاب / Unanswered Request» — FOUNDATIONS (migration 1 of 2)
--
-- Schema + data only. No workflow rewiring here (that is migration 2), so this
-- file is safe to apply ahead of the code deploy: it only ADDS options, fields,
-- a model, and permissions. Nothing reads them until migration 2 + the code ship.
--
-- Contents:
--   1. clients.client_stage  += «طلب غير مجاب»   (the parked stage)
--      clients.client_status += «يتم البحث»      (searching)
--   2. RESTORE 14 options a past re-seed dropped from clients (separate repair,
--      same two fields — see the block comment there).
--   3. Extend models_block_schema_shrink to count OPTIONS, not just fields —
--      the hole that let (2) happen in the first place.
--   4. NEW model `sales_tasks` — a general sales task that is NOT a follow-up.
--   5. `unanswered_requests` gains a "Search Management" section + two closing
--      request_status options.
--   6. Enroll `sales_tasks` + `unanswered_requests` in workflow_capture_models.
--      WITHOUT THIS the whole design is inert: tg_records_capture_workflow_event
--      fires only for enrolled models, so a workflow-created request would
--      trigger nothing (not server-side — not enrolled; not client-side — the
--      record arrives by realtime, not a browser saveRecord).
--   7. Grant the two models to every non-admin profile that already holds
--      `followups` view, mirroring the existing sales access surface. A model
--      absent from profiles.model_permissions is INVISIBLE to non-admins
--      (wassell_user_has_action returns false on a NULL match).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1 + 2. clients dropdown options (new + restored)
-- ---------------------------------------------------------------------------
-- Idempotent: each row is appended only when its `value` is absent. Order is
-- preserved via WITH ORDINALITY on both the sections and the fields arrays.
DO $do$
DECLARE
  r     record;
  v_opt jsonb;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- (1) the new parked stage + searching status
      ('client_stage',  'طلب غير مجاب',                'طلب غير مجاب',                'Unanswered Request',            '#8B5CF6'),
      ('client_status', 'يتم البحث',                   'يتم البحث',                   'Searching',                     '#8B5CF6'),
      -- (2) RESTORED — these are written by the sales-process config today but
      -- were missing from the live model, so they rendered as raw unmatched
      -- strings and were invisible to every option-keyed filter. 6 clients sit
      -- at «خاسر» and 8 at «إعادة تواصل لاحقًا» right now.
      ('client_stage',  'خاسر',                        'خاسر',                        'Lost',                          NULL),
      ('client_stage',  'مغلق ناجح',                   'مغلق ناجح',                   'Closed Won',                    NULL),
      ('client_status', 'رقم خاطئ',                    'رقم خاطئ',                    'Invalid Number',                NULL),
      ('client_status', 'مكرر',                        'مكرر',                        'Duplicate',                     NULL),
      ('client_status', 'تم رفض العرض',                'تم رفض العرض',                'Offer Rejected',                NULL),
      ('client_status', 'يحتاج معلومات تمويل',         'يحتاج معلومات تمويل',         'Needs Financing Info',          NULL),
      ('client_status', 'نقاش عائلي',                  'نقاش عائلي',                  'Family Discussion',             NULL),
      ('client_status', 'بانتظار القرار',              'بانتظار القرار',              'Waiting Decision',              NULL),
      ('client_status', 'تم إرسال واتساب',             'تم إرسال واتساب',             'WhatsApp Sent',                 NULL),
      ('client_status', 'إعادة تواصل لاحقًا',          'إعادة تواصل لاحقًا',          'Recontact Later',               NULL),
      ('client_status', 'بارد',                        'بارد',                        'Cold',                          NULL),
      ('client_status', 'بانتظار دفعة الحجز',          'بانتظار دفعة الحجز',          'Waiting Reservation Payment',   NULL),
      ('client_status', 'زار مشروعًا آخر — للمراجعة',  'زار مشروعًا آخر — للمراجعة',  'Visited Another Project — Review', NULL),
      ('client_status', 'تعذّر التواصل بعد الزيارة',   'تعذّر التواصل بعد الزيارة',   'Unreachable After Visit',       NULL)
    ) AS t(field_name, val, label_ar, label_en, color)
  LOOP
    v_opt := jsonb_build_object(
      'id',       gen_random_uuid()::text,
      'value',    r.val,
      'label_ar', r.label_ar,
      'label_en', r.label_en
    );
    IF r.color IS NOT NULL THEN
      v_opt := v_opt || jsonb_build_object('color', r.color);
    END IF;

    UPDATE public.models m
    SET schema = jsonb_set(m.schema, '{sections}', (
      SELECT jsonb_agg(
               CASE WHEN s ? 'fields' THEN jsonb_set(s, '{fields}', (
                 SELECT jsonb_agg(
                          CASE WHEN f->>'name' = r.field_name
                                 AND NOT (COALESCE(f->'options', '[]'::jsonb)
                                          @> jsonb_build_array(jsonb_build_object('value', r.val)))
                               THEN jsonb_set(f, '{options}',
                                      COALESCE(f->'options', '[]'::jsonb) || v_opt)
                               ELSE f END
                          ORDER BY fo)
                 FROM jsonb_array_elements(s->'fields') WITH ORDINALITY AS ff(f, fo)))
                    ELSE s END
               ORDER BY so)
      FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS ss(s, so)))
    WHERE m.name = 'clients';
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------------------
-- 3. Close the hole that dropped those 14 options
-- ---------------------------------------------------------------------------
-- The guard already refuses (a) a created_at rewrite — the seed-upsert
-- fingerprint — and (b) a FIELD-count shrink on a system model. It counts
-- fields. It never counted OPTIONS, so a browser write that silently dropped 12
-- dropdown options from an existing field passed clean. That is exactly what
-- happened to clients.client_status.
--
-- Same policy as the field rule and the same escape hatch: service_role (i.e. a
-- migration) is exempt, so deliberate option removal still goes through SQL.
CREATE OR REPLACE FUNCTION public.models_block_schema_shrink()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  jwt_role text;
  old_n int;
  new_n int;
BEGIN
  BEGIN
    jwt_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role';
  EXCEPTION WHEN OTHERS THEN
    jwt_role := NULL;
  END;
  IF jwt_role IS NULL OR jwt_role = 'service_role' THEN
    RETURN NEW;  -- trusted server-side writer
  END IF;

  -- Fingerprint 1: created_at rewrite = seed upsert. Applies to ALL models.
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'models_guard: refusing created_at rewrite on model "%" from a browser session — this is the seed-upsert fingerprint (stale bundle re-seeding). Reload the app to get the current version.',
      NEW.name
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(NEW.is_system, false) THEN
    -- Fingerprint 2: field-count shrink on a system model.
    SELECT count(*) INTO old_n
    FROM jsonb_array_elements(COALESCE(OLD.schema, '{}'::jsonb)->'sections') s,
         jsonb_array_elements(COALESCE(s->'fields', '[]'::jsonb)) f;
    SELECT count(*) INTO new_n
    FROM jsonb_array_elements(COALESCE(NEW.schema, '{}'::jsonb)->'sections') s,
         jsonb_array_elements(COALESCE(s->'fields', '[]'::jsonb)) f;
    IF new_n < old_n THEN
      RAISE EXCEPTION 'models_guard: refusing schema shrink on system model "%" (% -> % fields) from a browser session. Schema changes to system models go through migrations (service role).',
        NEW.name, old_n, new_n
        USING ERRCODE = 'P0001';
    END IF;

    -- Fingerprint 3 (2026-09-20): OPTION-count shrink on a system model. Total
    -- dropdown/multiselect options across every field. Catches the re-seed that
    -- kept the field and emptied its option list.
    SELECT count(*) INTO old_n
    FROM jsonb_array_elements(COALESCE(OLD.schema, '{}'::jsonb)->'sections') s,
         jsonb_array_elements(COALESCE(s->'fields', '[]'::jsonb)) f,
         jsonb_array_elements(COALESCE(f->'options', '[]'::jsonb)) o;
    SELECT count(*) INTO new_n
    FROM jsonb_array_elements(COALESCE(NEW.schema, '{}'::jsonb)->'sections') s,
         jsonb_array_elements(COALESCE(s->'fields', '[]'::jsonb)) f,
         jsonb_array_elements(COALESCE(f->'options', '[]'::jsonb)) o;
    IF new_n < old_n THEN
      RAISE EXCEPTION 'models_guard: refusing OPTION shrink on system model "%" (% -> % options) from a browser session. Removing a dropdown option on a system model goes through a migration (service role).',
        NEW.name, old_n, new_n
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- ---------------------------------------------------------------------------
-- 4. NEW MODEL: sales_tasks
-- ---------------------------------------------------------------------------
-- A general sales task that is NOT a follow-up. Follow-ups mean "contact the
-- client"; a search task means "go find the unit". v1 ships exactly one kind
-- (`search_update`) — the result vocabulary is per-kind, so a future general
-- task never has to answer "still searching?".
--
-- JSONB model (not a physical table) because the workflow engine can only
-- create_record into a models row, and workflow-created tasks are the point.
-- is_system = true, matching clients/followups/appointments: its schema changes
-- through migrations, and it inherits the guard above.
DO $do$
DECLARE
  v_model   uuid := '5a1e7a50-0000-4000-8000-000000000001';
  v_sec_a   uuid := gen_random_uuid();
  v_sec_b   uuid := gen_random_uuid();
  v_sec_c   uuid := gen_random_uuid();
  v_clients uuid := '2e86f197-385f-4853-908f-b4cb7237f7d8';
  v_reqs    uuid := 'da920a2c-43c2-4b82-9c39-ac36c4602e51';
  v_opts    uuid := 'e00d8df8-905c-4fb7-a117-3aefa6fd5603';
BEGIN
  IF EXISTS (SELECT 1 FROM public.models WHERE name = 'sales_tasks') THEN
    RETURN;  -- idempotent re-run
  END IF;

  INSERT INTO public.models (id, name, label_ar, label_en, icon, color, "order", is_system, group_id, card_config, schema)
  VALUES (
    v_model, 'sales_tasks', 'مهام المبيعات', 'Sales Tasks', 'list-checks', '#8E4E3A', 3, true,
    'ea355303-a1b2-4070-9e06-9be271a1bcc5',
    jsonb_build_object('title_field_id', NULL, 'shown_field_ids', '[]'::jsonb),
    jsonb_build_object(
      'section_selector_field_id', NULL,
      'sections', jsonb_build_array(
        -- Section A — the task itself
        jsonb_build_object(
          'id', v_sec_a::text, 'label_ar', 'المهمة', 'label_en', 'Task',
          'order', 0, 'is_base', true, 'color', '#8E4E3A',
          'fields', jsonb_build_array(
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'task_number', 'type', 'auto_id',
              'label_ar', 'رقم المهمة', 'label_en', 'Task Number', 'required', false, 'order', 0,
              'section_id', v_sec_a::text, 'width', 'half', 'show_in_table', true,
              'auto_id_prefix', 'ST-', 'auto_id_padding', 4, 'auto_id_counters', '{}'::jsonb,
              'auto_id_start_value', 1, 'auto_id_scope_field_id', NULL),
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'title', 'type', 'text',
              'label_ar', 'عنوان المهمة', 'label_en', 'Title', 'required', true, 'order', 1,
              'section_id', v_sec_a::text, 'width', 'full', 'show_in_table', true),
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'task_kind', 'type', 'dropdown',
              'label_ar', 'نوع المهمة', 'label_en', 'Task Kind', 'required', true, 'order', 2,
              'section_id', v_sec_a::text, 'width', 'half', 'show_in_table', true,
              'options', jsonb_build_array(
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'search_update',
                  'label_ar', 'تحديث البحث', 'label_en', 'Search Update', 'color', '#8B5CF6'))),
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'task_status', 'type', 'dropdown',
              'label_ar', 'حالة المهمة', 'label_en', 'Task Status', 'required', false, 'order', 3,
              'section_id', v_sec_a::text, 'width', 'half', 'show_in_table', true,
              'options', jsonb_build_array(
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'open',        'label_ar', 'مفتوحة',    'label_en', 'Open',        'color', '#3B82F6'),
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'in_progress', 'label_ar', 'قيد التنفيذ','label_en', 'In Progress', 'color', '#C09B5F'),
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'completed',   'label_ar', 'مكتملة',    'label_en', 'Completed',   'color', '#10B981'),
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'cancelled',   'label_ar', 'ملغاة',     'label_en', 'Cancelled',   'color', '#6B7280'))),
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'assignee', 'type', 'assignee',
              'label_ar', 'مسؤول المهمة', 'label_en', 'Assignee', 'required', false, 'order', 4,
              'section_id', v_sec_a::text, 'width', 'half', 'show_in_table', true,
              'assignee_role_ids', '[]'::jsonb, 'assignee_profile_ids', '[]'::jsonb,
              'assignee_user_filter_mode', 'all'),
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'due_date', 'type', 'datetime',
              'label_ar', 'تاريخ الاستحقاق', 'label_en', 'Due Date', 'required', false, 'order', 5,
              'section_id', v_sec_a::text, 'width', 'half', 'show_in_table', true),
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'details', 'type', 'textarea',
              'label_ar', 'تفاصيل', 'label_en', 'Details', 'required', false, 'order', 6,
              'section_id', v_sec_a::text, 'width', 'full', 'show_in_table', false))),
        -- Section B — what the task is about
        jsonb_build_object(
          'id', v_sec_b::text, 'label_ar', 'السياق', 'label_en', 'Context',
          'order', 1, 'is_base', true, 'color', '#B8734F',
          'fields', jsonb_build_array(
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'client_id', 'type', 'lookup',
              'label_ar', 'العميل', 'label_en', 'Client', 'required', false, 'order', 0,
              'section_id', v_sec_b::text, 'width', 'half', 'show_in_table', true, 'is_multi', false,
              'lookup_model_id', v_clients::text, 'lookup_display_field', 'client_name', 'lookup_max_records', 20),
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'request_id', 'type', 'lookup',
              'label_ar', 'الطلب غير المجاب', 'label_en', 'Unanswered Request', 'required', false, 'order', 1,
              'section_id', v_sec_b::text, 'width', 'half', 'show_in_table', true, 'is_multi', false,
              'lookup_model_id', v_reqs::text, 'lookup_display_field', 'client_name', 'lookup_max_records', 20))),
        -- Section C — closing it
        jsonb_build_object(
          'id', v_sec_c::text, 'label_ar', 'الإغلاق', 'label_en', 'Completion',
          'order', 2, 'is_base', true, 'color', '#C09B5F',
          'fields', jsonb_build_array(
            -- The result is what DRIVES the next state. Ending recurrence is not
            -- the same as resolving the client: `found` and `client_dropped`
            -- both close the request and move the client OUT of «طلب غير مجاب».
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'task_result', 'type', 'dropdown',
              'label_ar', 'النتيجة', 'label_en', 'Result', 'required', false, 'order', 0,
              'section_id', v_sec_c::text, 'width', 'half', 'show_in_table', true,
              'options', jsonb_build_array(
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'still_searching', 'label_ar', 'ما زلنا نبحث',   'label_en', 'Still Searching', 'color', '#C09B5F'),
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'found',           'label_ar', 'وجدنا خياراً',   'label_en', 'Option Found',    'color', '#10B981'),
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'client_dropped',  'label_ar', 'انسحب العميل',   'label_en', 'Client Dropped',  'color', '#8E4E3A'))),
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'found_option', 'type', 'lookup',
              'label_ar', 'الخيار الذي وُجد', 'label_en', 'Option Found', 'required', false, 'order', 1,
              'section_id', v_sec_c::text, 'width', 'half', 'show_in_table', false, 'is_multi', false,
              'lookup_model_id', v_opts::text, 'lookup_display_field', 'source_name', 'lookup_max_records', 20),
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'lost_reason', 'type', 'dropdown',
              'label_ar', 'سبب الانسحاب', 'label_en', 'Drop Reason', 'required', false, 'order', 2,
              'section_id', v_sec_c::text, 'width', 'half', 'show_in_table', false,
              'options', jsonb_build_array(
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'price',             'label_ar', 'السعر',              'label_en', 'Price'),
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'location',          'label_ar', 'الموقع',             'label_en', 'Location'),
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'unit_not_suitable', 'label_ar', 'الوحدة غير مناسبة',  'label_en', 'Unit Not Suitable'),
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'bought_elsewhere',  'label_ar', 'اشترى من جهة أخرى',  'label_en', 'Bought Elsewhere'),
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'timing_issue',      'label_ar', 'التوقيت',            'label_en', 'Timing'),
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'no_response',       'label_ar', 'توقف عن الرد',       'label_en', 'Stopped Responding'),
                jsonb_build_object('id', gen_random_uuid()::text, 'value', 'other',             'label_ar', 'أخرى',               'label_en', 'Other'))),
            -- Required by the app on completion: what was searched, what blocked
            -- it, what is next. A search review with no update is not a review.
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'outcome_notes', 'type', 'textarea',
              'label_ar', 'تحديث البحث', 'label_en', 'Search Update', 'required', false, 'order', 3,
              'section_id', v_sec_c::text, 'width', 'full', 'show_in_table', false),
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'completed_by_user', 'type', 'assignee',
              'label_ar', 'أنجزها', 'label_en', 'Completed By', 'required', false, 'order', 4,
              'section_id', v_sec_c::text, 'width', 'half', 'show_in_table', false,
              'assignee_role_ids', '[]'::jsonb, 'assignee_profile_ids', '[]'::jsonb,
              'assignee_user_filter_mode', 'all'),
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'completed_at', 'type', 'datetime',
              'label_ar', 'تاريخ الإنجاز', 'label_en', 'Completed At', 'required', false, 'order', 5,
              'section_id', v_sec_c::text, 'width', 'half', 'show_in_table', false),
            -- Provenance, so the daily reconciliation can count what it opened.
            jsonb_build_object('id', gen_random_uuid()::text, 'name', 'creation_source', 'type', 'text',
              'label_ar', 'مصدر الإنشاء', 'label_en', 'Creation Source', 'required', false, 'order', 6,
              'section_id', v_sec_c::text, 'width', 'half', 'show_in_table', false))))));
END
$do$;

-- ---------------------------------------------------------------------------
-- 5. unanswered_requests — make it a workable search file
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_sec     uuid := gen_random_uuid();
  v_offices uuid := (SELECT id FROM public.models WHERE name = 'real_estate_offices');
  v_opts    uuid := 'e00d8df8-905c-4fb7-a117-3aefa6fd5603';
  v_section jsonb;
BEGIN
  -- 5a. two closing request_status options
  IF NOT EXISTS (
    SELECT 1 FROM public.models m,
         jsonb_array_elements(m.schema->'sections') s,
         jsonb_array_elements(s->'fields') f,
         jsonb_array_elements(COALESCE(f->'options','[]'::jsonb)) o
    WHERE m.name = 'unanswered_requests' AND f->>'name' = 'request_status' AND o->>'value' = 'fulfilled'
  ) THEN
    UPDATE public.models m
    SET schema = jsonb_set(m.schema, '{sections}', (
      SELECT jsonb_agg(
               CASE WHEN s ? 'fields' THEN jsonb_set(s, '{fields}', (
                 SELECT jsonb_agg(
                          CASE WHEN f->>'name' = 'request_status'
                               THEN jsonb_set(f, '{options}', COALESCE(f->'options','[]'::jsonb)
                                    || jsonb_build_object('id', gen_random_uuid()::text, 'value', 'fulfilled',
                                         'label_ar', 'تم إيجاد خيار', 'label_en', 'Option Found', 'color', '#10B981')
                                    || jsonb_build_object('id', gen_random_uuid()::text, 'value', 'client_dropped',
                                         'label_ar', 'انسحب العميل', 'label_en', 'Client Dropped', 'color', '#8E4E3A'))
                               ELSE f END
                          ORDER BY fo)
                 FROM jsonb_array_elements(s->'fields') WITH ORDINALITY AS ff(f, fo)))
                    ELSE s END
               ORDER BY so)
      FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS ss(s, so)))
    WHERE m.name = 'unanswered_requests';
  END IF;

  -- 5b. a new "Search Management" section (added rather than editing the
  --     existing ones, so nothing already on the form shifts)
  IF NOT EXISTS (
    SELECT 1 FROM public.models m, jsonb_array_elements(m.schema->'sections') s,
         jsonb_array_elements(s->'fields') f
    WHERE m.name = 'unanswered_requests' AND f->>'name' = 'assigned_to'
  ) THEN
    v_section := jsonb_build_object(
      'id', v_sec::text, 'label_ar', 'إدارة البحث', 'label_en', 'Search Management',
      'order', 2, 'is_base', true, 'color', '#8B5CF6',
      'fields', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'name', 'assigned_to', 'type', 'assignee',
          'label_ar', 'مسؤول البحث', 'label_en', 'Sourcing Owner', 'required', false, 'order', 0,
          'section_id', v_sec::text, 'width', 'half', 'show_in_table', true,
          'assignee_role_ids', '[]'::jsonb, 'assignee_profile_ids', '[]'::jsonb,
          'assignee_user_filter_mode', 'all'),
        jsonb_build_object('id', gen_random_uuid()::text, 'name', 'target_date', 'type', 'datetime',
          'label_ar', 'تاريخ مستهدف', 'label_en', 'Target Date', 'required', false, 'order', 1,
          'section_id', v_sec::text, 'width', 'half', 'show_in_table', true),
        jsonb_build_object('id', gen_random_uuid()::text, 'name', 'offices_contacted', 'type', 'lookup',
          'label_ar', 'المكاتب التي تم التواصل معها', 'label_en', 'Offices Contacted', 'required', false, 'order', 2,
          'section_id', v_sec::text, 'width', 'full', 'show_in_table', false, 'is_multi', true,
          'lookup_model_id', v_offices::text, 'lookup_display_field', 'office_name', 'lookup_max_records', 20),
        jsonb_build_object('id', gen_random_uuid()::text, 'name', 'found_option', 'type', 'lookup',
          'label_ar', 'الخيار الذي وُجد', 'label_en', 'Option Found', 'required', false, 'order', 3,
          'section_id', v_sec::text, 'width', 'half', 'show_in_table', false, 'is_multi', false,
          'lookup_model_id', v_opts::text, 'lookup_display_field', 'source_name', 'lookup_max_records', 20),
        jsonb_build_object('id', gen_random_uuid()::text, 'name', 'closed_at', 'type', 'datetime',
          'label_ar', 'تاريخ الإغلاق', 'label_en', 'Closed At', 'required', false, 'order', 4,
          'section_id', v_sec::text, 'width', 'half', 'show_in_table', false),
        jsonb_build_object('id', gen_random_uuid()::text, 'name', 'closed_reason', 'type', 'textarea',
          'label_ar', 'سبب الإغلاق', 'label_en', 'Closing Note', 'required', false, 'order', 5,
          'section_id', v_sec::text, 'width', 'full', 'show_in_table', false)));

    UPDATE public.models
    SET schema = jsonb_set(schema, '{sections}', COALESCE(schema->'sections', '[]'::jsonb) || v_section)
    WHERE name = 'unanswered_requests';
  END IF;
END
$do$;

-- ---------------------------------------------------------------------------
-- 6. Server-authoritative workflow execution for both models
-- ---------------------------------------------------------------------------
-- Without these rows the convergence design is INERT — see the header.
INSERT INTO public.workflow_capture_models (model_id, enabled, note)
SELECT m.id, true, 'unanswered-request search lane (2026-09-20)'
FROM public.models m
WHERE m.name IN ('unanswered_requests', 'sales_tasks')
  AND NOT EXISTS (SELECT 1 FROM public.workflow_capture_models w WHERE w.model_id = m.id);

-- ---------------------------------------------------------------------------
-- 7. Make the two models visible to the people who do sales work
-- ---------------------------------------------------------------------------
-- A model absent from profiles.model_permissions is invisible to every
-- non-admin (wassell_user_has_action → false on a NULL match). Mirror the
-- existing sales surface: any non-admin profile that already holds `followups`
-- view gets view/create/edit on both models.
DO $do$
DECLARE
  m record;
BEGIN
  FOR m IN SELECT id, name FROM public.models WHERE name IN ('unanswered_requests', 'sales_tasks')
  LOOP
    UPDATE public.profiles p
    SET model_permissions = COALESCE(p.model_permissions, '[]'::jsonb) || jsonb_build_array(
          jsonb_build_object('model_id', m.id::text, 'permissions', jsonb_build_array('view', 'create', 'edit')))
    WHERE NOT COALESCE(p.is_admin, false)
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(p.model_permissions, '[]'::jsonb)) mp
        WHERE mp->>'model_id' = '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
          AND mp->'permissions' @> '["view"]'::jsonb)
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(p.model_permissions, '[]'::jsonb)) mp
        WHERE mp->>'model_id' = m.id::text);
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------------------
-- Assertions — fail loudly rather than leaving a half-applied migration
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  n_stage   int;
  n_status  int;
  n_model   int;
  n_capture int;
BEGIN
  SELECT count(*) INTO n_stage
  FROM public.models m, jsonb_array_elements(m.schema->'sections') s,
       jsonb_array_elements(s->'fields') f, jsonb_array_elements(f->'options') o
  WHERE m.name = 'clients' AND f->>'name' = 'client_stage';

  SELECT count(*) INTO n_status
  FROM public.models m, jsonb_array_elements(m.schema->'sections') s,
       jsonb_array_elements(s->'fields') f, jsonb_array_elements(f->'options') o
  WHERE m.name = 'clients' AND f->>'name' = 'client_status';

  IF n_stage <> 14 THEN
    RAISE EXCEPTION 'expected 14 client_stage options (11 live + طلب غير مجاب + خاسر + مغلق ناجح), got %', n_stage;
  END IF;
  IF n_status <> 37 THEN
    RAISE EXCEPTION 'expected 37 client_status options (24 live + يتم البحث + 12 restored), got %', n_status;
  END IF;

  SELECT count(*) INTO n_model FROM public.models WHERE name = 'sales_tasks';
  IF n_model <> 1 THEN RAISE EXCEPTION 'sales_tasks model not created'; END IF;

  SELECT count(*) INTO n_capture
  FROM public.workflow_capture_models w JOIN public.models m ON m.id = w.model_id
  WHERE m.name IN ('unanswered_requests', 'sales_tasks') AND w.enabled;
  IF n_capture <> 2 THEN
    RAISE EXCEPTION 'expected both models enrolled in workflow_capture_models, got %', n_capture;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.models m, jsonb_array_elements(m.schema->'sections') s,
         jsonb_array_elements(s->'fields') f
    WHERE m.name = 'unanswered_requests' AND f->>'name' = 'assigned_to'
  ) THEN
    RAISE EXCEPTION 'unanswered_requests missing the Search Management section';
  END IF;
END
$do$;

COMMIT;
