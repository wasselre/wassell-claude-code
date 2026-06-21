-- Visits Phase — experience rating + after-visit outcome expansion
-- =================================================================
-- Ships in this ORDER (model options before app code references them):
--   Part 1  model option/field additions (call_result, followup_type,
--           followup_status, client_status, visits rating fields)
--   Part 2  rating_token BEFORE-INSERT backstop trigger
--   Part 3  anon rating RPCs (get_visit_for_rating / submit_visit_rating)
--   Part 4  workflow edits (W6 arms timer, W7 outcomes+cap, new on_due send)
--
-- All option appends are guarded by NOT EXISTS so re-running is safe.
-- Backups taken into _backup_visits_phase_models_20260621 /
-- _backup_visits_phase_workflows_20260621 before first apply.
--
-- Live indices (verified 2026-06-21):
--   followups: call_result = sections[2].fields[1]
--              followup_type = sections[0].fields[15]
--              followup_status = sections[0].fields[12]
--   clients:   client_status = sections[0].fields[3]
--   visits:    single base section sections[0] ("Visit Details")

-- ── Part 1a: followups.call_result — two new after-visit outcomes ────────────
UPDATE public.models m
SET schema = jsonb_set(
  m.schema, '{sections,2,fields,1,options}',
  (m.schema->'sections'->2->'fields'->1->'options') || jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text, 'value','requested_another_visit',
      'label_ar','طلب زيارة أخرى','label_en','Requested Another Visit','color','#10B981'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value','visited_other_project',
      'label_ar','زار مشروعًا آخر','label_en','Visited Another Project','color','#8E4E3A')
  ))
WHERE m.name='followups'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.schema->'sections'->2->'fields'->1->'options') o
                  WHERE o->>'value' IN ('requested_another_visit','visited_other_project'));

-- ── Part 1b: followups.followup_type — rating_request system timer type ──────
UPDATE public.models m
SET schema = jsonb_set(
  m.schema, '{sections,0,fields,15,options}',
  (m.schema->'sections'->0->'fields'->15->'options') || jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text, 'value','rating_request',
      'label_ar','طلب تقييم الزيارة','label_en','Visit Rating Request','color','#C09B5F')
  ))
WHERE m.name='followups'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.schema->'sections'->0->'fields'->15->'options') o
                  WHERE o->>'value'='rating_request');

-- ── Part 1c: followups.followup_status — 'scheduled' (queue-invisible) ───────
UPDATE public.models m
SET schema = jsonb_set(
  m.schema, '{sections,0,fields,12,options}',
  (m.schema->'sections'->0->'fields'->12->'options') || jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text, 'value','scheduled',
      'label_ar','مجدولة','label_en','Scheduled','color','#6B7280')
  ))
WHERE m.name='followups'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.schema->'sections'->0->'fields'->12->'options') o
                  WHERE o->>'value'='scheduled');

-- ── Part 1d: clients.client_status — two new terminal/at-risk statuses ───────
--    client_status VALUES are Arabic strings (repo convention); label_en gives
--    the bilingual display + documents the canonical English keys
--    (visited_other_project_review / unreachable_after_visit).
UPDATE public.models m
SET schema = jsonb_set(
  m.schema, '{sections,0,fields,3,options}',
  (m.schema->'sections'->0->'fields'->3->'options') || jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text, 'value','زار مشروعًا آخر — للمراجعة',
      'label_ar','زار مشروعًا آخر — للمراجعة','label_en','Visited another project — review','color','#8E4E3A'),
    jsonb_build_object('id', gen_random_uuid()::text, 'value','تعذّر التواصل بعد الزيارة',
      'label_ar','تعذّر التواصل بعد الزيارة','label_en','Unreachable after visit','color','#6B7280')
  ))
WHERE m.name='clients'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.schema->'sections'->0->'fields'->3->'options') o
                  WHERE o->>'value' IN ('زار مشروعًا آخر — للمراجعة','تعذّر التواصل بعد الزيارة'));

-- ── Part 1e: visits — rating fields (rating_token hidden+immutable) ──────────
UPDATE public.models m
SET schema = jsonb_set(
  m.schema, '{sections,0,fields}',
  (m.schema->'sections'->0->'fields') || jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text, 'name','rating_token',
      'label_ar','رمز التقييم','label_en','Rating Token','type','text',
      'required',false,'order',90,'section_id', m.schema->'sections'->0->>'id',
      'width','full','show_in_table',false,'hidden',true,'read_only',true,
      'default_dynamic','token'),
    jsonb_build_object('id', gen_random_uuid()::text, 'name','visit_rating',
      'label_ar','تقييم الزيارة','label_en','Visit Rating','type','number',
      'required',false,'order',91,'section_id', m.schema->'sections'->0->>'id',
      'width','half','show_in_table',true,'read_only',true),
    jsonb_build_object('id', gen_random_uuid()::text, 'name','rated_at',
      'label_ar','تاريخ التقييم','label_en','Rated At','type','datetime',
      'required',false,'order',92,'section_id', m.schema->'sections'->0->>'id',
      'width','half','show_in_table',false,'read_only',true)
  ))
