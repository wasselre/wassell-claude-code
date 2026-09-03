-- "Wants Rent" outcome — a terminal classification for clients who want to RENT,
-- which Wassel does not currently offer. Recording it stops all follow-up
-- generation for that client (like غير مؤهل / Not Qualified) but keeps them
-- countable/filterable as a distinct group (re-engageable if rentals launch).
--
-- Operator decisions (2026-09-03): own status «يريد إيجار / Wants Rent»; offered
-- as a result on the WhatsApp follow-up + the appointment-booking call.
--
-- This migration is ADDITIVE and backward-compatible:
--   1. Adds the «يريد إيجار» option to clients.client_stage + client_status, and
--      the `wants_rent` option to followups.call_result (live model JSONB).
--   2. Adds a `wants_rent` branch to the two completion workflows (WhatsApp reply,
--      booking call) that sets the client to stage/status «يريد إيجار».
--   3. Adds «يريد إيجار» to the terminal-stage set in every task-engine function,
--      so a wants-rent client never has a task armed, created, or kept:
--        - reconcile_outbound_whatsapp (both overloads) / reconcile_inbound_whatsapp
--        - tg_records_supersede_followups (moving TO the stage cancels all open tasks)
--        - reconcile_stranded_clients (the backstop skips it)
--        - recalc_client_derived_data (lifecycle_health = closed)
-- Done as safe in-place edits of the LIVE function bodies (change only the terminal
-- literal), idempotent (guarded on «يريد إيجار» already present).

BEGIN;

-- 1a. clients.client_stage += يريد إيجار (order preserved via WITH ORDINALITY) ---
UPDATE public.models m
SET schema = jsonb_set(m.schema, '{sections}', (
  SELECT jsonb_agg(
           CASE WHEN s ? 'fields' THEN jsonb_set(s, '{fields}', (
             SELECT jsonb_agg(
                      CASE WHEN f->>'name' = 'client_stage'
                             AND NOT (COALESCE(f->'options','[]'::jsonb) @> '[{"value":"يريد إيجار"}]')
                           THEN jsonb_set(f, '{options}',
                                  COALESCE(f->'options','[]'::jsonb) || jsonb_build_object(
                                    'id', gen_random_uuid()::text, 'value', 'يريد إيجار',
                                    'label_ar', 'يريد إيجار', 'label_en', 'Wants Rent'))
                           ELSE f END
                      ORDER BY fo)
             FROM jsonb_array_elements(s->'fields') WITH ORDINALITY AS ff(f, fo)))
                ELSE s END
           ORDER BY so)
  FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS ss(s, so)))
WHERE m.name = 'clients';

-- 1b. clients.client_status += يريد إيجار --------------------------------------
UPDATE public.models m
SET schema = jsonb_set(m.schema, '{sections}', (
  SELECT jsonb_agg(
           CASE WHEN s ? 'fields' THEN jsonb_set(s, '{fields}', (
             SELECT jsonb_agg(
                      CASE WHEN f->>'name' = 'client_status'
                             AND NOT (COALESCE(f->'options','[]'::jsonb) @> '[{"value":"يريد إيجار"}]')
                           THEN jsonb_set(f, '{options}',
                                  COALESCE(f->'options','[]'::jsonb) || jsonb_build_object(
                                    'id', gen_random_uuid()::text, 'value', 'يريد إيجار',
                                    'label_ar', 'يريد إيجار', 'label_en', 'Wants Rent'))
                           ELSE f END
                      ORDER BY fo)
             FROM jsonb_array_elements(s->'fields') WITH ORDINALITY AS ff(f, fo)))
                ELSE s END
           ORDER BY so)
  FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS ss(s, so)))
WHERE m.name = 'clients';

-- 1c. followups.call_result += wants_rent --------------------------------------
UPDATE public.models m
SET schema = jsonb_set(m.schema, '{sections}', (
  SELECT jsonb_agg(
           CASE WHEN s ? 'fields' THEN jsonb_set(s, '{fields}', (
             SELECT jsonb_agg(
                      CASE WHEN f->>'name' = 'call_result'
                             AND NOT (COALESCE(f->'options','[]'::jsonb) @> '[{"value":"wants_rent"}]')
                           THEN jsonb_set(f, '{options}',
                                  COALESCE(f->'options','[]'::jsonb) || jsonb_build_object(
                                    'id', gen_random_uuid()::text, 'value', 'wants_rent',
                                    'label_ar', 'يريد إيجار', 'label_en', 'Wants Rent'))
                           ELSE f END
                      ORDER BY fo)
             FROM jsonb_array_elements(s->'fields') WITH ORDINALITY AS ff(f, fo)))
                ELSE s END
           ORDER BY so)
  FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS ss(s, so)))
