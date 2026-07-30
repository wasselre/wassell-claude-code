-- Country stamp on cities + districts, so name resolution can be country-scoped.
--
-- WHY THIS MUST LAND BEFORE THE UAE DISTRICT IMPORT
--
-- `resolveRequestedDistrict` / `resolveRequestedCity` in api/_lib/matchAgent.ts resolve
-- a requested district/city by ILIKE over EVERY row, then fall back to `pool[0]` with
-- no ORDER BY. That is already non-deterministic inside Saudi Arabia — measured on
-- prod, «حي الخالدية» exists in 49 different cities, «حي النهضة» in 46, «حي النخيل» in
-- 34 — and today it merely picks an arbitrary Saudi city's district. The moment UAE
-- rows exist it becomes CROSS-BORDER: a Saudi client asking for النخيل could resolve
-- to a Dubai community and the Project Finder would score against the wrong geography,
-- silently.
--
-- `regions` already has country_lookup (2026-07-30). Cities and districts get a plain
-- `country_code` instead of another lookup: the resolver needs a cheap, indexable
-- equality filter on the row it already fetched, not a join up two levels.
--
-- Both models are FROZEN, so per CLAUDE.md this does the DDL and the models.schema
-- JSONB together, then unwinds and rebuilds the view chain.

BEGIN;

-- ── 1. DDL ──────────────────────────────────────────────────────────────────
ALTER TABLE public.cities    ADD COLUMN IF NOT EXISTS country_code text;
ALTER TABLE public.districts ADD COLUMN IF NOT EXISTS country_code text;
CREATE INDEX IF NOT EXISTS cities_country_code_idx    ON public.cities (country_code);
CREATE INDEX IF NOT EXISTS districts_country_code_idx ON public.districts (country_code);

-- ── 2. Mirror into each frozen model's JSONB schema ─────────────────────────
-- Appended at the end (order = max+1) rather than inserted mid-list: these are
-- reference models whose form ordering carries no meaning, and appending avoids
-- renumbering every field.
DO $$
DECLARE
  m         text;
  v_sec     text;
  v_fields  jsonb;
  v_next    int;
BEGIN
  FOREACH m IN ARRAY ARRAY['cities', 'districts'] LOOP
    SELECT schema->'sections'->0->>'id', schema->'sections'->0->'fields'
      INTO v_sec, v_fields
    FROM public.models WHERE name = m;

    IF v_fields IS NULL THEN
      RAISE EXCEPTION '% model has no fields — refusing to patch schema', m;
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_fields) f WHERE f->>'name' = 'country_code') THEN
      RAISE NOTICE '%.country_code already in schema — skipping', m;
      CONTINUE;
    END IF;

    SELECT coalesce(max((f->>'order')::int), -1) + 1 INTO v_next
    FROM jsonb_array_elements(v_fields) f;

    UPDATE public.models
    SET schema = jsonb_set(schema, '{sections,0,fields}', v_fields || jsonb_build_array(jsonb_build_object(
          'id',            md5('geo-country-code-field:' || m)::uuid::text,
          'name',          'country_code',
          'type',          'text',
          'order',         v_next,
          'width',         'half',
          'label_ar',      'رمز الدولة',
          'label_en',      'Country Code',
          'required',      false,
          'section_id',    v_sec,
          'show_in_table', false)))
    WHERE name = m;
  END LOOP;
END $$;

-- ── 3. Backfill: everything currently in there is Saudi ─────────────────────
UPDATE public.cities    SET country_code = 'SA' WHERE country_code IS NULL;
UPDATE public.districts SET country_code = 'SA' WHERE country_code IS NULL;

-- A row with no country can never be preferred by the resolver, so refuse to ship one.
DO $$
DECLARE v_c int; v_d int;
BEGIN
  SELECT count(*) INTO v_c FROM public.cities    WHERE country_code IS NULL;
  SELECT count(*) INTO v_d FROM public.districts WHERE country_code IS NULL;
  IF v_c > 0 OR v_d > 0 THEN
    RAISE EXCEPTION '% cities and % districts still have no country_code', v_c, v_d;
  END IF;
END $$;

-- ── 4. Unwind + rebuild the view chain (see CLAUDE.md "Frozen models") ──────
-- Neither freeze helper uses CASCADE, and both drops have dependents.
DROP VIEW IF EXISTS public.v_our_projects_scope;
DROP VIEW IF EXISTS public.unified_records;

SELECT public.regenerate_frozen_model_artifacts((SELECT id FROM public.models WHERE name = 'cities'));
SELECT public.regenerate_frozen_model_artifacts((SELECT id FROM public.models WHERE name = 'districts'));
SELECT public.rebuild_unified_records();

-- Restored with its ORIGINAL reloptions: v_our_projects_scope is deliberately NOT
-- security_invoker (unlike unified_records and the *_v views), and flipping that would
-- change whose RLS applies to the website's project feed.
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
