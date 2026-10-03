-- ============================================================================
-- Competitor tracking: database-side bug fixes (2026-10-03)
-- ----------------------------------------------------------------------------
-- Found by the system analysis + 48-post audit of 2026-10-03. Each part is a
-- bug fix with no product decision in it.
--
-- 1. Six YouTube accounts failed EVERY day ("YouTube channel not found", 1,691
--    failed jobs). Four stored their channel id in lowercase — channel ids are
--    case-sensitive, so 'ucd117cauhsn4hsyof7c7_ea' can never resolve to
--    'UCD117CaUHsn4hSYOf7C7_EA'. Two stored a handle the YouTube API does not
--    know. Real ids were read from each company's own website (and, for Rawah,
--    from the videos its site embeds) and verified against the API.
--
-- 2. A post the AI decided was about project X (or no project) could keep an
--    older machine row saying it was "auto-accepted" for project Y: the
--    collection-time matcher auto-accepts, and nothing demoted that row when
--    the runner later decided otherwise. The project record's Marketing tab
--    reads that table, so it disagreed with Competitor Watch (15 posts).
--    New mkt_attribution_demote_stale() is called by the runner after every
--    decision; the existing disagreements are repaired here.
--
-- 3. The evidence the AI reads repeated the same on-screen text once per
--    frame or slide (an end-card 4–6×, a carousel footer 18×), pushing real
--    text towards the 12,000-character cut and burying it in noise.
--    mkt_intelligence_evidence now keeps each distinct OCR text once, in the
--    order it was first seen.
--
-- 4. 159 SECURITY DEFINER mkt_* functions were executable by `anon` — anyone
--    holding the public anon key (it ships in the web app) could call e.g.
--    mkt_enrichment_upsert or mkt_alert_emit and write as the table owner.
--    Nothing anonymous calls any of them (no RLS policy, view, edge function,
--    website page or unauthenticated API route uses one — checked). EXECUTE is
--    revoked from PUBLIC and anon only; authenticated and service_role keep
--    exactly what they had (re-granted explicitly, asserted below).
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '8s';

-- ── 1. YouTube channel ids ─────────────────────────────────────────────────
UPDATE public.mkt_social_accounts a
   SET external_account_id = v.channel_id,
       handle              = v.handle,
       profile_url         = 'https://www.youtube.com/channel/' || v.channel_id,
       scrape_status       = 'idle',
       updated_at          = now()
  FROM (VALUES
    ('fcc010eb-b1cb-48c4-b80f-1dfd37833a82'::uuid, 'UCD117CaUHsn4hSYOf7C7_EA', '@retalsa'),        -- Rattal
    ('cea51b7f-e6ad-435a-8632-1a46bd8a03f4'::uuid, 'UCG-WZdLZ83ieFHpj_ZJdMYQ', '@shurfahholding'), -- Shurfa
    ('e9fdb11c-50a8-4aa8-9d3f-01cc42429a30'::uuid, 'UCm6kp7v_ruFmoqOx78iysSA', '@alhabibinv'),     -- Mohammed Al Habib
    ('e8b956f8-d547-430a-8da5-c9145bd5e3d8'::uuid, 'UCZZXGk-IFxyA1E8kuyTzSJA', '@wareef_estate'),  -- Wareef
    ('18fab393-17b8-40a3-976a-b8f0ca303d29'::uuid, 'UC7-RoG1M0aB3kNtZneFp57Q', '@rafalliving'),    -- Rafal
    ('f0e99d4f-cb21-4c07-b224-46b2a34033b0'::uuid, 'UClq80OKkko7HBtTtCQMhOxg', '@rawahred-co')     -- Rawah
  ) AS v(id, channel_id, handle)
 WHERE a.id = v.id AND a.platform = 'youtube';

-- The jobs still queued for these accounts carry the old error; let them retry
-- now rather than after their backoff.
UPDATE public.mkt_collection_jobs
   SET next_run_at = now()
 WHERE status = 'queued'
   AND social_account_id IN ('fcc010eb-b1cb-48c4-b80f-1dfd37833a82','cea51b7f-e6ad-435a-8632-1a46bd8a03f4',
                             'e9fdb11c-50a8-4aa8-9d3f-01cc42429a30','e8b956f8-d547-430a-8da5-c9145bd5e3d8',
                             '18fab393-17b8-40a3-976a-b8f0ca303d29','f0e99d4f-cb21-4c07-b224-46b2a34033b0');

