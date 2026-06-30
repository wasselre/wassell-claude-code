-- Project Finder market scan — scope by a GEO-MATCHED record-id set, not only a district.
--
-- WHY: a client can express their area as `location_items` (district include/exclude OR
-- "within radius of a landmark", e.g. "داخل النخيل مول" / "north of King Salman Rd").
-- The deterministic finder already gates our_projects + all_projects to the compiled
-- geo area (wassell_geo_match → eligible record ids, which INCLUDE market_listing ids —
-- listing_points is populated, 46,608 rows). But the MARKET scan required a district
-- (`needs_district`) and ignored the element area, so a client whose ONLY location
-- preference was an element saw "select a district to show market listings" — exactly
-- the thing the element was supposed to replace.
--
-- FIX: add an optional `p_record_ids uuid[]` to wassell_market_candidates / _count. When
-- provided (the geo-matched listing ids for the client's area), the candidate set is
-- scoped by `r.id = any(p_record_ids)` INSTEAD of the district filter; everything else
-- (budget / bedrooms / unit-type filters, the explicit RLS re-check, ORDER BY r.id, the
-- count-then-paginate + too_many guard) is unchanged. The id scope uses the records PK,
-- so RLS is cost-ordered after it and runs only on the in-area subset (same posture as
-- the district path). For a huge element area (النخيل ≈ 7,904 listings) the engine still
-- returns `too_many` and asks for budget/bedrooms — never a silent truncation.
--
-- Signature change (param appended) requires DROP+CREATE (CREATE OR REPLACE can't add a
-- param without creating an ambiguous overload for the existing no-p_record_ids calls).
-- Supersedes 2026-06-30_market_candidates_order_definer_rls.sql; keep the DEFINER + RLS
-- qual + ORDER BY r.id from there. Applied to prod 2026-06-30.

drop function if exists public.wassell_market_candidates(uuid, text[], numeric, numeric, numeric, text[], int);
drop function if exists public.wassell_market_candidate_count(uuid, text[], numeric, numeric, numeric, text[]);

create function public.wassell_market_candidates(
  p_model_id uuid,
  p_district_ids text[],
  p_budget_min numeric default null,
  p_budget_max numeric default null,
  p_bedrooms numeric default null,
  p_type_terms text[] default null,
  p_limit int default 4001,
  p_record_ids uuid[] default null
) returns table(id uuid, data jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.data
  from public.records r
  where r.model_id = p_model_id
    and (
      -- Geo-area scope (location_items) when given; else the requested district(s).
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
    and public.wassell_can_view_record(auth.uid(), r.*)
  order by r.id
  limit p_limit;
$$;

create function public.wassell_market_candidate_count(
  p_model_id uuid,
  p_district_ids text[],
  p_budget_min numeric default null,
  p_budget_max numeric default null,
  p_bedrooms numeric default null,
  p_type_terms text[] default null,
  p_record_ids uuid[] default null
) returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from public.records r
  where r.model_id = p_model_id
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
    and public.wassell_can_view_record(auth.uid(), r.*);
$$;

grant execute on function public.wassell_market_candidates(uuid, text[], numeric, numeric, numeric, text[], int, uuid[]) to authenticated, anon;
grant execute on function public.wassell_market_candidate_count(uuid, text[], numeric, numeric, numeric, text[], uuid[]) to authenticated, anon;
