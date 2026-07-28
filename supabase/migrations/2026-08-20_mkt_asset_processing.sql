-- ============================================================================
-- Raw-asset analysis: OCR / transcript / description for uploaded files
-- (2026-08-20).
--
-- Routed through the EXISTING mkt_collection_jobs queue and the EXISTING vision
-- + transcription code in the worker. A second queue and a second OCR
-- implementation would be two more things to operate and two more things to
-- drift — this codebase has already paid for worker/api copies elsewhere.
--
-- Applied to production in this session; recorded here in full so the repo
-- creates what it documents.
-- ============================================================================

-- ── kind vocabulary ─────────────────────────────────────────────────────────
-- Rebuilt with ALL 13 pre-existing kinds plus the new one. A DROP+ADD from one
-- feature's migration silently removed `whatsapp_reply` from a shared CHECK
-- earlier in this codebase's history; the full list is spelled out so that
-- cannot happen again by omission.
ALTER TABLE public.mkt_collection_jobs DROP CONSTRAINT IF EXISTS mkt_collection_jobs_kind_check;
ALTER TABLE public.mkt_collection_jobs ADD CONSTRAINT mkt_collection_jobs_kind_check
  CHECK (kind = ANY (ARRAY[
    'discover','discover_advertiser','organization_discovery','account_verification',
    'backfill','incremental','post_metrics','account_metrics','paid_ads','attribution',
    'reprocess','content_process','campaign_group',
    'asset_process'
  ]::text[]));

-- ── enqueue ─────────────────────────────────────────────────────────────────
-- Gate on "is there an end user", NOT on a list of system role names. The first
-- version resolved the caller through auth.uid() unconditionally, which is NULL
-- server-side, so every system caller graded as role 'none' and the worker was
-- permanently locked out of its own queue — a feature that looked fine in the UI
-- and was dead everywhere else. A second version allowed only
-- auth.role()='service_role', which still refused the table owner and would
-- refuse any future system identity.
--
-- That reasoning only holds if anon cannot reach the function, so the grants are
-- stated explicitly below rather than assumed from elsewhere.
CREATE OR REPLACE FUNCTION public.mkt_asset_enqueue_processing(
  p_asset_ids uuid[] DEFAULT NULL, p_limit int DEFAULT 50)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_n int := 0; r record;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mkt_can('write_content') THEN
    RAISE EXCEPTION 'your marketing role does not permit asset processing'
      USING ERRCODE='insufficient_privilege';
  END IF;

  FOR r IN
    SELECT a.id
    FROM public.mkt_raw_assets a
    WHERE a.archived_at IS NULL
      AND a.file_id IS NOT NULL                       -- nothing to analyse without bytes
      AND (p_asset_ids IS NULL OR a.id = ANY(p_asset_ids))
      AND (p_asset_ids IS NOT NULL OR a.processing_status = 'not_attempted')
      -- never double-queue: an asset already pending/running is skipped even when
      -- named explicitly, so a double-click cannot spend model budget twice
      AND NOT EXISTS (
        SELECT 1 FROM public.mkt_collection_jobs j
        WHERE j.kind = 'asset_process'
          AND j.status IN ('queued','running')
          AND (j.params ->> 'asset_id') = a.id::text)
    LIMIT greatest(1, least(coalesce(p_limit,50), 500))
  LOOP
    PERFORM public.mkt_job_enqueue('asset_process','internal',NULL,
      jsonb_build_object('asset_id', r.id::text), 45, NULL, NULL);
    -- stamp pending so the UI reads "in flight" rather than offering to queue again
    UPDATE public.mkt_raw_assets SET processing_status='pending' WHERE id=r.id;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION public.mkt_asset_enqueue_processing(uuid[], int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_asset_enqueue_processing(uuid[], int) TO authenticated, service_role;

-- ── completion ──────────────────────────────────────────────────────────────
-- One place owns the honest-state vocabulary, so no call site can invent a
-- state or quietly write a success it did not achieve.
CREATE OR REPLACE FUNCTION public.mkt_asset_processing_complete(
  p_asset_id uuid,
  p_status text,                       -- completed | degraded | failed | unsupported
  p_ocr_text text DEFAULT NULL,
  p_transcript text DEFAULT NULL,
  p_ai_description text DEFAULT NULL,
  p_tags text[] DEFAULT NULL,
  p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF p_status NOT IN ('completed','degraded','failed','unsupported') THEN
    RAISE EXCEPTION 'invalid processing status: %', p_status USING ERRCODE='check_violation';
  END IF;
  UPDATE public.mkt_raw_assets SET
    -- COALESCE, not overwrite: a degraded run that only managed OCR must not
    -- wipe a transcript an earlier run already produced.
    ocr_text          = COALESCE(NULLIF(p_ocr_text,''),       ocr_text),
    transcript        = COALESCE(NULLIF(p_transcript,''),     transcript),
    ai_description    = COALESCE(NULLIF(p_ai_description,''), ai_description),
    tags              = CASE WHEN p_tags IS NULL OR array_length(p_tags,1) IS NULL
                             THEN tags ELSE p_tags END,
    processing_status = p_status,
    processing_error  = p_error,
    updated_at        = now()
  WHERE id = p_asset_id;
END $$;

REVOKE ALL ON FUNCTION public.mkt_asset_processing_complete(uuid,text,text,text,text,text[],text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_asset_processing_complete(uuid,text,text,text,text,text[],text) TO service_role;