-- ── 2. Stale auto-accepted links ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_attribution_demote_stale(p_post uuid, p_keep_project uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE n integer;
BEGIN
  -- A human-locked post is owned by mkt_attribution_set; never touch it here.
  IF EXISTS (SELECT 1 FROM public.mkt_content_enrichment
              WHERE content_post_id = p_post AND attribution_locked_at IS NOT NULL) THEN
    RETURN 0;
  END IF;
  -- Only MACHINE auto-accepts go back to 'candidate' (still visible to a
  -- reviewer as a suggestion). 'confirmed' and 'rejected' are human decisions.
  UPDATE public.mkt_content_attributions
     SET review_status = 'candidate', updated_at = now()
   WHERE content_post_id = p_post
     AND review_status = 'auto_accepted'
     AND (p_keep_project IS NULL OR project_id <> p_keep_project);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.mkt_attribution_demote_stale(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_attribution_demote_stale(uuid, uuid) TO service_role;

-- Repair the existing disagreements: a decided (status 'done'), unlocked post
-- whose auto-accepted row names a different project than its decision.
UPDATE public.mkt_content_attributions a
   SET review_status = 'candidate', updated_at = now()
  FROM public.mkt_content_enrichment e
 WHERE e.content_post_id = a.content_post_id
   AND e.status = 'done'
   AND e.attribution_locked_at IS NULL
   AND a.review_status = 'auto_accepted'
   AND (e.primary_project_id IS NULL OR a.project_id <> e.primary_project_id);

-- ── 3. De-duplicated OCR in the evidence package ───────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_intelligence_evidence(p_post_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(jsonb_agg(ev), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'post_id', cp.id,
      'platform', cp.platform,
      'post_type', cp.post_type,
      'account', (SELECT '@'||handle||' ('||platform||')' FROM mkt_social_accounts sa WHERE sa.id=cp.social_account_id),
      'organization_id', cp.organization_id,
      'organization_name', o.name_ar,
      'brand_tokens', COALESCE((
        SELECT jsonb_agg(DISTINCT w) FROM (
          SELECT regexp_split_to_table(lower(coalesce(o.name_ar,'')||' '||coalesce(o.name_en,'')), '\s+') AS w
          UNION ALL
          SELECT regexp_split_to_table(lower(regexp_replace(coalesce(sa2.handle,'')||' '||coalesce(sa2.display_name,''), '[._-]+', ' ', 'g')), '\s+')
            FROM mkt_social_accounts sa2 WHERE sa2.organization_id = cp.organization_id
        ) t WHERE length(w) >= 3
      ), '[]'::jsonb),
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
      -- Each distinct text once, in first-seen order (images/thumbnails by
      -- read time, frames by timestamp). The same end-card read off six frames
      -- is one piece of evidence, not six.
      SELECT string_agg(d.txt, ' | ' ORDER BY d.first_at, d.first_ts) AS txt
      FROM (
        SELECT btrim(v.text) AS txt, min(v.created_at) AS first_at, min(coalesce(v.frame_ts_ms, 0)) AS first_ts
          FROM mkt_visual_text v
         WHERE v.content_post_id = cp.id AND nullif(btrim(v.text), '') IS NOT NULL
         GROUP BY btrim(v.text)
      ) d
    ) oc ON true
    WHERE cp.id = ANY(p_post_ids)
  ) s;
$function$;

-- ── 4. No anonymous EXECUTE on SECURITY DEFINER mkt_* functions ─────────────
DO $grants$
DECLARE r record; v_auth boolean; v_svc boolean; n integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.proname LIKE 'mkt\_%' AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    v_auth := has_function_privilege('authenticated', r.oid, 'EXECUTE');
    v_svc  := has_function_privilege('service_role',  r.oid, 'EXECUTE');
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    IF v_auth THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig); END IF;
    IF v_svc  THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',  r.sig); END IF;
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE') IS DISTINCT FROM v_auth
       OR has_function_privilege('service_role', r.oid, 'EXECUTE') IS DISTINCT FROM v_svc THEN
      RAISE EXCEPTION 'GRANT_DRIFT % — authenticated/service_role access changed', r.sig;
    END IF;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'revoked anon EXECUTE on % SECURITY DEFINER mkt_* functions', n;
END $grants$;

DO $assert$
DECLARE v_left integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname LIKE 'mkt\_%' AND p.prosecdef
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_left > 0 THEN
    RAISE EXCEPTION 'ANON_EXECUTE_REMAINS on % SECURITY DEFINER mkt_* functions', v_left;
  END IF;
END $assert$;

COMMIT;
