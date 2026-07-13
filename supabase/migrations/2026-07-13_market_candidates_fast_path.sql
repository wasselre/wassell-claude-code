-- Market scan fast path + slim payload (Project Finder /api/project-finder).
--
-- WHY: after idx_records_model_district (2026-07-13) the district filter is fast,
-- but wassell_market_candidates_json still ran the per-row RLS qual
-- public.wassell_can_view_record(auth.uid(), r.*) over every in-district survivor.
-- That function does 2+ catalog lookups (users JOIN profiles, then a jsonb scan of
-- model_permissions) PER ROW — measured ~3.7–8s for the ~6.3k rows of a 3-district
-- request (النرجس/العارض/القيروان) even for an admin whose answer is always true.
-- The whole finder request sat ~17s, uncomfortably close to the 25s Vercel ceiling.
--
-- FIX 1 — model-level access class, computed ONCE per statement:
--   wassell_view_scope_class(uid, model_id) → 'none' | 'all' | 'filtered'
--   'all'      = the user can view the model AND their view_scope is unrestricted
--                (admin, no scope rule, mode='all', or filtered with 0 conditions)
--                → the per-row wassell_can_view_record call is provably constant-true
--                and is SKIPPED entirely (CASE guarantees it is not evaluated).
--   'filtered' = scope has real per-record conditions → per-row check runs, same
--                semantics as before (no behavior change for scoped profiles).
--   'none'     = no view permission / inactive / unknown user → zero rows, same as
--                the per-row check returning false everywhere.
--   The classification mirrors wassell_user_has_action + the mode preamble of
--   wassell_record_passes_scope EXACTLY — if you change either of those, revisit
--   this function (a drift makes the fast path disagree with real RLS).
--
-- FIX 2 — slim payload: new p_fields text[] (default NULL = full data, so the
-- currently-deployed endpoint keeps working unchanged). When provided, each row's
-- data is projected to just those keys. The scorer/adapter in api/_lib/matchAgent.ts
-- reads ~21 keys; the full Aqar blob (description, all metadata) is dead weight ×
-- up to 4000 rows in the jsonb_agg + the PostgREST response.
-- The projection MUST use jsonb_each (ONE pass over the row's jsonb, filter by
-- key) — the obvious unnest(p_fields) + per-key `data -> k` subplan re-detoasts
-- the ~4KB blob for every key and was measured SLOWER than returning full data
-- (9.9s vs 3.4s); jsonb_each measured 2.6s and cut the payload 15MB → 5.4MB.
--
-- NOTE: the signature changes (added param), so DROP + CREATE — CREATE OR REPLACE
-- would create a second overload and make PostgREST rpc resolution ambiguous.
--
-- Applied live 2026-07-13. This file is the committed record.

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_view_scope_class(
  auth_user_id uuid, the_model_id uuid
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  prof profiles%ROWTYPE;
  model_perm jsonb;
  rule jsonb;
BEGIN
  IF auth_user_id IS NULL THEN RETURN 'none'; END IF;
  SELECT p.* INTO prof FROM profiles p
    JOIN users u ON u.profile_id = p.id
   WHERE u.auth_uid = auth_user_id AND u.is_active = true LIMIT 1;
  IF NOT FOUND THEN RETURN 'none'; END IF;
  IF prof.is_admin THEN RETURN 'all'; END IF;
  SELECT mp INTO model_perm FROM jsonb_array_elements(prof.model_permissions) mp
    WHERE (mp->>'model_id')::uuid = the_model_id LIMIT 1;
  IF model_perm IS NULL THEN RETURN 'none'; END IF;
  IF NOT ((model_perm->'permissions') @> to_jsonb('view'::text)) THEN RETURN 'none'; END IF;
  rule := model_perm -> 'view_scope';
  IF rule IS NULL THEN RETURN 'all'; END IF;
  IF rule->>'mode' = 'all' THEN RETURN 'all'; END IF;
  IF rule->>'mode' <> 'filtered' THEN RETURN 'all'; END IF;
  IF jsonb_array_length(COALESCE(rule->'conditions', '[]'::jsonb)) = 0 THEN RETURN 'all'; END IF;
  RETURN 'filtered';
END $$;

GRANT EXECUTE ON FUNCTION public.wassell_view_scope_class(uuid, uuid) TO authenticated, anon;

DROP FUNCTION IF EXISTS public.wassell_market_candidates_json(uuid, text[], numeric, numeric, numeric, text[], int, uuid[]);

CREATE FUNCTION public.wassell_market_candidates_json(
  p_model_id uuid,
  p_district_ids text[],
  p_budget_min numeric default null,
  p_budget_max numeric default null,
  p_bedrooms numeric default null,
  p_type_terms text[] default null,
  p_limit int default 4000,
  p_record_ids uuid[] default null,
  p_fields text[] default null
) returns jsonb
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '25s'
as $function$
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
      -- CASE (not OR) so the expensive per-row RLS call is GUARANTEED skipped when
      -- the model-level class already proves the answer is true for every row.
      and (case when a.klass = 'all' then true
                else public.wassell_can_view_record(auth.uid(), r.*) end)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'rows', coalesce(
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
      '[]'::jsonb
    )
  );
$function$;

GRANT EXECUTE ON FUNCTION public.wassell_market_candidates_json(uuid, text[], numeric, numeric, numeric, text[], int, uuid[], text[]) to authenticated, anon;

COMMIT;
