-- ============================================================================
-- Content-understanding vertical: permanent media, transcripts, visual text,
-- and structured enrichment for collected social content. Builds ON TOP of the
-- existing collection tables (mkt_content_posts keeps the post + caption +
-- metadata; these tables add the per-asset media + understanding layer).
--
-- A content item is "processed" only when its media are stored AND (for videos)
-- transcribed AND its frames/images OCR'd AND it is enriched AND attributed —
-- or each of those has an explicit terminal failure. processing_status on
-- mkt_content_posts is the single roll-up.
-- ============================================================================

-- ── 1. per-asset permanent media ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_content_media (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_post_id   uuid NOT NULL REFERENCES public.mkt_content_posts(id) ON DELETE CASCADE,
  carousel_index    int  NOT NULL DEFAULT 0,          -- 0 for single-media posts
  media_kind        text NOT NULL,                    -- video | image | thumbnail
  original_url      text,                             -- platform CDN url (expires)
  stored_bucket     text,
  stored_path       text,
  stored_url        text,                             -- permanent public url
  mime_type         text,
  bytes             bigint,
  width             int,
  height            int,
  duration_ms       int,
  checksum_sha256   text,                             -- exact content fingerprint (dedup)
  phash             text,                             -- perceptual hash (best-effort)
  download_status   text NOT NULL DEFAULT 'pending',  -- pending | stored | failed | skipped
  failure_reason    text,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_verified_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_content_media_kind_check CHECK (media_kind IN ('video','image','thumbnail')),
  CONSTRAINT mkt_content_media_status_check CHECK (download_status IN ('pending','stored','failed','skipped')),
  UNIQUE (content_post_id, carousel_index, media_kind)
);
CREATE INDEX IF NOT EXISTS mkt_content_media_post_idx     ON public.mkt_content_media(content_post_id);
CREATE INDEX IF NOT EXISTS mkt_content_media_checksum_idx ON public.mkt_content_media(checksum_sha256) WHERE checksum_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS mkt_content_media_status_idx   ON public.mkt_content_media(download_status);

-- ── 2. transcripts (one per video media + model) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_transcripts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_media_id  uuid NOT NULL REFERENCES public.mkt_content_media(id) ON DELETE CASCADE,
  content_post_id   uuid NOT NULL REFERENCES public.mkt_content_posts(id) ON DELETE CASCADE,
  provider          text NOT NULL,                    -- fal
  model             text NOT NULL,                    -- e.g. wizper / whisper-large-v3
  language          text,                             -- detected (ar | en | mixed | ...)
  text              text,                             -- full normalized transcript
  segments          jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{start_ms,end_ms,text}]
  duration_ms       int,
  confidence        numeric,
  cost_usd          numeric NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'done',      -- done | failed
  failure_reason    text,
  source_checksum   text,                              -- media checksum at transcription time
  raw               jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_transcripts_status_check CHECK (status IN ('done','failed')),
  UNIQUE (content_media_id, model)
);
CREATE INDEX IF NOT EXISTS mkt_transcripts_post_idx ON public.mkt_transcripts(content_post_id);

-- ── 3. visual text (one per analysed image / video frame) ───────────────────
CREATE TABLE IF NOT EXISTS public.mkt_visual_text (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_media_id  uuid NOT NULL REFERENCES public.mkt_content_media(id) ON DELETE CASCADE,
  content_post_id   uuid NOT NULL REFERENCES public.mkt_content_posts(id) ON DELETE CASCADE,
  source            text NOT NULL,                     -- image | frame | thumbnail
  frame_ts_ms       int,                               -- for video frames
  model             text NOT NULL,
  text              text,                              -- concatenated visible text
  structured        jsonb NOT NULL DEFAULT '{}'::jsonb,-- {project_names,prices,phones,urls,ctas,offers,districts,unit_types,payment_plans,dates}
  confidence        numeric,
  cost_usd          numeric NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'done',
  failure_reason    text,
  raw               jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_visual_text_status_check CHECK (status IN ('done','failed')),
  UNIQUE (content_media_id, source, frame_ts_ms)
);
CREATE INDEX IF NOT EXISTS mkt_visual_text_post_idx ON public.mkt_visual_text(content_post_id);

