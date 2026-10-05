-- Al Ramz broker portal: the daily status check also saves the projects
-- (2026-10-05, for the automated project updates).
--
-- The portal is Laravel + Inertia and asks for an SMS code at every sign-in,
-- so the check (which already signs in daily for client statuses) captures
-- the projects in the same visit with the new `save_inertia` step: the
-- projects list page JSON plus each project's detail page, and the dashboard.
-- They run BEFORE the client list, so a client-list failure (2026-10-04) can
-- no longer lose them; both are optional (logged, never fatal).
-- Replaces the earlier `save_items` "projects" step (2026-10-04_14), which
-- sat after the client list and saved raw HTML.

UPDATE public.records r
SET data = r.data || jsonb_build_object('status_recipe', (
  WITH steps AS (
    SELECT s, ord
    FROM jsonb_array_elements((r.data->>'status_recipe')::jsonb) WITH ORDINALITY t(s, ord)
    WHERE NOT (s->>'do' = 'save_items' AND s->>'key' = 'projects')
  ),
  first_collect AS (SELECT min(ord) AS ord FROM steps WHERE s->>'do' = 'collect_rows'),
  added AS (
    SELECT jsonb_build_array(
      jsonb_build_object('do','phase','ar','حفظ مشاريع الرمز ووحداتها','en','Saving the Al Ramz projects'),
      jsonb_build_object('do','save_inertia','key','projects',
        'list_url','https://brokerportal.alramzre.com/user/projects?page={{page}}',
        'detail_url','https://brokerportal.alramzre.com/user/projects/{{id}}',
        'optional', true),
      jsonb_build_object('do','save_inertia','key','dashboard',
        'list_url','https://brokerportal.alramzre.com/user/dashboard',
        'optional', true)
    ) AS a
  )
  SELECT (
    SELECT jsonb_agg(x ORDER BY o)
    FROM (
      SELECT s AS x, ord::numeric AS o FROM steps
      UNION ALL
      SELECT e, (SELECT ord FROM first_collect) - 1 + (i::numeric / 10)
      FROM added, jsonb_array_elements(added.a) WITH ORDINALITY t(e, i)
    ) u
  )::text
))
WHERE r.id = 'a0702e76-8617-402b-9ac9-5d7ed3c865ec'
  AND r.data ? 'status_recipe'
  AND NOT (r.data->>'status_recipe' LIKE '%save_inertia%')
  AND (r.data->>'status_recipe') LIKE '%collect_rows%';
