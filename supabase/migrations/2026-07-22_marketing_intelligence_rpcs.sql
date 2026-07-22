-- ============================================================================
-- 2026-07-22: Project Marketing Intelligence — ingestion RPCs + seed data
-- ----------------------------------------------------------------------------
-- Idempotent, provider-agnostic upserts used by the import script + the worker.
-- All SECURITY DEFINER, service-role only (SPA never calls these directly; it
-- goes through /api/marketing/* which validates the JWT then uses service-role).
--
-- Dedup (design §6): posts collapse on (platform, external_id); a second provider
-- reporting the same post UPDATES the row and appends itself to `providers[]` —
-- never a duplicate. Metric snapshots are append-only history. Attributions
-- collapse on (content_post_id, project_id) and never clobber a human decision.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- Idempotent content-post upsert. Returns (id, was_inserted).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_content_post_upsert(
  p_platform          text,
  p_external_id       text,
  p_provider          text,
  p_social_account_id uuid    DEFAULT NULL,
  p_organization_id   uuid    DEFAULT NULL,
  p_post_url          text    DEFAULT NULL,
  p_canonical_url     text    DEFAULT NULL,
  p_post_type         text    DEFAULT NULL,
  p_caption           text    DEFAULT NULL,
  p_lang              text    DEFAULT NULL,
  p_published_at      timestamptz DEFAULT NULL,
  p_media_refs        jsonb   DEFAULT '[]'::jsonb,
  p_thumbnail_ref     text    DEFAULT NULL,
  p_duration_ms       int     DEFAULT NULL,
  p_hashtags          text[]  DEFAULT '{}',
  p_mentions          text[]  DEFAULT '{}',
  p_engagement        jsonb   DEFAULT '{}'::jsonb,
  p_content_hash      text    DEFAULT NULL
) RETURNS TABLE (id uuid, was_inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_existing uuid;
BEGIN
  SELECT cp.id INTO v_existing FROM public.mkt_content_posts cp
   WHERE cp.platform = p_platform AND cp.external_id = p_external_id;

  IF v_existing IS NULL THEN
    INSERT INTO public.mkt_content_posts (
      platform, external_id, social_account_id, organization_id, post_url, canonical_url,
      post_type, caption, lang, published_at, media_refs, thumbnail_ref, duration_ms,
      hashtags, mentions, engagement, content_hash, providers, first_provider,
      first_seen_at, last_seen_at)
    VALUES (
      p_platform, p_external_id, p_social_account_id, p_organization_id, p_post_url, p_canonical_url,
      p_post_type, p_caption, p_lang, p_published_at, COALESCE(p_media_refs,'[]'::jsonb), p_thumbnail_ref,
      p_duration_ms, COALESCE(p_hashtags,'{}'), COALESCE(p_mentions,'{}'),
      COALESCE(p_engagement,'{}'::jsonb), p_content_hash, ARRAY[p_provider], p_provider,
      now(), now())
    RETURNING mkt_content_posts.id INTO v_id;
    RETURN QUERY SELECT v_id, true;
  ELSE
    UPDATE public.mkt_content_posts cp SET
      -- accumulate provider (dedup across providers — never a new row)
      providers        = (SELECT array_agg(DISTINCT x) FROM unnest(cp.providers || ARRAY[p_provider]) x),
      -- refresh fields that can change; keep existing when the new value is null
      social_account_id = COALESCE(p_social_account_id, cp.social_account_id),
      organization_id   = COALESCE(p_organization_id, cp.organization_id),
      post_url          = COALESCE(p_post_url, cp.post_url),
      canonical_url     = COALESCE(p_canonical_url, cp.canonical_url),
      post_type         = COALESCE(p_post_type, cp.post_type),
      caption           = COALESCE(p_caption, cp.caption),
      published_at      = COALESCE(p_published_at, cp.published_at),
      media_refs        = CASE WHEN p_media_refs IS NULL OR p_media_refs='[]'::jsonb THEN cp.media_refs ELSE p_media_refs END,
      thumbnail_ref     = COALESCE(p_thumbnail_ref, cp.thumbnail_ref),
      duration_ms       = COALESCE(p_duration_ms, cp.duration_ms),
      hashtags          = CASE WHEN array_length(p_hashtags,1) IS NULL THEN cp.hashtags ELSE p_hashtags END,
      mentions          = CASE WHEN array_length(p_mentions,1) IS NULL THEN cp.mentions ELSE p_mentions END,
      engagement        = CASE WHEN p_engagement IS NULL OR p_engagement='{}'::jsonb THEN cp.engagement ELSE p_engagement END,
      content_hash      = COALESCE(p_content_hash, cp.content_hash),
      last_seen_at      = now()
    WHERE cp.id = v_existing;
    RETURN QUERY SELECT v_existing, false;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Append a metric snapshot (history is never overwritten). Also refreshes the
-- post's engagement cache when subject is a post.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_metric_snapshot_insert(
  p_subject_type text,
  p_subject_id   uuid,
  p_metrics      jsonb,
  p_provider     text DEFAULT NULL,
  p_raw_ref      uuid DEFAULT NULL,
  p_captured_at  timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.mkt_metric_snapshots (subject_type, subject_id, captured_at, metrics, provider, raw_ref)
  VALUES (p_subject_type, p_subject_id, COALESCE(p_captured_at, now()), p_metrics, p_provider, p_raw_ref)
  RETURNING id INTO v_id;

  IF p_subject_type = 'post' THEN
    UPDATE public.mkt_content_posts SET engagement = p_metrics, last_seen_at = now() WHERE id = p_subject_id;
  END IF;
  RETURN v_id;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Upsert a project attribution candidate. Never clobbers a human decision
-- (confirmed/rejected); keeps the higher confidence otherwise.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_attribution_upsert(
  p_content_post_id uuid,
  p_project_id      uuid,
  p_method          text,
  p_confidence      numeric,
  p_evidence        jsonb   DEFAULT '{}'::jsonb,
  p_matched_aliases text[]  DEFAULT '{}',
  p_auto_accept     boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_status text;
BEGIN
  SELECT id, review_status INTO v_id, v_status FROM public.mkt_content_attributions
   WHERE content_post_id = p_content_post_id AND project_id = p_project_id;

  IF v_id IS NULL THEN
    INSERT INTO public.mkt_content_attributions
      (content_post_id, project_id, attribution_method, confidence, evidence, matched_aliases, review_status)
    VALUES (p_content_post_id, p_project_id, p_method, p_confidence, COALESCE(p_evidence,'{}'::jsonb),
            COALESCE(p_matched_aliases,'{}'),
            CASE WHEN p_auto_accept THEN 'auto_accepted' ELSE 'candidate' END)
    RETURNING id INTO v_id;
  ELSIF v_status IN ('confirmed','rejected') THEN
    -- human already decided — do not touch
    NULL;
  ELSE
    UPDATE public.mkt_content_attributions SET
      attribution_method = CASE WHEN p_confidence >= confidence THEN p_method ELSE attribution_method END,
      confidence         = GREATEST(confidence, p_confidence),
      evidence           = COALESCE(p_evidence, evidence),
      matched_aliases    = CASE WHEN array_length(p_matched_aliases,1) IS NULL THEN matched_aliases ELSE p_matched_aliases END,
      review_status      = CASE WHEN p_auto_accept AND review_status='candidate' THEN 'auto_accepted' ELSE review_status END,
      updated_at         = now()
    WHERE id = v_id;
  END IF;
  RETURN v_id;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Ingestion-run bookkeeping.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_ingestion_run_start(
  p_provider text, p_source_account_id uuid, p_scope jsonb, p_worker_job_ref text DEFAULT NULL
) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.mkt_ingestion_runs (provider, source_account_id, requested_scope, worker_job_ref)
  VALUES (p_provider, p_source_account_id, COALESCE(p_scope,'{}'::jsonb), p_worker_job_ref)
  RETURNING id;
$$;

CREATE OR REPLACE FUNCTION public.mkt_ingestion_run_finish(
  p_run_id uuid, p_status text, p_received int, p_inserted int, p_updated int, p_skipped int,
  p_errors jsonb DEFAULT '[]'::jsonb, p_cost jsonb DEFAULT NULL, p_rate jsonb DEFAULT NULL
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.mkt_ingestion_runs
     SET status=p_status, finished_at=now(), items_received=p_received, items_inserted=p_inserted,
         items_updated=p_updated, items_skipped=p_skipped, errors=COALESCE(p_errors,'[]'::jsonb),
         provider_cost=p_cost, rate_limit_info=p_rate
   WHERE id=p_run_id;
$$;

-- Store a raw provider payload for debug/reprocessing.
CREATE OR REPLACE FUNCTION public.mkt_raw_ingestion_insert(
  p_provider text, p_source_type text, p_external_identity text, p_payload jsonb,
  p_dedup_key text DEFAULT NULL, p_run_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.mkt_raw_ingestions (provider, source_type, external_identity, payload, dedup_key, ingestion_run_id)
  VALUES (p_provider, p_source_type, p_external_identity, p_payload, p_dedup_key, p_run_id)
  RETURNING id;
$$;

-- Retention: drop raw payloads older than 90 days (called by a scheduled job).
CREATE OR REPLACE FUNCTION public.mkt_raw_ingestions_cleanup(p_days int DEFAULT 90)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  DELETE FROM public.mkt_raw_ingestions WHERE collected_at < now() - (p_days || ' days')::interval;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Lock down: service-role only.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'mkt_content_post_upsert(text,text,text,uuid,uuid,text,text,text,text,text,timestamptz,jsonb,text,int,text[],text[],jsonb,text)',
    'mkt_metric_snapshot_insert(text,uuid,jsonb,text,uuid,timestamptz)',
    'mkt_attribution_upsert(uuid,uuid,text,numeric,jsonb,text[],boolean)',
    'mkt_ingestion_run_start(text,uuid,jsonb,text)',
    'mkt_ingestion_run_finish(uuid,text,int,int,int,int,jsonb,jsonb,jsonb)',
    'mkt_raw_ingestion_insert(text,text,text,jsonb,text,uuid)',
    'mkt_raw_ingestions_cleanup(int)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Seed the provider registry (all start not_configured until secrets are set).
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO public.mkt_providers (provider_key, display_name, config) VALUES
  ('youtube',     'YouTube Data API v3', '{"env":"YOUTUBE_DATA_API_KEY","cost":"quota"}'::jsonb),
  ('apify',       'Apify',               '{"env":"APIFY_API_TOKEN","cost":"per-actor-run"}'::jsonb),
  ('browserbase', 'Browserbase (fallback)', '{"env":"BROWSERBASE_API_KEY","cost":"per-session"}'::jsonb)
ON CONFLICT (provider_key) DO NOTHING;

-- Seed candidate Apify Actor configs — DISABLED until vetted + token present.
-- These are the widely-used public-content scrapers; final selection is documented
-- in docs/marketing-intelligence-design.md and can be edited here without code changes.
INSERT INTO public.mkt_actor_configs (source_type, actor_id, input_builder, result_parser, version, notes) VALUES
  ('instagram_profile', 'apify/instagram-scraper',      'buildInstagramProfileInput', 'parseInstagramPosts', 'candidate', 'IG profile+posts+reels; public data.'),
  ('tiktok_profile',    'clockworks/tiktok-scraper',    'buildTiktokProfileInput',    'parseTiktokVideos',   'candidate', 'TikTok profile+videos; public data.'),
  ('facebook_posts',    'apify/facebook-posts-scraper', 'buildFacebookPostsInput',    'parseFacebookPosts',  'candidate', 'FB page posts; public data.'),
  ('meta_ads',          'apify/facebook-ads-scraper',   'buildMetaAdsInput',          'parseMetaAds',        'candidate', 'Public Meta Ad Library results.')
ON CONFLICT (source_type, actor_id) DO NOTHING;

COMMIT;
