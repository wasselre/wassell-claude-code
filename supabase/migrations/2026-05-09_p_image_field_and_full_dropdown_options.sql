-- ============================================================================
-- Two website-related polish changes.
--
-- 1. all_projects.image_url: type `url` → `image`. The CRM's image field type
--    (added in the marketing rebuild) provides a drop-zone uploader, sends
--    the file to the public-read marketing-assets Storage bucket, and stores
--    the resulting public URL as the field value. Field shape stays as a
--    string URL so the website's <img src=...> rendering needs zero
--    changes; existing values (if any) carry over untouched. Defaults the
--    upload folder to "reference" and limits to 10 MB / png+jpeg+webp.
--
-- 2. site_settings "بطاقة الخريطة" dropdowns: refresh option lists from
--    all_projects' CURRENT schema and drop the type filter so EVERY field
--    is selectable, including mirrors, assignees, and the website-side
--    fields like image_url and is_public. Saved selections are not
--    cleared — the dropdown UI still renders any saved value even when
--    it's no longer in the options array.
-- ============================================================================

BEGIN;

-- ─── 1. all_projects.image_url → image field ────────────────────────────────

UPDATE models
SET schema = jsonb_set(
  schema,
  '{sections}',
  (
    SELECT jsonb_agg(
      s || jsonb_build_object(
        'fields',
        (
          SELECT jsonb_agg(
            CASE
              WHEN f->>'name' = 'image_url' THEN
                f || jsonb_build_object(
                  'type',              'image',
                  'image_folder',      'reference',
                  'image_accept',      'image/png,image/jpeg,image/webp',
                  'image_max_size_mb', 10
                )
              ELSE f
            END
            ORDER BY (f->>'order')::int
          )
          FROM jsonb_array_elements(s->'fields') f
        )
      )
      ORDER BY (s->>'order')::int
    )
    FROM jsonb_array_elements(schema->'sections') s
  )
),
updated_at = NOW()
WHERE name = 'all_projects';

-- ─── 2. Refresh Map Card dropdown options from current all_projects fields ──

DO $$
DECLARE
  v_site_id            uuid;
  v_proj_model_id      uuid;
  v_field_options      jsonb;
BEGIN
  SELECT id INTO v_site_id       FROM models WHERE name = 'site_settings';
  SELECT id INTO v_proj_model_id FROM models WHERE name = 'all_projects';
  IF v_site_id IS NULL OR v_proj_model_id IS NULL THEN RETURN; END IF;

  -- ALL fields this time — no type filter. The admin gets to pick from
  -- everything; non-renderable types just show empty when picked, and the
  -- website's "sticky override" logic keeps the slot empty rather than
  -- falling through to a heuristic.
  SELECT jsonb_agg(
    jsonb_build_object(
      'id',       gen_random_uuid()::text,
      'value',    f->>'name',
      'label_ar', COALESCE(f->>'label_ar', f->>'name'),
      'label_en', COALESCE(f->>'label_en', f->>'label_ar', f->>'name')
    )
    ORDER BY (f->>'order')::int
  )
  INTO v_field_options
  FROM models m,
       jsonb_array_elements(m.schema->'sections') sec,
       jsonb_array_elements(sec->'fields') f
  WHERE m.id = v_proj_model_id;

  IF v_field_options IS NULL THEN v_field_options := '[]'::jsonb; END IF;

  -- Replace `options` on every Map Card dropdown. Saved values on records
  -- aren't touched; the CRM dropdown UI keeps rendering them even when
  -- they're outside the new options array.
  UPDATE models
  SET schema = jsonb_set(
    schema,
    '{sections}',
    (
      SELECT jsonb_agg(
        CASE
          WHEN s->>'label_ar' = 'بطاقة الخريطة' THEN
            s || jsonb_build_object(
              'fields',
              (
                SELECT jsonb_agg(
                  CASE
                    WHEN f->>'name' IN (
                      'card_status_field', 'card_chip1_field',
                      'card_chip2_field',  'card_chip3_field',
                      'card_price_field',  'card_cta_url_field'
                    ) THEN f || jsonb_build_object('options', v_field_options)
                    ELSE f
                  END
                  ORDER BY (f->>'order')::int
                )
                FROM jsonb_array_elements(s->'fields') f
              )
            )
          ELSE s
        END
        ORDER BY (s->>'order')::int
      )
      FROM jsonb_array_elements(schema->'sections') s
    )
  ),
  updated_at = NOW()
  WHERE id = v_site_id;
END $$;

COMMIT;
