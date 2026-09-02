-- Script writer v2: drafts (human approval before production scenes), scene
-- protection model, job stages/costs, feedback, and the brief RPC shared by the
-- API and the worker. All additive.

-- ── drafts ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mos_script_drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid REFERENCES public.mos_script_jobs(id) ON DELETE SET NULL,
  content_id        uuid NOT NULL REFERENCES public.mos_content(id) ON DELETE CASCADE,
  recipe            text NOT NULL,
  brief             jsonb NOT NULL DEFAULT '{}'::jsonb,
  facts             jsonb NOT NULL DEFAULT '{}'::jsonb,
  exemplars         jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan              jsonb NOT NULL DEFAULT '{}'::jsonb,
  scenes            jsonb NOT NULL DEFAULT '[]'::jsonb,
  hooks             jsonb NOT NULL DEFAULT '[]'::jsonb,
  chosen_hook       int,
  review            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','needs_attention','applied','discarded')),
  applied_scene_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved_by       uuid,
  applied_at        timestamptz,
  roles             jsonb NOT NULL DEFAULT '{}'::jsonb,   -- role -> {provider, model, version}
  cost_usd          numeric NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- one pending draft per content item
CREATE UNIQUE INDEX IF NOT EXISTS mos_script_drafts_one_pending
  ON public.mos_script_drafts (content_id) WHERE status IN ('draft','needs_attention');
CREATE INDEX IF NOT EXISTS mos_script_drafts_content ON public.mos_script_drafts (content_id, created_at DESC);
ALTER TABLE public.mos_script_drafts ENABLE ROW LEVEL SECURITY; -- service-only (API gates)

-- ── jobs: stage / cost / roles / draft link ──────────────────────────────────
ALTER TABLE public.mos_script_jobs
  ADD COLUMN IF NOT EXISTS draft_id   uuid,
  ADD COLUMN IF NOT EXISTS brief      jsonb,
  ADD COLUMN IF NOT EXISTS stage      text,
  ADD COLUMN IF NOT EXISTS cost_usd   numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS roles      jsonb,
  ADD COLUMN IF NOT EXISTS error_kind text;

