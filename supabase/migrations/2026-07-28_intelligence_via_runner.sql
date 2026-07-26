-- ============================================================================
-- Route content intelligence (enrichment / project attribution / general-branding)
-- through the Claude Code runner (paid subscription) instead of the Anthropic API.
-- The deterministic pipeline (media, transcribe, OCR/vision, candidate narrowing)
-- stays on the Fly worker; it now writes a PENDING enrichment row carrying the
-- narrowed candidates and flips the post to 'awaiting_intelligence'. A batching
-- RPC groups those posts into claude_jobs; scripts/claude-study-runner.mjs reads
-- a scoped evidence package, runs the content-enrichment Skill, validates the
-- JSON, and writes results via the existing scoped upsert RPCs.
-- ============================================================================

-- the runner is now the intelligence engine for marketing content, not just studies
ALTER TABLE public.claude_jobs DROP CONSTRAINT IF EXISTS claude_jobs_kind_check;
ALTER TABLE public.claude_jobs ADD CONSTRAINT claude_jobs_kind_check
  CHECK (kind = ANY (ARRAY['ping','client_study','mkt_content_enrichment']));

ALTER TABLE public.mkt_content_posts DROP CONSTRAINT IF EXISTS mkt_content_posts_processing_status_check;
ALTER TABLE public.mkt_content_posts ADD CONSTRAINT mkt_content_posts_processing_status_check
  CHECK (processing_status IN ('collected','processing','awaiting_intelligence','processed','partial','failed'));

ALTER TABLE public.mkt_content_enrichment DROP CONSTRAINT IF EXISTS mkt_content_enrichment_status_check;
ALTER TABLE public.mkt_content_enrichment ADD CONSTRAINT mkt_content_enrichment_status_check
  CHECK (status IN ('pending','done','failed'));

-- scoped, read-only evidence package for a batch (least privilege)
CREATE OR REPLACE FUNCTION public.mkt_intelligence_evidence(p_post_ids uuid[])
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT coalesce(jsonb_agg(ev), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'post_id', cp.id,
      'platform', cp.platform,
      'post_type', cp.post_type,
      'account', (SELECT '@'||handle||' ('||platform||')' FROM mkt_social_accounts sa WHERE sa.id=cp.social_account_id),
      'organization_id', cp.organization_id,
      'caption', left(coalesce(cp.caption,''), 2000),
      'transcript', left(coalesce((SELECT string_agg(nullif(t.text,''), ' ') FROM mkt_transcripts t WHERE t.content_post_id=cp.id AND t.status='done'),''), 4000),
      'ocr_text', left(coalesce((SELECT string_agg(nullif(v.text,''), ' | ') FROM mkt_visual_text v WHERE v.content_post_id=cp.id),''), 3000),
      'candidates', coalesce(e.candidate_projects, '[]'::jsonb),
      'deterministic_partial', coalesce((e.result->>'deterministic_partial')::boolean, false),
      'snippet', coalesce(e.result->>'snippet','')
    ) AS ev
    FROM mkt_content_posts cp
    LEFT JOIN mkt_content_enrichment e ON e.content_post_id=cp.id
    WHERE cp.id = ANY(p_post_ids)
  ) s;
$$;

-- batch awaiting-intelligence posts into claude_jobs (idempotent: skips posts
-- already in a pending/running enrichment job)
CREATE OR REPLACE FUNCTION public.mkt_enqueue_intelligence(p_org uuid, p_batch int DEFAULT 15, p_max_jobs int DEFAULT 20)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_jobs int := 0; v_ids uuid[];
BEGIN
  LOOP
    EXIT WHEN v_jobs >= p_max_jobs;
    SELECT array_agg(id) INTO v_ids FROM (
      SELECT cp.id FROM mkt_content_posts cp
      WHERE cp.organization_id = p_org AND cp.processing_status = 'awaiting_intelligence'
        AND NOT EXISTS (
          SELECT 1 FROM claude_jobs j WHERE j.kind='mkt_content_enrichment' AND j.status IN ('pending','running')
            AND j.payload->'post_ids' @> to_jsonb(cp.id::text)
        )
      ORDER BY cp.published_at DESC NULLS LAST
      LIMIT GREATEST(1, p_batch)
    ) z;
    EXIT WHEN v_ids IS NULL OR array_length(v_ids,1) IS NULL;
    INSERT INTO claude_jobs(kind, payload, status)
    VALUES ('mkt_content_enrichment', jsonb_build_object('organization_id', p_org, 'post_ids', to_jsonb(v_ids)), 'pending');
    v_jobs := v_jobs + 1;
  END LOOP;
  RETURN v_jobs;
END $$;

-- rate-limit: park a job as blocked; claude_jobs_unblock requeues after cooldown
CREATE OR REPLACE FUNCTION public.claude_job_block(p_job_id uuid, p_error text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.claude_jobs SET status='blocked_subscription_limit', error=p_error, finished_at=NULL WHERE id=p_job_id;
END $$;

CREATE OR REPLACE FUNCTION public.claude_jobs_unblock()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE public.claude_jobs SET status='pending', error=NULL WHERE status='blocked_subscription_limit';
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION public.mkt_intelligence_evidence(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_enqueue_intelligence(uuid,int,int) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.claude_job_block(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claude_jobs_unblock() TO service_role, authenticated;
