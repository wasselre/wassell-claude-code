-- Single-call market scan: returns { total, rows[] } as one jsonb value.
--
-- WHY: the engine fetched the market set with COUNT + up-to-3 paged
-- wassell_market_candidates calls (PostgREST caps a response at ~1000 rows). That's
-- 4 round-trips that EACH re-scan the market model and re-run the per-row RLS
-- (wassell_can_view_record) over the survivors. For a dense in-area set — e.g. the
-- "north of King Salman Rd" geo gate → 2,595 in-area villas — that ~4× duplication
-- made a finder request ~16s (measured: ~2.4s/call × 4).
--
-- FIX: one function that returns the whole result as a single jsonb value (one row →
-- not subject to the 1000-row cap). `with filtered as MATERIALIZED (...)` evaluates the
-- expensive filter (id/district scope + budget/bed/type + RLS) EXACTLY ONCE; `total`
-- (for the unchanged too_many guard) and the capped `rows` are computed over the
-- materialized set. Same scope/filters/RLS/order as wassell_market_candidates.
-- Measured ~2.3s for the 2595-villa set (was ~9.6s across 4 calls). Applied to prod
-- 2026-07-01; matchProjectsCore's market block now makes this ONE call.

create or replace function public.wassell_market_candidates_json(
  p_model_id uuid,
  p_district_ids text[],
  p_budget_min numeric default null,
  p_budget_max numeric default null,
  p_bedrooms numeric default null,
  p_type_terms text[] default null,
  p_limit int default 4000,
  p_record_ids uuid[] default null
) returns jsonb
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '25s'
as $function$
  with filtered as materialized (
    select r.id, r.data
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
      and public.wassell_can_view_record(auth.uid(), r.*)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'rows', coalesce(
      (select jsonb_agg(jsonb_build_object('id', f.id, 'data', f.data) order by f.id)
       from (select id, data from filtered order by id limit p_limit) f),
      '[]'::jsonb
    )
  );
$function$;

grant execute on function public.wassell_market_candidates_json(uuid, text[], numeric, numeric, numeric, text[], int, uuid[]) to authenticated, anon;
