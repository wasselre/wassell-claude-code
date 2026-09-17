-- ============================================================================
-- Step names: the writer's check of the design is «مراجعة التصميم». 2026-09-17.
--
-- Operator: the step where the writer reviews the finished design was called
-- «مراجعة الكاتب» in the progress bar and «مراجعة الكتابة» on its «مهامي»
-- button — it is a DESIGN review. It is now «مراجعة التصميم» / Design review.
-- The final step, which carried that name, is «الاعتماد النهائي» / Final
-- approval, the name its button already used — so no two steps share a name.
--
-- Labels only: step keys, roles and order are untouched, so pinned in-flight
-- work keeps its exact path. Both the versions (what the progress bar reads)
-- and the workflows' live metadata are updated.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.relabel_steps(p_steps jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(
           CASE s->>'key'
             WHEN 'design_writer_review' THEN s || '{"label_ar":"مراجعة التصميم","label_en":"Design review"}'::jsonb
             WHEN 'design_review'        THEN s || '{"label_ar":"الاعتماد النهائي","label_en":"Final approval"}'::jsonb
             ELSE s END
           ORDER BY ord), '[]'::jsonb)
    FROM jsonb_array_elements(p_steps) WITH ORDINALITY AS e(s, ord)
$$;

UPDATE public.workflow_versions wv
   SET definition = jsonb_set(wv.definition, '{metadata,steps}',
                              pg_temp.relabel_steps(wv.definition->'metadata'->'steps'))
 WHERE jsonb_typeof(wv.definition->'metadata'->'steps') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(wv.definition->'metadata'->'steps') s
                WHERE s->>'key' IN ('design_writer_review', 'design_review'));

UPDATE public.workflows w
   SET metadata = jsonb_set(w.metadata, '{steps}', pg_temp.relabel_steps(w.metadata->'steps'))
 WHERE jsonb_typeof(w.metadata->'steps') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(w.metadata->'steps') s
                WHERE s->>'key' IN ('design_writer_review', 'design_review'));

UPDATE public.mos_step_rules
   SET label_ar = 'مراجعة التصميم', label_en = 'Design review', updated_at = now()
 WHERE step_key = 'design_writer_review';
UPDATE public.mos_step_rules
   SET label_ar = 'الاعتماد النهائي', label_en = 'Final approval', updated_at = now()
 WHERE step_key = 'design_review';

COMMIT;
