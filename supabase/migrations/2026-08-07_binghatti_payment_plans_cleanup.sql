-- 2026-08-07  Binghatti (بن غاطي) payment-plans cleanup
-- =====================================================================
-- Developer 759fa833-e60e-4775-86ab-292005c8d517 = بن غاطي (Binghatti).
-- all_projects is UNFROZEN (JSONB in `records`), so we write records.data
-- directly + the shared model schema. Verified before writing:
--   * only Binghatti populates payment_plan_schedule (33 rows),
--   * 0 records use the field's declared {milestone,percent,due_at} columns,
--   * no code reads the field / its column slugs / the two headline fields.
--
-- Problems fixed:
--  A. payment_plan_schedule rows use keys {n,down,before,on,after,price} while
--     the field's table_columns were {milestone,percent,due_at,notes}, so the
--     Payment Schedule table rendered COMPLETELY BLANK (TableField reads
--     row[col.name]). Redefine the columns to the real semantics and reshape
--     each row: add _row_id, numeric values, drop the always-null `price` and
--     the always-zero `after`->post_handover stays but is now a real column.
--     Column mapping (confirmed 1:1 vs payment_plan_summary on every row):
--       down   -> مقدم (down payment %)
--       before -> أثناء الإنشاء (during construction %)
--       on     -> عند التسليم (on handover %)
--       after  -> بعد التسليم (post-handover %)
--  B. down_payment_percent / on_handover_percent were copied from an arbitrary
--     plan[0] (Ghost/Wraith showed 100% down while a 20% plan existed).
--     Re-derive from the ENTRY plan = lowest down %, tie-break highest
--     on-handover % (the most customer-attractive offer).
--  C. Collapse duplicate plans to the distinct set; regenerate
--     payment_plan_summary from that set so summary and schedule agree; clear
--     all-zero degenerate plans (Trillionaire) to missing (not a fake 0% plan).
--
-- Idempotent: every data step is guarded on the OLD row shape (`? 'n'`), so a
-- re-run is a no-op once reshaped.

-- ---- backups --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public._backup_binghatti_pp_20260807 AS
SELECT r.id, r.data
FROM records r JOIN models m ON m.id = r.model_id
WHERE m.name = 'all_projects'
  AND r.data->>'developer' = '759fa833-e60e-4775-86ab-292005c8d517';

CREATE TABLE IF NOT EXISTS public._backup_all_projects_schema_20260807 AS
SELECT id, schema FROM models WHERE name = 'all_projects';

-- ---- C(a): clear degenerate all-zero plans (old shape only) ---------------
UPDATE records r
SET data = r.data - 'payment_plan_schedule' - 'payment_plan_summary'
                  - 'down_payment_percent' - 'on_handover_percent'
FROM models m
WHERE r.model_id = m.id AND m.name = 'all_projects'
  AND r.data->>'developer' = '759fa833-e60e-4775-86ab-292005c8d517'
  AND jsonb_typeof(r.data->'payment_plan_schedule') = 'array'
  AND (r.data->'payment_plan_schedule'->0) ? 'n'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r.data->'payment_plan_schedule') e
    WHERE COALESCE((e->>'down')::numeric,0) + COALESCE((e->>'before')::numeric,0)
        + COALESCE((e->>'on')::numeric,0)   + COALESCE((e->>'after')::numeric,0) > 0
  );

