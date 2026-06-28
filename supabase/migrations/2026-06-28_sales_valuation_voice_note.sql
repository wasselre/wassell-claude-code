-- ============================================================================
-- Sales Valuation — voice note on a review's mistake notes
-- ============================================================================
-- Adds `coaching_voice_note` (text — stores the public URL of a recorded audio
-- clip in the marketing-assets bucket, folder voice-notes/) to the reviews
-- model's "تقييم المدير" section, right after `coaching_note`. The manager can
-- record a spoken note alongside (or instead of) the written one; the review
-- screen renders a recorder + playback control.
--
-- Unfrozen model → the models_view_sync trigger refreshes v_sales_valuation_reviews.
-- Idempotent.
-- ============================================================================

UPDATE public.models
SET schema = jsonb_set(
      schema,
      '{sections,1,fields}',
      (schema->'sections'->1->'fields') || jsonb_build_object(
        'id', '5a1e7a10-0502-4000-8000-000000000099',
        'name', 'coaching_voice_note',
        'label_ar', 'ملاحظة صوتية',
        'label_en', 'Voice Note',
        'type', 'text',
        'required', false,
        'order', 7,
        'section_id', '5a1e7a10-0502-4000-8000-000000000001',
        'width', 'full',
        'show_in_table', false
      )
    )
WHERE id = '5a1e7a10-0000-4000-8000-000000000001'
  AND NOT (schema->'sections'->1->'fields' @> '[{"name":"coaching_voice_note"}]'::jsonb);
