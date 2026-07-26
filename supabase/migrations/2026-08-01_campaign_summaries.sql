-- ============================================================================
-- 2026-08-01 — Campaign summaries: the SECOND intelligence Skill on the runner.
--
-- Campaign grouping already produces deterministic facts per campaign (members,
-- platforms, offers, payment plans, CTAs, creative reuse, active window). What
-- it cannot produce is the READ: what this competitor campaign is actually
-- doing, who it targets, how organic and paid are being used together, and how
-- it differs from that advertiser's other campaigns.
--
-- That judgement runs as a Claude Code Skill on the always-on Fly runner
-- (paid subscription, no incremental per-token API charge) — the same execution
-- path proven for content enrichment. This migration is deliberately a MIRROR of
-- the enrichment one (evidence RPC → claude_jobs → validated upsert), because a
-- second bespoke pattern would be a second thing to operate.
--
-- NOT a redesign: grouping, the queue, the lease and the runner are untouched.
-- ============================================================================

-- ── 1. New job kind ─────────────────────────────────────────────────────────
ALTER TABLE public.claude_jobs DROP CONSTRAINT IF EXISTS claude_jobs_kind_check;
ALTER TABLE public.claude_jobs ADD CONSTRAINT claude_jobs_kind_check
  CHECK (kind = ANY (ARRAY['ping','client_study','mkt_content_enrichment','mkt_campaign_summary']));

-- ── 2. Summary storage ──────────────────────────────────────────────────────
-- Separate table (not columns on mkt_campaigns) so a re-run never touches the
-- deterministic grouping facts, and so status/provenance/versioning live with
-- the judgement rather than with the data it was derived from.
CREATE TABLE IF NOT EXISTS public.mkt_campaign_summaries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES public.mkt_campaigns(id) ON DELETE CASCADE,
  organization_id  uuid,
  model            text,
  skill_version    text,
  result           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Which campaign members the summary actually cites. Makes every claim
  -- traceable back to a post/ad instead of being an unfalsifiable narrative.
  evidence_refs    jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence       numeric NOT NULL DEFAULT 0,
  cost_usd         numeric NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'done',
  failure_reason   text,
  -- Grouping state the summary was written against. When grouping moves on
  -- (members added/removed), the summary is stale and can be re-run.
  member_count_at_summary int NOT NULL DEFAULT 0,
  last_seen_at_at_summary timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mkt_campaign_summaries_status_check CHECK (status IN ('pending','done','failed')),
  UNIQUE (campaign_id)
);
CREATE INDEX IF NOT EXISTS mkt_campaign_summaries_org_idx    ON public.mkt_campaign_summaries(organization_id);
CREATE INDEX IF NOT EXISTS mkt_campaign_summaries_status_idx ON public.mkt_campaign_summaries(status);

ALTER TABLE public.mkt_campaign_summaries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_campaign_summaries_read ON public.mkt_campaign_summaries;
CREATE POLICY mkt_campaign_summaries_read ON public.mkt_campaign_summaries
  FOR SELECT TO authenticated USING (true);