WHERE m.name='visits'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.schema->'sections'->0->'fields') f
                  WHERE f->>'name' IN ('rating_token','visit_rating','rated_at'));

-- ── Part 1g: followups.rating_token — carries the token onto the timer ──────
--    The 'rating_request' timer follow-up copies the visit's rating_token here so
--    the on_due "Send Visit Rating" body can resolve {rating_token} in the link.
UPDATE public.models m
SET schema = jsonb_set(
  m.schema, '{sections,0,fields}',
  (m.schema->'sections'->0->'fields') || jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text, 'name','rating_token',
      'label_ar','رمز التقييم','label_en','Rating Token','type','text',
      'required',false,'order',95,'section_id', m.schema->'sections'->0->>'id',
      'width','full','show_in_table',false,'hidden',true,'read_only',true)
  ))
WHERE m.name='followups'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.schema->'sections'->0->'fields') f
                  WHERE f->>'name'='rating_token');

-- ── Part 1f: backfill rating_token onto pre-existing visits ─────────────────
UPDATE public.records r
SET data = r.data || jsonb_build_object('rating_token', replace(gen_random_uuid()::text,'-',''))
WHERE r.model_id = (SELECT id FROM public.models WHERE name='visits' LIMIT 1)
  AND (r.data->>'rating_token') IS NULL;

-- ── Part 2: rating_token BEFORE-INSERT backstop ─────────────────────────────
--   The client form stamps rating_token via default_dynamic:'token', so this
--   only fires for server-created visits. Write-once: BEFORE INSERT only, and
--   only when absent — never re-stamps on UPDATE. (gen_random_bytes ⇐ pgcrypto,
--   already enabled by the files-system migration.)
-- gen_random_uuid() (pg_catalog) is always resolvable; pgcrypto's
-- gen_random_bytes lives in the `extensions` schema and is NOT on
-- record_save's restricted search_path — using it here breaks visit saves.
CREATE OR REPLACE FUNCTION public.records_stamp_visit_rating_token()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $fn$
BEGIN
  IF (NEW.data->>'rating_token') IS NULL
     AND NEW.model_id = (SELECT id FROM public.models WHERE name='visits' LIMIT 1) THEN
    NEW.data := NEW.data || jsonb_build_object('rating_token', replace(gen_random_uuid()::text,'-',''));
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS records_stamp_visit_rating_token ON public.records;
CREATE TRIGGER records_stamp_visit_rating_token
BEFORE INSERT ON public.records
FOR EACH ROW EXECUTE FUNCTION public.records_stamp_visit_rating_token();

