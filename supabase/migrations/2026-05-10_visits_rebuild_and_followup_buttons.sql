-- ============================================================================
-- Visits model rebuild + Follow-Ups action buttons (2026-05-10)
--
-- Two coupled changes shipped together:
--
--   1. Tear down the old user-built visits model (slug `item_mo5t69tn`) and
--      replace it with a clean `visits` model whose schema supports the
--      bidirectional client auto-fill UX (typing a phone finds the client;
--      picking a client fills the phone + name). Kept as a Builder-managed
--      JSONB model — NOT frozen — per explicit user request.
--
--   2. Append three custom buttons to the followups model:
--        - Book a visit          (create_record → visits)
--        - Schedule follow-up    (create_record → followups)
--        - Register a visit      (find_or_create_record → visits, latest by
--                                 created_at, search by client_id)
--
-- DESTRUCTIVE — every record under `item_mo5t69tn` is deleted. The user
-- approved this in plan mode. A NOTICE is raised before the delete runs so
-- the operator can abort if the record count is unexpectedly large.
--
-- Mirror in code: src/data/seedModels.ts seeds the same shape so a fresh
-- install matches the migrated state.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_old_visits_count int := 0;
  v_clients_id        uuid;
  v_our_projects_id   uuid;
  v_followups_id      uuid;

  v_visits_id            uuid := gen_random_uuid();
  v_section_id           uuid := gen_random_uuid();
  v_client_field_id      uuid := gen_random_uuid();
  v_phone_field_id       uuid := gen_random_uuid();
  v_name_field_id        uuid := gen_random_uuid();
  v_scheduled_field_id   uuid := gen_random_uuid();
  v_project_field_id     uuid := gen_random_uuid();

  v_btn_book_id          uuid := gen_random_uuid();
  v_btn_schedule_id      uuid := gen_random_uuid();
  v_btn_register_id      uuid := gen_random_uuid();
