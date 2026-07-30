-- ============================================================================
-- Make geo-element search multi-city safe (relevance ranking, not id ordering)
-- ============================================================================
-- Context: until now geo_elements held Riyadh anchors ONLY (725 rows, every
-- external_id prefixed `RUH-`). The 2026-07-30 multi-city build adds 20 more
-- cities with their own prefixes (JED-, DMM-, MKH-, …), which exposes a latent
-- ordering bug in wassell_search_geo_elements.
--
-- THE BUG. The function was:
--
--   SELECT DISTINCT ON (e.external_id) …
--   ORDER BY e.external_id, e.is_verified DESC, e.confidence_score DESC
--   LIMIT greatest(1, least(coalesce(p_limit,30),100))
--
-- DISTINCT ON forces the leading ORDER BY term to be the distinct key, so the
-- result set was ordered by external_id ASCENDING and the LIMIT then sliced the
-- alphabetically-first prefixes. With one city that is invisible. With 21 cities,
-- an un-scoped search for "مستشفى" would return Abha's hospitals (AHB-…) and
-- silently truncate every other city — the caller
-- (src/components/LocationItemsEditor.tsx) passes limit 20 and no city filter,
-- so the element picker would simply stop showing most of the country with no
-- error and no indication anything was omitted.
--
-- THE FIX. Two parts:
--   1. Drop DISTINCT ON entirely. It was redundant: `geo_elements_external_id_uidx`
--      is UNIQUE on (external_id) WHERE external_id IS NOT NULL, and the WHERE
--      clause already requires external_id IS NOT NULL, so rows cannot duplicate.
--      The alias predicate is an EXISTS (semi-join), which does not multiply rows
--      either. DISTINCT ON bought nothing and cost correct ordering.
--   2. Rank by RELEVANCE — exact name match, then prefix match, then substring —
--      breaking ties on is_verified / confidence / shorter name, and only finally
--      on external_id for total determinism. So the limit now truncates the least
--      relevant results instead of an arbitrary alphabetical tail.
--
-- Signature, return shape, grants and security posture are unchanged, so no
-- caller needs updating. p_city still scopes to one city when supplied.
--
-- NOTE ON THE RETURN SHAPE. The authoritative prior definition is NOT the one in
-- 2026-06-30_geo_elements_intelligence.sql — it was superseded later the same day
-- by 2026-06-30_geo_directional_polygon_rules.sql, which inserted `geom_kind`
-- between `type` and `city`. That column is load-bearing: src/lib/geo/client.ts
-- types it on GeoElementHit and LocationItemsEditor's kindOf(hit) uses it to pick
-- the default condition rule for a picked anchor. It is preserved here verbatim.
-- (Postgres refused the first attempt with 42P13 "cannot change return type",
-- which is the only reason the omission was caught — CREATE OR REPLACE will not
-- silently reshape a function, but a DROP + CREATE would have.)
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_search_geo_elements(
  p_q text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_type text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_limit int DEFAULT 30,
  p_include_unapproved boolean DEFAULT false
)
RETURNS TABLE(
  external_id text, name_ar text, name_en text, display_name text,
  category text, type text, geom_kind text, city text,
  latitude double precision, longitude double precision,
  confidence_score numeric, is_verified boolean, is_approximate boolean,
  review_status text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH q AS (SELECT lower(btrim(coalesce(p_q, ''))) AS term)
  SELECT
    e.external_id, e.name_ar, e.name_en, e.display_name,
    e.category, e.type, e.geom_kind, e.city,
    e.latitude, e.longitude, e.confidence_score, e.is_verified, e.is_approximate,
    e.review_status
  FROM public.geo_elements e, q
  WHERE e.external_id IS NOT NULL
    AND e.is_active
    AND (p_include_unapproved OR (e.is_searchable AND e.review_status = 'approved'))
    AND (p_category IS NULL OR e.category = p_category)
    AND (p_type     IS NULL OR e.type = p_type)
    AND (p_city     IS NULL OR e.city ILIKE p_city)
    AND (
      q.term = '' OR
      e.name_ar ILIKE '%' || q.term || '%' OR
      e.name_en ILIKE '%' || q.term || '%' OR
      e.display_name ILIKE '%' || q.term || '%' OR
      EXISTS (SELECT 1 FROM public.geo_element_aliases a
              WHERE a.element_id = e.id AND a.alias_norm ILIKE '%' || q.term || '%')
    )
  ORDER BY
    -- relevance tier: 0 exact name, 1 starts-with, 2 anything else (incl. alias-only
    -- and the empty-term browse case, where every row is tier 2 and the tie-breaks
    -- below decide — best-verified, highest-confidence first).
    CASE
      WHEN q.term = '' THEN 2
      WHEN lower(coalesce(e.name_ar, '')) = q.term
        OR lower(coalesce(e.name_en, '')) = q.term
        OR lower(coalesce(e.display_name, '')) = q.term THEN 0
      WHEN lower(coalesce(e.name_ar, '')) LIKE q.term || '%'
        OR lower(coalesce(e.name_en, '')) LIKE q.term || '%'
        OR lower(coalesce(e.display_name, '')) LIKE q.term || '%' THEN 1
      ELSE 2
    END,
    e.is_verified DESC,
    e.confidence_score DESC NULLS LAST,
    -- shorter names are usually the canonical entity ("Jeddah Park" over
    -- "Jeddah Park North Extension Car Park").
    length(coalesce(e.display_name, e.name_en, e.name_ar, '')),
    e.external_id
  LIMIT greatest(1, least(coalesce(p_limit, 30), 100))
$$;

COMMENT ON FUNCTION public.wassell_search_geo_elements(text, text, text, text, int, boolean) IS
  'Search geo_elements by name/alias/category/type/city, ranked by relevance then '
  'verification/confidence. Multi-city safe: never orders by external_id first (that '
  'made LIMIT slice off whole cities alphabetically). Pass p_city to scope to one city.';

GRANT EXECUTE ON FUNCTION public.wassell_search_geo_elements(text, text, text, text, int, boolean)
  TO authenticated, service_role;

COMMIT;
