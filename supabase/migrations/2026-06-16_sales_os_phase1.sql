-- Sales Operating System — Phase 1
-- Adds: workflows.metadata column; new fields on followups / phone_calls /
-- appointments / clients; appended call_result outcome options; appended Arabic
-- client_stage / client_status options. All schema mutations are idempotent
-- (keyed by field slug / option value) so re-running is safe. This file is the
-- explicit "applier" — schema is never mutated on app initialize() (correction #9).
--
-- Models are UNFROZEN (JSONB in `records`), so we edit `models.schema`; the
-- `models_view_sync` trigger regenerates each `v_<name>` view automatically.

-- 1) workflows.metadata (round-trips automatically via workflowToSupabaseRow + select '*')
ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS metadata jsonb;

-- 2) helper functions (dropped at the end) ----------------------------------

-- Build a single dropdown option with a fresh id.
CREATE OR REPLACE FUNCTION public._sos_opt(p_value text, p_ar text, p_en text, p_color text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object('id', gen_random_uuid()::text, 'value', p_value, 'label_ar', p_ar, 'label_en', p_en)
       || CASE WHEN p_color IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('color', p_color) END;
$$;

-- Build a full field object with a fresh id. p_extra carries type-specific keys
-- (options / lookup_model_id / lookup_display_field / assignee_role_ids).
CREATE OR REPLACE FUNCTION public._sos_field(
  p_name text, p_ar text, p_en text, p_type text, p_section text,
  p_order int, p_width text, p_show boolean, p_extra jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object(
    'id', gen_random_uuid()::text,
    'name', p_name, 'label_ar', p_ar, 'label_en', p_en,
    'type', p_type, 'required', false, 'order', p_order,
    'section_id', p_section, 'width', p_width, 'show_in_table', p_show
  ) || COALESCE(p_extra, '{}'::jsonb);
$$;

-- Append a field to <model>'s section <section_id>, only if the slug is absent
-- anywhere on the model (idempotent).
CREATE OR REPLACE FUNCTION public._sos_add_field(p_model text, p_section text, p_field jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE sch jsonb; slug text;
BEGIN
  slug := p_field->>'name';
  SELECT schema INTO sch FROM public.models WHERE name = p_model;
  IF sch IS NULL THEN RAISE NOTICE 'sos: model % not found', p_model; RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(sch->'sections') s, jsonb_array_elements(COALESCE(s->'fields','[]'::jsonb)) f
    WHERE f->>'name' = slug
  ) THEN RETURN; END IF;
  UPDATE public.models SET schema = jsonb_set(schema, '{sections}', (
    SELECT jsonb_agg(CASE WHEN sec->>'id' = p_section
      THEN jsonb_set(sec, '{fields}', COALESCE(sec->'fields','[]'::jsonb) || p_field)
      ELSE sec END)
    FROM jsonb_array_elements(schema->'sections') sec
  )) WHERE name = p_model;
END; $$;

-- Append a dropdown option to <model>.<field_slug>, only if the value is absent.
CREATE OR REPLACE FUNCTION public._sos_add_option(p_model text, p_field_slug text, p_option jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE val text;
BEGIN
  val := p_option->>'value';
  IF EXISTS (
    SELECT 1 FROM public.models m,
      jsonb_array_elements(m.schema->'sections') s,
      jsonb_array_elements(COALESCE(s->'fields','[]'::jsonb)) f,
      jsonb_array_elements(COALESCE(f->'options','[]'::jsonb)) o
    WHERE m.name = p_model AND f->>'name' = p_field_slug AND o->>'value' = val
  ) THEN RETURN; END IF;
  UPDATE public.models SET schema = jsonb_set(schema, '{sections}', (
    SELECT jsonb_agg(
      jsonb_set(sec, '{fields}', COALESCE((
        SELECT jsonb_agg(CASE WHEN f->>'name' = p_field_slug
          THEN jsonb_set(f, '{options}', COALESCE(f->'options','[]'::jsonb) || p_option)
          ELSE f END)
        FROM jsonb_array_elements(sec->'fields') f
      ), '[]'::jsonb))
    )
    FROM jsonb_array_elements(schema->'sections') sec
  )) WHERE name = p_model;
END; $$;

-- Relabel a field's display labels (slug + value unchanged).
CREATE OR REPLACE FUNCTION public._sos_relabel(p_model text, p_slug text, p_ar text, p_en text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.models SET schema = jsonb_set(schema, '{sections}', (
    SELECT jsonb_agg(
      jsonb_set(sec, '{fields}', COALESCE((
        SELECT jsonb_agg(CASE WHEN f->>'name' = p_slug
          THEN f || jsonb_build_object('label_ar', p_ar, 'label_en', p_en)
          ELSE f END)
        FROM jsonb_array_elements(sec->'fields') f
      ), '[]'::jsonb))
    )
    FROM jsonb_array_elements(schema->'sections') sec
  )) WHERE name = p_model;
END; $$;

-- 3) reusable option arrays --------------------------------------------------
-- (built inline below via jsonb_build_array(_sos_opt(...)))

-- 4) followups fields --------------------------------------------------------
DO $$
DECLARE
  basic  text := '61a5b4c4-4743-4c2b-87e8-99b883adf403'; -- followups Basic Info
  result text := 'adb3a7a4-d266-49cc-8d0b-8a01ced8375c'; -- followups Follow-up Result
  phone_calls_id text := '1ef36cc7-a5bb-4fdc-b3ef-9fc965c2b2d4';
  chats_id       text := '7e6c23b5-5492-413a-bc34-d928086f6e7e';
  lost_opts jsonb := jsonb_build_array(
    public._sos_opt('price','السعر','Price'),
    public._sos_opt('location','الموقع','Location'),
    public._sos_opt('unit_not_suitable','الوحدة غير مناسبة','Unit Not Suitable'),
    public._sos_opt('bought_elsewhere','اشترى من جهة أخرى','Bought Elsewhere'),
    public._sos_opt('not_serious','غير جاد','Not Serious'),
    public._sos_opt('financing_issue','مشكلة تمويل','Financing Issue'),
    public._sos_opt('timing_issue','التوقيت','Timing'),
    public._sos_opt('invalid_number','رقم خاطئ','Invalid Number'),
    public._sos_opt('duplicate','مكرر','Duplicate'),
    public._sos_opt('other','أخرى','Other')
  );
BEGIN
  -- Basic Info: task state + priority
  PERFORM public._sos_add_field('followups', basic, public._sos_field(
    'followup_status','حالة المتابعة','Status','dropdown', basic, 7, 'half', true,
    jsonb_build_object('options', jsonb_build_array(
      public._sos_opt('open','مفتوحة','Open','#3B82F6'),
      public._sos_opt('in_progress','قيد التنفيذ','In Progress','#C09B5F'),
      public._sos_opt('completed','مكتملة','Completed','#10B981'),
      public._sos_opt('cancelled','ملغاة','Cancelled','#6B7280'),
      public._sos_opt('skipped','متخطاة','Skipped','#8E4E3A')
    ))));
  PERFORM public._sos_add_field('followups', basic, public._sos_field(
    'priority','الأولوية','Priority','dropdown', basic, 8, 'half', true,
    jsonb_build_object('options', jsonb_build_array(
      public._sos_opt('low','منخفضة','Low','#6B7280'),
      public._sos_opt('normal','عادية','Normal','#3B82F6'),
      public._sos_opt('high','عالية','High','#C09B5F'),
      public._sos_opt('urgent','عاجلة','Urgent','#8E4E3A')
    ))));

  -- Follow-up Result: outcome detail + evidence + snapshots
  PERFORM public._sos_add_field('followups', result, public._sos_field(
    'outcome_notes','ملاحظات النتيجة','Outcome Notes','textarea', result, 10, 'full', false));
  PERFORM public._sos_add_field('followups', result, public._sos_field(
    'lost_reason','سبب الخسارة','Lost Reason','dropdown', result, 11, 'half', false,
    jsonb_build_object('options', lost_opts)));
  PERFORM public._sos_add_field('followups', result, public._sos_field(
    'completed_by_call_id','المكالمة المرتبطة','Linked Call','lookup', result, 12, 'half', false,
    jsonb_build_object('lookup_model_id', phone_calls_id, 'lookup_display_field', 'call_time')));
  PERFORM public._sos_add_field('followups', result, public._sos_field(
    'completed_by_chat_id','المحادثة المرتبطة','Linked Chat','lookup', result, 13, 'half', false,
    jsonb_build_object('lookup_model_id', chats_id, 'lookup_display_field', 'name')));
  PERFORM public._sos_add_field('followups', result, public._sos_field(
    'completed_by_user','أكملها','Completed By','assignee', result, 14, 'half', false,
    jsonb_build_object('assignee_role_ids', '[]'::jsonb)));
  PERFORM public._sos_add_field('followups', result, public._sos_field(
    'new_appointment_datetime','موعد الزيارة الجديد','New Appointment Time','datetime', result, 15, 'half', false));
  PERFORM public._sos_add_field('followups', result, public._sos_field(
    'source_stage_snapshot','مرحلة العميل عند الإنشاء','Stage at Creation','text', result, 16, 'half', false));
  PERFORM public._sos_add_field('followups', result, public._sos_field(
    'source_status_snapshot','حالة العميل عند الإنشاء','Status at Creation','text', result, 17, 'half', false));
END $$;

-- 5) followups call_result: relabel + append outcome options -----------------
SELECT public._sos_relabel('followups', 'call_result', 'النتيجة', 'Outcome');
SELECT public._sos_add_option('followups','call_result', public._sos_opt('invalid_number','رقم خاطئ','Invalid Number'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('duplicate','مكرر','Duplicate'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('message_sent','تم إرسال الرسالة','Message Sent'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('message_replied','تم الرد','Message Replied'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('request_offer','طلب عرض سعر','Request Offer'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('still_interested','لا يزال مهتمًا','Still Interested'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('needs_financing_info','يحتاج معلومات تمويل','Needs Financing Info'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('family_discussion','نقاش عائلي','Family Discussion'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('offer_accepted','قبول العرض','Offer Accepted'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('offer_rejected','رفض العرض','Offer Rejected'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('waiting_decision','بانتظار القرار','Waiting Decision'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('payment_pending','بانتظار الدفع','Payment Pending'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('payment_received','تم استلام الدفعة','Payment Received'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('documents_pending','بانتظار المستندات','Documents Pending'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('appointment_cancelled_rebook','إلغاء الموعد - إعادة حجز','Cancelled — Rebook'));
SELECT public._sos_add_option('followups','call_result', public._sos_opt('appointment_cancelled_lost','إلغاء الموعد - خسارة','Cancelled — Lost'));

-- 6) phone_calls.linked_followup_id + appointments.source_followup_id --------
SELECT public._sos_add_field('phone_calls', 'e8c585b1-9ae3-467a-8a4c-0022a77f295b', public._sos_field(
  'linked_followup_id','المتابعة المرتبطة','Linked Follow-up','lookup',
  'e8c585b1-9ae3-467a-8a4c-0022a77f295b', 50, 'half', false,
  jsonb_build_object('lookup_model_id','764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63','lookup_display_field','scheduled_datetime')));

SELECT public._sos_add_field('appointments', '76a80c7a-647d-468a-8551-7e431feded96', public._sos_field(
  'source_followup_id','المتابعة المصدر','Source Follow-up','lookup',
  '76a80c7a-647d-468a-8551-7e431feded96', 50, 'half', false,
  jsonb_build_object('lookup_model_id','764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63','lookup_display_field','scheduled_datetime')));

-- 7) clients fields ----------------------------------------------------------
DO $$
DECLARE
  basic text := '63ee11b7-d43c-4715-86c6-ee729d50cd51'; -- clients Basic
  followups_id text := '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63';
  lost_opts jsonb := jsonb_build_array(
    public._sos_opt('price','السعر','Price'),
    public._sos_opt('location','الموقع','Location'),
    public._sos_opt('unit_not_suitable','الوحدة غير مناسبة','Unit Not Suitable'),
    public._sos_opt('bought_elsewhere','اشترى من جهة أخرى','Bought Elsewhere'),
    public._sos_opt('not_serious','غير جاد','Not Serious'),
    public._sos_opt('financing_issue','مشكلة تمويل','Financing Issue'),
    public._sos_opt('timing_issue','التوقيت','Timing'),
    public._sos_opt('invalid_number','رقم خاطئ','Invalid Number'),
    public._sos_opt('duplicate','مكرر','Duplicate'),
    public._sos_opt('other','أخرى','Other')
  );
BEGIN
  PERFORM public._sos_add_field('clients', basic, public._sos_field(
    'client_owner','مالك العميل','Client Owner','assignee', basic, 50, 'half', false,
    jsonb_build_object('assignee_role_ids', '[]'::jsonb)));
  PERFORM public._sos_add_field('clients', basic, public._sos_field(
    'next_followup_id','المتابعة التالية','Next Follow-up','lookup', basic, 51, 'half', false,
    jsonb_build_object('lookup_model_id', followups_id, 'lookup_display_field', 'scheduled_datetime')));
  PERFORM public._sos_add_field('clients', basic, public._sos_field(
    'next_action_type','نوع الإجراء التالي','Next Action Type','dropdown', basic, 52, 'half', false,
    jsonb_build_object('options', jsonb_build_array(
      public._sos_opt('call','اتصال','Call'),
      public._sos_opt('whatsapp','واتساب','WhatsApp'),
      public._sos_opt('appointment','موعد','Appointment'),
      public._sos_opt('offer','عرض سعر','Offer'),
      public._sos_opt('financing','تمويل','Financing'),
      public._sos_opt('ownership','إفراغ','Ownership Transfer')
    ))));
  PERFORM public._sos_add_field('clients', basic, public._sos_field(
    'next_action_due_at','موعد الإجراء التالي','Next Action Due','datetime', basic, 53, 'half', false));
  PERFORM public._sos_add_field('clients', basic, public._sos_field(
    'last_activity_at','آخر نشاط','Last Activity','datetime', basic, 54, 'half', false));
  PERFORM public._sos_add_field('clients', basic, public._sos_field(
    'lost_reason','سبب الخسارة','Lost Reason','dropdown', basic, 55, 'half', false,
    jsonb_build_object('options', lost_opts)));
  PERFORM public._sos_add_field('clients', basic, public._sos_field(
    'lost_at','تاريخ الخسارة','Lost At','datetime', basic, 56, 'half', false));
  PERFORM public._sos_add_field('clients', basic, public._sos_field(
    'lifecycle_health','صحة دورة الحياة','Lifecycle Health','dropdown', basic, 57, 'half', false,
    jsonb_build_object('options', jsonb_build_array(
      public._sos_opt('on_track','على المسار','On Track','#10B981'),
      public._sos_opt('overdue','متأخر','Overdue','#8E4E3A'),
      public._sos_opt('no_next_action','لا يوجد إجراء تالٍ','No Next Action','#C09B5F'),
      public._sos_opt('closed','مغلق','Closed','#6B7280')
    ))));
END $$;

-- 8) clients: append Arabic stage + status options ---------------------------
SELECT public._sos_add_option('clients','client_stage', public._sos_opt('خاسر','خاسر','Lost','#8E4E3A'));
SELECT public._sos_add_option('clients','client_stage', public._sos_opt('مغلق ناجح','مغلق ناجح','Closed Won','#10B981'));

SELECT public._sos_add_option('clients','client_status', public._sos_opt('رقم خاطئ','رقم خاطئ','Invalid Number'));
SELECT public._sos_add_option('clients','client_status', public._sos_opt('مكرر','مكرر','Duplicate'));
SELECT public._sos_add_option('clients','client_status', public._sos_opt('تم رفض العرض','تم رفض العرض','Offer Rejected'));
SELECT public._sos_add_option('clients','client_status', public._sos_opt('يحتاج معلومات تمويل','يحتاج معلومات تمويل','Needs Financing Info'));
SELECT public._sos_add_option('clients','client_status', public._sos_opt('نقاش عائلي','نقاش عائلي','Family Discussion'));
SELECT public._sos_add_option('clients','client_status', public._sos_opt('بانتظار القرار','بانتظار القرار','Waiting Decision'));
SELECT public._sos_add_option('clients','client_status', public._sos_opt('تم إرسال واتساب','تم إرسال واتساب','WhatsApp Sent'));
SELECT public._sos_add_option('clients','client_status', public._sos_opt('إعادة تواصل لاحقًا','إعادة تواصل لاحقًا','Recontact Later'));
SELECT public._sos_add_option('clients','client_status', public._sos_opt('بارد','بارد','Cold'));
SELECT public._sos_add_option('clients','client_status', public._sos_opt('بانتظار دفعة الحجز','بانتظار دفعة الحجز','Waiting Reservation Payment'));

-- 9) drop helpers ------------------------------------------------------------
DROP FUNCTION IF EXISTS public._sos_add_field(text, text, jsonb);
DROP FUNCTION IF EXISTS public._sos_add_option(text, text, jsonb);
DROP FUNCTION IF EXISTS public._sos_relabel(text, text, text, text);
DROP FUNCTION IF EXISTS public._sos_field(text, text, text, text, text, int, text, boolean, jsonb);
DROP FUNCTION IF EXISTS public._sos_opt(text, text, text, text);
