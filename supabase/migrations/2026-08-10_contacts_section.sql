-- Contacts (جهات الاتصال) — 2026-08-10
--
-- Promotes the dormant `contacts` model into a first-class top-level section.
--
-- Background: `contacts` was created in the Builder on 2026-04-18 (3 fields:
-- name / phone / position), parked inside the «المبيعات» group, and then hidden
-- from the UI on 2026-07-22 by ARCHIVED_MODULE_MODELS. Its 2 records survived.
-- The user now wants it back as its own section: a plain address book for people
-- who are NEITHER clients NOR real-estate advertisers — just a name and a number.
--
-- What this does:
--   1. Moves the model to the top level (group_id NULL) so it gets its own
--      sidebar entry, right after `advertisers` (the other "people" model).
--   2. Fixes the Arabic label («جهات الإتصال» → «جهات الاتصال») and gives it a
--      real icon instead of the generic `database` fallback.
--   3. Extends the schema — name + phone become REQUIRED (they are the whole
--      point of the model), and company / email / notes are added alongside the
--      existing `position`. Existing field ids are PRESERVED so the 2 live
--      records keep their values.
--   4. Sets `duplicate_check_field_id` to phone, so creating a contact whose
--      number already exists raises the duplicate warning instead of silently
--      making a second card for the same person.
--   5. Fills card_config (list/card view was showing an unlabelled card).
--   6. Grants the model to «مدير مبيعات» — the one profile that can reach the
--      WhatsApp inbox (and therefore the new "Add new contact" button) but had
--      no contacts grant. The other three chat-capable profiles already have it.
--
-- Backward compatible: additive schema change on an unfrozen (JSONB) model, so
-- it is safe to apply before the code that surfaces the section ships.

BEGIN;

UPDATE public.models
SET
  label_ar = 'جهات الاتصال',
  label_en = 'Contacts',
  icon     = 'contact',
  group_id = NULL,
  "order"  = 52,
  card_config = jsonb_build_object(
    'title_field_id',    '6e91fa58-a2fe-444c-8bd0-82b752d663a8',
    'subtitle_field_id', '19924026-be95-42a3-8a51-3fbd40d91951',
    'badge_field_id',    NULL,
    'shown_field_ids',   jsonb_build_array(
      'c0a7ac70-0000-4000-8000-000000000001',
      '765e1549-e687-4602-85cd-0e608705d9b5'
    )
  ),
  schema = jsonb_build_object(
    'section_selector_field_id', NULL,
    -- Phone is the identity of a contact — warn before creating a second card.
    'duplicate_check_field_id', '19924026-be95-42a3-8a51-3fbd40d91951',
    'sections', jsonb_build_array(
      jsonb_build_object(
        'id',       '182b83aa-faf1-412b-872e-3d3ad38bc90a',
        'label_ar', 'معلومات جهة الاتصال',
        'label_en', 'Contact Info',
        'order',    0,
        'is_base',  true,
        'color',    '#B8734F',
        'fields',   jsonb_build_array(
          jsonb_build_object(
            'id', '6e91fa58-a2fe-444c-8bd0-82b752d663a8',
            'name', 'name', 'label_ar', 'الاسم', 'label_en', 'Name',
            'type', 'text', 'required', true, 'order', 0,
            'section_id', '182b83aa-faf1-412b-872e-3d3ad38bc90a',
            'width', 'half', 'show_in_table', true
          ),
          jsonb_build_object(
            'id', '19924026-be95-42a3-8a51-3fbd40d91951',
            'name', 'phone', 'label_ar', 'رقم الجوال', 'label_en', 'Phone Number',
            'type', 'phone', 'required', true, 'order', 1,
            'section_id', '182b83aa-faf1-412b-872e-3d3ad38bc90a',
            'width', 'half', 'show_in_table', true,
            'default_country_code', '+966'
          ),
          jsonb_build_object(
            'id', 'c0a7ac70-0000-4000-8000-000000000001',
            'name', 'company', 'label_ar', 'الجهة / الشركة', 'label_en', 'Company / Organization',
            'type', 'text', 'required', false, 'order', 2,
            'section_id', '182b83aa-faf1-412b-872e-3d3ad38bc90a',
            'width', 'half', 'show_in_table', true
          ),
          jsonb_build_object(
            'id', '765e1549-e687-4602-85cd-0e608705d9b5',
            'name', 'position', 'label_ar', 'المنصب', 'label_en', 'Position',
            'type', 'text', 'required', false, 'order', 3,
            'section_id', '182b83aa-faf1-412b-872e-3d3ad38bc90a',
            'width', 'half', 'show_in_table', true
          ),
          jsonb_build_object(
            'id', 'c0a7ac70-0000-4000-8000-000000000002',
            'name', 'email', 'label_ar', 'البريد الإلكتروني', 'label_en', 'Email',
            'type', 'email', 'required', false, 'order', 4,
            'section_id', '182b83aa-faf1-412b-872e-3d3ad38bc90a',
            'width', 'half', 'show_in_table', false
          ),
          jsonb_build_object(
            'id', 'c0a7ac70-0000-4000-8000-000000000003',
            'name', 'notes', 'label_ar', 'ملاحظات', 'label_en', 'Notes',
            'type', 'textarea', 'required', false, 'order', 5,
            'section_id', '182b83aa-faf1-412b-872e-3d3ad38bc90a',
            'width', 'full', 'show_in_table', false
          )
        )
      )
    )
  ),
  updated_at = now()
WHERE id = 'f08c674a-0808-4c5e-8421-101d76b30187';

-- «مدير مبيعات» can open the WhatsApp inbox but had no contacts grant, so the
-- new "Add new contact" button would have been rejected by RLS on save.
UPDATE public.profiles
SET model_permissions = model_permissions || jsonb_build_array(
      jsonb_build_object(
        'model_id', 'f08c674a-0808-4c5e-8421-101d76b30187',
        'permissions', jsonb_build_array('view', 'create', 'edit', 'delete', 'import', 'export')
      )
    ),
    updated_at = now()
WHERE id = 'b27f9903-48f7-4570-b115-b54a3bb72e54'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(model_permissions) mp
    WHERE mp->>'model_id' = 'f08c674a-0808-4c5e-8421-101d76b30187'
  );

COMMIT;
