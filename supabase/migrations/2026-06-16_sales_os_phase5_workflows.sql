-- Sales OS Phase 5 (safe slice): Sales Lifecycle group + metadata tagging +
-- the surgical W3 fix (the 2nd confirmation follow-up was missing appointment_id).
-- Full pre-change backup of all workflows: docs/audits/sales-workflows-before-2026-06-16.json
-- The larger workflow build (W2/W1 enhancements + new W4-W7) is intentionally NOT here.

-- 1) Sales Lifecycle group
INSERT INTO public.workflow_groups (id, label_ar, label_en, "order")
VALUES ('f1e1d1c1-5a1e-4000-8000-000000000001', 'دورة حياة المبيعات', 'Sales Lifecycle', 1)
ON CONFLICT (id) DO NOTHING;

-- 2) Move the 3 existing sales workflows into it + tag with Studio metadata (additive, no behavior change)
UPDATE public.workflows SET group_id='f1e1d1c1-5a1e-4000-8000-000000000001',
  metadata='{"managed_by":"sales_process_studio","sales_stage":"جديد","activity_type":"appointment_booking_call","compatibility":"simple"}'::jsonb
  WHERE id='a336e134-2d79-44f3-8219-a4bd8e2f76f8';  -- First Follow-up
UPDATE public.workflows SET group_id='f1e1d1c1-5a1e-4000-8000-000000000001',
  metadata='{"managed_by":"sales_process_studio","sales_stage":"الاتصال لحجز موعد","activity_type":"appointment_booking_call","compatibility":"simple"}'::jsonb
  WHERE id='d997425a-0c8d-48c4-afef-b5792792cfae';  -- Booking Call
UPDATE public.workflows SET group_id='f1e1d1c1-5a1e-4000-8000-000000000001',
  metadata='{"managed_by":"sales_process_studio","sales_stage":"موعد زيارة","activity_type":"appointment_confirmation_call","compatibility":"simple"}'::jsonb
  WHERE id='4b60ef83-5e16-4ff1-b522-b88e7ae2ab35';  -- Appointment booked via call

-- 3) W3 fix: the 2nd confirmation follow-up (action id 66962966…, the +0d @10:00 create_record)
--    was missing the appointment_id mapping that the 1st confirmation has. Insert it
--    (record_id -> appointment_id) before scheduled_datetime. Guarded by the action id +
--    a "not already present" check so it's safe + idempotent. Both branched + legacy-flat shapes.
UPDATE public.workflows
SET branches = jsonb_insert(
      branches, '{0,actions,3,field_mappings,2}',
      '{"id":"a1b2c3d4-0000-4000-8000-000000000001","source_type":"record_id","static_value":"","target_field_id":"appointment_id","trigger_field_id":""}'::jsonb)
WHERE id='4b60ef83-5e16-4ff1-b522-b88e7ae2ab35'
  AND branches #>> '{0,actions,3,id}' = '66962966-14d8-4c08-9752-85d3fdf10d92'
  AND NOT (branches #> '{0,actions,3,field_mappings}' @> '[{"target_field_id":"appointment_id"}]');

UPDATE public.workflows
SET actions = jsonb_insert(
      actions, '{3,field_mappings,2}',
      '{"id":"a1b2c3d4-0000-4000-8000-000000000002","source_type":"record_id","static_value":"","target_field_id":"appointment_id","trigger_field_id":""}'::jsonb)
WHERE id='4b60ef83-5e16-4ff1-b522-b88e7ae2ab35'
  AND actions #>> '{3,id}' = '66962966-14d8-4c08-9752-85d3fdf10d92'
  AND NOT (actions #> '{3,field_mappings}' @> '[{"target_field_id":"appointment_id"}]');