-- ── Part 3: anonymous rating RPCs (pattern of get_shared_file) ───────────────
--   get_visit_for_rating exposes ONLY project name + visit date — no client PII.
CREATE OR REPLACE FUNCTION public.get_visit_for_rating(p_token text)
RETURNS TABLE(project_name text, visit_date text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
  SELECT
    (SELECT p.data->>'project_name' FROM public.records p
      WHERE p.id = COALESCE(NULLIF(v.data->'project_id'->>0,''), NULLIF(v.data->>'project_id',''))::uuid
      LIMIT 1) AS project_name,
    v.data->>'scheduled_datetime' AS visit_date
  FROM public.records v
  JOIN public.models m ON m.id = v.model_id AND m.name = 'visits'
  WHERE NULLIF(v.data->>'rating_token','') = p_token
  LIMIT 1;
$fn$;
GRANT EXECUTE ON FUNCTION public.get_visit_for_rating(text) TO anon, authenticated;

--   submit_visit_rating writes ONLY visit_rating/rated_at (never the token) +
--   mirrors a latest-only convenience pointer to the client. Idempotent.
CREATE OR REPLACE FUNCTION public.submit_visit_rating(p_token text, p_rating int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_id uuid; v_client text; v_visits uuid;
BEGIN
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_rating');
  END IF;
  SELECT id INTO v_visits FROM public.models WHERE name='visits' LIMIT 1;
  SELECT id INTO v_id FROM public.records
   WHERE model_id = v_visits AND NULLIF(data->>'rating_token','') = p_token
   LIMIT 1;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  UPDATE public.records
     SET data = data || jsonb_build_object('visit_rating', p_rating, 'rated_at', now()),
         updated_at = now()
   WHERE id = v_id
   RETURNING COALESCE(NULLIF(data->'client_id'->>0,''), NULLIF(data->>'client_id','')) INTO v_client;
  IF v_client IS NOT NULL AND v_client <> '' THEN
    UPDATE public.records
       SET data = data || jsonb_build_object('latest_visit_rating', p_rating, 'latest_visit_rated_at', now()),
           updated_at = now()
     WHERE id = v_client::uuid;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.submit_visit_rating(text, int) TO anon, authenticated;

-- ── Part 4: workflow edits (live Sales-OS rows; idempotent, prod-targeted) ──
--   These patch the live unfrozen workflow JSON. Ids: W6 (Visit→After-Visit)
--   3f2b8499-…, W7 (After-Visit Completed) e4e0680c-…, plus a NEW on_due
--   "Send Visit Rating". Backups in _backup_visits_phase_workflows_20260621.

-- W6.A — stamp followup_number=1 on the after-visit follow-up create (action[1])
UPDATE public.workflows
SET branches = jsonb_set(branches, '{0,actions,1,field_mappings}',
  (branches->0->'actions'->1->'field_mappings') || jsonb_build_array(
    jsonb_build_object('id', gen_random_uuid()::text,'source_type','static','static_value',1,'target_field_id','followup_number','trigger_field_id','')))
WHERE id='3f2b8499-c2ed-42d8-960f-75722a2d3736'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(branches->0->'actions'->1->'field_mappings') m WHERE m->>'target_field_id'='followup_number');

-- W6.B — append the rating-request timer create (status 'scheduled', +2h, copies rating_token)
UPDATE public.workflows
SET branches = jsonb_set(branches, '{0,actions}',
  (branches->0->'actions') || jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid()::text,'type','create_record','skip_if_exists',false,
    'target_model_id','764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63',
    'field_mappings', jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid()::text,'source_type','trigger_field','static_value','','target_field_id','client_id','trigger_field_id','client_id'),
      jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value',jsonb_build_array('rating_request'),'target_field_id','followup_type','trigger_field_id',''),
      jsonb_build_object('id',gen_random_uuid()::text,'source_type','trigger_field','static_value','','target_field_id','rating_token','trigger_field_id','rating_token'),
      jsonb_build_object('id',gen_random_uuid()::text,'source_type','record_id','static_value','','target_field_id','visit','trigger_field_id',''),
      jsonb_build_object('id',gen_random_uuid()::text,'date_base','current_date','source_type','date_expression','static_value','','date_expression','+2h','target_field_id','scheduled_datetime','trigger_field_id',''),
      jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value','scheduled','target_field_id','followup_status','trigger_field_id','')))))
WHERE id='3f2b8499-c2ed-42d8-960f-75722a2d3736'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(branches->0->'actions') a, jsonb_array_elements(a->'field_mappings') m WHERE m->>'target_field_id'='rating_token');

-- W7.1 — increment followup_number on the no_answer retry (branch 5 create), mirroring W2
UPDATE public.workflows
SET branches = jsonb_set(branches, '{5,actions,0,field_mappings}',
  (branches->5->'actions'->0->'field_mappings') || jsonb_build_array(
    jsonb_build_object('id',gen_random_uuid()::text,'source_type','formula','static_value','','target_field_id','followup_number','trigger_field_id','','formula_expression','{followup_number} + 1')))
WHERE id='e4e0680c-4400-4030-8013-2bb21abb2a2f'
  AND (branches->5->'conditions') @> '[{"field_id":"call_result","value":"no_answer"}]'::jsonb
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(branches->5->'actions'->0->'field_mappings') m WHERE m->>'target_field_id'='followup_number');

