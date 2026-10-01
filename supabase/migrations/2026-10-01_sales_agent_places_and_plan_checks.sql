-- Sales agent: detailed geography + floor-plan checks (2026-10-01).
--
-- 1. sales_agent_find_places(query) — a place the customer named («طريق الملك
--    سلمان», «الرياض بارك», «جامعة الأميرة نورة») → matching geo_elements in
--    the city, best match first. The agent's retrieval test showed it guessing
--    neighbouring districts for «near Riyadh Park» and missing 2 of 3 projects.
-- 2. sales_agent_project_distances(projects, elements | element types) — the
--    distance in km from each project's own coordinates to the NEAREST of the
--    given elements (roads as lines, malls/universities as polygons, metro
--    stations as points). Element types answer «any metro station».
-- 3. unit_plan_checks — the answer read from ONE floor-plan image for ONE
--    feature question, cached so a plan is read once per question.
--
-- All service-role only: the agent runs server-side.

BEGIN;

CREATE OR REPLACE FUNCTION public.sales_agent_find_places(p_query text, p_city_prefix text DEFAULT 'RUH', p_limit int DEFAULT 8)
 RETURNS TABLE(id uuid, name_ar text, name_en text, element_type text, geom_kind text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- «أبو بكر» / «أبي بكر» (case endings) are the same name: fold both to «اب».
  WITH q AS (
    SELECT regexp_replace(public.wassell_search_norm(
             regexp_replace(btrim(coalesce(p_query, '')), '^(طريق|شارع|حي|محطة مترو|محطه مترو|محطة|محطه|مول|مجمع|جامعة|جامعه|مستشفى|مستشفي)\s+', '')
           ), '\mاب[وي]\M', 'اب', 'g') AS n,
           regexp_replace(public.wassell_search_norm(btrim(coalesce(p_query, ''))), '\mاب[وي]\M', 'اب', 'g') AS full_n
  ), cand AS (
    SELECT e.id, e.name_ar, e.name_en, e.element_type, e.geom_kind,
           regexp_replace(public.wassell_search_norm(e.name_ar), '\mاب[وي]\M', 'اب', 'g') AS en_ar,
           lower(coalesce(e.name_en, '')) AS en_en
      FROM public.geo_elements e
     WHERE e.is_active
       AND coalesce(e.is_searchable, true)
       AND e.geom IS NOT NULL
       AND e.external_id LIKE p_city_prefix || '%'
  )
  SELECT c.id, c.name_ar, c.name_en, c.element_type, c.geom_kind
    FROM cand c, q
   WHERE length(q.n) >= 2
     AND (c.en_ar = q.n OR c.en_ar = q.full_n
          OR c.en_ar LIKE '%' || q.n || '%'
          OR (length(c.en_ar) >= 4 AND q.full_n LIKE '%' || c.en_ar || '%')
          OR (c.en_en <> '' AND c.en_en LIKE '%' || lower(btrim(p_query)) || '%'))
   ORDER BY
            -- The kind the customer named («جامعة …», «مستشفى …», «مول …», «طريق …») first.
            CASE WHEN q.full_n LIKE 'جامع%' AND c.element_type = 'universities' THEN 0
                 WHEN q.full_n LIKE 'مستشف%' AND c.element_type = 'hospitals' THEN 0
                 WHEN (q.full_n LIKE 'مول%' OR q.full_n LIKE 'مجمع%') AND c.element_type = 'malls' THEN 0
                 WHEN q.full_n LIKE 'محط%' AND c.element_type = 'metro_stations' THEN 0
                 WHEN (q.full_n LIKE 'طريق%' OR q.full_n LIKE 'شارع%') AND c.element_type IN ('roads_major', 'ring_roads') THEN 0
                 ELSE 1 END,
            (c.en_ar = q.n OR c.en_ar = q.full_n) DESC,
            (c.element_type IN ('roads_major', 'ring_roads') AND q.full_n LIKE '%طريق%') DESC,
            abs(length(c.en_ar) - length(q.n)),
            (c.geom_kind = 'point')
   LIMIT greatest(1, least(coalesce(p_limit, 8), 30));
$function$;

CREATE OR REPLACE FUNCTION public.sales_agent_project_distances(
  p_project_ids uuid[], p_element_ids uuid[] DEFAULT NULL, p_element_types text[] DEFAULT NULL, p_city_prefix text DEFAULT 'RUH'
)
 RETURNS TABLE(project_id uuid, km numeric)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH p AS (
    SELECT r.id,
           ST_SetSRID(ST_MakePoint((r.data->>'longitude')::float8, (r.data->>'latitude')::float8), 4326)::geography AS g
      FROM public.records r
     WHERE r.id = ANY(p_project_ids)
       AND r.data->>'latitude' ~ '^-?[0-9]+(\.[0-9]+)?$'
       AND r.data->>'longitude' ~ '^-?[0-9]+(\.[0-9]+)?$'
  ), e AS (
    SELECT el.geom::geography AS gg
      FROM public.geo_elements el
     WHERE el.is_active AND el.geom IS NOT NULL
       AND ((p_element_ids IS NOT NULL AND el.id = ANY(p_element_ids))
         OR (p_element_types IS NOT NULL AND el.element_type = ANY(p_element_types)
             AND el.external_id LIKE p_city_prefix || '%'))
  )
  SELECT p.id, round((min(ST_Distance(p.g, e.gg)) / 1000.0)::numeric, 2)
    FROM p CROSS JOIN e
   GROUP BY p.id;
$function$;

CREATE TABLE IF NOT EXISTS public.unit_plan_checks (
  file_id       uuid        NOT NULL,
  question_key  text        NOT NULL,     -- normalized feature asked about
  answer        text        NOT NULL CHECK (answer IN ('yes', 'no', 'unclear')),
  evidence      text,                     -- what the reader saw, one short line
  model         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, question_key)
);
ALTER TABLE public.unit_plan_checks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.unit_plan_checks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.unit_plan_checks TO service_role;
REVOKE ALL ON FUNCTION public.sales_agent_find_places(text, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_agent_project_distances(uuid[], uuid[], text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_agent_find_places(text, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_agent_project_distances(uuid[], uuid[], text[], text) TO service_role;

COMMIT;
