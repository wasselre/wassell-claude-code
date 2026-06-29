-- Market-listings candidate fetch for the Project Finder — DB-side filtered + bounded.
--
-- WHY: the Suggested Projects modal includes market_listings (~46k external ads). The
-- old in-memory path either (a) scanned the 20km-neighbour set (≈17k listings for a
-- dense Riyadh district) and 504'd the edge function, or (b) was capped to the newest
-- N — which SILENTLY DROPS good listings (unacceptable: we'd lose real opportunities).
--
-- FIX: narrow the candidate set with REAL filters (district + budget + bedrooms + type)
-- DB-side so the result is small enough to score in full, and let the caller decide —
-- when even the filtered set is too large to scan, the caller asks the salesperson for
-- more criteria instead of truncating. NEVER a recency cap.
--
-- Scope is the requested district(s) ONLY (not the 20km neighbour expansion) — that is
-- what blew the budget; the exact district is the salesperson's actual ask. Distribution
-- (measured 2026-06-29): 167/170 districts ≤ 2,500 listings; only 3 exceed 2,500, max
-- 5,866. So the common case scans fully; only ultra-dense districts need extra criteria.
--
-- Budget/bedrooms filters NEVER drop a listing whose value is MISSING/non-numeric — a
-- price-less ad is kept (it just can't be budget-matched), so we never lose an
-- opportunity to a blank field. Only a KNOWN value outside the range is excluded.
--
-- SECURITY INVOKER: runs as the caller, so the records-table RLS (per-profile scope)
-- applies exactly as the normal read path — a salesperson sees only what they may see.
-- Uses the partial index idx_records_market_loc_district for the district filter.

create or replace function public.wassell_market_candidates(
  p_model_id uuid,
  p_district_ids text[],
  p_budget_min numeric default null,
  p_budget_max numeric default null,
  p_bedrooms numeric default null,
  p_type_terms text[] default null,
  p_limit int default 4001
) returns table(id uuid, data jsonb)
language sql
stable
security invoker
set search_path = public
as $$
  select r.id, r.data
  from public.records r
  where r.model_id = p_model_id
    and p_district_ids is not null
    and (r.data -> 'location' ->> 'district') = any(p_district_ids)
    -- budget: keep when no budget asked, OR price missing/non-numeric, OR price in range
    and (
      p_budget_max is null
      or (r.data ->> 'price') is null
      or (r.data ->> 'price') !~ '^[0-9]+(\.[0-9]+)?$'
      or (
        (r.data ->> 'price')::numeric <= p_budget_max
        and (p_budget_min is null or (r.data ->> 'price')::numeric >= p_budget_min)
      )
    )
    -- bedrooms: keep when not asked, OR bedrooms missing/non-numeric, OR exact match
    and (
      p_bedrooms is null
      or (r.data ->> 'bedrooms') is null
      or (r.data ->> 'bedrooms') !~ '^[0-9]+(\.[0-9]+)?$'
      or (r.data ->> 'bedrooms')::numeric = p_bedrooms
    )
    -- unit type: keep when not asked, OR all type fields are blank (unknown → never
    -- drop), OR any of the listing's type fields matches a requested term
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
  limit p_limit;
$$;

create or replace function public.wassell_market_candidate_count(
  p_model_id uuid,
  p_district_ids text[],
  p_budget_min numeric default null,
  p_budget_max numeric default null,
  p_bedrooms numeric default null,
  p_type_terms text[] default null
) returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)
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
    );
$$;

grant execute on function public.wassell_market_candidates(uuid, text[], numeric, numeric, numeric, text[], int) to authenticated, anon;
grant execute on function public.wassell_market_candidate_count(uuid, text[], numeric, numeric, numeric, text[]) to authenticated, anon;
