-- ============================================================================
-- Website integration — opens a narrow public-read window on the data the
-- public marketing site (Wassel Website) renders, and adds the fields it
-- needs.
--
-- 1. all_projects model: adds `image_url` (hero image for project cards),
--    `location_url` (a Google Maps URL parsed by lib/locationUtils for the
--    map page), and `is_public` (a checkbox controlling whether the project
--    appears on the public website — DEFAULT OFF, so existing projects stay
--    private until an admin opts them in). Wires maps_config to use
--    location_url + project_name + project_status, so the existing CRM Maps
--    view also picks up the location automatically.
--
-- 2. site_settings model: a new singleton-style model holding hero copy,
--    contact info, social links, working hours. Editable from the CRM, so
--    site copy can change without a code redeploy. Seeded with one record
--    matching the current static index.html.
--
-- 3. Public-read RLS: grants the `anon` role SELECT on `records` filtered
--    to (a) site_settings rows always, and (b) all_projects rows ONLY where
--    `data->>'is_public'` is true. Plus SELECT on the `models` table for
--    those two model rows (so the website can resolve dropdown option
--    labels). Authenticated/CRM traffic is unchanged — they keep going
--    through the existing wassell_can_view_record policy.
-- ============================================================================

BEGIN;

-- ─── 1. Add image_url + location_url to all_projects, wire maps_config ────

DO $$
DECLARE
  v_model_id        uuid;
  v_section_id      text;
  v_image_field_id  text;
  v_loc_field_id    text;
  v_public_field_id text;
  v_name_field_id   text;
  v_status_field_id text;