WHERE m.name = 'followups';

-- 2. Add a wants_rent branch to the two completion workflows -------------------
-- WhatsApp reply completion (scopes followup_type, mirroring its not_interested branch).
UPDATE public.workflows
SET branches = COALESCE(branches, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text, 'label_ar', 'يريد إيجار', 'label_en', 'Wants Rent',
      'condition_mode', 'all',
      'conditions', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'value', jsonb_build_array('whatsapp_follow_up'), 'field_id', 'followup_type', 'operator', 'equals'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', '', 'field_id', 'actual_datetime', 'operator', 'is_not_empty'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'wants_rent', 'field_id', 'call_result', 'operator', 'equals', 'only_on_change', true)),
      'actions', jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid()::text, 'type', 'update_record', 'filter_value', '',
        'filter_field_id', 'id', 'filter_value_source', 'trigger_field', 'filter_trigger_field_id', 'client_id',
        'target_model_id', '2e86f197-385f-4853-908f-b4cb7237f7d8',
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'static_value', 'يريد إيجار', 'target_field_id', 'client_stage', 'trigger_field_id', ''),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'static_value', 'يريد إيجار', 'target_field_id', 'client_status', 'trigger_field_id', '')))))),
      updated_at = now()
WHERE id = '95bdbe0f-1247-4eb4-bc8f-f0db786c7e27'
  AND NOT (COALESCE(branches::text,'') ILIKE '%wants_rent%');

-- Booking-call completion (no followup_type filter, mirroring its not_interested branch).
UPDATE public.workflows
SET branches = COALESCE(branches, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text, 'label_ar', 'يريد إيجار', 'label_en', 'Wants Rent',
      'condition_mode', 'all',
      'conditions', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'wants_rent', 'field_id', 'call_result', 'operator', 'equals', 'only_on_change', true),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', '', 'field_id', 'actual_datetime', 'operator', 'is_not_empty')),
      'actions', jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid()::text, 'type', 'update_record', 'filter_value', '',
        'filter_field_id', 'id', 'filter_value_source', 'trigger_field', 'filter_trigger_field_id', 'client_id',
        'target_model_id', '2e86f197-385f-4853-908f-b4cb7237f7d8',
        'field_mappings', jsonb_build_array(
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'static_value', 'يريد إيجار', 'target_field_id', 'client_stage', 'trigger_field_id', ''),
          jsonb_build_object('id', gen_random_uuid()::text, 'source_type', 'static', 'static_value', 'يريد إيجار', 'target_field_id', 'client_status', 'trigger_field_id', '')))))),
      updated_at = now()
WHERE id = 'd997425a-0c8d-48c4-afef-b5792792cfae'
  AND NOT (COALESCE(branches::text,'') ILIKE '%wants_rent%');

-- 3. Add يريد إيجار to the terminal set in every task-engine function ----------
-- In-place edit of the LIVE bodies: change only the terminal literal. Idempotent.
DO $do$
DECLARE
  fn   record;
  body text;
BEGIN
  FOR fn IN
    SELECT p.oid FROM pg_proc p
    WHERE p.prokind = 'f'
      AND p.proname IN ('reconcile_outbound_whatsapp','reconcile_inbound_whatsapp',
                        'reconcile_stranded_clients','recalc_client_derived_data',
                        'tg_records_supersede_followups')
  LOOP
    body := pg_get_functiondef(fn.oid);
    IF position('يريد إيجار' IN body) = 0 THEN
      -- reconcile_outbound/inbound/backstop: ('خاسر', 'مغلق ناجح', 'غير مؤهل')
      body := replace(body,
        '''خاسر'', ''مغلق ناجح'', ''غير مؤهل''',
        '''خاسر'', ''مغلق ناجح'', ''غير مؤهل'', ''يريد إيجار''');
      -- recalc_client_derived_data v_terminal: ('خاسر', 'غير مؤهل', 'مغلق ناجح')
      body := replace(body,
        '''خاسر'', ''غير مؤهل'', ''مغلق ناجح''',
        '''خاسر'', ''غير مؤهل'', ''مغلق ناجح'', ''يريد إيجار''');
      -- supersede trigger v_terminal: ARRAY['مغلق ناجح','خاسر','غير مؤهل']
      body := replace(body,
        'ARRAY[''مغلق ناجح'',''خاسر'',''غير مؤهل'']',
        'ARRAY[''مغلق ناجح'',''خاسر'',''غير مؤهل'',''يريد إيجار'']');
      EXECUTE body;
    END IF;
  END LOOP;
END
$do$;

COMMIT;
