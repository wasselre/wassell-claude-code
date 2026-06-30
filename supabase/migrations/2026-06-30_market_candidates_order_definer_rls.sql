-- Project Finder market scan — fix the dense-district RLS timeout (silent empty market).
--
-- SYMPTOM (live, 2026-06-30): a villa search in dense north-Riyadh districts
-- (العارض/النرجس/القيروان ≤4M) returned ZERO market listings even though ~1,841
-- matching ads existed and were fully visible to the salesperson. The rep saw only
-- the (sold-out-filtered) project results — "5 results" — with NO sign anything broke.
--
-- ROOT CAUSE: wassell_market_candidates was SECURITY INVOKER, so the records-table RLS
-- policy applied as a SECURITY QUAL — which Postgres evaluates BEFORE regular quals.
-- That ran wassell_can_view_record(auth.uid(), r.*) on ALL ~46,589 market rows (the
-- district filter is a post-filter; the partial idx_records_market_loc_district is
-- never chosen by the planner for `district = ANY(...)`) before the cheap filters could
-- shrink the set. Measured as the salesperson: 7.8 s (single dense district 17 s) vs
-- 0.69 s service-role — ~11× RLS amplification that exceeds the `authenticated` role's
-- 8 s statement_timeout. The RPC threw; matchProjectsCore's catch flips marketInfo to
-- 'unavailable' (loud banner) — but the listings were simply never shown.
--
-- FIX: make wassell_market_candidates / _count SECURITY DEFINER and re-apply the SAME
-- RLS check as an EXPLICIT regular qual (`and wassell_can_view_record(auth.uid(), r.*)`).
-- As a normal qual it is cost-ordered AFTER the cheap district/budget/type filters, so
-- it runs only on the ~1,841 survivors instead of all 46k. Measured: 7.8 s -> 1.5 s,
-- well under the 8 s ceiling. Per-record visibility is IDENTICAL to the invoker path
-- (same evaluator, same auth.uid(); verified same 1,841 rows), and market_listings has
-- no per-profile row scoping today anyway (model_permissions null for every profile).
--
-- Supersedes 2026-06-30_market_candidates_order.sql — this file PRESERVES that file's
-- `ORDER BY r.id` (required for the engine's count-then-paginate, which fixed the
-- PostgREST 1000-row silent-truncation bug) and only adds DEFINER + the explicit RLS
-- qual. The filename sorts AFTER `_order.sql` so a fresh rebuild ends on THIS version.
-- Applied to prod 2026-06-30. Keep in sync with 2026-06-29_market_candidates_rpc.sql.

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
security definer
set search_path = public
as $$
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
    -- Explicit RLS re-check: a regular qual (cost-ordered after the cheap filters above),
    -- so it runs on the small filtered set, not all ~46k rows. Same evaluator the
    -- records-table policy uses — per-record visibility is unchanged.
    and public.wassell_can_view_record(auth.uid(), r.*)
  order by r.id
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
security definer
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
    )
    and public.wassell_can_view_record(auth.uid(), r.*);
$$;

grant execute on function public.wassell_market_candidates(uuid, text[], numeric, numeric, numeric, text[], int) to authenticated, anon;
grant execute on function public.wassell_market_candidate_count(uuid, text[], numeric, numeric, numeric, text[]) to authenticated, anon;
