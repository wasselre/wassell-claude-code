-- ============================================================================
-- Plan-driven task assignment — 5/6: ATOMIC META ENQUEUE.
-- 2026-09-22. Plan v9 §5f + 07-decisions.md D4 (no caption phase for workflow
-- content: every job is `create`, carrying the approved caption payload) and
-- D18 (retry = fresh job; bulk push de-duplicates per ad).
--
-- One transaction: replay check first (job id exists → touch nothing), then
-- phase-specific admission — already produced? being performed with the SAME
-- approved payload? ready to start? — and only then the job insert + the row
-- reset. A live job of another phase is neither a satisfaction nor a blocker.
-- The worker builds from `params.approved_caption.text`, never from the row.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.mos_meta_ad_enqueue(
  p_job_id uuid, p_phase text, p_event_id uuid,
  p_content_id uuid, p_content_title text, p_ad_row_id uuid,
  p_execution_id uuid, p_ad_set_id uuid, p_platform_adset_id text, p_ad_set_name text,
  p_approved_by_auth_uid uuid, p_approved_by_user_id uuid,
  p_approved_caption jsonb DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_row     uuid := COALESCE(p_ad_row_id, CASE WHEN p_event_id IS NULL THEN NULL ELSE public.mos_meta_ad_row_id(p_event_id) END);
  v_ad      record;
  v_state   text;
  v_hash    text;
  v_live    record;
  v_auto    jsonb;
  v_reason  text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';   -- service only
  END IF;
  IF p_phase NOT IN ('caption','create') THEN
    RAISE EXCEPTION 'MOS:BAD_PHASE %', p_phase USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_phase = 'create' AND NULLIF(btrim(COALESCE(p_approved_caption ->> 'text', '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NO_APPROVED_PAYLOAD a create job must carry the approved caption'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'MOS:NO_AD_ROW neither an ad row nor an event id to derive one' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- the hash the DATABASE computes, so every comparison uses one function
  v_hash := CASE WHEN p_phase = 'create' THEN public.mos_caption_hash(p_approved_caption ->> 'text') END;

  -- (i) ensure the ad row exists (deterministic id when there was no placeholder)
  INSERT INTO public.mos_execution_ads (id, execution_id, ad_set_id, content_id, label, status, creative)
  VALUES (v_row, p_execution_id, p_ad_set_id, p_content_id, p_content_title, 'waiting', '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  -- (ii) lock it
  SELECT ea.id, ea.platform_ad_id, ea.status, ea.creative, ea.creative -> 'auto_ad' AS auto_ad
    INTO v_ad FROM public.mos_execution_ads ea WHERE ea.id = v_row FOR UPDATE;
  v_state := COALESCE(v_ad.auto_ad ->> 'state', '');

  -- (iii) replay: this exact job already exists → touch nothing
  IF EXISTS (SELECT 1 FROM public.generation_jobs g WHERE g.id = p_job_id) THEN
    RETURN jsonb_build_object('enqueued', false, 'reason', 'replay', 'job_id', p_job_id,
                              'ad_row_id', v_row, 'ad_state', v_state);
  END IF;

  -- (iv) phase-specific admission
  -- already produced? (create: built; caption: caption written or beyond)
  IF p_phase = 'create' AND (v_ad.platform_ad_id IS NOT NULL
        OR (v_state IN ('creating','created') AND COALESCE(v_ad.auto_ad ->> 'phase', 'create') = 'create')) THEN
    IF v_ad.auto_ad ->> 'approval_hash' IS NOT DISTINCT FROM v_hash THEN
      RETURN jsonb_build_object('enqueued', false, 'reason', 'already_done', 'job_id', v_ad.auto_ad ->> 'job_id',
                                'ad_row_id', v_row, 'ad_state', v_state);
    END IF;
    RETURN jsonb_build_object('enqueued', false, 'reason', 'superseded', 'detail', 'built_with_other_caption',
                              'ad_row_id', v_row, 'ad_state', v_state);
  END IF;
  IF p_phase = 'caption' AND (v_ad.platform_ad_id IS NOT NULL OR v_state IN ('caption_review','creating','created')) THEN
    RETURN jsonb_build_object('enqueued', false, 'reason', 'already_done', 'ad_row_id', v_row, 'ad_state', v_state);
  END IF;

  -- being performed by a live job of the SAME phase (and, for create, the same approved payload)?
  SELECT g.id, g.params INTO v_live
    FROM public.generation_jobs g
   WHERE g.kind = 'meta-ad' AND g.status IN ('queued','running')
     AND g.params ->> 'ad_row_id' = v_row::text
     AND COALESCE(g.params ->> 'phase', 'caption') = p_phase
   ORDER BY g.created_at DESC LIMIT 1;
  IF v_live.id IS NOT NULL THEN
    IF p_phase = 'create' AND (v_live.params -> 'approved_caption' ->> 'hash') IS DISTINCT FROM v_hash THEN
      RETURN jsonb_build_object('enqueued', false, 'reason', 'superseded', 'detail', 'superseded_by_job:' || v_live.id,
                                'job_id', v_live.id, 'ad_row_id', v_row, 'ad_state', v_state);
    END IF;
    RETURN jsonb_build_object('enqueued', false, 'reason', 'satisfied_by', 'job_id', v_live.id,
                              'ad_row_id', v_row, 'ad_state', v_state);
  END IF;

  -- ready to start? (a live job of ANOTHER phase is neither a satisfaction nor a blocker)
  v_reason := NULL;
  IF p_phase = 'create' AND v_state NOT IN ('', 'caption_review', 'failed', 'queued') THEN v_reason := 'wrong_state:' || v_state; END IF;
  IF p_phase = 'caption' AND v_state NOT IN ('', 'failed') THEN v_reason := 'wrong_state:' || v_state; END IF;
  IF v_state = 'queued' AND COALESCE(v_ad.auto_ad ->> 'phase', '') <> p_phase
     AND EXISTS (SELECT 1 FROM public.generation_jobs g WHERE g.id::text = v_ad.auto_ad ->> 'job_id' AND g.status IN ('queued','running')) THEN
    v_reason := 'retry_later';     -- the predecessor phase is queued and has not produced its output yet
  END IF;
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('enqueued', false, 'reason', CASE WHEN v_reason = 'retry_later' THEN 'retry_later' ELSE 'retry_later' END,
                              'detail', v_reason, 'ad_row_id', v_row, 'ad_state', v_state);
  END IF;

  -- (v) admit: the job, then the reset — same transaction, gated on the same insert
  INSERT INTO public.generation_jobs (id, record_id, message_id, generation_id, user_id, kind, status, prompt, params)
  VALUES (p_job_id, p_content_id, v_row::text, NULL, p_approved_by_auth_uid, 'meta-ad', 'queued', NULL,
          jsonb_build_object('content_id', p_content_id, 'ad_row_id', v_row, 'execution_id', p_execution_id,
                             'ad_set_id', p_ad_set_id, 'platform_adset_id', p_platform_adset_id,
                             'ad_set_name', p_ad_set_name, 'approved_by_user_id', p_approved_by_user_id,
                             'phase', p_phase, 'event_id', p_event_id,
                             'approved_caption', CASE WHEN p_phase = 'create'
                                                      THEN p_approved_caption || jsonb_build_object('hash', v_hash)
                                                      ELSE NULL END))
  ON CONFLICT (id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('enqueued', false, 'reason', 'replay', 'job_id', p_job_id, 'ad_row_id', v_row, 'ad_state', v_state);
  END IF;

  v_auto := COALESCE(v_ad.auto_ad, '{}'::jsonb)
            || jsonb_build_object('state', 'queued', 'phase', p_phase, 'job_id', p_job_id, 'queued_at', now(),
                                  'approved_by_user_id', p_approved_by_user_id, 'error', NULL,
                                  'approval_hash', v_hash, 'approval_scope', 'caption', 'event_id', p_event_id);
  UPDATE public.mos_execution_ads
     SET content_id = COALESCE(p_content_id, content_id),
         ad_set_id  = COALESCE(p_ad_set_id, ad_set_id),
         status     = 'waiting',
         creative   = COALESCE(creative, '{}'::jsonb)
                      || CASE WHEN p_phase = 'create'
                              THEN jsonb_build_object('primary_text', p_approved_caption ->> 'text',
                                                      'message', p_approved_caption ->> 'text')
                              ELSE '{}'::jsonb END
                      || jsonb_build_object('auto_ad', v_auto),
         updated_at = now()
   WHERE id = v_row;

  RETURN jsonb_build_object('enqueued', true, 'reason', 'enqueued', 'job_id', p_job_id, 'ad_row_id', v_row, 'ad_state', 'queued');
END $function$;

REVOKE ALL ON FUNCTION public.mos_meta_ad_enqueue(uuid, text, uuid, uuid, text, uuid, uuid, uuid, text, text, uuid, uuid, jsonb) FROM anon, authenticated;

COMMIT;
