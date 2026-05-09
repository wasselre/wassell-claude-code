-- ============================================================================
-- Rename the three Map Card chip-slot labels.
--
-- Previously the three chip dropdowns advertised a role ("Chip 1 — Area",
-- "Chip 2 — Units", "Chip 3 — Phase"). The user prefers neutral numbered
-- labels — the chips are just slots, not type-bound — so rename to
-- "البطاقة الأولى/الثانية/الثالثة" / "Card 1/2/3". Field NAMES stay
-- unchanged (card_chip1_field, etc.) so saved records keep working.
-- Idempotent.
-- ============================================================================

BEGIN;

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
                  WHEN f->>'name' = 'card_chip1_field' THEN
                    f || jsonb_build_object('label_ar', 'البطاقة الأولى', 'label_en', 'Card 1')
                  WHEN f->>'name' = 'card_chip2_field' THEN
                    f || jsonb_build_object('label_ar', 'البطاقة الثانية', 'label_en', 'Card 2')
                  WHEN f->>'name' = 'card_chip3_field' THEN
                    f || jsonb_build_object('label_ar', 'البطاقة الثالثة', 'label_en', 'Card 3')
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
WHERE name = 'site_settings';

COMMIT;
