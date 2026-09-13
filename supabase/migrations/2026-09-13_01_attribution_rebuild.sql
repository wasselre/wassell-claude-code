-- ============================================================================
-- Competitor content → project attribution rebuild (2026-09-13)
--
-- Measured on the live corpus before this migration (3,014 enriched posts,
-- 906 attributed): 214 links rested on the publisher's own brand word, the
-- AI picked-vs-declined 219/191 on identical brand-only candidate sets, all
-- 1,006 project↔organization rows dated the 2026-07-22 seed (projects added
-- since were never candidates), 32 posts named a project verbatim that never
-- became a candidate, and 0 human corrections had ever reached the Library
-- because the review write and the Library read used different tables.
--
-- This migration is the DB half of the fix (the worker's candidate rules and
-- the runner's validator are the other half):
--   1. a human LOCK on the enrichment pointer that every machine write honours
--   2. one correction RPC that writes BOTH tables as confirmed
--   3. the Y/N review surface now sets + locks the pointer too
--   4. reset of machine-made attributions before a re-decision
--   5. project↔developer relationships kept in sync from all_projects.developer
--      by trigger (live), plus a one-time catch-up
--   6. the evidence package tells the reader the publisher's brand words, its
--      sibling projects, and whether the post is human-locked
--   7. a bulk "re-narrow everything" enqueue for the rerun
--   8. attribution health numbers on the Pipeline surface
--   9. the Library exposes lock / strength / unknown-project mentions
--
-- Idempotent. Backward compatible with the running worker/runner (new columns
-- are nullable, signatures unchanged except additive jsonb keys).
-- ============================================================================
BEGIN;

-- ── 1. human lock ───────────────────────────────────────────────────────────
ALTER TABLE public.mkt_content_enrichment
  ADD COLUMN IF NOT EXISTS attribution_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS attribution_locked_by uuid,
  ADD COLUMN IF NOT EXISTS attribution_note      text;
CREATE INDEX IF NOT EXISTS mkt_content_enrichment_locked_idx
  ON public.mkt_content_enrichment (attribution_locked_at) WHERE attribution_locked_at IS NOT NULL;
COMMENT ON COLUMN public.mkt_content_enrichment.attribution_locked_at IS
  'Set when a human decided this post''s project (or "no project"). Every machine write (runner upsert, re-narrow) keeps primary_project_id as-is while this is set.';

-- the machine upsert honours the lock
CREATE OR REPLACE FUNCTION public.mkt_enrichment_upsert(
  p_post uuid, p_model text, p_rule_version text, p_org uuid, p_developer uuid,
  p_marketer uuid, p_primary_project uuid, p_candidates jsonb, p_result jsonb,
  p_cost numeric, p_status text, p_failure text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.mkt_content_enrichment(content_post_id,model,rule_version,organization_id,developer_id,marketer_id,primary_project_id,candidate_projects,result,cost_usd,status,failure_reason)
  VALUES (p_post,p_model,p_rule_version,p_org,p_developer,p_marketer,p_primary_project,COALESCE(p_candidates,'[]'::jsonb),COALESCE(p_result,'{}'::jsonb),COALESCE(p_cost,0),COALESCE(p_status,'done'),p_failure)
  ON CONFLICT (content_post_id) DO UPDATE SET
    model=EXCLUDED.model, rule_version=EXCLUDED.rule_version, organization_id=EXCLUDED.organization_id,
    developer_id=EXCLUDED.developer_id, marketer_id=EXCLUDED.marketer_id,
    -- a human decision outlives every machine re-decision
    primary_project_id = CASE WHEN mkt_content_enrichment.attribution_locked_at IS NOT NULL
                              THEN mkt_content_enrichment.primary_project_id
                              ELSE EXCLUDED.primary_project_id END,
    candidate_projects=EXCLUDED.candidate_projects, result=EXCLUDED.result, cost_usd=EXCLUDED.cost_usd,
    status=EXCLUDED.status, failure_reason=EXCLUDED.failure_reason, updated_at=now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ── 2. the ONE correction path ──────────────────────────────────────────────
-- p_project NULL = "this post is about no project (general branding)".
CREATE OR REPLACE FUNCTION public.mkt_attribution_set(
  p_post uuid, p_project uuid, p_user uuid, p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  UPDATE public.mkt_content_enrichment
     SET primary_project_id = p_project,
         attribution_locked_at = now(), attribution_locked_by = p_user,
         attribution_note = p_note, updated_at = now()
   WHERE content_post_id = p_post
   RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'post % has no enrichment row — it has not been processed yet', p_post;
  END IF;

  IF p_project IS NOT NULL THEN
    INSERT INTO public.mkt_content_attributions
      (content_post_id, project_id, attribution_method, confidence, evidence, matched_aliases, review_status, confirmed_by, confirmed_at)
    VALUES (p_post, p_project, 'manual', 1, jsonb_build_object('note', p_note), '{}', 'confirmed', p_user, now())
    ON CONFLICT (content_post_id, project_id) DO UPDATE SET
      review_status = 'confirmed', attribution_method = 'manual', confidence = 1,
      confirmed_by = p_user, confirmed_at = now(), updated_at = now();
    UPDATE public.mkt_content_attributions
       SET review_status = 'rejected', confirmed_by = p_user, confirmed_at = now(), updated_at = now()
     WHERE content_post_id = p_post AND project_id <> p_project AND review_status <> 'rejected';
  ELSE
    UPDATE public.mkt_content_attributions
       SET review_status = 'rejected', confirmed_by = p_user, confirmed_at = now(), updated_at = now()
     WHERE content_post_id = p_post AND review_status <> 'rejected';
  END IF;

  RETURN jsonb_build_object('post_id', p_post, 'project_id', p_project, 'locked_at', now());
END $$;
REVOKE ALL ON FUNCTION public.mkt_attribution_set(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_attribution_set(uuid, uuid, uuid, text) TO service_role;

-- ── 3. the Y/N review surface sets + locks the pointer (it used to fill only
--       a NULL pointer, so a wrong existing link survived a "yes" on the right
--       one, and a "yes" never protected the post from the next re-run) ─────
CREATE OR REPLACE FUNCTION public.mkt_attribution_review(
  p_post_id uuid, p_project_id uuid, p_accept boolean, p_user uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF p_accept THEN
    PERFORM public.mkt_attribution_set(p_post_id, p_project_id, p_user, NULL);
  ELSE
    UPDATE public.mkt_content_attributions
       SET review_status='rejected', confirmed_by=p_user, confirmed_at=now(), updated_at=now()
     WHERE content_post_id=p_post_id AND project_id=p_project_id AND review_status<>'rejected';
    -- if the rejected project was the live pointer, the pointer was wrong: clear it
    UPDATE public.mkt_content_enrichment
       SET primary_project_id=NULL, updated_at=now()
     WHERE content_post_id=p_post_id AND primary_project_id=p_project_id
       AND attribution_locked_at IS NULL;
  END IF;
END;
$$;

-- ── 4. reset machine-made attributions before a re-decision ─────────────────
CREATE OR REPLACE FUNCTION public.mkt_attribution_reset_auto(p_post uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE public.mkt_content_attributions
     SET review_status = 'candidate', updated_at = now()
   WHERE content_post_id = p_post AND review_status = 'auto_accepted';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.mkt_attribution_reset_auto(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_attribution_reset_auto(uuid) TO service_role;

-- ── 5. project ↔ developer relationships, kept live ─────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_sync_developer_relationships(p_project uuid DEFAULT NULL, p_org uuid DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  INSERT INTO public.mkt_project_organizations
    (project_id, organization_id, relationship_type, confidence, evidence, human_confirmed, is_active)
  SELECT r.id, o.id, 'developer', 1,
         jsonb_build_object('source', 'developer_field_sync', 'synced_at', now()), false, true
    FROM public.records r
    JOIN public.mkt_organizations o
      ON o.developer_record_id IS NOT NULL
     AND o.developer_record_id::text = r.data->>'developer'
   WHERE r.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'   -- all_projects
     AND (p_project IS NULL OR r.id = p_project)
     AND (p_org IS NULL OR o.id = p_org)
  ON CONFLICT (project_id, organization_id, relationship_type) DO UPDATE
     SET is_active = true, last_observed_at = now(), updated_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.mkt_sync_developer_relationships(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_sync_developer_relationships(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.mkt_tg_records_sync_developer_relationship()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.mkt_sync_developer_relationships(NEW.id, NULL);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS records_sync_developer_relationship ON public.records;
CREATE TRIGGER records_sync_developer_relationship
  AFTER INSERT OR UPDATE OF data ON public.records
  FOR EACH ROW
  WHEN (NEW.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'::uuid)
  EXECUTE FUNCTION public.mkt_tg_records_sync_developer_relationship();

CREATE OR REPLACE FUNCTION public.mkt_tg_org_sync_developer_relationships()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.developer_record_id IS NOT NULL THEN
    PERFORM public.mkt_sync_developer_relationships(NULL, NEW.id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mkt_organizations_sync_developer_relationships ON public.mkt_organizations;
CREATE TRIGGER mkt_organizations_sync_developer_relationships
  AFTER INSERT OR UPDATE OF developer_record_id ON public.mkt_organizations
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_org_sync_developer_relationships();

-- one-time catch-up (ستون الملقا, تل الربوة, and the 3 other unmapped)
SELECT public.mkt_sync_developer_relationships(NULL, NULL);

-- ── 6. evidence package: brand words, sibling projects, lock ────────────────
CREATE OR REPLACE FUNCTION public.mkt_intelligence_evidence(p_post_ids uuid[])
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT coalesce(jsonb_agg(ev), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'post_id', cp.id,
      'platform', cp.platform,
      'post_type', cp.post_type,
      'account', (SELECT '@'||handle||' ('||platform||')' FROM mkt_social_accounts sa WHERE sa.id=cp.social_account_id),
      'organization_id', cp.organization_id,
      'organization_name', o.name_ar,
      -- words of the publisher's own name(s) + account handles: never project evidence
      'brand_tokens', COALESCE((
        SELECT jsonb_agg(DISTINCT w) FROM (
          SELECT regexp_split_to_table(lower(coalesce(o.name_ar,'')||' '||coalesce(o.name_en,'')), '\s+') AS w
          UNION ALL
          SELECT regexp_split_to_table(lower(regexp_replace(coalesce(sa2.handle,'')||' '||coalesce(sa2.display_name,''), '[._-]+', ' ', 'g')), '\s+')
            FROM mkt_social_accounts sa2 WHERE sa2.organization_id = cp.organization_id
        ) t WHERE length(w) >= 3
      ), '[]'::jsonb),
      -- every project this publisher is linked to (so a mention of a sibling
      -- that is NOT a candidate can be recognised as "another project", not
      -- forced onto the nearest candidate)
      'sibling_projects', COALESCE((
        SELECT jsonb_agg(DISTINCT COALESCE(ur.data->>'project_name', ur.data->>'project_name_en'))
          FROM mkt_project_organizations po
          JOIN unified_records ur ON ur.id = po.project_id
         WHERE po.organization_id = cp.organization_id AND po.is_active
      ), '[]'::jsonb),
      'attribution_locked', (e.attribution_locked_at IS NOT NULL),
      'caption',    left(coalesce(cp.caption,''), 8000),
      'transcript', left(coalesce(tr.txt,''),    16000),
      'ocr_text',   left(coalesce(oc.txt,''),    12000),
      'evidence_lengths', jsonb_build_object(
        'caption',    length(coalesce(cp.caption,'')),
        'transcript', length(coalesce(tr.txt,'')),
        'ocr_text',   length(coalesce(oc.txt,''))
      ),
      'evidence_truncated', jsonb_build_object(
        'caption',    length(coalesce(cp.caption,'')) > 8000,
        'transcript', length(coalesce(tr.txt,''))    > 16000,
        'ocr_text',   length(coalesce(oc.txt,''))    > 12000
      ),
      'candidates', coalesce(e.candidate_projects, '[]'::jsonb),
      'deterministic_partial', coalesce((e.result->>'deterministic_partial')::boolean, false),
      'snippet', coalesce(e.result->>'snippet','')
    ) AS ev
    FROM mkt_content_posts cp
    LEFT JOIN mkt_organizations o ON o.id = cp.organization_id
    LEFT JOIN mkt_content_enrichment e ON e.content_post_id = cp.id
    LEFT JOIN LATERAL (
      SELECT string_agg(nullif(t.text,''), ' ') AS txt
      FROM mkt_transcripts t WHERE t.content_post_id = cp.id AND t.status = 'done'
    ) tr ON true
    LEFT JOIN LATERAL (
      SELECT string_agg(nullif(v.text,''), ' | ') AS txt
      FROM mkt_visual_text v WHERE v.content_post_id = cp.id
    ) oc ON true
    WHERE cp.id = ANY(p_post_ids)
  ) s;
$$;

-- ── 7. bulk re-narrow for the rerun ─────────────────────────────────────────
-- Enqueues an attribution-only content_process job (mode=narrow_only) for
-- every processed post that a human has not locked. The worker re-scores
-- candidates from stored evidence (no download, no vision), resets machine
-- attributions and hands posts with candidates back to the runner.
CREATE OR REPLACE FUNCTION public.mkt_enqueue_attribution_rerun(p_org uuid DEFAULT NULL, p_limit int DEFAULT 10000)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT cp.id, cp.organization_id FROM public.mkt_content_posts cp
    JOIN public.mkt_content_enrichment e ON e.content_post_id = cp.id
    WHERE (p_org IS NULL OR cp.organization_id = p_org)
      AND cp.processing_status IN ('processed','partial','awaiting_intelligence')
      AND cp.availability = 'available'
      AND e.attribution_locked_at IS NULL
    ORDER BY cp.published_at DESC NULLS LAST
    LIMIT GREATEST(0, p_limit)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.mkt_collection_jobs j
      WHERE j.kind='content_process' AND j.status IN ('queued','running')
        AND (j.params->>'content_post_id')::uuid = r.id
    ) THEN
      PERFORM public.mkt_job_enqueue('content_process','internal',NULL,
        jsonb_build_object('content_post_id', r.id, 'organization_id', r.organization_id, 'from', 'attribution_rerun', 'mode', 'narrow_only'),
        40, NULL, NULL);
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.mkt_enqueue_attribution_rerun(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_enqueue_attribution_rerun(uuid, int) TO service_role;

-- ── 8. attribution health ───────────────────────────────────────────────────
-- The exact checks that found the problem, so it cannot come back quietly.
CREATE OR REPLACE FUNCTION public.mkt_attribution_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
WITH ev AS (
  SELECT e.content_post_id, e.primary_project_id, e.attribution_locked_at, e.result, e.candidate_projects,
         p.organization_id, p.processing_status,
         lower(regexp_replace(regexp_replace(
           coalesce(p.caption,'')||' '||
           coalesce((SELECT string_agg(vt.text,' ') FROM mkt_visual_text vt WHERE vt.content_post_id=p.id),'')||' '||
           coalesce((SELECT string_agg(t.text,' ') FROM mkt_transcripts t WHERE t.content_post_id=p.id AND t.status='done'),''),
           '[أإآ]','ا','g'),'ة','ه','g')) AS t,
         lower(regexp_replace(regexp_replace(coalesce(ur.data->>'project_name',''),'[أإآ]','ا','g'),'ة','ه','g')) AS pn
  FROM mkt_content_enrichment e
  JOIN mkt_content_posts p ON p.id = e.content_post_id
  LEFT JOIN unified_records ur ON ur.id = e.primary_project_id
  WHERE e.status = 'done'
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
  -- the attributed project's name never appears in the caption, OCR or transcript
  'name_absent',         (SELECT count(*) FROM ev WHERE primary_project_id IS NOT NULL AND attribution_locked_at IS NULL
                                                   AND pn <> '' AND position(pn IN t) = 0),
  -- the pick rests on a lone word (weak candidate)
  'weak_picks',          (SELECT count(*) FROM chosen WHERE strength = 'word'),
  -- posts that name a project the AI could not link (not in catalog / not a candidate)
  'unknown_mentions',    (SELECT count(*) FROM ev WHERE jsonb_array_length(coalesce(result->'mentioned_projects','[]'::jsonb)) > 0),
  'awaiting_decision',   (SELECT count(*) FROM mkt_content_posts WHERE processing_status = 'awaiting_intelligence'),
  'rerun_queued',        (SELECT count(*) FROM mkt_collection_jobs WHERE kind='content_process' AND status IN ('queued','running') AND params->>'mode'='narrow_only'),
  'checked_at',          now()
);
$$;
REVOKE ALL ON FUNCTION public.mkt_attribution_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mkt_attribution_health() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mkt_pipeline_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
SELECT jsonb_build_object(
  'collected',    (SELECT count(*) FROM mkt_content_posts),
  'media_stored', (SELECT count(*) FROM mkt_content_media WHERE download_status='stored'),
  'media_failed', (SELECT count(*) FROM mkt_content_media WHERE download_status='failed'),
  'ocr_done',     (SELECT count(*) FROM mkt_visual_text WHERE status='done'),
  'transcribed',  (SELECT count(*) FROM mkt_transcripts WHERE status='done'),
  'enriched',     (SELECT count(*) FROM mkt_content_enrichment WHERE status='done'),
  'facts',        (SELECT count(*) FROM mkt_observed_facts),
  'attributed',   (SELECT count(*) FROM mkt_content_enrichment WHERE status='done' AND primary_project_id IS NOT NULL),
  'by_status',    (SELECT COALESCE(jsonb_object_agg(processing_status, c), '{}'::jsonb)
                    FROM (SELECT processing_status, count(*) c FROM mkt_content_posts GROUP BY 1) s),
  'attribution',  public.mkt_attribution_health()
);
$$;

-- ── 9. Library: lock, strength, unknown-project mentions ────────────────────
CREATE OR REPLACE FUNCTION public.mkt_content_library(
  p_shelf     text    DEFAULT NULL,
  p_org       uuid    DEFAULT NULL,
  p_format    text    DEFAULT NULL,
  p_platform  text    DEFAULT NULL,
  p_has_offer boolean DEFAULT NULL,
  p_q         text    DEFAULT NULL,
  p_limit     int     DEFAULT 40,
  p_offset    int     DEFAULT 0
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
WITH base AS (
  SELECT
    p.id, p.platform, p.post_type, p.caption, p.engagement, p.published_at,
    p.post_url, p.duration_ms, p.organization_id,
    o.name_ar                                   AS org_name,
    o.developer_record_id                       AS developer_record_id,
    e.primary_project_id,
    e.attribution_locked_at,
    e.candidate_projects,
    e.result                                    AS r,
    (e.result->>'content_type')                 AS content_type
  FROM public.mkt_content_posts p
  JOIN public.mkt_organizations o        ON o.id = p.organization_id
  JOIN public.mkt_content_enrichment e   ON e.content_post_id = p.id AND e.status = 'done'
),
filt AS (
  SELECT * FROM base
  WHERE (p_org      IS NULL OR organization_id = p_org)
    AND (p_format   IS NULL OR post_type = p_format)
    AND (p_platform IS NULL OR platform = p_platform)
    AND (p_has_offer IS NULL OR (p_has_offer = ((COALESCE(r->>'offer','') <> '') OR content_type = 'offer')))
    AND (p_q IS NULL OR p_q = '' OR (
          caption               ILIKE '%'||p_q||'%'
       OR (r->>'campaign_message') ILIKE '%'||p_q||'%'
       OR (r->>'objective')        ILIKE '%'||p_q||'%'
    ))
),
shelved AS (
  SELECT * FROM filt WHERE (p_shelf IS NULL OR content_type = p_shelf)
),
page AS (
  SELECT jsonb_agg(to_jsonb(x)) AS rows FROM (
    SELECT
      s.id, s.org_name, s.organization_id, s.developer_record_id, s.platform,
      s.primary_project_id::text                      AS project_record_id,
      (s.attribution_locked_at IS NOT NULL)           AS attribution_locked,
      (SELECT c->>'strength' FROM jsonb_array_elements(s.candidate_projects) c
        WHERE c->>'projectId' = s.primary_project_id::text LIMIT 1) AS attribution_strength,
      COALESCE(s.r->'mentioned_projects', '[]'::jsonb) AS unknown_projects,
      COALESCE((s.r->>'is_general_branding')::boolean, false) AS is_general_branding,
      s.post_type                                     AS format,
      s.content_type                                  AS shelf,
      COALESCE(NULLIF(s.r->>'campaign_message',''), LEFT(s.caption, 180)) AS summary,
      LEFT(s.caption, 500)                            AS caption,
      (s.r->'selling_points')                         AS selling_points,
      (s.r->'unit_types')                             AS unit_types,
      (s.r->'amenities')                              AS amenities,
      (s.r->'ctas')                                   AS ctas,
      NULLIF(s.r->>'offer','')                        AS offer,
      NULLIF(s.r->>'price','')                        AS price,
      NULLIF(s.r->>'payment_plan','')                 AS payment_plan,
      NULLIF(s.r->>'district','')                     AS district,
      s.engagement, s.published_at, s.post_url,
      (s.duration_ms IS NOT NULL AND s.duration_ms > 0) AS is_video,
      EXISTS (SELECT 1 FROM public.mkt_transcripts t
               WHERE t.content_post_id = s.id AND t.status = 'done') AS has_transcript,
      (SELECT COALESCE(ur.data->>'project_name', ur.data->>'name', ur.data->>'title')
         FROM public.unified_records ur
        WHERE ur.id = s.primary_project_id)          AS project_name,
      (SELECT m.stored_url FROM public.mkt_content_media m
         WHERE m.content_post_id = s.id AND m.download_status = 'stored' AND m.stored_url IS NOT NULL
         ORDER BY (m.media_kind = 'thumbnail') DESC, (m.media_kind = 'image') DESC, m.created_at
         LIMIT 1)                                     AS thumb_url,
      (SELECT jsonb_agg(jsonb_build_object('kind', m.media_kind, 'url', m.stored_url) ORDER BY m.created_at)
         FROM public.mkt_content_media m
        WHERE m.content_post_id = s.id AND m.download_status = 'stored'
          AND m.stored_url IS NOT NULL
          AND m.media_kind IN ('image', 'video')) AS media
    FROM shelved s
    ORDER BY s.published_at DESC NULLS LAST, s.id
    LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0)
  ) x
),
shelves AS (
  SELECT jsonb_object_agg(content_type, c) AS obj FROM (
    SELECT COALESCE(content_type, 'unknown') AS content_type, count(*) AS c
    FROM filt GROUP BY 1
  ) f
)
SELECT jsonb_build_object(
  'total',   (SELECT count(*) FROM shelved),
  'shelves', COALESCE((SELECT obj FROM shelves), '{}'::jsonb),
  'rows',    COALESCE((SELECT rows FROM page), '[]'::jsonb)
);
$$;

COMMIT;