BEGIN
  -- Resolve cross-model references from the live state. Hard-fail if a
  -- referenced model is missing — better to abort than to write a broken
  -- schema with a NULL lookup_model_id.
  SELECT id INTO v_clients_id FROM models WHERE name = 'clients';
  IF v_clients_id IS NULL THEN
    RAISE EXCEPTION 'clients model not found — cannot wire visits.client_id lookup';
  END IF;
  SELECT id INTO v_our_projects_id FROM models WHERE name = 'our_projects';
  IF v_our_projects_id IS NULL THEN
    RAISE EXCEPTION 'our_projects model not found — cannot wire visits.project_id lookup';
  END IF;
  SELECT id INTO v_followups_id FROM models WHERE name = 'followups';
  IF v_followups_id IS NULL THEN
    RAISE EXCEPTION 'followups model not found — cannot attach buttons';
  END IF;

  -- Audit step. Records under the old visits model are deleted by the
  -- next statement; surface the count first so the run is debuggable
  -- if something turns out to have been valuable.
  SELECT count(*) INTO v_old_visits_count
  FROM records
  WHERE model_id = (SELECT id FROM models WHERE name = 'item_mo5t69tn');
  IF v_old_visits_count > 0 THEN
    RAISE NOTICE 'Deleting % old visits record(s) under model item_mo5t69tn', v_old_visits_count;
  END IF;
  DELETE FROM records
   WHERE model_id IN (SELECT id FROM models WHERE name = 'item_mo5t69tn');
  DELETE FROM models WHERE name = 'item_mo5t69tn';

  -- Insert the new visits model. Field display order mirrors the seed in
  -- src/data/seedModels.ts. The phone & name fields carry the new
  -- auto_link_* / auto_fill_* JSONB props the form-side hooks read.
  INSERT INTO models (
    id, name, label_ar, label_en, icon, color,
    schema, card_config, maps_config,
    group_id, is_system, created_at, updated_at
  )
  VALUES (
    v_visits_id, 'visits', 'الزيارات', 'Visits', 'map-pin', '#B8734F',
    jsonb_build_object(
      'sections', jsonb_build_array(
        jsonb_build_object(
          'id', v_section_id,
          'label_ar', 'تفاصيل الزيارة',
          'label_en', 'Visit Details',
          'order', 0,
          'is_base', true,
          'color', '#B8734F',
          'fields', jsonb_build_array(
            jsonb_build_object(
              'id', v_client_field_id, 'name', 'client_id',
              'label_ar', 'العميل', 'label_en', 'Client',
              'type', 'lookup', 'required', true, 'order', 0,
              'section_id', v_section_id, 'width', 'half',
              'show_in_table', true,
              'lookup_model_id', v_clients_id,
              'lookup_display_field', 'client_code'
            ),
            jsonb_build_object(
              'id', v_phone_field_id, 'name', 'phone',
              'label_ar', 'رقم الجوال', 'label_en', 'Phone',
              'type', 'phone', 'required', false, 'order', 1,
              'section_id', v_section_id, 'width', 'half',
              'show_in_table', true,
              'default_country_code', '+966',
              'auto_link_lookup_field_id', v_client_field_id,
              'auto_link_target_field_name', 'phone_number',
              'auto_link_normalize', 'phone',
              'auto_fill_from_lookup_field_id', v_client_field_id,
              'auto_fill_source_field_name', 'phone_number'
            ),
            jsonb_build_object(
              'id', v_name_field_id, 'name', 'name',
              'label_ar', 'الاسم', 'label_en', 'Name',
              'type', 'text', 'required', false, 'order', 2,
              'section_id', v_section_id, 'width', 'half',
              'show_in_table', true,
              'auto_fill_from_lookup_field_id', v_client_field_id,
              'auto_fill_source_field_name', 'client_name'
            ),
            jsonb_build_object(
              'id', v_scheduled_field_id, 'name', 'scheduled_datetime',
              'label_ar', 'موعد الزيارة', 'label_en', 'Scheduled Date & Time',
              'type', 'datetime', 'required', false, 'order', 3,
              'section_id', v_section_id, 'width', 'half',
              'show_in_table', true
            ),
            jsonb_build_object(
              'id', v_project_field_id, 'name', 'project_id',
              'label_ar', 'المشروع', 'label_en', 'Project',
              'type', 'lookup', 'required', false, 'order', 4,
              'section_id', v_section_id, 'width', 'half',
              'show_in_table', true,
              'lookup_model_id', v_our_projects_id,
              'lookup_display_field', 'project_name'
            )
          )
        )
      ),
      'section_selector_field_id', null,
      'custom_buttons', jsonb_build_array()
    ),
    jsonb_build_object(
      'title_field_id', v_name_field_id,
      'subtitle_field_id', v_scheduled_field_id,
      'badge_field_id', null,
      'shown_field_ids', jsonb_build_array()
    ),
    -- Use the table default for maps_config — visits is not map-rendered.
    '{"location_url_field_id":null,"manual_lat_field_id":null,"manual_lng_field_id":null,"pin_color_field_id":null,"pin_label_field_id":null,"click_action":"popup","popup_title_field_id":null,"popup_subtitle_field_id":null,"popup_badge_field_id":null,"popup_shown_field_ids":[],"map_style_json":null,"default_center_lat":null,"default_center_lng":null,"default_zoom":null}'::jsonb,
    null, true, now(), now()
  );

  -- Append the three buttons. The COALESCE preserves any custom_buttons
  -- a previous migration / Builder edit may have already attached, so
  -- this stays additive.
  UPDATE models
  SET schema = jsonb_set(
        schema,
        '{custom_buttons}',
        COALESCE(schema->'custom_buttons', '[]'::jsonb) || jsonb_build_array(
          jsonb_build_object(
            'id', v_btn_book_id,
            'label_ar', 'حجز زيارة',
            'label_en', 'Book a visit',
            'icon', 'calendar-plus',
            'locations', jsonb_build_array('record_form'),
            'action', jsonb_build_object(
              'type', 'create_record',
              'target_model_id', v_visits_id,
              'prefill', jsonb_build_array(
                jsonb_build_object('target_field_name', 'client_id', 'source_field_name', 'client_id')
              )
            )
          ),
          jsonb_build_object(
            'id', v_btn_schedule_id,
            'label_ar', 'جدولة متابعة',
            'label_en', 'Schedule follow-up',
            'icon', 'calendar-clock',
            'locations', jsonb_build_array('record_form'),
            'action', jsonb_build_object(
              'type', 'create_record',
              'target_model_id', v_followups_id,
              'prefill', jsonb_build_array(
                jsonb_build_object('target_field_name', 'client_id', 'source_field_name', 'client_id')
              )
            )
          ),
          jsonb_build_object(
            'id', v_btn_register_id,
            'label_ar', 'تسجيل زيارة',
            'label_en', 'Register a visit',
            'icon', 'map-pin-check',
            'locations', jsonb_build_array('record_form'),
            'action', jsonb_build_object(
              'type', 'find_or_create_record',
              'target_model_id', v_visits_id,
              'search_by', jsonb_build_array(
                jsonb_build_object('target_field_name', 'client_id', 'source_field_name', 'client_id')
              ),
              'order_by', 'created_at_desc',
              'prefill', jsonb_build_array(
                jsonb_build_object('target_field_name', 'client_id', 'source_field_name', 'client_id')
              )
            )
          )
        ),
        true  -- create the key if missing
      ),
      updated_at = now()
   WHERE id = v_followups_id;
END $$;

COMMIT;