-- ── 4. structured enrichment (one per content post) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_content_enrichment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_post_id   uuid NOT NULL REFERENCES public.mkt_content_posts(id) ON DELETE CASCADE,
  model             text,
  rule_version      text,
  organization_id   uuid,
  developer_id      uuid,
  marketer_id       uuid,
  primary_project_id uuid,
  candidate_projects jsonb NOT NULL DEFAULT '[]'::jsonb,
  result            jsonb NOT NULL DEFAULT '{}'::jsonb, -- content_type,objective,offer,financing,payment_plan,price,unit_types,location,district,amenities,selling_points,ctas,audience,language,campaign_message
  cost_usd          numeric NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'done',
  failure_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_content_enrichment_status_check CHECK (status IN ('done','failed')),
  UNIQUE (content_post_id)
);
CREATE INDEX IF NOT EXISTS mkt_content_enrichment_project_idx ON public.mkt_content_enrichment(primary_project_id);

-- ── 5. roll-up status on the post ───────────────────────────────────────────
ALTER TABLE public.mkt_content_posts ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'collected';
ALTER TABLE public.mkt_content_posts ADD COLUMN IF NOT EXISTS media_count int NOT NULL DEFAULT 0;
ALTER TABLE public.mkt_content_posts ADD COLUMN IF NOT EXISTS processed_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_content_posts_processing_status_check') THEN
    ALTER TABLE public.mkt_content_posts ADD CONSTRAINT mkt_content_posts_processing_status_check
      CHECK (processing_status IN ('collected','processing','processed','partial','failed'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS mkt_content_posts_processing_idx ON public.mkt_content_posts(processing_status);

-- ── 6. new job kind + provider ──────────────────────────────────────────────
ALTER TABLE public.mkt_collection_jobs DROP CONSTRAINT IF EXISTS mkt_collection_jobs_kind_check;
ALTER TABLE public.mkt_collection_jobs ADD CONSTRAINT mkt_collection_jobs_kind_check CHECK (kind = ANY (ARRAY[
  'discover','discover_advertiser','organization_discovery','account_verification',
  'backfill','incremental','post_metrics','account_metrics','paid_ads','attribution','reprocess',
  'content_process'
]));
-- content_process is not provider-specific — it downloads media + calls FAL/Anthropic.
ALTER TABLE public.mkt_collection_jobs DROP CONSTRAINT IF EXISTS mkt_collection_jobs_provider_check;
ALTER TABLE public.mkt_collection_jobs ADD CONSTRAINT mkt_collection_jobs_provider_check CHECK (provider = ANY (ARRAY[
  'apify','youtube','browserbase','internal'
]));
-- mkt_job_claim_next JOINs mkt_providers and requires is_enabled + max_concurrency,
-- so the 'internal' provider MUST have a row or content_process jobs never claim.
INSERT INTO public.mkt_providers (provider_key, display_name, is_enabled, max_concurrency, max_backfill_posts)
VALUES ('internal','Internal (content understanding)', true, 5, 200)
ON CONFLICT (provider_key) DO UPDATE SET is_enabled=true, max_concurrency=EXCLUDED.max_concurrency;

-- ── 7. RLS (authenticated read; writes via SECURITY DEFINER RPCs / service role) ─
ALTER TABLE public.mkt_content_media      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_transcripts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_visual_text        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_content_enrichment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_content_media_read      ON public.mkt_content_media;
DROP POLICY IF EXISTS mkt_transcripts_read        ON public.mkt_transcripts;
DROP POLICY IF EXISTS mkt_visual_text_read        ON public.mkt_visual_text;
DROP POLICY IF EXISTS mkt_content_enrichment_read ON public.mkt_content_enrichment;
CREATE POLICY mkt_content_media_read      ON public.mkt_content_media      FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_transcripts_read        ON public.mkt_transcripts        FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_visual_text_read        ON public.mkt_visual_text        FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_content_enrichment_read ON public.mkt_content_enrichment FOR SELECT TO authenticated USING (true);

-- ── 8. RPCs (SECURITY DEFINER; idempotent upserts) ──────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_content_media_upsert(
  p_post uuid, p_carousel_index int, p_kind text, p_original_url text,
  p_bucket text, p_path text, p_url text, p_mime text, p_bytes bigint,
  p_width int, p_height int, p_duration_ms int, p_checksum text, p_phash text,
  p_status text, p_failure text)
RETURNS TABLE(id uuid, was_inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_ins boolean := false;
BEGIN
  INSERT INTO public.mkt_content_media(content_post_id,carousel_index,media_kind,original_url,stored_bucket,stored_path,stored_url,mime_type,bytes,width,height,duration_ms,checksum_sha256,phash,download_status,failure_reason,last_verified_at)
  VALUES (p_post,COALESCE(p_carousel_index,0),p_kind,p_original_url,p_bucket,p_path,p_url,p_mime,p_bytes,p_width,p_height,p_duration_ms,p_checksum,p_phash,COALESCE(p_status,'pending'),p_failure, CASE WHEN p_status='stored' THEN now() END)
  ON CONFLICT (content_post_id,carousel_index,media_kind) DO UPDATE SET
    original_url=COALESCE(EXCLUDED.original_url, mkt_content_media.original_url),
    stored_bucket=COALESCE(EXCLUDED.stored_bucket, mkt_content_media.stored_bucket),
    stored_path=COALESCE(EXCLUDED.stored_path, mkt_content_media.stored_path),
    stored_url=COALESCE(EXCLUDED.stored_url, mkt_content_media.stored_url),
    mime_type=COALESCE(EXCLUDED.mime_type, mkt_content_media.mime_type),
    bytes=COALESCE(EXCLUDED.bytes, mkt_content_media.bytes),
    width=COALESCE(EXCLUDED.width, mkt_content_media.width),
    height=COALESCE(EXCLUDED.height, mkt_content_media.height),
    duration_ms=COALESCE(EXCLUDED.duration_ms, mkt_content_media.duration_ms),
    checksum_sha256=COALESCE(EXCLUDED.checksum_sha256, mkt_content_media.checksum_sha256),
    phash=COALESCE(EXCLUDED.phash, mkt_content_media.phash),
    download_status=EXCLUDED.download_status,
    failure_reason=EXCLUDED.failure_reason,
    last_verified_at=CASE WHEN EXCLUDED.download_status='stored' THEN now() ELSE mkt_content_media.last_verified_at END,
    updated_at=now()
  RETURNING mkt_content_media.id, (xmax = 0) INTO v_id, v_ins;
  RETURN QUERY SELECT v_id, v_ins;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_transcript_upsert(
  p_media uuid, p_post uuid, p_provider text, p_model text, p_language text,
  p_text text, p_segments jsonb, p_duration_ms int, p_confidence numeric,
  p_cost numeric, p_status text, p_failure text, p_source_checksum text, p_raw jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.mkt_transcripts(content_media_id,content_post_id,provider,model,language,text,segments,duration_ms,confidence,cost_usd,status,failure_reason,source_checksum,raw)
  VALUES (p_media,p_post,p_provider,p_model,p_language,p_text,COALESCE(p_segments,'[]'::jsonb),p_duration_ms,p_confidence,COALESCE(p_cost,0),COALESCE(p_status,'done'),p_failure,p_source_checksum,p_raw)
  ON CONFLICT (content_media_id,model) DO UPDATE SET
    language=EXCLUDED.language, text=EXCLUDED.text, segments=EXCLUDED.segments, duration_ms=EXCLUDED.duration_ms,
    confidence=EXCLUDED.confidence, cost_usd=EXCLUDED.cost_usd, status=EXCLUDED.status, failure_reason=EXCLUDED.failure_reason,
    source_checksum=EXCLUDED.source_checksum, raw=EXCLUDED.raw, updated_at=now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_visual_text_upsert(
  p_media uuid, p_post uuid, p_source text, p_frame_ts_ms int, p_model text,
  p_text text, p_structured jsonb, p_confidence numeric, p_cost numeric,
  p_status text, p_failure text, p_raw jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.mkt_visual_text(content_media_id,content_post_id,source,frame_ts_ms,model,text,structured,confidence,cost_usd,status,failure_reason,raw)
  VALUES (p_media,p_post,p_source,p_frame_ts_ms,p_model,p_text,COALESCE(p_structured,'{}'::jsonb),p_confidence,COALESCE(p_cost,0),COALESCE(p_status,'done'),p_failure,p_raw)
  ON CONFLICT (content_media_id,source,frame_ts_ms) DO UPDATE SET
    model=EXCLUDED.model, text=EXCLUDED.text, structured=EXCLUDED.structured, confidence=EXCLUDED.confidence,
    cost_usd=EXCLUDED.cost_usd, status=EXCLUDED.status, failure_reason=EXCLUDED.failure_reason, raw=EXCLUDED.raw
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

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
    developer_id=EXCLUDED.developer_id, marketer_id=EXCLUDED.marketer_id, primary_project_id=EXCLUDED.primary_project_id,
    candidate_projects=EXCLUDED.candidate_projects, result=EXCLUDED.result, cost_usd=EXCLUDED.cost_usd,
    status=EXCLUDED.status, failure_reason=EXCLUDED.failure_reason, updated_at=now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_content_set_status(p_post uuid, p_status text, p_media_count int DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.mkt_content_posts
     SET processing_status=p_status,
         media_count=COALESCE(p_media_count, media_count),
         processed_at=CASE WHEN p_status IN ('processed','partial','failed') THEN now() ELSE processed_at END,
         updated_at=now()
   WHERE id=p_post;
END $$;

-- Enqueue content_process jobs for an org's not-yet-processed posts (bounded).
CREATE OR REPLACE FUNCTION public.mkt_enqueue_content_processing(p_org uuid, p_limit int DEFAULT 100, p_force boolean DEFAULT false)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT cp.id FROM public.mkt_content_posts cp
    WHERE cp.organization_id = p_org
      AND (p_force OR cp.processing_status IN ('collected','failed','partial'))
      AND cp.availability = 'available'
    ORDER BY cp.published_at DESC NULLS LAST
    LIMIT GREATEST(0, p_limit)
  LOOP
    -- skip if an active job already exists for this post
    IF NOT EXISTS (
      SELECT 1 FROM public.mkt_collection_jobs j
      WHERE j.kind='content_process' AND j.status IN ('queued','running')
        AND (j.params->>'content_post_id')::uuid = r.id
    ) THEN
      PERFORM public.mkt_job_enqueue('content_process','internal',NULL,
        jsonb_build_object('content_post_id', r.id, 'organization_id', p_org), 45, NULL, NULL);
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.mkt_content_media_upsert(uuid,int,text,text,text,text,text,text,bigint,int,int,int,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_transcript_upsert(uuid,uuid,text,text,text,text,jsonb,int,numeric,numeric,text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_visual_text_upsert(uuid,uuid,text,int,text,text,jsonb,numeric,numeric,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_enrichment_upsert(uuid,text,text,uuid,uuid,uuid,uuid,jsonb,jsonb,numeric,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_content_set_status(uuid,text,int) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_enqueue_content_processing(uuid,int,boolean) TO service_role, authenticated;
