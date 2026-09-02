-- ============================================================================
-- Post Creative Director — performance view, job-kind CHECKs, backfill runs,
-- settings seeds (2026-09-02_25)
--
-- 1. mos_content_performance_v — per content item: publication count + the
--    LATEST metric snapshot per publication summed (views / engagement /
--    likes / comments / saves / enquiries) + last capture time.
-- 2. generation_jobs kind CHECK: re-list EVERY existing value + 'creative-image'
--    (the 2026-08-03 lesson: never drop-and-add a shared CHECK listing only
--    the kinds your own vertical knows — re-list the full live set).
-- 3. claude_jobs kind CHECK: full live set + 'mkt_visual_design_slide' +
--    'mkt_visual_design_post'.
-- 4. claude_job_claim_next: both design kinds join the OCR lane (the existing
--    OCR runner lease serves them) and the lease-kinds array (so a worker with
--    no lease can never claim them). Body is the LATEST repo copy
--    (2026-08-26_marketing_runner_slots.sql) plus those two additions.
--    ⚠ LEAD: diff this body against the LIVE pg_get_functiondef before
--    applying — this function has been edited in production more than once
--    (2026-08-26's own header says so), and silently reverting a live-only
--    edit would be the same class of bug this re-issue exists to avoid.
-- 5. creative_backfill_runs + start/finish RPCs (observability for the
--    backfill controller, contracts §9).
-- 6. mos_settings seeds: creative_writer (all flags false — ship DARK),
--    role_map, creative_backfill (disabled), writer_rules (transcribed from
--    .claude/skills/writing-post + writing-video-script, hard rules +
--    Decisions Logs), and the ai_roles ADDITIVE merge (nine new keys; never
--    replaces an existing key).
--
-- NOTE: contract §2 mentioned seeding a notification_rules row for
-- 'post_creative_ready'. SKIPPED deliberately (contract deviation, agreed via
-- brief): the in-app bell ALWAYS fires through notify_emit without a rule, and
-- the sibling video lane emits 'video_script_ready' the same way — no rule row
-- is needed for in-app delivery, and no push/whatsapp fan-out is wanted yet.
--
-- Additive + idempotent.
-- ============================================================================

BEGIN;

-- ── 1. mos_content_performance_v ────────────────────────────────────────────
CREATE OR REPLACE VIEW public.mos_content_performance_v
WITH (security_invoker = true) AS
SELECT p.content_id,
       count(*)                          AS publications,
       COALESCE(sum(ls.views), 0)        AS views,
       COALESCE(sum(ls.engagement), 0)   AS engagement,
       COALESCE(sum(public.try_numeric(ls.extra->>'likes')), 0)    AS likes,
       COALESCE(sum(public.try_numeric(ls.extra->>'comments')), 0) AS comments,
       COALESCE(sum(public.try_numeric(ls.extra->>'saves')), 0)    AS saves,
       COALESCE(sum(ls.enquiries), 0)    AS enquiries,
       max(ls.captured_at)               AS last_captured_at
  FROM public.mos_publications p
  LEFT JOIN LATERAL (
    SELECT s.views, s.engagement, s.enquiries, s.extra, s.captured_at
      FROM public.mos_metric_snapshots s
     WHERE s.publication_id = p.id
     ORDER BY s.captured_at DESC
     LIMIT 1
  ) ls ON true
 GROUP BY p.content_id;

REVOKE ALL ON public.mos_content_performance_v FROM PUBLIC, anon;
GRANT SELECT ON public.mos_content_performance_v TO authenticated, service_role;

-- ── 2. generation_jobs kind CHECK ───────────────────────────────────────────
-- Full live set ('image','video','audio','clean-text','video-convert',
-- 'listing-mirror' — per 2026-07-19 + 2026-07-29) + 'creative-image'.
ALTER TABLE public.generation_jobs DROP CONSTRAINT IF EXISTS generation_jobs_kind_check;
ALTER TABLE public.generation_jobs ADD CONSTRAINT generation_jobs_kind_check
  CHECK (kind IN ('image','video','audio','clean-text','video-convert','listing-mirror','creative-image'));

-- ── 3. claude_jobs kind CHECK ───────────────────────────────────────────────
-- Full live set (7 kinds, per 2026-07-29 + 2026-08-03) + the two design lanes.
ALTER TABLE public.claude_jobs DROP CONSTRAINT IF EXISTS claude_jobs_kind_check;
ALTER TABLE public.claude_jobs ADD CONSTRAINT claude_jobs_kind_check
  CHECK (kind = ANY (ARRAY[
    'ping','client_study','mkt_content_enrichment','mkt_campaign_summary',
    'whatsapp_reply','mkt_visual_ocr','aqar_listing_extract',
    'mkt_visual_design_slide','mkt_visual_design_post'
  ]));

-- ── 4. claude_job_claim_next — design kinds ride the OCR lane ───────────────
-- LEAD-CORRECTED 2026-09-02: rebased onto the LIVE pg_get_functiondef (which
-- carries the aqar lane that the 2026-08-26 repo copy predates — applying the
-- repo copy would have SILENTLY DROPPED aqar routing). The ONLY changes vs live:
-- 'mkt_visual_design_slide' + 'mkt_visual_design_post' added to v_ocr_kinds
-- (the OCR runner's lease serves them) and to v_lease_kinds (lease-scoped).
-- Everything else — including the aqar lane — is verbatim live.
CREATE OR REPLACE FUNCTION public.claude_job_claim_next(p_worker text)
 RETURNS SETOF claude_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_interactive_kinds constant text[] := ARRAY['ping','client_study'];
  v_batch_kinds       constant text[] := ARRAY['mkt_content_enrichment','mkt_campaign_summary'];
  v_ocr_kinds         constant text[] := ARRAY['mkt_visual_ocr','mkt_visual_design_slide','mkt_visual_design_post'];
  v_aqar_kinds        constant text[] := ARRAY['aqar_listing_extract'];
  v_lease_kinds       constant text[] := ARRAY['ping','client_study','mkt_content_enrichment',
                                               'mkt_campaign_summary','mkt_visual_ocr',
                                               'mkt_visual_design_slide','mkt_visual_design_post',
                                               'aqar_listing_extract'];
  v_holds_interactive boolean; v_holds_marketing boolean; v_holds_ocr boolean; v_holds_aqar boolean;
  v_interactive_orphan boolean; v_marketing_orphan boolean; v_ocr_orphan boolean; v_aqar_orphan boolean;
  v_holds_any boolean; v_no_leases boolean;
  v_may_interactive boolean; v_may_batch boolean; v_may_ocr boolean; v_may_aqar boolean;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease) INTO v_no_leases;

  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='interactive'
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_interactive;
  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l
      WHERE (l.lease_name = 'marketing_intelligence' OR starts_with(l.lease_name, 'marketing_intelligence#'))
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_marketing;
  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='ocr'
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_ocr;
  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l
      WHERE (l.lease_name = 'aqar' OR starts_with(l.lease_name, 'aqar#'))
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_aqar;

  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='interactive'
      AND l.released_at IS NULL AND l.expires_at > now()) INTO v_interactive_orphan;
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l
      WHERE (l.lease_name = 'marketing_intelligence' OR starts_with(l.lease_name, 'marketing_intelligence#'))
      AND l.released_at IS NULL AND l.expires_at > now()) INTO v_marketing_orphan;
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='ocr'
      AND l.released_at IS NULL AND l.expires_at > now()) INTO v_ocr_orphan;
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l
      WHERE (l.lease_name = 'aqar' OR starts_with(l.lease_name, 'aqar#'))
      AND l.released_at IS NULL AND l.expires_at > now()) INTO v_aqar_orphan;

  v_holds_any := v_holds_interactive OR v_holds_marketing OR v_holds_ocr OR v_holds_aqar;

  v_may_interactive := v_no_leases OR v_holds_interactive OR (v_interactive_orphan AND v_holds_any);
  v_may_batch       := v_no_leases OR v_holds_marketing   OR (v_marketing_orphan   AND v_holds_any);
  v_may_ocr         := v_no_leases OR v_holds_ocr         OR (v_ocr_orphan         AND v_holds_any);
  v_may_aqar        := v_no_leases OR v_holds_aqar        OR (v_aqar_orphan        AND v_holds_any);

  SELECT id INTO v_id FROM public.claude_jobs
  WHERE status = 'pending'
    AND (
      kind <> ALL (v_lease_kinds)
      OR (kind = ANY (v_interactive_kinds) AND v_may_interactive)
      OR (kind = ANY (v_batch_kinds)       AND v_may_batch)
      OR (kind = ANY (v_ocr_kinds)         AND v_may_ocr)
      OR (kind = ANY (v_aqar_kinds)        AND v_may_aqar)
    )
  ORDER BY
    CASE
      WHEN kind = ANY (v_interactive_kinds) AND v_may_interactive THEN 0
      WHEN kind <> ALL (v_lease_kinds) THEN 1
      ELSE 2
    END,
    created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE public.claude_jobs
  SET status='running', claimed_by=p_worker, started_at=now(), attempts=attempts+1
  WHERE id = v_id
  RETURNING *;