-- W7.2 — PREPEND the "unreachable (cap reached)" terminal branch (cap N=3 ⇒ followup_number>2)
UPDATE public.workflows
SET branches = jsonb_build_array(jsonb_build_object(
  'id', gen_random_uuid()::text,
  'label_ar','تعذّر التواصل بعد الزيارة (تجاوز الحد)','label_en','Unreachable after visit (cap reached)','condition_mode','all',
  'conditions', jsonb_build_array(
    jsonb_build_object('id',gen_random_uuid()::text,'field_id','followup_type','operator','equals','value',jsonb_build_array('follow_up_call_after_visit')),
    jsonb_build_object('id',gen_random_uuid()::text,'field_id','actual_datetime','operator','is_not_empty','value',''),
    jsonb_build_object('id',gen_random_uuid()::text,'field_id','call_result','operator','equals','value','no_answer','only_on_change',true),
    jsonb_build_object('id',gen_random_uuid()::text,'field_id','followup_number','operator','greater_than','value',2)),
  'actions', jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'type','update_record','filter_value','','filter_field_id','id','target_model_id','2e86f197-385f-4853-908f-b4cb7237f7d8','filter_value_source','trigger_field','filter_trigger_field_id','client_id',
    'field_mappings', jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value','تعذّر التواصل بعد الزيارة','target_field_id','client_status','trigger_field_id',''))))
  )) || branches
WHERE id='e4e0680c-4400-4030-8013-2bb21abb2a2f'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(branches) b WHERE b->>'label_en'='Unreachable after visit (cap reached)');

-- W7.3 — append the 4 new outcome branches. Guarded idempotent on requested_another_visit.
--   requested_another_visit → booking-call re-entry; visited_other_project → at-risk status
--   + Sales-Manager review task (role c54976bb, priority high), NOT lost; recontact_later →
--   reschedule to reschedule_contact_date; invalid_number → terminal غير مؤهل.
UPDATE public.workflows
SET branches = branches || jsonb_build_array(
  jsonb_build_object('id',gen_random_uuid()::text,'label_ar','طلب زيارة أخرى','label_en','Requested Another Visit','condition_mode','all',
    'conditions', jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid()::text,'field_id','followup_type','operator','equals','value',jsonb_build_array('follow_up_call_after_visit')),
      jsonb_build_object('id',gen_random_uuid()::text,'field_id','actual_datetime','operator','is_not_empty','value',''),
      jsonb_build_object('id',gen_random_uuid()::text,'field_id','call_result','operator','equals','value','requested_another_visit','only_on_change',true)),
    'actions', jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid()::text,'type','update_record','filter_value','','filter_field_id','id','target_model_id','2e86f197-385f-4853-908f-b4cb7237f7d8','filter_value_source','trigger_field','filter_trigger_field_id','client_id',
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value','الاتصال لحجز موعد','target_field_id','client_stage','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value','مهتم','target_field_id','client_status','trigger_field_id',''))),
      jsonb_build_object('id',gen_random_uuid()::text,'type','create_record','skip_if_exists',false,'target_model_id','764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63',
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','trigger_field','static_value','','target_field_id','client_id','trigger_field_id','client_id'),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value',jsonb_build_array('appointment_booking_call'),'target_field_id','followup_type','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value',1,'target_field_id','followup_number','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'date_base','current_date','source_type','date_expression','static_value','','date_expression','+0d','target_field_id','scheduled_datetime','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value','open','target_field_id','followup_status','trigger_field_id',''))))),
  jsonb_build_object('id',gen_random_uuid()::text,'label_ar','زار مشروعًا آخر','label_en','Visited Another Project','condition_mode','all',
    'conditions', jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid()::text,'field_id','followup_type','operator','equals','value',jsonb_build_array('follow_up_call_after_visit')),
      jsonb_build_object('id',gen_random_uuid()::text,'field_id','actual_datetime','operator','is_not_empty','value',''),
      jsonb_build_object('id',gen_random_uuid()::text,'field_id','call_result','operator','equals','value','visited_other_project','only_on_change',true)),
    'actions', jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid()::text,'type','update_record','filter_value','','filter_field_id','id','target_model_id','2e86f197-385f-4853-908f-b4cb7237f7d8','filter_value_source','trigger_field','filter_trigger_field_id','client_id',
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value','زار مشروعًا آخر — للمراجعة','target_field_id','client_status','trigger_field_id',''))),
      jsonb_build_object('id',gen_random_uuid()::text,'type','create_record','skip_if_exists',false,'target_model_id','764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63',
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','trigger_field','static_value','','target_field_id','client_id','trigger_field_id','client_id'),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value',jsonb_build_array('follow_up_call_after_visit'),'target_field_id','followup_type','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','role_variable','static_value','','role_id','c54976bb-d0ae-4c5c-a7a7-05ef5fd07551','role_conditions',jsonb_build_array(),'selection_strategy','least_workload','target_field_id','sales_rep','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value','high','target_field_id','priority','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value',1,'target_field_id','followup_number','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'date_base','current_date','source_type','date_expression','static_value','','date_expression','+1d @10:00','target_field_id','scheduled_datetime','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value','open','target_field_id','followup_status','trigger_field_id',''))))),
  jsonb_build_object('id',gen_random_uuid()::text,'label_ar','إعادة تواصل لاحقًا','label_en','Recontact Later','condition_mode','all',
    'conditions', jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid()::text,'field_id','followup_type','operator','equals','value',jsonb_build_array('follow_up_call_after_visit')),
      jsonb_build_object('id',gen_random_uuid()::text,'field_id','actual_datetime','operator','is_not_empty','value',''),
      jsonb_build_object('id',gen_random_uuid()::text,'field_id','call_result','operator','equals','value','recontact_later','only_on_change',true)),
    'actions', jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid()::text,'type','update_record','filter_value','','filter_field_id','id','target_model_id','2e86f197-385f-4853-908f-b4cb7237f7d8','filter_value_source','trigger_field','filter_trigger_field_id','client_id',
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value','إعادة تواصل لاحقًا','target_field_id','client_status','trigger_field_id',''))),
      jsonb_build_object('id',gen_random_uuid()::text,'type','create_record','skip_if_exists',false,'target_model_id','764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63',
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','trigger_field','static_value','','target_field_id','client_id','trigger_field_id','client_id'),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value',jsonb_build_array('follow_up_call_after_visit'),'target_field_id','followup_type','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value',1,'target_field_id','followup_number','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'date_base','trigger_field','date_base_field_id','reschedule_contact_date','source_type','date_expression','static_value','','date_expression','+0d','target_field_id','scheduled_datetime','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value','open','target_field_id','followup_status','trigger_field_id',''))))),
  jsonb_build_object('id',gen_random_uuid()::text,'label_ar','رقم خاطئ','label_en','Invalid Number','condition_mode','all',
    'conditions', jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid()::text,'field_id','followup_type','operator','equals','value',jsonb_build_array('follow_up_call_after_visit')),
      jsonb_build_object('id',gen_random_uuid()::text,'field_id','actual_datetime','operator','is_not_empty','value',''),
      jsonb_build_object('id',gen_random_uuid()::text,'field_id','call_result','operator','equals','value','invalid_number','only_on_change',true)),
    'actions', jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid()::text,'type','update_record','filter_value','','filter_field_id','id','target_model_id','2e86f197-385f-4853-908f-b4cb7237f7d8','filter_value_source','trigger_field','filter_trigger_field_id','client_id',
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value','غير مؤهل','target_field_id','client_stage','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','static','static_value','رقم خاطئ','target_field_id','client_status','trigger_field_id',''),
          jsonb_build_object('id',gen_random_uuid()::text,'source_type','trigger_field','static_value','','target_field_id','lost_reason','trigger_field_id','lost_reason')))))
)
WHERE id='e4e0680c-4400-4030-8013-2bb21abb2a2f'
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(branches) b
    WHERE (SELECT c->>'value' FROM jsonb_array_elements(b->'conditions') c WHERE c->>'field_id'='call_result' LIMIT 1)='requested_another_visit');

