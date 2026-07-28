-- ============================================================================
-- Marketing Management v2, part 6: planning-layer alerts, performance roll-ups,
-- and the backfill + reconciliation of existing rows.
-- Design: docs/marketing-management-v2.md
-- ============================================================================

-- ── 1. Alerts can now point at planning entities ────────────────────────────
-- mkt_mgmt_alerts.target_type had a CHECK allowing only content_item, campaign,
-- publication, project, task, asset and user. Every new rule below targets a
-- plan, goal, initiative, program or channel, so the constraint is rebuilt with
-- the FULL list spelled out. A DROP+ADD that listed only the new values would
-- silently remove the old ones — that exact mistake has been made in this
-- codebase before on a shared kind CHECK.
ALTER TABLE public.mkt_mgmt_alerts DROP CONSTRAINT IF EXISTS mkt_mgmt_alerts_target_type_check;
ALTER TABLE public.mkt_mgmt_alerts ADD CONSTRAINT mkt_mgmt_alerts_target_type_check
  CHECK (target_type IN (
    -- pre-existing, preserved verbatim
    'content_item','campaign','publication','project','task','asset','user',
    -- v2 planning layer
    'strategy','plan','goal','initiative','program','channel_plan','platform_campaign','ad'
  ));

-- ── 2. Planning-layer alert rules ───────────────────────────────────────────
-- A SEPARATE function, deliberately. The existing mkt_mgmt_generate_alerts is
-- live and has been patched in the database since its migration file was
-- written, so the file no longer matches production. Rewriting it from the
-- stale file would silently drop whatever the patch fixed. This function adds
-- rules alongside it; the API calls both.
-- Emit helper first: every rule funnels through it, so dedup-key construction
-- and the evidence-attached convention cannot drift between rules.
CREATE OR REPLACE FUNCTION public.mkt_alert_emit(
  p_kind text, p_severity text, p_title_ar text, p_title_en text,
  p_target_type text, p_target_id uuid, p_evidence jsonb, p_dedup_key text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.mkt_mgmt_alerts
    (kind, severity, title_ar, title_en, target_type, target_id, evidence, dedup_key)
  VALUES (p_kind, p_severity, p_title_ar, p_title_en, p_target_type, p_target_id,
          COALESCE(p_evidence, '{}'::jsonb), p_dedup_key)
  ON CONFLICT (dedup_key) DO NOTHING;
  RETURN CASE WHEN FOUND THEN 1 ELSE 0 END;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_mgmt_generate_v2_alerts()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE out jsonb := '[]'::jsonb; n int; r record;
BEGIN
  -- ── active plan with no approved strategy ────────────────────────────────
  n := 0;
  FOR r IN SELECT p.id, p.name_ar FROM public.mkt_plans p
            WHERE p.status = 'active' AND p.archived_at IS NULL
              AND (p.strategy_version_id IS NULL
                   OR NOT EXISTS (SELECT 1 FROM public.mkt_strategy_versions s
                                   WHERE s.id = p.strategy_version_id AND s.status = 'approved'))
  LOOP
    n := n + public.mkt_alert_emit('plan_without_approved_strategy','critical',
      'خطة نشطة بلا استراتيجية معتمدة', 'Active plan without an approved strategy',
      'plan', r.id, jsonb_build_object('plan', r.name_ar),
      'plan_no_strategy:'||r.id::text);
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','plan_without_approved_strategy','emitted',n));

  -- ── active plan with no goals ────────────────────────────────────────────
  n := 0;
  FOR r IN SELECT p.id, p.name_ar FROM public.mkt_plans p
            WHERE p.status IN ('approved','active') AND p.archived_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.mkt_goals g
                               WHERE g.plan_id = p.id AND g.archived_at IS NULL)
  LOOP
    n := n + public.mkt_alert_emit('plan_without_goals','critical',
      'خطة بلا أهداف', 'Plan without goals', 'plan', r.id,
      jsonb_build_object('plan', r.name_ar), 'plan_no_goals:'||r.id::text);
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','plan_without_goals','emitted',n));

  -- ── goal with no source of truth: unmeasurable by construction ───────────
  n := 0;
  FOR r IN SELECT g.id, g.name_ar FROM public.mkt_goals g
            WHERE g.status = 'active' AND g.archived_at IS NULL
              AND (g.source_of_truth IS NULL OR btrim(g.source_of_truth) = '')
  LOOP
    n := n + public.mkt_alert_emit('goal_without_source_of_truth','warning',
      'هدف بلا مصدر قياس', 'Goal without a source of truth', 'goal', r.id,
      jsonb_build_object('goal', r.name_ar), 'goal_no_source:'||r.id::text);
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','goal_without_source_of_truth','emitted',n));

  -- ── goal off track ───────────────────────────────────────────────────────
  n := 0;
  FOR r IN SELECT g.id, g.name_ar, g.result FROM public.mkt_goals g
            WHERE g.status = 'active' AND g.archived_at IS NULL AND g.result = 'off_track'
  LOOP
    n := n + public.mkt_alert_emit('goal_off_track','critical',
      'هدف خارج المسار', 'Goal off track', 'goal', r.id,
      jsonb_build_object('goal', r.name_ar, 'result', r.result), 'goal_off_track:'||r.id::text);
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','goal_off_track','emitted',n));

  -- ── initiative without a primary goal ────────────────────────────────────
  n := 0;
  FOR r IN SELECT i.id, i.name_ar FROM public.mkt_initiatives i
            WHERE i.status IN ('proposed','active') AND i.archived_at IS NULL
              AND i.primary_goal_id IS NULL
  LOOP
    n := n + public.mkt_alert_emit('initiative_without_primary_goal','warning',
      'مبادرة بلا هدف رئيسي', 'Initiative without a primary goal', 'initiative', r.id,
      jsonb_build_object('initiative', r.name_ar), 'init_no_goal:'||r.id::text);
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','initiative_without_primary_goal','emitted',n));

  -- ── initiative with no execution underneath it ───────────────────────────
  n := 0;
  FOR r IN SELECT i.id, i.name_ar FROM public.mkt_initiatives i
            WHERE i.status = 'active' AND i.archived_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.mkt_programs pr WHERE pr.initiative_id = i.id)
              AND NOT EXISTS (SELECT 1 FROM public.mkt_internal_campaigns c WHERE c.initiative_id = i.id)
  LOOP
    n := n + public.mkt_alert_emit('initiative_without_activity','warning',
      'مبادرة نشطة بلا برامج أو حملات', 'Active initiative with no programs or campaigns',
      'initiative', r.id, jsonb_build_object('initiative', r.name_ar),
      'init_no_activity:'||r.id::text);
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','initiative_without_activity','emitted',n));

  -- ── program with no recurring commitment ─────────────────────────────────
  n := 0;
  FOR r IN SELECT p.id, p.name_ar FROM public.mkt_programs p
            WHERE p.status = 'active' AND p.archived_at IS NULL AND p.commitment_count IS NULL
  LOOP
    n := n + public.mkt_alert_emit('program_without_commitment','warning',
      'برنامج بلا التزام متكرر', 'Program without a recurring commitment', 'program', r.id,
      jsonb_build_object('program', r.name_ar),
      'prog_no_commitment:'||r.id::text);
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','program_without_commitment','emitted',n));

  -- ── overdue program commitment: an active weekly program that produced
  --    nothing in the last completed week ───────────────────────────────────
  n := 0;
  FOR r IN SELECT p.id, p.name_ar, p.commitment_count, p.commitment_unit
             FROM public.mkt_programs p
            WHERE p.status = 'active' AND p.archived_at IS NULL
              AND p.commitment_unit = 'week' AND p.commitment_count > 0
              AND (SELECT count(*) FROM public.mkt_content_items ci
                    WHERE ci.origin_program_id = p.id
                      AND ci.created_at >= date_trunc('week', now()) - interval '7 days'
                      AND ci.created_at <  date_trunc('week', now())) < p.commitment_count
  LOOP
    n := n + public.mkt_alert_emit('program_commitment_overdue','warning',
      'التزام برنامج غير مُنجز', 'Program commitment not met last week', 'program', r.id,
      jsonb_build_object('committed', r.commitment_count, 'unit', r.commitment_unit),
      'prog_overdue:'||r.id::text||':'||to_char(date_trunc('week', now()), 'IYYY-IW'));
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','program_commitment_overdue','emitted',n));

  -- ── campaign without deliverables ────────────────────────────────────────
  n := 0;
  FOR r IN SELECT c.id, c.code FROM public.mkt_internal_campaigns c
            WHERE c.status IN ('planned','active') AND c.archived_at IS NULL
              AND jsonb_array_length(COALESCE(c.deliverables, '[]'::jsonb)) = 0
  LOOP
    n := n + public.mkt_alert_emit('campaign_without_deliverables','warning',
      'حملة بلا مخرجات محددة', 'Campaign without deliverables', 'campaign', r.id,
      jsonb_build_object('code', r.code), 'camp_no_deliverables:'||r.id::text);
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','campaign_without_deliverables','emitted',n));

  -- ── channel over-allocation, per channel per week ────────────────────────
  n := 0;
  FOR r IN
    SELECT cp.id AS channel_plan_id, a.week_start, cp.platform,
           cp.max_per_week,
           sum(a.slots_requested) FILTER (WHERE a.allocation_kind='campaign_allocation') AS requested,
           sum(a.slots_requested) FILTER (WHERE a.allocation_kind='program_reservation')  AS reserved,
           COALESCE(sum(a.slots_requested) FILTER (WHERE a.allocation_kind='reactive_reserve'),
                    cp.reactive_reserve) AS reactive
      FROM public.mkt_capacity_allocations a
      JOIN public.mkt_channel_plans cp ON cp.id = a.channel_plan_id
     WHERE cp.max_per_week IS NOT NULL
     GROUP BY cp.id, a.week_start, cp.platform, cp.max_per_week, cp.reactive_reserve
    HAVING COALESCE(sum(a.slots_requested) FILTER (WHERE a.allocation_kind='campaign_allocation'), 0)
         > cp.max_per_week
         - COALESCE(sum(a.slots_requested) FILTER (WHERE a.allocation_kind='program_reservation'), 0)
         - COALESCE(sum(a.slots_requested) FILTER (WHERE a.allocation_kind='reactive_reserve'),
                    cp.reactive_reserve)
  LOOP
    n := n + public.mkt_alert_emit('channel_over_allocated','critical',
      'طلبات الحملات تتجاوز سعة القناة', 'Campaign requests exceed channel capacity',
      'channel_plan', r.channel_plan_id,
      jsonb_build_object('platform', r.platform, 'week_start', r.week_start,
                         'week_capacity', r.max_per_week, 'program_reserved', r.reserved,
                         'reactive_reserved', r.reactive, 'campaign_requested', r.requested),
      'chan_over:'||r.channel_plan_id::text||':'||r.week_start::text);
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','channel_over_allocated','emitted',n));

  -- ── content awaiting approval without strategic context ──────────────────
  n := 0;
  FOR r IN SELECT ci.id, ci.content_number FROM public.mkt_content_items ci
            WHERE ci.status IN ('internal_review','awaiting_final_approval')
              AND ci.archived_at IS NULL
              AND array_length(public.mkt_content_missing_context(ci.id), 1) > 0
  LOOP
    n := n + public.mkt_alert_emit('content_without_strategic_context','warning',
      'محتوى بانتظار الاعتماد بلا سياق استراتيجي',
      'Content awaiting approval without strategic context', 'content_item', r.id,
      jsonb_build_object('content_number', r.content_number,
                         'missing', public.mkt_content_missing_context(r.id)),
      'content_no_context:'||r.id::text);
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','content_without_strategic_context','emitted',n));

  -- ── paid ad running without approved creative ────────────────────────────
  n := 0;
  FOR r IN SELECT ad.id, ad.name FROM public.mkt_ads ad
            WHERE ad.status = 'active'
              AND (ad.content_item_id IS NULL
                   OR NOT EXISTS (SELECT 1 FROM public.mkt_content_items ci
                                   WHERE ci.id = ad.content_item_id
                                     AND ci.status IN ('approved','ready_to_publish','scheduled','published')))
  LOOP
    n := n + public.mkt_alert_emit('ad_without_approved_creative','critical',
      'إعلان نشط بلا مادة معتمدة', 'Active ad without an approved creative', 'ad', r.id,
      jsonb_build_object('ad', r.name), 'ad_no_creative:'||r.id::text);
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','ad_without_approved_creative','emitted',n));

  -- ── legacy rows needing classification ───────────────────────────────────
  n := 0;
  FOR r IN SELECT ci.id, ci.content_number FROM public.mkt_content_items ci
            WHERE ci.needs_classification AND ci.archived_at IS NULL
  LOOP
    n := n + public.mkt_alert_emit('legacy_needs_classification','info',
      'سجل قديم يحتاج تصنيفاً استراتيجياً', 'Legacy record needs strategic classification',
      'content_item', r.id, jsonb_build_object('content_number', r.content_number),
      'legacy_class:'||r.id::text);
  END LOOP;
  out := out || jsonb_build_array(jsonb_build_object('kind','legacy_needs_classification','emitted',n));

  RETURN out;