END;
$function$;

-- ── 5. creative_backfill_runs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.creative_backfill_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL,            -- 'design_reads' | 'asset_meta' | 'asset_enrich'
  tier        int,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','paused')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  processed   int NOT NULL DEFAULT 0,
  failed      int NOT NULL DEFAULT 0,
  cost_usd    numeric,
  worker_id   text,
  note        text
);
CREATE INDEX IF NOT EXISTS creative_backfill_runs_kind_idx
  ON public.creative_backfill_runs (kind, started_at DESC);

ALTER TABLE public.creative_backfill_runs ENABLE ROW LEVEL SECURITY;
-- No policies by design: the worker (service_role) writes; the API reads via
-- the service client for the admin status surface.

CREATE OR REPLACE FUNCTION public.creative_backfill_run_start(
  p_kind text, p_tier int, p_worker_id text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.creative_backfill_runs (kind, tier, worker_id)
  VALUES (p_kind, p_tier, p_worker_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.creative_backfill_run_finish(
  p_run_id uuid, p_status text, p_processed int, p_failed int,
  p_cost_usd numeric, p_note text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  UPDATE public.creative_backfill_runs
     SET status = COALESCE(p_status, 'completed'),
         processed = COALESCE(p_processed, processed),
         failed = COALESCE(p_failed, failed),
         cost_usd = COALESCE(p_cost_usd, cost_usd),
         note = COALESCE(p_note, note),
         finished_at = now()
   WHERE id = p_run_id AND status = 'running';
$$;

REVOKE ALL ON FUNCTION public.creative_backfill_run_start(text, int, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.creative_backfill_run_finish(uuid, text, int, int, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.creative_backfill_run_start(text, int, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.creative_backfill_run_finish(uuid, text, int, int, numeric, text) TO service_role;

-- ── 6. mos_settings seeds ───────────────────────────────────────────────────
-- Feature flags: ship DARK (every lane checks its flag each tick; rollback =
-- a flip). writer_rules transcribed from .claude/skills/writing-post/SKILL.md
-- and .claude/skills/writing-video-script/SKILL.md (hard rules + Decisions
-- Logs, 2026-09-01). ai_roles: ADDITIVE merge — the nine creative keys are
-- added only when absent; existing keys are never touched.
INSERT INTO public.mos_settings (key, value) VALUES
  ('creative_writer', '{
     "post_enabled": false,
     "ai_image_execution": false,
     "design_reads_enabled": false,
     "asset_enrich_v2": false,
     "backfill_enabled": false
   }'::jsonb),
  ('role_map', '{
     "design_owner": "montage",
     "design_reviewer": "marketing_manager"
   }'::jsonb),
  ('creative_backfill', '{
     "design_reads": {"enabled": false, "lane": "runner", "batch_size": 24, "tiers": [1,2,3,4], "pilot_ids": []},
     "asset_meta":   {"enabled": false, "batch_size": 50},
     "asset_enrich": {"enabled": false, "lane": "worker", "batch_size": 20, "approved_cost_usd": 0, "estimated_cost_per_item": 0.004}
   }'::jsonb),
  ('writer_rules', '{
     "shared": [
       "Facts only — every number comes from the project record; if a fact is missing, omit it, never invent it.",
       "Use the AVAILABLE price range as the «تبدأ من» — never the all-unit range (a sold-out tier must never set the headline price).",
       "Off-plan flag works BOTH ways: «بيع على الخارطة» + delivery date when off-plan; «جاهزة للسكن / استلام فوري» when ready — never imply the wrong one.",
       "Only وصل العقارية is named, plus the project''s DEVELOPER. NEVER the marketer in our data, a competitor, or an agency. Every CTA/contact is Wassel — never a marketer name, phone, license, or portal; do not fabricate a phone (use the brand CTA «تواصل معنا — وصل العقارية»).",
       "Saudi dialect, warm; Arabic-Indic numerals (١٬٠٥٠٬٠٠٠); currency ر.س.",
       "Hook is punchy — variety-, immediacy- or price-led; never the slow «بسم الله…» greeting as the opener (warmth may appear after the hook).",
       "NEVER say «بدون سعي» anywhere — headline, caption, or script — even when it sits in the project record; drop it silently."
     ],
     "post": [
       "Hashtags: #وصل_العقارية + the project hashtag + generic/district tags; NEVER a competitor''s brand hashtag.",
       "The design = the PROJECT NAME (wordmark/lead with the وصل logo lockup) + 3–4 short headline lines and NOTHING else — no price/area/units/status/CTA/contact stack on the image; all detail lives in the caption.",
       "A price line may be ONE of the 3–4 headlines only when the recipe is offer/launch and it is the hook — never a stack.",
       "Learn the on-design copy from mkt_visual_text OCR first (that is the hook); the caption is the supporting layer (price, area, units, status, amenities, location, Wassel CTA, hashtag block). Always output BOTH layers, design copy first.",
       "Ready-to-paste: emojis, line breaks, and the hashtag block included."
     ],
     "video": [
       "Keep it filmable: ~45–60s, ≤8 scenes, one idea per scene.",
       "Structure: hook → location anchor → positioning/variety → feature walk → specs → variety → entry price → trust signals → Wassel CTA.",
       "Study the marketer''s voice from transcripts but NEVER name them; the script is ours.",
       "Voiceover in natural Saudi dialect; Arabic-Indic numerals on-screen; output strict scene objects (visual / voiceover / on_screen_text / start_sec / end_sec), never prose."
     ],
     "decisions_log": [
       {"date": "2026-09-01", "note": "Shared rules seeded: only وصل العقارية named (plus the developer); every contact/CTA is Wassel — never the marketer or a competitor, no phones/licenses/portals. Off-plan flagged both ways. Facts only; available price is the «تبدأ من». Hook is punchy / variety- or price-led, not the slow «بسم الله» greeting.", "source": "writing-post"},
       {"date": "2026-09-01", "note": "Hashtags are ours, never theirs: #وصل_العقارية + the project + generic/district tags; never carry a competitor''s brand hashtag.", "source": "writing-post"},
       {"date": "2026-09-01", "note": "The PROJECT NAME must be ON the design, prominently as the lead/wordmark (with the وصل logo) — a design without the project name is a failure.", "source": "writing-post"},
       {"date": "2026-09-01", "note": "NEVER say «بدون سعي» (hard rule), even when it sits in the record''s features / marketing_document. Drop it silently.", "source": "writing-post"},
       {"date": "2026-09-01", "note": "The design = project name + 3–4 headlines, NOTHING else. All detail (price, area, units, «على الخارطة», amenities, location, CTA) lives in the CAPTION.", "source": "writing-post"},
       {"date": "2026-09-01", "note": "Learn from the ON-IMAGE text (mkt_visual_text OCR), not the caption; output both layers, design copy first.", "source": "writing-post"},
       {"date": "2026-09-01", "note": "Hook style: punchy, question/variety-led, landing an immediate benefit or entry price; never open with the long «بسم الله…» greeting (warmth comes after the hook).", "source": "writing-video-script"},
       {"date": "2026-09-01", "note": "Only Wassel is named; contact is always us. Applies to voiceover AND on-screen text (the أكنان 25 draft once closed with the marketer''s name + phone — do not repeat).", "source": "writing-video-script"}
     ]
   }'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ai_roles: create the row if some future environment lacks it, then merge the
-- nine creative keys WITHOUT touching existing ones.
INSERT INTO public.mos_settings (key, value)
SELECT 'ai_roles', '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.mos_settings WHERE key = 'ai_roles');

UPDATE public.mos_settings
   SET value = value || (
         SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
           FROM jsonb_each('{
             "creative_concepts":    {"provider": "anthropic", "model": "claude-sonnet-5", "params": {"max_tokens": 2500, "thinking": "adaptive", "effort": "medium"}},
             "creative_package":     {"provider": "anthropic", "model": "claude-opus-5",   "params": {"max_tokens": 32000, "thinking": "adaptive", "effort": "high"}},
             "creative_derivatives": {"provider": "anthropic", "model": "claude-sonnet-5", "params": {"max_tokens": 16000, "thinking": "adaptive", "effort": "medium"}},
             "design_read_slide":    {"provider": "anthropic", "model": "claude-sonnet-5", "params": {"max_tokens": 2000}},
             "design_read_post":     {"provider": "anthropic", "model": "claude-sonnet-5", "params": {"max_tokens": 3000, "thinking": "adaptive", "effort": "medium"}},
             "asset_enrich_v2":      {"provider": "anthropic", "model": "claude-haiku-4-5-20251001", "params": {"max_tokens": 1500}},
             "image_edit":           {"provider": "fal", "model": "fal-ai/nano-banana-pro/edit"},
             "image_generate":       {"provider": "fal", "model": "fal-ai/nano-banana-pro"},
             "image_remove_text":    {"provider": "fal", "model": "fal-ai/flux-2/klein/4b/edit"}
           }'::jsonb) e(k, v)
           WHERE NOT (value ? k)
       )
 WHERE key = 'ai_roles';

COMMIT;