-- ── 3. Evidence package ─────────────────────────────────────────────────────
-- Read-only, least-privilege, and self-describing about its own limits: every
-- truncation is reported (see 2026-07-31 — evidence must never be silently cut).
CREATE OR REPLACE FUNCTION public.mkt_campaign_evidence(p_campaign_ids uuid[])
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT coalesce(jsonb_agg(ev ORDER BY ev->>'campaign_id'), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(
      'campaign_id',   c.id,
      'label',         coalesce(c.manual_label, c.label),
      'organization',  (SELECT coalesce(o.name_en, o.name_ar) FROM mkt_organizations o WHERE o.id = c.organization_id),
      'objective',     c.objective,
      'platforms',     to_jsonb(c.platforms),
      'is_active',     c.is_active,
      'first_seen_at', c.first_seen_at,
      'last_seen_at',  c.last_seen_at,
      'member_count',  c.member_count,
      'organic_count', c.organic_count,
      'paid_count',    c.paid_count,
      'reused_creatives', c.reused_creatives,
      'offers',        to_jsonb(c.offers),
      'payment_plans', to_jsonb(c.payment_plans),
      'ctas',          to_jsonb(c.ctas),
      'key_message',   c.key_message,
      -- The project this campaign promotes, by NAME (a bare uuid is unusable
      -- to a model and to a human reviewer alike).
      -- `project_name` is the LIVE all_projects slug (verified against the
      -- database, not seedModels — the two have drifted).
      'project', (
        SELECT jsonb_build_object('project_id', c.project_id, 'name', r.data->>'project_name')
        FROM unified_records r WHERE r.id = c.project_id
      ),
      -- Members with their own evidence, capped and REPORTED as capped.
      'members', coalesce(m.members, '[]'::jsonb),
      'members_included', coalesce(m.n, 0),
      'members_omitted',  greatest(0, c.member_count - coalesce(m.n, 0)),
      -- Sibling campaigns from the same advertiser: "how does this differ from
      -- their other campaigns" is unanswerable without them. Capped at the 10
      -- most recent — and the cap is REPORTED, never silent (a summary written
      -- against a partial sibling set must say so).
      'sibling_campaigns', coalesce(sib.rows, '[]'::jsonb),
      'siblings_omitted', greatest(0, coalesce(sib.total, 0) - coalesce(sib.n, 0))
    ) AS ev
    FROM mkt_campaigns c
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(mm ORDER BY mm->>'published_at' DESC) AS members, count(*) AS n
      FROM (
        SELECT jsonb_build_object(
          'member_type', cm.member_type,
          'post_id',     cm.content_post_id,
          'ad_id',       cm.paid_ad_id,
          'platform',    coalesce(cp.platform, 'meta'),
          'post_type',   cp.post_type,
          'published_at', coalesce(cp.published_at, pa.first_seen_at),
          'url',         coalesce(cp.post_url, pa.landing_url),
          'caption',     left(coalesce(cp.caption, pa.headline, ''), 1200),
          'caption_full_length', length(coalesce(cp.caption, pa.headline, '')),
          'transcript',  left(coalesce((SELECT string_agg(nullif(t.text,''), ' ')
                                        FROM mkt_transcripts t
                                        WHERE t.content_post_id = cp.id AND t.status='done'), ''), 2500),
          'ocr_text',    left(coalesce((SELECT string_agg(nullif(v.text,''), ' | ')
                                        FROM mkt_visual_text v
                                        WHERE v.content_post_id = cp.id), ''), 1500),
          'engagement',  cp.engagement,
          'enrichment',  (SELECT jsonb_build_object('content_type', e.result->>'content_type',
                                                    'offer', e.result->>'offer',
                                                    'price', e.result->>'price',
                                                    'district', e.result->>'district',
                                                    'campaign_message', e.result->>'campaign_message')
                          FROM mkt_content_enrichment e WHERE e.content_post_id = cp.id)
        ) AS mm
        FROM mkt_campaign_members cm
        LEFT JOIN mkt_content_posts cp ON cp.id = cm.content_post_id
        LEFT JOIN mkt_paid_ads      pa ON pa.id = cm.paid_ad_id
        WHERE cm.campaign_id = c.id
        ORDER BY coalesce(cp.published_at, pa.first_seen_at) DESC NULLS LAST
        LIMIT 40
      ) z
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(ss) AS rows, count(*) AS n,
             (SELECT count(*) FROM mkt_campaigns s2
               WHERE s2.organization_id = c.organization_id AND s2.id <> c.id) AS total
      FROM (
        SELECT jsonb_build_object(
                 'campaign_id', s.id, 'label', coalesce(s.manual_label, s.label),
                 'objective', s.objective, 'platforms', to_jsonb(s.platforms),
                 'member_count', s.member_count, 'is_active', s.is_active,
                 'key_message', s.key_message) AS ss
        FROM mkt_campaigns s
        WHERE s.organization_id = c.organization_id AND s.id <> c.id
        ORDER BY s.last_seen_at DESC NULLS LAST
        LIMIT 10
      ) y
    ) sib ON true
    WHERE c.id = ANY(p_campaign_ids)
  ) s;
$$;