-- W7 new on_due sender — "Send Visit Rating" (fixed id for idempotency)
-- GO-LIVE GATE: created is_active=false so customers never receive a
-- /rate/<token> link before the frontend route is deployed. Flip to true
-- AFTER the app deploy reaches READY:
--   UPDATE public.workflows SET is_active=true WHERE id='b9f2a1c4-7e3d-4a5b-9c8e-1d2f3a4b5c6d';
INSERT INTO public.workflows (id, label_ar, label_en, trigger_model_id, trigger_event, is_active, branches, conditions, actions, metadata)
VALUES (
  'b9f2a1c4-7e3d-4a5b-9c8e-1d2f3a4b5c6d','إرسال تقييم الزيارة','Send Visit Rating',
  '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63','on_due', false,
  jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid()::text,'label_ar','إرسال رابط التقييم','label_en','Send rating link','condition_mode','all',
    'conditions', jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'field_id','followup_type','operator','equals','value',jsonb_build_array('rating_request'))),
    'actions', jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'type','send_whatsapp_message',
      'to', jsonb_build_object('kind','lookup','lookup_field_name','client_id','target_phone_field_name','phone_number'),
      'body_template','شكرًا لزيارتك! يسعدنا معرفة رأيك في تجربة زيارتك. قيّمها من ١ إلى ٥ عبر الرابط: https://app.wassel.re/rate/{rating_token}')))),
  '[]'::jsonb, '[]'::jsonb, '{"managed_by":"sales_process_studio"}'::jsonb)
ON CONFLICT (id) DO NOTHING;
