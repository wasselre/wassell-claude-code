-- ============================================================================
-- 2026-07-23: Paid Advertising Intelligence — extra ad fields, append-only change
-- history (the core historical-tracking feature), + ad RPCs. Reuses mkt_paid_ads
-- / mkt_ad_attributions (Phase 0) + the mkt_collection_jobs queue + attribution
-- engine. Meta Ad Library only (via the apify/facebook-ads-scraper actor);
-- platform-agnostic so TikTok/Snap ad libraries add later without a model change.
-- Applied to prod via apply_migration; this file is the repo record.
-- ============================================================================
BEGIN;

ALTER TABLE public.mkt_paid_ads
  ADD COLUMN IF NOT EXISTS description       text,
  ADD COLUMN IF NOT EXISTS languages         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS platform_ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS creative_file_id  uuid;

CREATE UNIQUE INDEX IF NOT EXISTS mkt_paid_ads_platform_ext_uidx ON public.mkt_paid_ads (platform, external_ad_id);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_ad_attributions_ad_proj_uidx ON public.mkt_ad_attributions (paid_ad_id, project_id);

-- Append-only change log. NEVER overwritten — this is how competitor campaign
-- activity is reconstructed over time.
CREATE TABLE IF NOT EXISTS public.mkt_ad_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paid_ad_id  uuid NOT NULL REFERENCES public.mkt_paid_ads(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  change_type text NOT NULL CHECK (change_type IN
                ('new','removed','creative_change','cta_change','landing_change','status_change','text_change')),
  field       text, old_value jsonb, new_value jsonb, run_id uuid
);
CREATE INDEX IF NOT EXISTS mkt_ad_history_ad_idx   ON public.mkt_ad_history (paid_ad_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS mkt_ad_history_type_idx ON public.mkt_ad_history (change_type, observed_at DESC);
ALTER TABLE public.mkt_ad_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_ad_history_read ON public.mkt_ad_history;
CREATE POLICY mkt_ad_history_read ON public.mkt_ad_history FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.mkt_ad_history TO authenticated;

-- Stable URL key: strip scheme+host (Meta rotates CDN edge hosts) + query
-- (expiring tokens) so re-fetching the same creative isn't a false 'change'.
CREATE OR REPLACE FUNCTION public.mkt_url_key(u text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(split_part(COALESCE(u,''),'?',1),'^https?://[^/]+','');
$$;

-- Upsert one ad (dedup on platform+external_ad_id); diff tracked fields → one
-- history row per change; accumulate providers; return the change list.
CREATE OR REPLACE FUNCTION public.mkt_paid_ad_upsert(
  p_platform text, p_external_ad_id text, p_provider text,
  p_organization_id uuid DEFAULT NULL, p_advertiser_name text DEFAULT NULL,
  p_creative_media_ref text DEFAULT NULL, p_creative_type text DEFAULT NULL,
  p_headline text DEFAULT NULL, p_body text DEFAULT NULL, p_description text DEFAULT NULL,
  p_cta text DEFAULT NULL, p_landing_url text DEFAULT NULL, p_languages text[] DEFAULT '{}',
  p_platform_started_at timestamptz DEFAULT NULL, p_is_active boolean DEFAULT true,
  p_reach_info jsonb DEFAULT '{}'::jsonb, p_raw_ref uuid DEFAULT NULL, p_run_id uuid DEFAULT NULL
) RETURNS TABLE (id uuid, was_inserted boolean, changes text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; e record; ch text[] := '{}';
BEGIN
  SELECT * INTO e FROM public.mkt_paid_ads a WHERE a.platform=p_platform AND a.external_ad_id=p_external_ad_id;
  IF e.id IS NULL THEN
    INSERT INTO public.mkt_paid_ads (platform, external_ad_id, organization_id, advertiser_name,
      creative_media_ref, creative_type, headline, body, description, cta, landing_url, languages,
      platform_started_at, is_active, reach_info, providers, raw_ref, first_seen_at, last_seen_at)
    VALUES (p_platform, p_external_ad_id, p_organization_id, p_advertiser_name, p_creative_media_ref,
      p_creative_type, p_headline, p_body, p_description, p_cta, p_landing_url, COALESCE(p_languages,'{}'),
      p_platform_started_at, p_is_active, COALESCE(p_reach_info,'{}'::jsonb), ARRAY[p_provider], p_raw_ref, now(), now())
    RETURNING mkt_paid_ads.id INTO v_id;
    INSERT INTO public.mkt_ad_history (paid_ad_id, change_type, new_value, run_id) VALUES (v_id,'new',to_jsonb(p_external_ad_id),p_run_id);
    RETURN QUERY SELECT v_id, true, ARRAY['new']; RETURN;
  END IF;
  v_id := e.id;
  -- creative/landing change: compare the host+query-stripped key (Meta rotates CDN hosts + expiring tokens)
  IF p_creative_media_ref IS NOT NULL AND mkt_url_key(p_creative_media_ref) IS DISTINCT FROM mkt_url_key(e.creative_media_ref) THEN
    INSERT INTO mkt_ad_history(paid_ad_id,change_type,field,old_value,new_value,run_id) VALUES (v_id,'creative_change','creative_media_ref',to_jsonb(e.creative_media_ref),to_jsonb(p_creative_media_ref),p_run_id);
    ch := array_append(ch,'creative_change');
  END IF;
  IF p_cta IS NOT NULL AND p_cta IS DISTINCT FROM e.cta THEN
    INSERT INTO mkt_ad_history(paid_ad_id,change_type,field,old_value,new_value,run_id) VALUES (v_id,'cta_change','cta',to_jsonb(e.cta),to_jsonb(p_cta),p_run_id);
    ch := array_append(ch,'cta_change');
  END IF;
  IF p_landing_url IS NOT NULL AND mkt_url_key(p_landing_url) IS DISTINCT FROM mkt_url_key(e.landing_url) THEN
    INSERT INTO mkt_ad_history(paid_ad_id,change_type,field,old_value,new_value,run_id) VALUES (v_id,'landing_change','landing_url',to_jsonb(e.landing_url),to_jsonb(p_landing_url),p_run_id);
    ch := array_append(ch,'landing_change');
  END IF;
  IF p_is_active IS DISTINCT FROM e.is_active THEN
    INSERT INTO mkt_ad_history(paid_ad_id,change_type,field,old_value,new_value,run_id) VALUES (v_id,'status_change','is_active',to_jsonb(e.is_active),to_jsonb(p_is_active),p_run_id);
    ch := array_append(ch,'status_change');
  END IF;
  IF (p_body IS NOT NULL AND p_body IS DISTINCT FROM e.body) OR (p_headline IS NOT NULL AND p_headline IS DISTINCT FROM e.headline) THEN
    INSERT INTO mkt_ad_history(paid_ad_id,change_type,field,old_value,new_value,run_id) VALUES (v_id,'text_change','body/headline',jsonb_build_object('headline',e.headline,'body',e.body),jsonb_build_object('headline',p_headline,'body',p_body),p_run_id);
    ch := array_append(ch,'text_change');
  END IF;
  UPDATE public.mkt_paid_ads a SET
    providers=(SELECT array_agg(DISTINCT x) FROM unnest(a.providers || ARRAY[p_provider]) x),
    organization_id=COALESCE(p_organization_id,a.organization_id), advertiser_name=COALESCE(p_advertiser_name,a.advertiser_name),
    creative_media_ref=COALESCE(p_creative_media_ref,a.creative_media_ref), creative_type=COALESCE(p_creative_type,a.creative_type),
    headline=COALESCE(p_headline,a.headline), body=COALESCE(p_body,a.body), description=COALESCE(p_description,a.description),
    cta=COALESCE(p_cta,a.cta), landing_url=COALESCE(p_landing_url,a.landing_url),
    languages=CASE WHEN p_languages IS NULL OR p_languages='{}' THEN a.languages ELSE p_languages END,
    platform_started_at=COALESCE(p_platform_started_at,a.platform_started_at), is_active=p_is_active,
    platform_ended_at=CASE WHEN a.is_active AND NOT p_is_active THEN now() ELSE a.platform_ended_at END,
    reach_info=CASE WHEN p_reach_info IS NULL OR p_reach_info='{}'::jsonb THEN a.reach_info ELSE p_reach_info END,
    raw_ref=COALESCE(p_raw_ref,a.raw_ref), last_seen_at=now(), updated_at=now()
  WHERE a.id=v_id;
  RETURN QUERY SELECT v_id, false, ch;
END $$;

-- Mark ads not seen this run as removed (append 'removed' history).
CREATE OR REPLACE FUNCTION public.mkt_ad_mark_removed(
  p_organization_id uuid, p_platform text, p_seen_ids text[], p_run_id uuid DEFAULT NULL
) RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT id, external_ad_id FROM public.mkt_paid_ads
            WHERE organization_id=p_organization_id AND platform=p_platform AND is_active=true
              AND NOT (external_ad_id = ANY(COALESCE(p_seen_ids,'{}'))) LOOP
    UPDATE public.mkt_paid_ads SET is_active=false, platform_ended_at=now(), updated_at=now() WHERE id=r.id;
    INSERT INTO public.mkt_ad_history(paid_ad_id,change_type,old_value,run_id) VALUES (r.id,'removed',to_jsonb(r.external_ad_id),p_run_id);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_ad_attribution_upsert(
  p_paid_ad_id uuid, p_project_id uuid, p_method text, p_confidence numeric,
  p_evidence jsonb DEFAULT '{}'::jsonb, p_auto_accept boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.mkt_ad_attributions (paid_ad_id, project_id, attribution_method, confidence, evidence, review_status)
  VALUES (p_paid_ad_id, p_project_id, p_method, p_confidence, COALESCE(p_evidence,'{}'::jsonb),
          CASE WHEN p_auto_accept THEN 'auto_accepted' ELSE 'candidate' END)
  ON CONFLICT (paid_ad_id, project_id) DO UPDATE SET
    confidence=GREATEST(mkt_ad_attributions.confidence, EXCLUDED.confidence), evidence=EXCLUDED.evidence,
    review_status=CASE WHEN mkt_ad_attributions.review_status IN ('confirmed','rejected') THEN mkt_ad_attributions.review_status ELSE EXCLUDED.review_status END;
END $$;

DO $$ DECLARE fn text; BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'mkt_paid_ad_upsert(text,text,text,uuid,text,text,text,text,text,text,text,text,text[],timestamptz,boolean,jsonb,uuid,uuid)',
    'mkt_ad_mark_removed(uuid,text,text[],uuid)','mkt_ad_attribution_upsert(uuid,uuid,text,numeric,jsonb,boolean)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
  END LOOP;
END $$;

COMMIT;
