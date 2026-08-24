-- Tighten file_link_suggest: drop pure-substring matching, keep exact + edge-
-- prefix (either direction). The substring branch let "وصل العقارية" (Wassell's
-- own name, printed on every brochure) match a developer record "العقارية", and
-- "أيالا سدرة" drag in a separate "سدرة" project — noise. Exact/prefix still
-- catches the real cases: "مينا 52" → "مينا 52 - النرجس" (project starts with the
-- detected name), and "مينا 52 السكني" → "مينا 52" (detected starts with the
-- project). Verified against the live normalizer: "العقاريه" is not a prefix of
-- "وصل العقاريه", so the false positive is gone.
CREATE OR REPLACE FUNCTION public.file_link_suggest(p_names text[])
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH q AS (
    SELECT DISTINCT btrim(n) AS raw, public.wassell_search_norm(btrim(n)) AS norm
      FROM unnest(coalesce(p_names, '{}'::text[])) n
     WHERE length(public.wassell_search_norm(btrim(n))) >= 2
  ),
  cand AS (
    SELECT m.id AS model_id, m.name AS model_name, r.id AS record_id,
           r.data->>'project_name' AS label,
           public.wassell_search_norm(r.data->>'project_name') AS nlabel
      FROM public.records r JOIN public.models m ON m.id = r.model_id
     WHERE m.name = 'all_projects' AND coalesce(r.data->>'project_name', '') <> ''
    UNION ALL
    SELECT m.id, m.name, r.id, r.data->>'name',
           public.wassell_search_norm(r.data->>'name')
      FROM public.records r JOIN public.models m ON m.id = r.model_id
     WHERE m.name = 'developers' AND coalesce(r.data->>'name', '') <> ''
  ),
  matched AS (
    SELECT c.model_id, c.model_name, c.record_id, c.label, q.raw AS matched_name,
           CASE WHEN c.nlabel = q.norm THEN 0 ELSE 1 END AS rank,
           length(c.nlabel) AS nlen
      FROM cand c
      JOIN q ON length(c.nlabel) >= 2
            AND (c.nlabel = q.norm
                 OR c.nlabel LIKE q.norm || '%'
                 OR q.norm LIKE c.nlabel || '%')
  ),
  ranked AS (
    SELECT DISTINCT ON (record_id) model_id, model_name, record_id, label, matched_name, rank
      FROM matched
     ORDER BY record_id, rank, nlen
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'model_id', model_id, 'model_name', model_name,
           'record_id', record_id, 'label', label, 'matched_name', matched_name
         ) ORDER BY rank), '[]'::jsonb)
    FROM (SELECT * FROM ranked ORDER BY rank LIMIT 5) x;
$$;