END $$;

REVOKE ALL ON FUNCTION public.mkt_mgmt_generate_v2_alerts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_mgmt_generate_v2_alerts() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mkt_alert_emit(text,text,text,text,text,uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_alert_emit(text,text,text,text,text,uuid,jsonb,text) TO service_role;

-- ── 3. Roll-ups ─────────────────────────────────────────────────────────────
-- Performance rolls up from the lowest reliable evidence. Two rules make it
-- honest: the CURRENT value of a publication is its LATEST snapshot (never a
-- sum across captures of the same post), and a lead is counted once per parent
-- by distinct client, so content reused in three places cannot triple a lead.
CREATE OR REPLACE FUNCTION public.mkt_content_rollup(p_content_item_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_pubs int; v_published int; v_measured int;
  v_views numeric; v_eng numeric; v_clicks numeric;
  v_direct int; v_influenced int; v_unknown int; v_revenue numeric;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE status = 'published')
    INTO v_pubs, v_published
    FROM public.mkt_publications WHERE content_item_id = p_content_item_id;

  WITH latest AS (
    SELECT DISTINCT ON (s.publication_id) s.*
      FROM public.mkt_performance_snapshots s
      JOIN public.mkt_publications p ON p.id = s.publication_id
     WHERE p.content_item_id = p_content_item_id
       -- Only these two states carry numbers. not_available / failed /
       -- not_attempted / awaiting_data are real states, not zeros.
       AND s.collection_status IN ('collected','partial')
     ORDER BY s.publication_id, s.captured_at DESC
  )
  SELECT count(*),
         sum(COALESCE((metrics->>'views')::numeric, (metrics->>'impressions')::numeric)),
         sum(COALESCE((metrics->>'likes')::numeric,0) + COALESCE((metrics->>'comments')::numeric,0)
           + COALESCE((metrics->>'shares')::numeric,0) + COALESCE((metrics->>'saves')::numeric,0)),
         sum((metrics->>'link_clicks')::numeric)
    INTO v_measured, v_views, v_eng, v_clicks
    FROM latest;

  -- Direct = the touch credited last, or a confirmed/platform-reported lead.
  -- Influenced = an earlier or multi-touch contribution. 'unknown' is reported
  -- separately rather than being folded into either.
  SELECT count(DISTINCT client_id) FILTER (WHERE touch_type = 'last'
             OR attribution_type IN ('platform_lead_form','manual_confirmed')),
         count(DISTINCT client_id) FILTER (WHERE touch_type IN ('first','multi')
             AND NOT (attribution_type IN ('platform_lead_form','manual_confirmed'))),
         count(DISTINCT client_id) FILTER (WHERE touch_type = 'unknown'
             AND attribution_type NOT IN ('platform_lead_form','manual_confirmed')),
         sum(revenue)
    INTO v_direct, v_influenced, v_unknown, v_revenue
    FROM public.mkt_lead_attributions
   WHERE content_item_id = p_content_item_id;

  RETURN jsonb_build_object(
    'content_item_id',  p_content_item_id,
    'publications',     v_pubs,
    'published',        v_published,
    -- The denominator travels with the numbers.
    'coverage',         jsonb_build_object('measured', COALESCE(v_measured,0), 'total', v_pubs),
    'is_measurable',    COALESCE(v_measured,0) > 0,
    'views',            v_views,
    'engagement',       v_eng,
    'link_clicks',      v_clicks,
    'leads_direct',     COALESCE(v_direct,0),
    'leads_influenced', COALESCE(v_influenced,0),
    'leads_unknown',    COALESCE(v_unknown,0),
    'revenue',          v_revenue
  );
END $$;

-- Goal roll-up: gathers every content item reached through the activities that
-- serve this goal — by ORIGIN and by USAGE — then counts distinct leads across
-- the whole set so reuse cannot double count at the goal level.
CREATE OR REPLACE FUNCTION public.mkt_goal_rollup(p_goal_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_items int; v_direct int; v_influenced int; v_revenue numeric;
        v_measured int; v_pubs int;
BEGIN
  -- A CTE, not a temp table: Postgres refuses data modification inside a
  -- non-volatile function, and CREATE TEMP TABLE counts as modification.
  -- Gathering by ORIGIN and by USAGE in one set is also what makes the
  -- distinct-lead count honest at the goal level.
  WITH items AS (
    SELECT DISTINCT ci.id
      FROM public.mkt_content_items ci
     WHERE ci.archived_at IS NULL AND (
       ci.primary_goal_id = p_goal_id
       OR ci.origin_program_id IN (
            SELECT id FROM public.mkt_programs WHERE primary_goal_id = p_goal_id
            UNION SELECT program_id FROM public.mkt_activity_goals
                   WHERE goal_id = p_goal_id AND program_id IS NOT NULL)
       OR ci.origin_campaign_id IN (
            SELECT id FROM public.mkt_internal_campaigns WHERE primary_goal_id = p_goal_id
            UNION SELECT campaign_id FROM public.mkt_activity_goals
                   WHERE goal_id = p_goal_id AND campaign_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.mkt_content_usage u
                   WHERE u.content_item_id = ci.id AND (
                     u.campaign_id IN (SELECT id FROM public.mkt_internal_campaigns
                                        WHERE primary_goal_id = p_goal_id)
                  OR u.program_id  IN (SELECT id FROM public.mkt_programs
                                        WHERE primary_goal_id = p_goal_id)))
     )
  ),
  pubs AS (
    SELECT p.id,
           EXISTS (SELECT 1 FROM public.mkt_performance_snapshots s
                    WHERE s.publication_id = p.id
                      AND s.collection_status IN ('collected','partial')) AS measured
      FROM public.mkt_publications p
     WHERE p.content_item_id IN (SELECT id FROM items)
  ),
  leads AS (
    SELECT count(DISTINCT client_id) FILTER (WHERE touch_type = 'last'
               OR attribution_type IN ('platform_lead_form','manual_confirmed')) AS direct,
           count(DISTINCT client_id) FILTER (WHERE touch_type IN ('first','multi')
               AND attribution_type NOT IN ('platform_lead_form','manual_confirmed')) AS influenced,
           sum(revenue) AS revenue
      FROM public.mkt_lead_attributions
     WHERE content_item_id IN (SELECT id FROM items)
  )
  SELECT (SELECT count(*) FROM items),
         (SELECT count(*) FROM pubs),
         (SELECT count(*) FROM pubs WHERE measured),
         l.direct, l.influenced, l.revenue
    INTO v_items, v_pubs, v_measured, v_direct, v_influenced, v_revenue
    FROM leads l;

  RETURN jsonb_build_object(
    'goal_id',          p_goal_id,
    'content_items',    COALESCE(v_items, 0),
    'publications',     COALESCE(v_pubs, 0),
    'coverage',         jsonb_build_object('measured', COALESCE(v_measured, 0),
                                           'total', COALESCE(v_pubs, 0)),
    'leads_direct',     COALESCE(v_direct, 0),
    'leads_influenced', COALESCE(v_influenced, 0),
    'revenue',          v_revenue,
    'pacing',           public.mkt_goal_pacing(p_goal_id)
  );
END $$;

REVOKE ALL ON FUNCTION public.mkt_content_rollup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_content_rollup(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mkt_goal_rollup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_goal_rollup(uuid) TO authenticated, service_role;

-- ── 4. Backfill ─────────────────────────────────────────────────────────────
-- NO holding strategy or holding plan is created. Nothing in the v2 schema
-- REQUIRES plan_id on an existing campaign or content item, so inventing an
-- "approved strategy" for historical work would be a fabrication with no
-- referential justification. Legacy rows are flagged instead, stay fully
-- accessible, and can be classified later.
DO $$
DECLARE
  before_camp int; before_content int; before_hist int; before_ver int; before_appr int;
  after_camp int; after_content int; after_hist int; after_ver int; after_appr int;
  n_origin_camp int; n_origin_standalone int; n_pillar int; n_flagged int;
BEGIN
  SELECT count(*) INTO before_camp    FROM public.mkt_internal_campaigns;
  SELECT count(*) INTO before_content FROM public.mkt_content_items;
  SELECT count(*) INTO before_hist    FROM public.mkt_content_status_history;
  SELECT count(*) INTO before_ver     FROM public.mkt_content_versions;
  SELECT count(*) INTO before_appr    FROM public.mkt_approvals;
  RAISE NOTICE 'BEFORE  campaigns=% content=% history=% versions=% approvals=%',
    before_camp, before_content, before_hist, before_ver, before_appr;

  -- Content that already had a campaign becomes campaign-origin.
  UPDATE public.mkt_content_items
     SET origin_kind = 'campaign', origin_campaign_id = campaign_id
   WHERE campaign_id IS NOT NULL AND origin_kind IS NULL;
  GET DIAGNOSTICS n_origin_camp = ROW_COUNT;

  -- Content with no campaign is standalone and needs classifying. It is NOT
  -- attached to an invented plan or goal.
  UPDATE public.mkt_content_items
     SET origin_kind = 'standalone', needs_classification = true
   WHERE campaign_id IS NULL AND origin_kind IS NULL;
  GET DIAGNOSTICS n_origin_standalone = ROW_COUNT;

  -- Legacy free-text pillar → the pillar FK, where the text actually matches.
  UPDATE public.mkt_content_items ci
     SET primary_pillar_id = p.id
    FROM public.mkt_content_pillars p
   WHERE ci.primary_pillar_id IS NULL AND ci.content_pillar IS NOT NULL
     AND (p.slug = ci.content_pillar OR p.name_en = ci.content_pillar
          OR p.name_ar = ci.content_pillar);
  GET DIAGNOSTICS n_pillar = ROW_COUNT;

  -- Existing campaigns keep every field. campaign_class is left NULL rather
  -- than guessed from channel_mix: a wrong organic/paid label would silently
  -- mis-file the campaign forever.
  UPDATE public.mkt_internal_campaigns
     SET needs_classification = true
   WHERE plan_id IS NULL AND archived_at IS NULL;
  GET DIAGNOSTICS n_flagged = ROW_COUNT;

  SELECT count(*) INTO after_camp    FROM public.mkt_internal_campaigns;
  SELECT count(*) INTO after_content FROM public.mkt_content_items;
  SELECT count(*) INTO after_hist    FROM public.mkt_content_status_history;
  SELECT count(*) INTO after_ver     FROM public.mkt_content_versions;
  SELECT count(*) INTO after_appr    FROM public.mkt_approvals;

  RAISE NOTICE 'AFTER   campaigns=% content=% history=% versions=% approvals=%',
    after_camp, after_content, after_hist, after_ver, after_appr;
  RAISE NOTICE 'BACKFILL origin_campaign=% origin_standalone=% pillar_linked=% campaigns_flagged=%',
    n_origin_camp, n_origin_standalone, n_pillar, n_flagged;

  -- No row may be created or destroyed by a backfill.
  IF after_camp <> before_camp OR after_content <> before_content
     OR after_hist <> before_hist OR after_ver <> before_ver OR after_appr <> before_appr THEN
    RAISE EXCEPTION 'BACKFILL CHANGED ROW COUNTS — aborting (campaigns %→%, content %→%, history %→%, versions %→%, approvals %→%)',
      before_camp, after_camp, before_content, after_content, before_hist, after_hist,
      before_ver, after_ver, before_appr, after_appr;
  END IF;
END $$;

-- ── 5. Reconciliation ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mkt_v2_reconcile()
RETURNS TABLE(check_name text, count bigint, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT 'campaigns_total', count(*)::bigint, 'all campaigns preserved'
    FROM public.mkt_internal_campaigns
  UNION ALL SELECT 'content_total', count(*)::bigint, 'all content preserved'
    FROM public.mkt_content_items
  UNION ALL SELECT 'content_without_origin', count(*)::bigint,
                   'must be 0 after backfill'
    FROM public.mkt_content_items WHERE origin_kind IS NULL
  UNION ALL SELECT 'content_origin_mismatch', count(*)::bigint,
                   'campaign_id and origin_campaign_id disagree — mirror trigger failed'
    FROM public.mkt_content_items WHERE campaign_id IS DISTINCT FROM origin_campaign_id
  UNION ALL SELECT 'active_content_missing_context', count(*)::bigint,
                   'approved/scheduled/published content lacking required context'
    FROM public.mkt_content_items
   WHERE status IN ('approved','ready_to_publish','scheduled','published')
     AND array_length(public.mkt_content_missing_context(id), 1) > 0
  UNION ALL SELECT 'broken_publication_links', count(*)::bigint,
                   'publications whose content item is gone'
    FROM public.mkt_publications p
   WHERE p.content_item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.mkt_content_items c WHERE c.id = p.content_item_id)
  UNION ALL SELECT 'broken_asset_links', count(*)::bigint,
                   'asset links pointing at a missing asset'
    FROM public.mkt_asset_links l
   WHERE NOT EXISTS (SELECT 1 FROM public.mkt_raw_assets a WHERE a.id = l.asset_id)
  UNION ALL SELECT 'broken_attribution_links', count(*)::bigint,
                   'attribution rows with no surviving marketing side'
    FROM public.mkt_lead_attributions a
   WHERE a.campaign_id IS NULL AND a.content_item_id IS NULL
     AND a.publication_id IS NULL AND a.paid_ad_id IS NULL
  UNION ALL SELECT 'duplicate_usage_links', count(*)::bigint,
                   'must be 0 — unique indexes should prevent this'
    FROM (SELECT content_item_id, usage_kind, campaign_id, program_id, initiative_id, publication_id
            FROM public.mkt_content_usage
           GROUP BY 1,2,3,4,5,6 HAVING count(*) > 1) d
  UNION ALL SELECT 'orphan_platform_campaigns', count(*)::bigint,
                   'platform campaigns whose parent is not paid'
    FROM public.mkt_platform_campaigns pc
    JOIN public.mkt_internal_campaigns c ON c.id = pc.campaign_id
   WHERE c.campaign_class IS DISTINCT FROM 'paid'
  UNION ALL SELECT 'campaigns_needing_classification', count(*)::bigint,
                   'legacy campaigns with no plan — expected, not an error'
    FROM public.mkt_internal_campaigns WHERE needs_classification
  UNION ALL SELECT 'content_needing_classification', count(*)::bigint,
                   'legacy content with no plan — expected, not an error'
    FROM public.mkt_content_items WHERE needs_classification
  UNION ALL SELECT 'invalid_plan_parents', count(*)::bigint,
                   'child plan of an equal-or-shorter parent'
    FROM public.mkt_plans c JOIN public.mkt_plans p ON p.id = c.parent_plan_id
   WHERE public.mkt_plan_rank(c.plan_type) > public.mkt_plan_rank(p.plan_type)
  UNION ALL SELECT 'goals_in_wrong_plan', count(*)::bigint,
                   'sub-goal whose parent belongs to another plan'
    FROM public.mkt_goals g JOIN public.mkt_goals p ON p.id = g.parent_goal_id
   WHERE g.plan_id <> p.plan_id;
$$;

REVOKE ALL ON FUNCTION public.mkt_v2_reconcile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_v2_reconcile() TO authenticated, service_role;

COMMENT ON FUNCTION public.mkt_mgmt_generate_v2_alerts() IS
  'Planning-layer alert rules. Separate from mkt_mgmt_generate_alerts because that function was patched in the database after its migration file was written; rewriting it from the stale file would drop the patch.';
COMMENT ON FUNCTION public.mkt_content_rollup(uuid) IS
  'Latest snapshot per publication (never summed across captures); leads counted distinct so reuse cannot double count.';