-- ── 4. Persist a validated summary ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_campaign_summary_upsert(
  p_campaign uuid, p_org uuid, p_model text, p_skill_version text,
  p_result jsonb, p_evidence_refs jsonb, p_confidence numeric,
  p_cost numeric, p_status text, p_failure text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_members int; v_last timestamptz;
BEGIN
  SELECT member_count, last_seen_at INTO v_members, v_last
  FROM public.mkt_campaigns WHERE id = p_campaign;

  INSERT INTO public.mkt_campaign_summaries(
    campaign_id, organization_id, model, skill_version, result, evidence_refs,
    confidence, cost_usd, status, failure_reason,
    member_count_at_summary, last_seen_at_at_summary)
  VALUES (p_campaign, p_org, p_model, p_skill_version,
          COALESCE(p_result,'{}'::jsonb), COALESCE(p_evidence_refs,'[]'::jsonb),
          COALESCE(p_confidence,0), COALESCE(p_cost,0), COALESCE(p_status,'done'), p_failure,
          COALESCE(v_members,0), v_last)
  ON CONFLICT (campaign_id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id, model = EXCLUDED.model,
    skill_version = EXCLUDED.skill_version, result = EXCLUDED.result,
    evidence_refs = EXCLUDED.evidence_refs, confidence = EXCLUDED.confidence,
    cost_usd = EXCLUDED.cost_usd, status = EXCLUDED.status,
    failure_reason = EXCLUDED.failure_reason,
    member_count_at_summary = EXCLUDED.member_count_at_summary,
    last_seen_at_at_summary = EXCLUDED.last_seen_at_at_summary,
    updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ── 5. Enqueue ──────────────────────────────────────────────────────────────
-- Idempotent in the same way as mkt_enqueue_intelligence: skips campaigns
-- already sitting in a pending/running job. Only summarises campaigns with
-- enough substance to be worth a session, and re-runs a campaign whose grouping
-- has moved on since its last summary.
-- p_min_members defaults to 1 because that is the ACTUAL shape of the data:
-- as of 2026-07-26 all 23 campaigns hold exactly one member — the grouper is
-- currently emitting one campaign per post (signatures include the per-post key
-- message, so nothing collapses). Defaulting to 2 would have made this feature
-- silently enqueue nothing forever. Raise it once grouping genuinely clusters.
CREATE OR REPLACE FUNCTION public.mkt_enqueue_campaign_summaries(
  p_org uuid, p_batch int DEFAULT 4, p_max_jobs int DEFAULT 10,
  p_min_members int DEFAULT 1, p_force boolean DEFAULT false)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_jobs int := 0; v_ids uuid[];
BEGIN
  LOOP
    EXIT WHEN v_jobs >= p_max_jobs;
    SELECT array_agg(id) INTO v_ids FROM (
      SELECT c.id FROM mkt_campaigns c
      LEFT JOIN mkt_campaign_summaries su ON su.campaign_id = c.id
      WHERE c.organization_id = p_org
        AND c.member_count >= p_min_members
        AND (
          p_force
          OR su.id IS NULL
          OR su.status = 'failed'
          OR su.member_count_at_summary IS DISTINCT FROM c.member_count
          OR su.last_seen_at_at_summary IS DISTINCT FROM c.last_seen_at
        )
        AND NOT EXISTS (
          SELECT 1 FROM claude_jobs j
          WHERE j.kind = 'mkt_campaign_summary' AND j.status IN ('pending','running')
            AND j.payload->'campaign_ids' @> to_jsonb(c.id::text)
        )
      ORDER BY c.last_seen_at DESC NULLS LAST
      LIMIT GREATEST(1, p_batch)
    ) z;
    EXIT WHEN v_ids IS NULL OR array_length(v_ids,1) IS NULL;
    INSERT INTO claude_jobs(kind, payload, status)
    VALUES ('mkt_campaign_summary',
            jsonb_build_object('organization_id', p_org, 'campaign_ids', to_jsonb(v_ids)),
            'pending');
    v_jobs := v_jobs + 1;
  END LOOP;
  RETURN v_jobs;
END $$;

GRANT EXECUTE ON FUNCTION public.mkt_campaign_evidence(uuid[])                              TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_campaign_summary_upsert(uuid,uuid,text,text,jsonb,jsonb,numeric,numeric,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_enqueue_campaign_summaries(uuid,int,int,int,boolean)    TO service_role, authenticated;
