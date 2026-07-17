-- Unit-age (عمر العقار) client preference → finder algorithm (2026-07-17).
--
-- Market listings carry `age` as FREE TEXT from Aqar ("جديد" 31k, "أكثر من 10
-- سنوات", "سنتين", "5 سنوات", bare digits, "سنة ونصف", …). This migration:
--   1. wassell_parse_unit_age(text) → numeric years (IMMUTABLE; TS twin
--      `parseUnitAgeText` in api/_lib/matchAgent.ts — KEEP IN SYNC).
--   2. wassell_market_candidates_json gains p_max_age: drops only listings
--      whose PARSED age is known and over the max (null/unparseable ages are
--      kept — same missing-tolerant posture as budget/bedrooms/type; scoring
--      then applies the requested-but-missing honesty penalty).
--      NOTE: the new parameter changes the signature, so the old function is
--      DROPPED first (CREATE OR REPLACE would create an ambiguous overload).
--   3. clients model gains `preferred_max_unit_age` (dropdown: جديد فقط /
--      حتى سنتين / حتى 5 سنوات / حتى 10 سنوات; values '0','2','5','10').
-- Applied to wassell-prod 2026-07-17 via the Supabase MCP (unit_age_preference).

-- 1 ─ Age text → numeric years.
CREATE OR REPLACE FUNCTION public.wassell_parse_unit_age(p_age text)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_age IS NULL OR btrim(p_age) = '' THEN NULL
    WHEN p_age LIKE '%جديد%' THEN 0
    WHEN p_age LIKE '%سنتين%' OR p_age LIKE '%سنتان%' THEN 2
    WHEN translate(p_age, '٠١٢٣٤٥٦٧٨٩', '0123456789') ~ '[0-9]' THEN
      CASE WHEN p_age LIKE '%أكثر%'
        -- "أكثر من N سنوات" → N+1 (strictly over N).
        THEN public.try_numeric(regexp_replace(translate(p_age, '٠١٢٣٤٥٦٧٨٩', '0123456789'), '[^0-9]', '', 'g')) + 1
        ELSE public.try_numeric(regexp_replace(translate(p_age, '٠١٢٣٤٥٦٧٨٩', '0123456789'), '[^0-9]', '', 'g'))
      END
    -- Digit-less year words: "سنة" / "سنة واحدة" / "سنة ونصف" → 1.
    WHEN p_age LIKE '%سنة%' THEN 1
    ELSE NULL
  END
$$;

-- 2 ─ Market candidates RPC with the age filter.
DROP FUNCTION IF EXISTS public.wassell_market_candidates_json(uuid, text[], numeric, numeric, numeric, text[], integer, uuid[], text[]);

CREATE FUNCTION public.wassell_market_candidates_json(
  p_model_id uuid,
  p_district_ids text[],
  p_budget_min numeric DEFAULT NULL::numeric,
  p_budget_max numeric DEFAULT NULL::numeric,
  p_bedrooms numeric DEFAULT NULL::numeric,
  p_type_terms text[] DEFAULT NULL::text[],
  p_limit integer DEFAULT 4000,
  p_record_ids uuid[] DEFAULT NULL::uuid[],
  p_fields text[] DEFAULT NULL::text[],
  p_max_age numeric DEFAULT NULL::numeric)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '25s'
AS $function$
  with access as materialized (
    select public.wassell_view_scope_class(auth.uid(), p_model_id) as klass
  ),
  filtered as materialized (
    select r.id, r.data
    from public.records r
    cross join access a
    where a.klass <> 'none'
      and r.model_id = p_model_id
      and (
        (p_record_ids is not null and r.id = any(p_record_ids))
        or (p_record_ids is null and p_district_ids is not null
            and (r.data -> 'location' ->> 'district') = any(p_district_ids))
      )
      and (
        p_budget_max is null
        or (r.data ->> 'price') is null
        or (r.data ->> 'price') !~ '^[0-9]+(\.[0-9]+)?$'
        or (
          (r.data ->> 'price')::numeric <= p_budget_max
          and (p_budget_min is null or (r.data ->> 'price')::numeric >= p_budget_min)
        )
      )
      and (
        p_bedrooms is null
        or (r.data ->> 'bedrooms') is null
        or (r.data ->> 'bedrooms') !~ '^[0-9]+(\.[0-9]+)?$'
        or (r.data ->> 'bedrooms')::numeric = p_bedrooms
      )
      and (
        p_type_terms is null
        or (
          coalesce(r.data ->> 'property_type', '') = ''
          and coalesce(r.data ->> 'listing_type', '') = ''
          and coalesce(r.data ->> 'category', '') = ''
        )
        or exists (
          select 1 from unnest(p_type_terms) t
          where (r.data ->> 'property_type') ilike '%' || t || '%'
             or (r.data ->> 'listing_type') ilike '%' || t || '%'
             or (r.data ->> 'category') ilike '%' || t || '%'
        )
      )
      and (
        p_max_age is null
        or public.wassell_parse_unit_age(r.data ->> 'age') is null
        or public.wassell_parse_unit_age(r.data ->> 'age') <= p_max_age
      )
      and (case when a.klass = 'all' then true
                else public.wassell_can_view_record(auth.uid(), r.*) end)
  ),
  tot as (select count(*) as n from filtered)
  select jsonb_build_object(
    'total', (select n from tot),
    'rows', case
      when (select n from tot) > p_limit then '[]'::jsonb
      else coalesce(
        (select jsonb_agg(jsonb_build_object(
                  'id', f.id,
                  'data', case
                    when p_fields is null then f.data
                    else coalesce(
                      (select jsonb_object_agg(key, value)
                         from jsonb_each(f.data) where key = any(p_fields)),
                      '{}'::jsonb)
                  end
                ) order by f.id)
         from (select id, data from filtered order by id limit p_limit) f),
        '[]'::jsonb)
    end
  );
$function$;

-- 3 ─ clients.preferred_max_unit_age dropdown (appended to the section that
--     holds preferred_unit_type; idempotent).
DO $$
DECLARE
  v_model_id uuid;
  v_sidx int;
  v_section_id text;
BEGIN
  SELECT m.id, s.ord - 1, s.sec->>'id'
    INTO v_model_id, v_sidx, v_section_id
  FROM models m,
       LATERAL jsonb_array_elements(m.schema->'sections') WITH ORDINALITY s(sec, ord)
  WHERE m.name = 'clients'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.sec->'fields') f WHERE f->>'name' = 'preferred_unit_type')
  LIMIT 1;

  IF v_model_id IS NULL THEN
    RAISE EXCEPTION 'clients preferences section not found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
    WHERE m.id = v_model_id AND f->>'name' = 'preferred_max_unit_age'
  ) THEN
    RAISE NOTICE 'preferred_max_unit_age already exists — skipping';
    RETURN;
  END IF;

  UPDATE models m
  SET schema = jsonb_set(
    m.schema,
    ARRAY['sections', v_sidx::text, 'fields'],
    (m.schema->'sections'->v_sidx->'fields') || jsonb_build_object(
      'id', gen_random_uuid()::text,
      'name', 'preferred_max_unit_age',
      'label_ar', 'عمر العقار (حد أقصى)',
      'label_en', 'Unit age (max)',
      'type', 'dropdown',
      'required', false,
      'order', 99,
      'section_id', v_section_id,
      'width', 'half',
      'show_in_table', false,
      'options', jsonb_build_array(
        jsonb_build_object('id', gen_random_uuid()::text, 'label_ar', 'جديد فقط',      'label_en', 'New only',       'value', '0',  'color', '#C09B5F'),
        jsonb_build_object('id', gen_random_uuid()::text, 'label_ar', 'حتى سنتين',     'label_en', 'Up to 2 years',  'value', '2',  'color', '#B8734F'),
        jsonb_build_object('id', gen_random_uuid()::text, 'label_ar', 'حتى 5 سنوات',   'label_en', 'Up to 5 years',  'value', '5',  'color', '#8E4E3A'),
        jsonb_build_object('id', gen_random_uuid()::text, 'label_ar', 'حتى 10 سنوات',  'label_en', 'Up to 10 years', 'value', '10', 'color', '#4A4E54')
      )
    )
  )
  WHERE m.id = v_model_id;
END $$;
