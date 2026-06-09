-- 2026-06-09 — Competitor reel analysis fields
-- ============================================================================
-- Adds the structured marketing-analysis fields to the `competitors` model
-- ("مكتبة المنافسين" / Competitor Library) so each reel_script row can carry a
-- cleaned transcript + the extracted thinking patterns (hook, angle, trigger,
-- structure, tone, CTA). These fields are the knowledge base the real-estate
-- copywriter agent retrieves over.
--
-- `competitors` is UNFROZEN (models.is_hardcoded = false), so this is a pure
-- JSONB schema edit on the `models` row — no DDL, no freeze artifacts. The
-- `models_view_sync` trigger regenerates `v_competitors` automatically because
-- we touch `schema`.
--
-- Idempotent: any field whose `name` is in the new set is stripped first, then
-- the canonical set is appended — re-running cannot duplicate fields.
--
-- Existing `content` (raw transcript) and `notes` (source metadata) are left
-- untouched.
-- ============================================================================

WITH new_fields AS (
  SELECT jsonb_build_array(
    -- Clean Transcript (Phase 1 output)
    jsonb_build_object(
      'id', gen_random_uuid()::text, 'name', 'clean_content', 'type', 'textarea',
      'label_ar', 'النص المنقّح', 'label_en', 'Clean Transcript',
      'required', false, 'order', 4, 'section_id', s.sid, 'width', 'full', 'show_in_table', false
    ),
    -- Hook (verbatim opening line)
    jsonb_build_object(
      'id', gen_random_uuid()::text, 'name', 'hook', 'type', 'textarea',
      'label_ar', 'الخطّاف (الجملة الافتتاحية)', 'label_en', 'Hook',
      'required', false, 'order', 5, 'section_id', s.sid, 'width', 'full', 'show_in_table', false
    ),
    -- Hook Type
    jsonb_build_object(
      'id', gen_random_uuid()::text, 'name', 'hook_type', 'type', 'dropdown',
      'label_ar', 'نوع الخطّاف', 'label_en', 'Hook Type',
      'required', false, 'order', 6, 'section_id', s.sid, 'width', 'half', 'show_in_table', true,
      'options', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'question',   'label_ar', 'سؤال',        'label_en', 'Question'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'curiosity',  'label_ar', 'فضول',        'label_en', 'Curiosity'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'shock',      'label_ar', 'صدمة',        'label_en', 'Shock'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'lifestyle',  'label_ar', 'نمط حياة',    'label_en', 'Lifestyle'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'investment', 'label_ar', 'فرصة استثمارية', 'label_en', 'Investment'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'problem',    'label_ar', 'طرح مشكلة',   'label_en', 'Problem'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'statement',  'label_ar', 'تصريح جريء',  'label_en', 'Statement')
      )
    ),
    -- Main Angle (multi)
    jsonb_build_object(
      'id', gen_random_uuid()::text, 'name', 'angle', 'type', 'multiselect',
      'label_ar', 'الزاوية الرئيسية', 'label_en', 'Main Angle',
      'required', false, 'order', 7, 'section_id', s.sid, 'width', 'full', 'show_in_table', false,
      'options', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'location',          'label_ar', 'الموقع',            'label_en', 'Location'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'luxury',            'label_ar', 'الفخامة',           'label_en', 'Luxury'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'privacy',           'label_ar', 'الخصوصية',          'label_en', 'Privacy'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'family',            'label_ar', 'الحياة العائلية',    'label_en', 'Family living'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'investment_return', 'label_ar', 'العائد الاستثماري',  'label_en', 'Investment return'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'exclusivity',       'label_ar', 'الحصرية',           'label_en', 'Exclusivity'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'space',             'label_ar', 'المساحة والرحابة',   'label_en', 'Space'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'design',            'label_ar', 'التصميم',           'label_en', 'Design'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'value',             'label_ar', 'القيمة مقابل السعر', 'label_en', 'Value'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'amenities',         'label_ar', 'الخدمات والمرافق',   'label_en', 'Amenities')
      )
    ),
    -- Psychological Trigger (multi)
    jsonb_build_object(
      'id', gen_random_uuid()::text, 'name', 'psych_trigger', 'type', 'multiselect',
      'label_ar', 'المحفّز النفسي', 'label_en', 'Psychological Trigger',
      'required', false, 'order', 8, 'section_id', s.sid, 'width', 'full', 'show_in_table', false,
      'options', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'status',      'label_ar', 'المكانة الاجتماعية', 'label_en', 'Status'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'fomo',        'label_ar', 'الخوف من فوات الفرصة', 'label_en', 'Fear of missing out'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'security',    'label_ar', 'الأمان',           'label_en', 'Security'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'comfort',     'label_ar', 'الراحة',           'label_en', 'Comfort'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'achievement', 'label_ar', 'الإنجاز',          'label_en', 'Achievement'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'pride',       'label_ar', 'الفخر',            'label_en', 'Pride'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'convenience', 'label_ar', 'السهولة والتيسير',  'label_en', 'Convenience'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'wealth',      'label_ar', 'الثراء',           'label_en', 'Wealth'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'belonging',   'label_ar', 'الانتماء',         'label_en', 'Belonging'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'aspiration',  'label_ar', 'الطموح',           'label_en', 'Aspiration')
      )
    ),
    -- Script Structure (beat breakdown)
    jsonb_build_object(
      'id', gen_random_uuid()::text, 'name', 'structure', 'type', 'textarea',
      'label_ar', 'بنية النص', 'label_en', 'Script Structure',
      'required', false, 'order', 9, 'section_id', s.sid, 'width', 'full', 'show_in_table', false
    ),
    -- Tone (multi)
    jsonb_build_object(
      'id', gen_random_uuid()::text, 'name', 'tone', 'type', 'multiselect',
      'label_ar', 'النبرة', 'label_en', 'Tone',
      'required', false, 'order', 10, 'section_id', s.sid, 'width', 'half', 'show_in_table', false,
      'options', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'luxury',       'label_ar', 'فاخرة',     'label_en', 'Luxury'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'premium',      'label_ar', 'راقية',     'label_en', 'Premium'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'urgent',       'label_ar', 'عاجلة',     'label_en', 'Urgent'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'friendly',     'label_ar', 'ودّية',      'label_en', 'Friendly'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'expert',       'label_ar', 'احترافية',  'label_en', 'Expert'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'educational',  'label_ar', 'تثقيفية',   'label_en', 'Educational'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'aspirational', 'label_ar', 'ملهمة',     'label_en', 'Aspirational'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'warm',         'label_ar', 'دافئة',     'label_en', 'Warm')
      )
    ),
    -- CTA (verbatim)
    jsonb_build_object(
      'id', gen_random_uuid()::text, 'name', 'cta', 'type', 'text',
      'label_ar', 'الدعوة لاتخاذ إجراء', 'label_en', 'CTA',
      'required', false, 'order', 11, 'section_id', s.sid, 'width', 'half', 'show_in_table', false
    ),
    -- CTA Type
    jsonb_build_object(
      'id', gen_random_uuid()::text, 'name', 'cta_type', 'type', 'dropdown',
      'label_ar', 'نوع الدعوة', 'label_en', 'CTA Type',
      'required', false, 'order', 12, 'section_id', s.sid, 'width', 'half', 'show_in_table', false,
      'options', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'book_visit',     'label_ar', 'احجز زيارة',    'label_en', 'Book a visit'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'contact',        'label_ar', 'تواصل معنا',    'label_en', 'Contact us'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'reserve',        'label_ar', 'احجز الآن',     'label_en', 'Reserve now'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'message',        'label_ar', 'أرسل رسالة',    'label_en', 'Send a message'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'whatsapp',       'label_ar', 'واتساب',        'label_en', 'WhatsApp'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'visit_location', 'label_ar', 'زورونا بالموقع', 'label_en', 'Visit location'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'learn_more',     'label_ar', 'اعرف المزيد',   'label_en', 'Learn more'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'none',           'label_ar', 'بدون دعوة',     'label_en', 'None')
      )
    ),
    -- Analysis Notes (model notes + flagged uncertain reconstructions)
    jsonb_build_object(
      'id', gen_random_uuid()::text, 'name', 'analysis_notes', 'type', 'textarea',
      'label_ar', 'ملاحظات التحليل', 'label_en', 'Analysis Notes',
      'required', false, 'order', 13, 'section_id', s.sid, 'width', 'full', 'show_in_table', false
    ),
    -- Processing Status (pipeline state) — colored for scannability
    jsonb_build_object(
      'id', gen_random_uuid()::text, 'name', 'processing_status', 'type', 'dropdown',
      'label_ar', 'حالة المعالجة', 'label_en', 'Processing Status',
      'required', false, 'order', 14, 'section_id', s.sid, 'width', 'half', 'show_in_table', true,
      'options', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'raw',      'label_ar', 'خام',      'label_en', 'Raw',      'color', '#9CA3AF'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'cleaned',  'label_ar', 'منقّح',     'label_en', 'Cleaned',  'color', '#60A5FA'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'analyzed', 'label_ar', 'محلَّل',     'label_en', 'Analyzed', 'color', '#34D399'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'reviewed', 'label_ar', 'مُراجَع',    'label_en', 'Reviewed', 'color', '#B8734F'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'skipped',  'label_ar', 'متجاوَز',   'label_en', 'Skipped',  'color', '#D1D5DB'),
        jsonb_build_object('id', gen_random_uuid()::text, 'value', 'error',    'label_ar', 'خطأ',      'label_en', 'Error',    'color', '#EF4444')
      )
    )
  ) AS arr
  FROM (SELECT m.schema->'sections'->0->>'id' AS sid FROM public.models m WHERE m.name = 'competitors') s
),
kept AS (
  SELECT m.id,
         COALESCE(
           (SELECT jsonb_agg(f ORDER BY (f->>'order')::int)
            FROM jsonb_array_elements(m.schema->'sections'->0->'fields') f
            WHERE f->>'name' NOT IN (
              'clean_content','hook','hook_type','angle','psych_trigger',
              'structure','tone','cta','cta_type','analysis_notes','processing_status'
            )),
           '[]'::jsonb
         ) AS kept_fields
  FROM public.models m WHERE m.name = 'competitors'
)
UPDATE public.models m
SET schema = jsonb_set(m.schema, '{sections,0,fields}', kept.kept_fields || new_fields.arr),
    updated_at = now()
FROM kept, new_fields
WHERE m.id = kept.id;

-- ============================================================================
-- "Clean & Analyze" custom button — fires POST /api/analyze-reel for the
-- current reel (action type `analyze_reel`, wired in RecordFormPage). Mirrors
-- the marketing_operations `generate_design` button. Idempotent: replaces the
-- whole custom_buttons array with this single button.
-- ============================================================================

UPDATE public.models
SET schema = jsonb_set(
      schema,
      '{custom_buttons}',
      jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid()::text,
        'label_ar', 'تنظيف وتحليل',
        'label_en', 'Clean & Analyze',
        'icon', 'sparkles',
        'color', '#B8734F',
        'locations', jsonb_build_array('record_form'),
        'action', jsonb_build_object('type', 'analyze_reel'),
        'enabled', true
      )),
      true
    ),
    updated_at = now()
WHERE name = 'competitors';