CREATE OR REPLACE FUNCTION public.mos_script_job_stage(p_job_id uuid, p_stage text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE public.mos_script_jobs SET stage = p_stage WHERE id = p_job_id AND status = 'running';
$$;
REVOKE ALL ON FUNCTION public.mos_script_job_stage(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_script_job_stage(uuid, text) TO service_role;

-- complete now also records the draft + cost (keeps the old signature working)
CREATE OR REPLACE FUNCTION public.mos_script_job_complete(
  p_job_id uuid, p_scene_count int, p_hooks jsonb, p_draft_id uuid, p_cost_usd numeric, p_roles jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE public.mos_script_jobs
     SET status = 'completed', scene_count = p_scene_count, hooks = p_hooks, draft_id = p_draft_id,
         cost_usd = COALESCE(p_cost_usd, 0), roles = p_roles, stage = 'draft', error = NULL, finished_at = now()
   WHERE id = p_job_id AND status = 'running';
$$;
REVOKE ALL ON FUNCTION public.mos_script_job_complete(uuid, int, jsonb, uuid, numeric, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_script_job_complete(uuid, int, jsonb, uuid, numeric, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.mos_script_job_fail(p_job_id uuid, p_error text, p_error_kind text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE public.mos_script_jobs
     SET status = 'failed', error = LEFT(COALESCE(p_error, 'unknown'), 2000), error_kind = p_error_kind, finished_at = now()
   WHERE id = p_job_id AND status = 'running';
$$;
REVOKE ALL ON FUNCTION public.mos_script_job_fail(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_script_job_fail(uuid, text, text) TO service_role;

-- watchdog: the staged pipeline (2–3 model calls) needs a longer ceiling
CREATE OR REPLACE FUNCTION public.mos_script_jobs_watchdog()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n int;
BEGIN
  UPDATE public.mos_script_jobs
     SET status = 'failed', error = 'watchdog: stuck running > 8 min', error_kind = 'watchdog', finished_at = now()
   WHERE status = 'running' AND started_at < now() - interval '8 minutes';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END; $$;

-- ── scene protection model ───────────────────────────────────────────────────
ALTER TABLE public.mos_scenes
  ADD COLUMN IF NOT EXISTS source              text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai')),
  ADD COLUMN IF NOT EXISTS source_draft_id     uuid,
  ADD COLUMN IF NOT EXISTS last_edited_by      uuid,
  ADD COLUMN IF NOT EXISTS manually_edited_at  timestamptz,
  ADD COLUMN IF NOT EXISTS purpose             text,
  ADD COLUMN IF NOT EXISTS visual_intent       jsonb,
  ADD COLUMN IF NOT EXISTS fact_refs           jsonb;
CREATE INDEX IF NOT EXISTS mos_scenes_source_draft ON public.mos_scenes (source_draft_id) WHERE source_draft_id IS NOT NULL;

-- Which scenes of a content item may be replaced by a draft apply, and why the
-- rest are protected. Used by preview AND re-checked at apply time.
CREATE OR REPLACE FUNCTION public.mos_scene_protection(p_content_id uuid)
RETURNS TABLE (scene_id uuid, "position" int, visual text, replaceable boolean, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT s.id, s.position, s.visual,
         (s.source = 'ai' AND s.manually_edited_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM public.mos_shoot_items i WHERE i.scene_id = s.id)
            AND s.asset_id IS NULL AND s.footage_status NOT IN ('have','template')) AS replaceable,
         CASE
           WHEN s.source <> 'ai' THEN 'manual'
           WHEN s.manually_edited_at IS NOT NULL THEN 'edited'
           WHEN EXISTS (SELECT 1 FROM public.mos_shoot_items i WHERE i.scene_id = s.id) THEN 'shoot_linked'
           WHEN s.asset_id IS NOT NULL OR s.footage_status IN ('have','template') THEN 'production_used'
           ELSE NULL END AS reason
    FROM public.mos_scenes s WHERE s.content_id = p_content_id ORDER BY s.position;
$$;
REVOKE ALL ON FUNCTION public.mos_scene_protection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_scene_protection(uuid) TO service_role, authenticated;

-- ── feedback (learning infrastructure; proposals only, never auto-applied) ───
CREATE TABLE IF NOT EXISTS public.mos_script_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id    uuid REFERENCES public.mos_script_drafts(id) ON DELETE CASCADE,
  content_id  uuid NOT NULL,
  rating      int CHECK (rating BETWEEN 1 AND 5),
  note        text,
  diff        jsonb,          -- draft scenes vs applied/edited scenes
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mos_script_feedback ENABLE ROW LEVEL SECURITY;

-- ── the brief, built ONCE in SQL for both the API and the worker ─────────────
CREATE OR REPLACE FUNCTION public.mos_script_brief(p_content_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  c record;
  v_camp_id uuid; v_camp_name text; v_objective text; v_kind text; v_offer text; v_camp_audience text; v_audience_id uuid;
  v_aud_name text; v_aud_details text;
  v_platforms text[]; v_paid_platforms text[];
  v_project_name text; v_projects jsonb; v_scenes jsonb; v_assets jsonb; v_purpose text;
BEGIN
  SELECT * INTO c FROM public.mos_content_v WHERE id = p_content_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF c.campaign_id IS NOT NULL THEN
    SELECT id, name, objective, kind, offer, audience, audience_id
      INTO v_camp_id, v_camp_name, v_objective, v_kind, v_offer, v_camp_audience, v_audience_id
      FROM public.mos_campaigns WHERE id = c.campaign_id;
    IF v_audience_id IS NOT NULL THEN
      SELECT name, details INTO v_aud_name, v_aud_details FROM public.mos_audiences WHERE id = v_audience_id;
    END IF;
    SELECT array_agg(DISTINCT e.platform) INTO v_paid_platforms FROM public.mos_campaign_executions e WHERE e.campaign_id = c.campaign_id AND e.platform IS NOT NULL;
  END IF;
  v_platforms := COALESCE(c.organic_platforms, '{}') || COALESCE(v_paid_platforms, '{}');
  v_purpose := COALESCE(NULLIF(c.purpose,''), v_kind, 'unknown');
  SELECT data->>'project_name' INTO v_project_name FROM public.unified_records WHERE id = c.project_id;
  v_projects := COALESCE(c.project_ids, '[]'::jsonb);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'visual', s.visual, 'voiceover', s.voiceover,
           'on_screen_text', s.on_screen_text, 'footage_status', s.footage_status, 'source', s.source, 'manually_edited_at', s.manually_edited_at) ORDER BY s.position), '[]'::jsonb)
    INTO v_scenes FROM public.mos_scenes s WHERE s.content_id = p_content_id;
  SELECT jsonb_build_object('count', count(*), 'kinds', COALESCE(jsonb_object_agg(k.kind, k.n) FILTER (WHERE k.kind IS NOT NULL), '{}'::jsonb))
    INTO v_assets
    FROM (SELECT a.kind, count(*) AS n FROM public.mos_asset_links l JOIN public.mos_assets a ON a.id = l.asset_id
           WHERE l.content_id = p_content_id AND a.archived_at IS NULL GROUP BY a.kind) k;
  RETURN jsonb_build_object(
    'content_id', c.id, 'title', c.title, 'content_type_key', c.content_type_key,
    'project_id', c.project_id, 'project_ids', v_projects, 'project_name', v_project_name,
    'multi_project_warning', (jsonb_array_length(v_projects) > 1),
    'campaign', CASE WHEN v_camp_id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v_camp_id, 'name', v_camp_name, 'objective', v_objective, 'kind', v_kind, 'offer', v_offer,
        'audience_text', COALESCE(NULLIF(c.audience,''), v_camp_audience), 'audience_id', v_audience_id,
        'audience_name', v_aud_name, 'audience_details', v_aud_details) END,
    'purpose', v_purpose, 'platforms', to_jsonb(v_platforms),
    'objective', COALESCE(v_objective, NULLIF(c.goal,'')),
    'audience', COALESCE(NULLIF(c.audience,''), v_camp_audience, v_aud_details),
    'language', COALESCE(c.language, 'ar'), 'cta', NULLIF(c.cta,''), 'angle', NULLIF(c.angle,''),
    'core_message', c.data->>'core_message', 'idea', c.data->>'idea', 'hook', c.data->>'hook',
    'existing_scenes', v_scenes, 'assets_summary', COALESCE(v_assets, '{"count":0,"kinds":{}}'::jsonb));
END; $$;
REVOKE ALL ON FUNCTION public.mos_script_brief(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_script_brief(uuid) TO service_role, authenticated;