BEGIN
  SELECT id INTO v_model_id FROM models WHERE name = 'all_projects';
  IF v_model_id IS NULL THEN
    RAISE NOTICE 'all_projects model not found — seed has not run yet, skipping projects field updates';
    RETURN;
  END IF;

  SELECT schema->'sections'->0->>'id' INTO v_section_id FROM models WHERE id = v_model_id;

  SELECT field->>'id' INTO v_name_field_id
  FROM models, jsonb_array_elements(schema->'sections'->0->'fields') field
  WHERE id = v_model_id AND field->>'name' = 'project_name';

  SELECT field->>'id' INTO v_status_field_id
  FROM models, jsonb_array_elements(schema->'sections'->0->'fields') field
  WHERE id = v_model_id AND field->>'name' = 'project_status';

  -- Add image_url if not already present (idempotent re-run safe).
  IF NOT EXISTS (
    SELECT 1 FROM models, jsonb_array_elements(schema->'sections'->0->'fields') field
    WHERE id = v_model_id AND field->>'name' = 'image_url'
  ) THEN
    v_image_field_id := gen_random_uuid()::text;
    UPDATE models
    SET schema = jsonb_set(
      schema,
      '{sections,0,fields}',
      (schema->'sections'->0->'fields') || jsonb_build_array(jsonb_build_object(
        'id', v_image_field_id,
        'name', 'image_url',
        'label_ar', 'صورة المشروع',
        'label_en', 'Project Image',
        'type', 'url',
        'required', false,
        'order', 12,
        'section_id', v_section_id,
        'width', 'half',
        'show_in_table', false
      ))
    ),
    updated_at = NOW()
    WHERE id = v_model_id;
  END IF;

  -- Add location_url if not already present.
  IF NOT EXISTS (
    SELECT 1 FROM models, jsonb_array_elements(schema->'sections'->0->'fields') field
    WHERE id = v_model_id AND field->>'name' = 'location_url'
  ) THEN
    v_loc_field_id := gen_random_uuid()::text;
    UPDATE models
    SET schema = jsonb_set(
      schema,
      '{sections,0,fields}',
      (schema->'sections'->0->'fields') || jsonb_build_array(jsonb_build_object(
        'id', v_loc_field_id,
        'name', 'location_url',
        'label_ar', 'رابط الموقع على الخريطة',
        'label_en', 'Map Location URL',
        'type', 'url',
        'required', false,
        'order', 13,
        'section_id', v_section_id,
        'width', 'half',
        'show_in_table', false
      ))
    ),
    updated_at = NOW()
    WHERE id = v_model_id;
  ELSE
    SELECT field->>'id' INTO v_loc_field_id
    FROM models, jsonb_array_elements(schema->'sections'->0->'fields') field
    WHERE id = v_model_id AND field->>'name' = 'location_url';
  END IF;

  -- Add is_public checkbox so admins explicitly opt projects in to the
  -- website. Default OFF — see RLS policy below; only `is_public = true`
  -- rows are visible to the anon role, so existing 1,366 projects stay
  -- private until an admin toggles them on individually.
  IF NOT EXISTS (
    SELECT 1 FROM models, jsonb_array_elements(schema->'sections'->0->'fields') field
    WHERE id = v_model_id AND field->>'name' = 'is_public'
  ) THEN
    v_public_field_id := gen_random_uuid()::text;
    UPDATE models
    SET schema = jsonb_set(
      schema,
      '{sections,0,fields}',
      (schema->'sections'->0->'fields') || jsonb_build_array(jsonb_build_object(
        'id', v_public_field_id,
        'name', 'is_public',
        'label_ar', 'عرض على الموقع',
        'label_en', 'Show on Website',
        'type', 'checkbox',
        'required', false,
        'order', 14,
        'section_id', v_section_id,
        'width', 'half',
        'show_in_table', true
      ))
    ),
    updated_at = NOW()
    WHERE id = v_model_id;
  END IF;

  -- Wire maps_config: location source = location_url URL field. Pin label /
  -- popup title use project_name; pin color / popup badge use project_status
  -- (so off-plan / under-construction / ready get distinct colors via the
  -- option's `color` property already in seedModels).
  UPDATE models
  SET maps_config = COALESCE(maps_config, '{}'::jsonb)
    || jsonb_build_object(
      'location_url_field_id', v_loc_field_id,
      'pin_label_field_id', v_name_field_id,
      'pin_color_field_id', v_status_field_id,
      'popup_title_field_id', v_name_field_id,
      'popup_badge_field_id', v_status_field_id
    ),
    updated_at = NOW()
  WHERE id = v_model_id;
END $$;

-- ─── 2. Create site_settings model + seed one record ──────────────────────

DO $$
DECLARE
  v_model_id           uuid;
  v_group_id           uuid;
  v_section_id         text := gen_random_uuid()::text;
  v_hero_title_id      text := gen_random_uuid()::text;
  v_hero_subtitle_id   text := gen_random_uuid()::text;
  v_hero_desc_id       text := gen_random_uuid()::text;
  v_hero_bg_id         text := gen_random_uuid()::text;
  v_contact_phone_id   text := gen_random_uuid()::text;
  v_contact_email_id   text := gen_random_uuid()::text;
  v_address_ar_id      text := gen_random_uuid()::text;
  v_address_en_id      text := gen_random_uuid()::text;
  v_hours_ar_id        text := gen_random_uuid()::text;
  v_hours_en_id        text := gen_random_uuid()::text;
  v_linkedin_id        text := gen_random_uuid()::text;
  v_instagram_id       text := gen_random_uuid()::text;
  v_tiktok_id          text := gen_random_uuid()::text;
  v_whatsapp_id        text := gen_random_uuid()::text;
BEGIN
  IF EXISTS (SELECT 1 FROM models WHERE name = 'site_settings') THEN
    RAISE NOTICE 'site_settings model already exists — skipping';
    RETURN;
  END IF;

  -- Best-effort group lookup; NULL is fine if no Settings group exists.
  SELECT id INTO v_group_id FROM model_groups
  WHERE label_en = 'Settings' OR label_ar = 'الإعدادات' LIMIT 1;

  v_model_id := gen_random_uuid();

  INSERT INTO models (
    id, name, label_ar, label_en, icon, color, group_id,
    is_system, schema, maps_config, card_config, created_at, updated_at
  )
  VALUES (
    v_model_id,
    'site_settings',
    'إعدادات الموقع',
    'Website Settings',
    'globe',
    '#B8734F',
    v_group_id,
    true,
    jsonb_build_object(
      'sections', jsonb_build_array(jsonb_build_object(
        'id', v_section_id,
        'label_ar', 'إعدادات الموقع',
        'label_en', 'Website Settings',
        'order', 0,
        'is_base', true,
        'color', '#B8734F',
        'fields', jsonb_build_array(
          jsonb_build_object('id', v_hero_title_id,    'name', 'hero_title',       'label_ar', 'عنوان البطل',           'label_en', 'Hero Title',            'type', 'text',     'required', false, 'order', 0,  'section_id', v_section_id, 'width', 'half', 'show_in_table', true),
          jsonb_build_object('id', v_hero_subtitle_id, 'name', 'hero_subtitle',    'label_ar', 'العنوان الفرعي',        'label_en', 'Hero Subtitle',         'type', 'text',     'required', false, 'order', 1,  'section_id', v_section_id, 'width', 'half', 'show_in_table', true),
          jsonb_build_object('id', v_hero_desc_id,     'name', 'hero_description', 'label_ar', 'وصف البطل',             'label_en', 'Hero Description',      'type', 'textarea', 'required', false, 'order', 2,  'section_id', v_section_id, 'width', 'full', 'show_in_table', false),
          jsonb_build_object('id', v_hero_bg_id,       'name', 'hero_bg_image_url','label_ar', 'صورة خلفية البطل',      'label_en', 'Hero Background Image', 'type', 'url',      'required', false, 'order', 3,  'section_id', v_section_id, 'width', 'full', 'show_in_table', false),
          jsonb_build_object('id', v_contact_phone_id, 'name', 'contact_phone',    'label_ar', 'رقم التواصل',           'label_en', 'Contact Phone',         'type', 'phone',    'required', false, 'order', 4,  'section_id', v_section_id, 'width', 'half', 'show_in_table', true),
          jsonb_build_object('id', v_contact_email_id, 'name', 'contact_email',    'label_ar', 'البريد الإلكتروني',     'label_en', 'Contact Email',         'type', 'email',    'required', false, 'order', 5,  'section_id', v_section_id, 'width', 'half', 'show_in_table', true),
          jsonb_build_object('id', v_address_ar_id,    'name', 'address_ar',       'label_ar', 'العنوان (عربي)',        'label_en', 'Address (AR)',          'type', 'text',     'required', false, 'order', 6,  'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_address_en_id,    'name', 'address_en',       'label_ar', 'العنوان (إنجليزي)',     'label_en', 'Address (EN)',          'type', 'text',     'required', false, 'order', 7,  'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_hours_ar_id,      'name', 'hours_ar',         'label_ar', 'ساعات العمل (عربي)',    'label_en', 'Working Hours (AR)',    'type', 'text',     'required', false, 'order', 8,  'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_hours_en_id,      'name', 'hours_en',         'label_ar', 'ساعات العمل (إنجليزي)','label_en', 'Working Hours (EN)',    'type', 'text',     'required', false, 'order', 9,  'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_linkedin_id,      'name', 'linkedin_url',     'label_ar', 'لينكدإن',               'label_en', 'LinkedIn URL',          'type', 'url',      'required', false, 'order', 10, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_instagram_id,     'name', 'instagram_url',    'label_ar', 'إنستغرام',              'label_en', 'Instagram URL',         'type', 'url',      'required', false, 'order', 11, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_tiktok_id,        'name', 'tiktok_url',       'label_ar', 'تيك توك',               'label_en', 'TikTok URL',            'type', 'url',      'required', false, 'order', 12, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false),
          jsonb_build_object('id', v_whatsapp_id,      'name', 'whatsapp_phone',   'label_ar', 'رقم الواتساب',          'label_en', 'WhatsApp Phone',        'type', 'phone',    'required', false, 'order', 13, 'section_id', v_section_id, 'width', 'half', 'show_in_table', false)
        )
      )),
      'section_selector_field_id', null
    ),
    jsonb_build_object(
      'location_url_field_id', null,
      'manual_lat_field_id', null,
      'manual_lng_field_id', null,
      'pin_color_field_id', null,
      'pin_label_field_id', null,
      'click_action', 'popup',
      'popup_title_field_id', null,
      'popup_subtitle_field_id', null,
      'popup_badge_field_id', null,
      'popup_shown_field_ids', '[]'::jsonb,
      'map_style_json', null,
      'default_center_lat', null,
      'default_center_lng', null,
      'default_zoom', null
    ),
    jsonb_build_object(
      'title_field_id', v_hero_title_id,
      'subtitle_field_id', v_hero_subtitle_id,
      'badge_field_id', null,
      'shown_field_ids', '[]'::jsonb
    ),
    NOW(),
    NOW()
  );

  -- Seed one default record so the website renders out-of-the-box copy
  -- matching the current static index.html.
  INSERT INTO records (id, model_id, data, created_at, updated_at)
  VALUES (
    gen_random_uuid(),
    v_model_id,
    jsonb_build_object(
      'hero_title', 'وصل العقارية',
      'hero_subtitle', 'نقود المشهد العقاري بثقة واحتراف',
      'hero_description', 'شركة تجمع بين قوة السوق العقاري وعمق الخبرة في إدارة وتسويق العقارات الفاخرة بمعايير عالية الجودة',
      'contact_phone', '+966556546238',
      'contact_email', 'info@wassel.re',
      'address_ar', 'الرياض، المملكة العربية السعودية',
      'address_en', 'Riyadh, Saudi Arabia',
      'hours_ar', 'الأحد - الخميس: 9:00 ص - 6:00 م',
      'hours_en', 'Sunday - Thursday: 9:00 AM - 6:00 PM',
      'whatsapp_phone', '+966556546238'
    ),
    NOW(),
    NOW()
  );
END $$;

-- ─── 3. Public-read RLS for the website ──────────────────────────────────
--
-- The `anon` role gets a narrow SELECT-only window: only records belonging
-- to all_projects + site_settings, and only those two model rows. Everything
-- else stays gated behind the existing authenticated policies.
--
-- Existing policies on records/models are `TO authenticated` only — adding
-- `TO anon` policies doesn't broaden authenticated access, since RLS
-- evaluates per role.

DROP POLICY IF EXISTS "records_public_website_read" ON public.records;
CREATE POLICY "records_public_website_read"
  ON public.records FOR SELECT TO anon
  USING (
    -- site_settings is the website's own config — always readable. The
    -- singleton-record convention means there's nothing sensitive to gate.
    model_id IN (SELECT id FROM public.models WHERE name = 'site_settings')
    OR
    -- all_projects is opt-in: only rows the admin has explicitly toggled
    -- on (`is_public` checkbox) leak to the public website.
    (
      model_id IN (SELECT id FROM public.models WHERE name = 'all_projects')
      AND COALESCE((data->>'is_public')::boolean, false) = true
    )
  );

DROP POLICY IF EXISTS "models_public_website_read" ON public.models;
CREATE POLICY "models_public_website_read"
  ON public.models FOR SELECT TO anon
  USING (name IN ('all_projects', 'site_settings'));

-- Anon needs base table-level SELECT privilege before RLS can let any rows
-- through. Without these GRANTs the policies above are no-ops.
GRANT SELECT ON public.records TO anon;
GRANT SELECT ON public.models  TO anon;

COMMIT;
