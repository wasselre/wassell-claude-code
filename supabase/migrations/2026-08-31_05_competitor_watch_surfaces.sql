-- Competitor Watch — the four monitoring surfaces' gathering RPCs.
-- Read-only composites (one round trip each), SECURITY DEFINER like
-- mkt_intelligence_index; the /competitor-watch route is the access gate.
-- Additive; nothing else calls these until the UI ships.

-- 1. AGENTS & RUNS ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mkt_agent_activity()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
SELECT jsonb_build_object(
  'collection', jsonb_build_object(
    'paused',           COALESCE((SELECT (value)::boolean FROM mkt_settings WHERE key='collection_paused'), true),
    'enabled_accounts', (SELECT count(*) FROM mkt_social_accounts WHERE collection_enabled AND is_active),
    'total_accounts',   (SELECT count(*) FROM mkt_social_accounts WHERE is_active),
    'runs_today',       (SELECT count(*) FROM mkt_ingestion_runs WHERE started_at >= date_trunc('day', now())),
    'received_today',   (SELECT COALESCE(sum(items_received),0) FROM mkt_ingestion_runs WHERE started_at >= date_trunc('day', now())),
    'inserted_today',   (SELECT COALESCE(sum(items_inserted),0) FROM mkt_ingestion_runs WHERE started_at >= date_trunc('day', now())),
    'last_activity',    (SELECT max(updated_at) FROM mkt_collection_jobs),
    'daily',            (SELECT COALESCE(jsonb_agg(jsonb_build_object('day', d, 'inserted', ins) ORDER BY d), '[]'::jsonb)
                          FROM (SELECT date_trunc('day', started_at)::date AS d, sum(items_inserted) AS ins
                                FROM mkt_ingestion_runs WHERE started_at >= now() - interval '7 days' GROUP BY 1) x)
  ),
  'understanding', jsonb_build_object(
    'processed_24h', (SELECT count(*) FROM mkt_collection_jobs WHERE kind='content_process' AND status='succeeded' AND updated_at > now()-interval '24 hours'),
    'queued',        (SELECT count(*) FROM mkt_collection_jobs WHERE kind='content_process' AND status IN ('queued','running')),
    'all_time',      (SELECT count(*) FROM mkt_collection_jobs WHERE kind='content_process' AND status='succeeded')
  ),
  'discovery', jsonb_build_object(
    'last_run',  (SELECT max(started_at) FROM mkt_discovery_runs),
    'runs',      (SELECT count(*) FROM mkt_discovery_runs),
    'confirmed', (SELECT COALESCE(sum(confirmed_count),0) FROM mkt_discovery_runs)
  ),
  'runs', (SELECT COALESCE(jsonb_agg(to_jsonb(rr) ORDER BY rr.started_at DESC), '[]'::jsonb) FROM (
      SELECT r.provider, sa.platform, sa.handle, r.items_received AS received,
             r.items_inserted AS inserted, r.started_at, r.status
      FROM mkt_ingestion_runs r
      LEFT JOIN mkt_social_accounts sa ON sa.id = r.source_account_id
      WHERE r.started_at >= date_trunc('day', now())
      ORDER BY r.started_at DESC LIMIT 25
    ) rr)
);
$$;
REVOKE ALL ON FUNCTION public.mkt_agent_activity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mkt_agent_activity() TO authenticated, service_role;

-- 2. CONTENT PIPELINE -------------------------------------------------------
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
  'attributed',   (SELECT count(*) FROM mkt_content_attributions WHERE review_status IN ('confirmed','auto_accepted')),
  'by_status',    (SELECT COALESCE(jsonb_object_agg(processing_status, c), '{}'::jsonb)
                    FROM (SELECT processing_status, count(*) c FROM mkt_content_posts GROUP BY 1) s)
);
$$;
REVOKE ALL ON FUNCTION public.mkt_pipeline_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mkt_pipeline_health() TO authenticated, service_role;

-- 3. STORAGE ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mkt_storage_usage()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
SELECT jsonb_build_object(
  'media_bytes',     (SELECT COALESCE(sum(bytes),0) FROM mkt_content_media WHERE download_status='stored'),
  'media_rows',      (SELECT count(*) FROM mkt_content_media WHERE download_status='stored'),
  'raw_asset_bytes', (SELECT COALESCE(sum(size_bytes),0) FROM mkt_raw_assets),
  'by_kind', (SELECT COALESCE(jsonb_object_agg(media_kind, jsonb_build_object('count', c, 'bytes', b)), '{}'::jsonb)
               FROM (SELECT media_kind, count(*) c, COALESCE(sum(bytes),0) b
                     FROM mkt_content_media WHERE download_status='stored' GROUP BY 1) s),
  'by_company', (SELECT COALESCE(jsonb_agg(to_jsonb(cc) ORDER BY cc.bytes DESC), '[]'::jsonb) FROM (
      SELECT o.name_ar AS org, count(m.id) AS files, COALESCE(sum(m.bytes),0) AS bytes
      FROM mkt_content_media m
      JOIN mkt_content_posts p ON p.id = m.content_post_id
      JOIN mkt_organizations o ON o.id = p.organization_id
      WHERE m.download_status='stored'
      GROUP BY o.id, o.name_ar
      ORDER BY bytes DESC LIMIT 12) cc)
);
$$;
REVOKE ALL ON FUNCTION public.mkt_storage_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mkt_storage_usage() TO authenticated, service_role;

-- 4. COMPANIES + ACCOUNTS ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.mkt_company_roster()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
WITH acct_posts AS (
  SELECT social_account_id, count(*) AS posts FROM mkt_content_posts GROUP BY social_account_id
)
SELECT jsonb_build_object(
  'companies', COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.posts DESC NULLS LAST), '[]'::jsonb)
) FROM (
  SELECT
    o.id, o.name_ar AS name, o.org_type,
    (SELECT count(*) FROM mkt_observed_facts f WHERE f.organization_id = o.id) AS facts,
    (SELECT count(*) FROM mkt_social_accounts sa WHERE sa.organization_id = o.id AND sa.is_active) AS accounts,
    (SELECT COALESCE(sum(ap.posts),0) FROM mkt_social_accounts sa JOIN acct_posts ap ON ap.social_account_id = sa.id
       WHERE sa.organization_id = o.id) AS posts,
    (SELECT COALESCE(sum(sa.followers),0) FROM mkt_social_accounts sa WHERE sa.organization_id = o.id AND sa.is_active) AS followers,
    (SELECT max(sa.last_incremental_at) FROM mkt_social_accounts sa WHERE sa.organization_id = o.id) AS last_pull,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'platform', sa.platform, 'handle', sa.handle, 'followers', sa.followers,
         'enabled', sa.collection_enabled, 'last_pull', sa.last_incremental_at,
         'posts', (SELECT ap.posts FROM acct_posts ap WHERE ap.social_account_id = sa.id)
       ) ORDER BY sa.platform), '[]'::jsonb)
       FROM mkt_social_accounts sa WHERE sa.organization_id = o.id AND sa.is_active) AS account_list
  FROM mkt_organizations o
  WHERE EXISTS (SELECT 1 FROM mkt_social_accounts sa WHERE sa.organization_id = o.id AND sa.is_active)
) row;
$$;
REVOKE ALL ON FUNCTION public.mkt_company_roster() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mkt_company_roster() TO authenticated, service_role;
