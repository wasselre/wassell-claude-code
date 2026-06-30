-- The endpoint's gate used the ROW-returning wassell_geo_match, which PostgREST caps
-- at ~1000 rows per response — so for a large area (north-of-King-Salman-Rd = 8046) the
-- gate was silently truncated to the first 1000, and (before the ORDER BY) the 1000 were
-- non-deterministic, so the visible result count flickered (market 329↔489 per load).
-- Paging the row function is not viable: PostgREST re-runs the whole function per
-- .range() call (the 1.5s scan would run N times). Instead return the full id set as a
-- single uuid[] (ONE row → not row-capped; the scan runs exactly once). statement_timeout
-- matches the inner scan's budget (the whole select, incl. the inner call, runs under it).
-- Applied to prod 2026-07-01; api/project-finder.ts calls this for the geo gate.
create or replace function public.wassell_geo_match_ids(p_client_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '25s'
as $function$
  select coalesce(array_agg(record_id), '{}'::uuid[])
  from public.wassell_geo_match(p_client_id)
$function$;

grant execute on function public.wassell_geo_match_ids(uuid) to authenticated, anon;
