-- UAE geography, step 2 of 3: publish the country tier to the location cascade.
--
-- APPLY ONLY AFTER the LocationCascadeField default-fallback fix is deployed to
-- production. See the header of `2026-07-30_uae_geography_country_tier.sql` for why:
-- 64k records carry region/city/district with no `country` key, and the old cascade
-- rendered an empty candidate list whenever a parent level had no selection.
--
-- `regions` is a FROZEN model, so per CLAUDE.md this does the JSONB schema update and
-- then regenerates the frozen artifacts (the `_v` view + the four RLS policies) and
-- the unified_records UNION. The column itself already exists from step 1.

BEGIN;

-- ── 1. Mirror the column into the frozen model's JSONB schema ───────────────
-- Inserted at order 3 (right before country_code); the trailing fields' `order` is
-- bumped so the form doesn't end up with two fields claiming the same slot.
DO $$
DECLARE
  v_sec    text;
  v_fields jsonb;
  v_new    jsonb;
BEGIN
  SELECT schema->'sections'->0->>'id', schema->'sections'->0->'fields'
    INTO v_sec, v_fields
  FROM public.models WHERE name = 'regions';

  IF v_fields IS NULL THEN
    RAISE EXCEPTION 'regions model has no fields — refusing to patch schema';
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_fields) f WHERE f->>'name' = 'country_lookup') THEN
    RAISE NOTICE 'regions.country_lookup already in schema — skipping';
  ELSE
    SELECT jsonb_agg(
             CASE WHEN (f->>'order')::int >= 3
                  THEN jsonb_set(f, '{order}', to_jsonb(((f->>'order')::int) + 1))
                  ELSE f END
             ORDER BY (f->>'order')::int
           )
      INTO v_fields
    FROM jsonb_array_elements(v_fields) f;

    v_new := jsonb_build_object(
      'id',                   'd15a0001-f1d0-4000-8001-000000000008',
      'name',                 'country_lookup',
      'type',                 'lookup',
      'order',                3,
      'width',                'half',
      'label_ar',             'الدولة',
      'label_en',             'Country',
      'required',             false,
      'section_id',           v_sec,
      'show_in_table',        true,
      'lookup_model_id',      'd15a0001-0000-4000-8000-000000000003',
      'lookup_display_field', 'name_ar'
    );

    UPDATE public.models
    SET schema = jsonb_set(schema, '{sections,0,fields}', v_fields || jsonb_build_array(v_new))
    WHERE name = 'regions';
  END IF;
END $$;

-- ── 2. Teach every location field to filter regions by the chosen country ───
-- A loop, not one UPDATE…FROM: a model with two location fields would only get one
-- of them patched by a set-returning join (Postgres applies a single matching row).
DO $$
DECLARE
  r         record;
  v_schema  jsonb;
  v_patched int := 0;
BEGIN
  FOR r IN SELECT m.id, m.name, m.schema FROM public.models m WHERE m.schema::text LIKE '%location_levels%'
  LOOP
    v_schema := r.schema;
    FOR i IN 0 .. jsonb_array_length(v_schema->'sections') - 1 LOOP
      FOR j IN 0 .. jsonb_array_length(v_schema->'sections'->i->'fields') - 1 LOOP
        IF v_schema->'sections'->i->'fields'->j->>'type' = 'location'
           AND v_schema->'sections'->i->'fields'->j->'location_levels' @> '[{"key":"region"}]'::jsonb THEN
          v_schema := jsonb_set(
            v_schema,
            ARRAY['sections', i::text, 'fields', j::text, 'location_levels'],
            (SELECT jsonb_agg(
                      CASE WHEN lvl->>'key' = 'region'
                           THEN lvl || jsonb_build_object('parent_link_field', 'country_lookup')
                           ELSE lvl END
                      ORDER BY ord)
             FROM jsonb_array_elements(v_schema->'sections'->i->'fields'->j->'location_levels')
                  WITH ORDINALITY AS l(lvl, ord))
          );
          v_patched := v_patched + 1;
        END IF;
      END LOOP;
    END LOOP;
    IF v_schema IS DISTINCT FROM r.schema THEN
      UPDATE public.models SET schema = v_schema WHERE id = r.id;
    END IF;
  END LOOP;
  RAISE NOTICE 'location fields patched with region→country_lookup: %', v_patched;
END $$;

-- ── 3. Rebuild the view chain, top down ─────────────────────────────────────
--
-- NEITHER freeze helper uses CASCADE, and both drops now have dependents:
-- regenerate_frozen_model_artifacts() does a plain `DROP VIEW regions_v`, which
-- unified_records is built on, and rebuild_unified_records() does a plain
-- `DROP VIEW unified_records`, which v_our_projects_scope — added long after the
-- freeze tooling was written — is built on. Calling them directly fails with
-- SQLSTATE 2BP01. So unwind the stack explicitly and rebuild it in reverse.
--
-- Inside this transaction the drops hold ACCESS EXCLUSIVE, so concurrent readers
-- block until COMMIT rather than seeing a missing view.
--
-- Grants are not restored by hand: Supabase's ALTER DEFAULT PRIVILEGES grants
-- anon/authenticated/service_role on any new view in public, which is what the
-- dropped views had. reloptions ARE preserved deliberately — v_our_projects_scope is
-- NOT security_invoker (unlike unified_records and regions_v), and flipping that
-- would silently change whose RLS applies to the website's project feed.
--
-- ANY future schema change to a frozen model needs this same unwind. Worth
-- remembering before reaching for the CLAUDE.md migration template, which still
-- shows the two helper calls on their own.
DROP VIEW IF EXISTS public.v_our_projects_scope;
DROP VIEW IF EXISTS public.unified_records;

SELECT public.regenerate_frozen_model_artifacts(
  (SELECT id FROM public.models WHERE name = 'regions')
);
SELECT public.rebuild_unified_records();

CREATE VIEW public.v_our_projects_scope AS
 SELECT op.id AS our_project_id,
    ap.id AS project_id,
    (ap.data ->> 'project_name'::text) AS project_name_ar,
    (ap.data ->> 'project_name_en'::text) AS project_name_en,
    (NULLIF((ap.data ->> 'developer'::text), ''::text))::uuid AS developer_record_id,
    (dev.data ->> 'name'::text) AS developer_name,
    (ap.data ->> 'city_name'::text) AS city,
    (ap.data ->> 'project_location'::text) AS location_text,
    (ap.data ->> 'project_page_url'::text) AS project_page_url,
    (ap.data ->> 'brochure_link'::text) AS brochure_url,
    (ap.data ->> 'project_status'::text) AS project_status,
    (ap.data ->> 'project_id'::text) AS external_project_id,
    (op.data ->> 'portfolio_status'::text) AS portfolio_status,
    (op.data ->> 'sales_priority'::text) AS sales_priority,
    ((op.data ->> 'show_on_website'::text))::boolean AS show_on_website,
    op.created_at AS scoped_since,
    (dev.data ->> 'website'::text) AS developer_website,
    (dev.data ->> 'phone'::text) AS developer_phone
   FROM ((unified_records op
     JOIN unified_records ap ON (((ap.id = (NULLIF((op.data ->> 'project'::text), ''::text))::uuid) AND (ap.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'::uuid))))
     LEFT JOIN unified_records dev ON (((dev.id = (NULLIF((ap.data ->> 'developer'::text), ''::text))::uuid) AND (dev.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'::uuid))))
  WHERE (op.model_id = '6609286a-f95a-45db-94e6-48cfa915ccbd'::uuid);

COMMIT;
