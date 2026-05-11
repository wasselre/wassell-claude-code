-- ============================================================================
-- Appointments: add phone_number + client_name with auto-link / auto-create
-- (2026-05-11)
--
-- Lets the user create an appointment by typing a client phone number.
-- Auto-link infrastructure (already wired for the visits model) searches
-- clients by normalized phone; on a unique match it auto-fills client_id.
-- New behavior in this commit: on ZERO matches, auto-create a minimal
-- client with just the phone — see auto_link_create_if_missing in
-- src/types/index.ts and the matching branch in
-- src/pages/Records/hooks/useAutoLink.ts.
--
-- The seed (src/data/seedModels.ts) already includes these fields for
-- fresh installs. This migration appends them to the live model JSONB
-- on existing installs. Idempotent.
--
-- ORDER POLICY: we put phone_number at 0 and client_name at 2 so the
-- form opens phone-first. Existing canonical fields get bumped via a
-- name → order map. Any custom user-added fields (added via the
-- Builder, not present in the seed) land at the end (order 99+) and
-- the user can drag-reorder them in the Builder if needed. This is
-- much safer than blanket "+2 all existing orders" — that approach
-- collided when an install had a custom `app_id` field at order 0.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_model_id      uuid;
  v_schema        jsonb;
  v_basic         jsonb;
  v_basic_id      text;
  v_fields        jsonb;
  v_client_id_fid text;
  v_phone_field   jsonb;
  v_name_field    jsonb;
  v_has_phone     boolean;
BEGIN
  SELECT id, schema INTO v_model_id, v_schema FROM models WHERE name = 'appointments';
  IF v_model_id IS NULL THEN
    RAISE NOTICE 'appointments model not found — fresh install will pick this up from the seed';
    RETURN;
  END IF;

  v_basic    := v_schema->'sections'->0;
  v_basic_id := v_basic->>'id';
  v_fields   := v_basic->'fields';

  -- Idempotency.
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(v_fields) f WHERE f->>'name' = 'phone_number')
    INTO v_has_phone;
  IF v_has_phone THEN
    RAISE NOTICE 'phone_number field already present — no change';
    RETURN;
  END IF;

  -- Find the existing client_id field's UUID so the new auto-link / auto-fill
  -- props point at the right id.
  SELECT f->>'id' INTO v_client_id_fid
  FROM jsonb_array_elements(v_fields) f
  WHERE f->>'name' = 'client_id'
  LIMIT 1;
  IF v_client_id_fid IS NULL THEN
    RAISE EXCEPTION 'appointments schema has no client_id field';
  END IF;

  -- Build the two new fields.
  v_phone_field := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'name', 'phone_number',
    'label_ar', 'رقم جوال العميل',
    'label_en', 'Client Phone',
    'type', 'phone',
    'required', false,
    'order', 0,
    'section_id', v_basic_id,
    'width', 'half',
    'show_in_table', true,
    'default_country_code', '+966',
    'auto_link_lookup_field_id', v_client_id_fid,
    'auto_link_target_field_name', 'phone_number',
    'auto_link_normalize', 'phone',
    'auto_link_create_if_missing', true,
    'auto_link_create_min_length', 12,
    'auto_fill_from_lookup_field_id', v_client_id_fid,
    'auto_fill_source_field_name', 'phone_number'
  );

  v_name_field := jsonb_build_object(
    'id', gen_random_uuid()::text,
    'name', 'client_name',
    'label_ar', 'اسم العميل',
    'label_en', 'Client Name',
    'type', 'text',
    'required', false,
    'order', 2,
    'section_id', v_basic_id,
    'width', 'half',
    'show_in_table', false,
    'auto_fill_from_lookup_field_id', v_client_id_fid,
    'auto_fill_source_field_name', 'client_name'
  );

  -- Apply canonical orders to the existing canonical fields; anything
  -- not in the map gets pushed to 99+ in its original relative order.
  v_fields := (
    WITH ordered AS (
      SELECT
        f.value AS f,
        CASE f.value->>'name'
          WHEN 'client_id'          THEN 1
          WHEN 'app_id'             THEN 3
          WHEN 'appointment_date'   THEN 4
          WHEN 'project_id'         THEN 5
          WHEN 'sales_rep'          THEN 6
          WHEN 'appointment_status' THEN 7
          WHEN 'notes'              THEN 8
          ELSE 99 + (f.value->>'order')::int
        END AS new_order
      FROM jsonb_array_elements(v_fields) WITH ORDINALITY AS f(value, idx)
    )
    SELECT jsonb_agg(f || jsonb_build_object('order', new_order) ORDER BY new_order)
    FROM ordered
  );

  -- Combine + sort.
  v_fields := (
    SELECT jsonb_agg(f ORDER BY (f->>'order')::int)
    FROM jsonb_array_elements(v_fields || jsonb_build_array(v_phone_field, v_name_field)) f
  );

  v_basic  := jsonb_set(v_basic, '{fields}', v_fields);
  v_schema := jsonb_set(v_schema, '{sections,0}', v_basic);
  UPDATE models SET schema = v_schema, updated_at = NOW() WHERE id = v_model_id;
END $$;

COMMIT;
