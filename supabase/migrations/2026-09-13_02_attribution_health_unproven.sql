-- Attribution health: "name absent" measured the exact catalog spelling of the
-- project inside the evidence text. Under the rebuilt rules that flags CORRECT
-- links — «جديل الرمال» for «أدوار جديل الرمال», «سديم تاون» for «سديم تاون -
-- شقق», «ريَّا النخيل» (diacritics) for «ريا النخيل» — 23 of the first 71 links,
-- every one of them right. Replace it with what actually matters now that every
-- machine pick carries a proof quote: a link is UNPROVEN when its quote is
-- empty or names none of the project's words (diacritics folded). Locked
-- (human) links are never unproven.
BEGIN;

CREATE OR REPLACE FUNCTION public.mkt_attribution_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
WITH ev AS (
  SELECT e.content_post_id, e.primary_project_id, e.attribution_locked_at, e.result, e.candidate_projects,
         lower(regexp_replace(regexp_replace(regexp_replace(coalesce(e.result->>'evidence_quote',''), '[ً-ْـ]', '', 'g'), '[أإآ]','ا','g'), 'ة','ه','g')) AS q,
         lower(regexp_replace(regexp_replace(regexp_replace(coalesce(ur.data->>'project_name',''), '[ً-ْـ]', '', 'g'), '[أإآ]','ا','g'), 'ة','ه','g')) AS pn
  FROM mkt_content_enrichment e
  LEFT JOIN unified_records ur ON ur.id = e.primary_project_id
  WHERE e.status = 'done'
),
proven AS (
  SELECT ev.content_post_id,
         EXISTS (
           SELECT 1 FROM regexp_split_to_table(regexp_replace(ev.pn, '[^[:alnum:]\s]', ' ', 'g'), '\s+') w
            WHERE length(w) >= 3 AND position(w IN ev.q) > 0
         ) AS ok
  FROM ev WHERE ev.primary_project_id IS NOT NULL AND ev.attribution_locked_at IS NULL
),
chosen AS (
  SELECT ev.content_post_id,
         (SELECT c->>'strength' FROM jsonb_array_elements(ev.candidate_projects) c
           WHERE c->>'projectId' = ev.primary_project_id::text LIMIT 1) AS strength
  FROM ev WHERE ev.primary_project_id IS NOT NULL
)
SELECT jsonb_build_object(
  'enriched',            (SELECT count(*) FROM ev),
  'attributed',          (SELECT count(*) FROM ev WHERE primary_project_id IS NOT NULL),
  'locked',              (SELECT count(*) FROM ev WHERE attribution_locked_at IS NOT NULL),
  -- machine link with no proof quote naming the project (the old "name_absent" key, kept for the client)
  'name_absent',         (SELECT count(*) FROM proven WHERE NOT ok),
  'weak_picks',          (SELECT count(*) FROM chosen WHERE strength = 'word'),
  'unknown_mentions',    (SELECT count(*) FROM ev WHERE jsonb_array_length(coalesce(result->'mentioned_projects','[]'::jsonb)) > 0),
  'awaiting_decision',   (SELECT count(*) FROM mkt_content_posts WHERE processing_status = 'awaiting_intelligence'),
  'rerun_queued',        (SELECT count(*) FROM mkt_collection_jobs WHERE kind='content_process' AND status IN ('queued','running') AND params->>'mode'='narrow_only'),
  'checked_at',          now()
);
$$;

COMMIT;
