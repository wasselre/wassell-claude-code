-- Speed fix for wassell_geo_names_in_text (2026-10-04_01).
--
-- Measured: 464 ms on a short text but 15.6 s on a ~2.5k-character conversation,
-- which PostgREST cancels ("statement timeout") — and the resolver's I8 check
-- THROWS on a failed lookup (no silent pass), so every long chat's geography
-- read failed outright (17 of 84 conversations in the stored-evidence replay).
-- Cause: the CTE t (normalising the customer text) was referenced once, so
-- Postgres 12+ inlined it and re-normalised the whole text once PER NAME ROW
-- (~14k rows). MATERIALIZED computes it once: the same 2.6k-char text now takes
-- ~0.3 s. Same algorithm, same output; only the plan changes.

BEGIN;
SET LOCAL check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.wassell_geo_names_in_text(p_text text)
RETURNS TABLE(external_id text, name text, category text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '5s'
AS $function$
  WITH t AS MATERIALIZED (
    SELECT ' ' || regexp_replace(regexp_replace(public.wassell_search_norm(p_text), '[ً-ٰٟ]', '', 'g'),
                                 '[^0-9a-zء-يٱ]+', ' ', 'g') || ' ' AS txt
  ),
  names AS (
    SELECT e.external_id, n.name, e.category
      FROM public.geo_elements e
      CROSS JOIN LATERAL (VALUES (e.name_ar), (e.name_en), (e.display_name)) AS n(name)
     WHERE e.is_active AND e.is_searchable AND e.review_status = 'approved' AND coalesce(n.name, '') <> ''
    UNION
    SELECT e.external_id, a.alias, e.category
      FROM public.geo_element_aliases a JOIN public.geo_elements e ON e.id = a.element_id
     WHERE e.is_active AND e.is_searchable AND e.review_status = 'approved'
  ),
  norm AS (
    SELECT external_id, name, category,
           btrim(regexp_replace(regexp_replace(public.wassell_search_norm(name), '[ً-ٰٟ]', '', 'g'),
                                '[^0-9a-zء-يٱ]+', ' ', 'g')) AS nn
      FROM names
  )
  SELECT n.external_id, n.name, n.category
    FROM norm n, t
   WHERE n.nn LIKE '% %'
     -- no leading-space anchor on purpose: «بالرياض بارك» must still generate
     -- «الرياض بارك»; the caller's clitic-aware whole-word check decides.
     AND position(n.nn || ' ' IN t.txt) > 0
   LIMIT 300
$function$;

REVOKE ALL ON FUNCTION public.wassell_geo_names_in_text(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_geo_names_in_text(text) TO service_role;

COMMIT;