-- ---- A + B + C: reshape, dedupe, regenerate summary, re-derive headlines ---
WITH bng AS (
  SELECT r.id, r.data->'payment_plan_schedule' AS sched
  FROM records r JOIN models m ON m.id = r.model_id
  WHERE m.name = 'all_projects'
    AND r.data->>'developer' = '759fa833-e60e-4775-86ab-292005c8d517'
    AND jsonb_typeof(r.data->'payment_plan_schedule') = 'array'
    AND jsonb_array_length(r.data->'payment_plan_schedule') > 0
    AND (r.data->'payment_plan_schedule'->0) ? 'n'        -- old shape only (idempotency guard)
),
rn AS (
  SELECT b.id,
         COALESCE((e->>'down')::numeric,0)   AS down,
         COALESCE((e->>'before')::numeric,0) AS during,
         COALESCE((e->>'on')::numeric,0)     AS on_h,
         COALESCE((e->>'after')::numeric,0)  AS post,
         ord
  FROM bng b, jsonb_array_elements(b.sched) WITH ORDINALITY t(e, ord)
),
valid AS (                                                 -- drop all-zero rows
  SELECT * FROM rn WHERE down + during + on_h + post > 0
),
dedup AS (                                                 -- keep first of each distinct plan
  SELECT DISTINCT ON (id, down, during, on_h, post) id, down, during, on_h, post, ord
  FROM valid ORDER BY id, down, during, on_h, post, ord
),
ranked AS (                                                -- renumber by original order
  SELECT id, down, during, on_h, post,
         row_number() OVER (PARTITION BY id ORDER BY ord) AS pno
  FROM dedup
),
agg AS (
  SELECT id,
    jsonb_agg(jsonb_build_object(
      '_row_id', gen_random_uuid()::text,
      'plan', pno::text,
      'down', down,
      'during_construction', during,
      'on_handover', on_h,
      'post_handover', post
    ) ORDER BY pno) AS new_sched,
    string_agg(
      'خطة ' || pno || ': ' || array_to_string(ARRAY[
        CASE WHEN down   > 0 THEN trim(to_char(down,  'FM99990.###')) || '% مقدم' END,
        CASE WHEN during > 0 THEN trim(to_char(during,'FM99990.###')) || '% أثناء الإنشاء' END,
        CASE WHEN on_h   > 0 THEN trim(to_char(on_h,  'FM99990.###')) || '% عند التسليم' END,
        CASE WHEN post   > 0 THEN trim(to_char(post,  'FM99990.###')) || '% بعد التسليم' END
      ], ' / '),
      E'\n' ORDER BY pno) AS new_summary
  FROM ranked GROUP BY id
),
featured AS (                                              -- entry plan: lowest down, tie-break highest on-handover
  SELECT DISTINCT ON (id) id, down AS f_down, on_h AS f_on
  FROM ranked ORDER BY id, down ASC, on_h DESC
)
UPDATE records r
SET data = r.data
         || jsonb_build_object('payment_plan_schedule', a.new_sched)
         || jsonb_build_object('payment_plan_summary',  a.new_summary)
         || jsonb_build_object('down_payment_percent',  f.f_down)
         || jsonb_build_object('on_handover_percent',   f.f_on)
FROM agg a JOIN featured f USING (id)
WHERE r.id = a.id;

-- ---- A: redefine the shared field's columns to the real semantics ---------
UPDATE models m
SET schema = jsonb_set(schema, '{sections}', (
  SELECT jsonb_agg(
    CASE WHEN s ? 'fields'
      THEN jsonb_set(s, '{fields}', (
        SELECT jsonb_agg(
          CASE WHEN f->>'name' = 'payment_plan_schedule'
            THEN jsonb_set(f, '{table_columns}', $cols$[
              {"id":"a1111111-0000-4000-8000-000000000001","name":"plan","type":"text","label_ar":"الخطة","label_en":"Plan"},
              {"id":"a1111111-0000-4000-8000-000000000002","name":"down","type":"number","label_ar":"مقدم %","label_en":"Down %"},
              {"id":"a1111111-0000-4000-8000-000000000003","name":"during_construction","type":"number","label_ar":"أثناء الإنشاء %","label_en":"During Construction %"},
              {"id":"a1111111-0000-4000-8000-000000000004","name":"on_handover","type":"number","label_ar":"عند التسليم %","label_en":"On Handover %"},
              {"id":"a1111111-0000-4000-8000-000000000005","name":"post_handover","type":"number","label_ar":"بعد التسليم %","label_en":"Post-Handover %"}
            ]$cols$::jsonb)
            ELSE f END)
        FROM jsonb_array_elements(s->'fields') f))
      ELSE s END)
  FROM jsonb_array_elements(schema->'sections') s))
WHERE m.name = 'all_projects';
