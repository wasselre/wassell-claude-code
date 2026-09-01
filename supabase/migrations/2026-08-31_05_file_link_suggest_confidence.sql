-- Add a CONFIDENCE score to file_link_suggest so the reviewer sees how sure the
-- match is (exact name = 1.0; a prefix match scales by how much of the two names
-- overlap — a short detected name against a long project name is less sure). The
-- worker passes the function's output straight into ai_suggestions.links, so no
-- worker change is needed; a backfill below stamps confidence onto already-staged
-- suggestions.

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
           -- 1.0 for an exact normalized name; otherwise the overlap ratio of the
           -- two normalized strings (shorter / longer), rounded to 2 decimals.
           CASE WHEN c.nlabel = q.norm THEN 1.00
                ELSE round(least(length(c.nlabel), length(q.norm))::numeric
                           / nullif(greatest(length(c.nlabel), length(q.norm)), 0), 2) END AS confidence,
           length(c.nlabel) AS nlen
      FROM cand c
      JOIN q ON length(c.nlabel) >= 2
            AND (c.nlabel = q.norm
                 OR c.nlabel LIKE q.norm || '%'
                 OR q.norm LIKE c.nlabel || '%')
  ),
  ranked AS (
    SELECT DISTINCT ON (record_id) model_id, model_name, record_id, label, matched_name, rank, confidence
      FROM matched
     ORDER BY record_id, rank, nlen
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'model_id', model_id, 'model_name', model_name,
           'record_id', record_id, 'label', label, 'matched_name', matched_name,
           'confidence', confidence
         ) ORDER BY confidence DESC, rank), '[]'::jsonb)
    FROM (SELECT * FROM ranked ORDER BY confidence DESC, rank LIMIT 5) x;
$$;

-- Backfill: stamp confidence onto suggestions already staged in files.ai_suggestions.
UPDATE public.files f
   SET ai_suggestions = jsonb_set(f.ai_suggestions, '{links}', (
     SELECT jsonb_agg(
       l || jsonb_build_object('confidence',
         CASE WHEN public.wassell_search_norm(l->>'label') = public.wassell_search_norm(l->>'matched_name') THEN 1.00
              ELSE round(
                least(length(public.wassell_search_norm(l->>'label')), length(public.wassell_search_norm(l->>'matched_name')))::numeric
                / nullif(greatest(length(public.wassell_search_norm(l->>'label')), length(public.wassell_search_norm(l->>'matched_name'))), 0), 2)
         END))
       FROM jsonb_array_elements(f.ai_suggestions->'links') l
   ))
 WHERE f.ai_suggestions ? 'links'
   AND jsonb_typeof(f.ai_suggestions->'links') = 'array'
   AND jsonb_array_length(f.ai_suggestions->'links') > 0;
