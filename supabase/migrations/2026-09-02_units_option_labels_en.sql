-- Fill the English option labels on the `units` model that were left holding
-- Arabic text (so a unit's English PDF / English chat message renders English
-- component/facade/floor chips instead of Arabic). Model-schema option labels
-- are NOT part of the durable record-value translation pipeline, so they are
-- corrected directly here. Idempotent: re-running sets the same values.
--
-- Scope confirmed from live data (2026-09-02): only the `units` model had
-- options with Arabic in label_en (facade, floor, unit_components); all_projects
-- / our_projects were already fully bilingual.

BEGIN;

WITH mapping(field, value, en) AS (
  VALUES
    ('facade',          'جانبية',                          'Side'),
    ('floor',           'الروف',                           'Roof'),
    ('unit_components', 'بيت-ذكي',                         'Smart Home'),
    ('unit_components', 'تراس',                            'Terrace'),
    ('unit_components', 'تكييف-مخفي-مجهز-مسبقا',           'Pre-installed Concealed A/C'),
    ('unit_components', 'حديقة',                           'Garden'),
    ('unit_components', 'حمام-رييسي',                      'Master Bathroom'),
    ('unit_components', 'حمام-ضيوف',                       'Guest Bathroom'),
    ('unit_components', 'حمام-غرفة-النوم-الرييسية',        'En-suite Bathroom'),
    ('unit_components', 'غرفة-نوم-رييسية',                 'Master Bedroom'),
    ('unit_components', 'فتحة-سماوية',                     'Skylight'),
    ('unit_components', 'مدخل-جانبي',                      'Side Entrance'),
    ('unit_components', 'مدخل-خاص',                        'Private Entrance'),
    ('unit_components', 'مستودع',                          'Storage Room'),
    ('unit_components', 'مصعد',                            'Elevator'),
    ('unit_components', 'مطبخ-مجهز-مسبقا',                'Pre-fitted Kitchen')
)
UPDATE public.models m
SET schema = jsonb_set(
  m.schema,
  '{sections}',
  (
    SELECT jsonb_agg(
      CASE WHEN sec ? 'fields' THEN jsonb_set(sec, '{fields}', (
        SELECT jsonb_agg(
          CASE WHEN fld ? 'options' THEN jsonb_set(fld, '{options}', (
            SELECT jsonb_agg(
              CASE
                WHEN (SELECT en FROM mapping mp WHERE mp.field = fld->>'name' AND mp.value = opt->>'value') IS NOT NULL
                THEN jsonb_set(opt, '{label_en}', to_jsonb((SELECT en FROM mapping mp WHERE mp.field = fld->>'name' AND mp.value = opt->>'value')))
                ELSE opt
              END
            )
            FROM jsonb_array_elements(fld->'options') opt
          )) ELSE fld END
        )
        FROM jsonb_array_elements(sec->'fields') fld
      )) ELSE sec END
    )
    FROM jsonb_array_elements(m.schema->'sections') sec
  )
)
WHERE m.name = 'units';

COMMIT;
