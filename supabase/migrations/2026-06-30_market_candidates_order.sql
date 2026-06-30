-- ============================================================================
-- wassell_market_candidates — add a STABLE order so the engine can paginate it
-- ============================================================================
-- The function had no ORDER BY. PostgREST caps a single RPC response at ~1000
-- rows, so for a district with >1000 matching listings the Project Finder saw
-- only the first 1000 — SILENTLY, before its 4000-row "too_many" tripwire could
-- fire (a narrow-don't-cap violation; live: النرجس villas = 1,348 matched, 1,000
-- scored). The engine now counts first and paginates to fetch the COMPLETE set;
-- pagination is only correct with a deterministic order, so add `ORDER BY r.id`.
-- (id is arbitrary-but-stable — deliberately NOT created_at, to avoid any recency
-- semantics; we fetch the whole set, order is just iteration order.)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.wassell_market_candidates(
  p_model_id uuid, p_district_ids text[], p_budget_min numeric DEFAULT NULL,
  p_budget_max numeric DEFAULT NULL, p_bedrooms numeric DEFAULT NULL,
  p_type_terms text[] DEFAULT NULL, p_limit integer DEFAULT 4001)
RETURNS TABLE(id uuid, data jsonb)
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $function$
  select r.id, r.data
  from public.records r
  where r.model_id = p_model_id
    and p_district_ids is not null
    and (r.data -> 'location' ->> 'district') = any(p_district_ids)
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
  order by r.id
  limit p_limit;
$function$;
