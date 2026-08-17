-- Paid Ads identity hierarchy + Meta-ad → lead attribution
-- ============================================================================
-- Adds the missing Ad Set / Ad Group level to the LIVE Marketing-OS own-ads
-- hierarchy and the external platform ids needed to resolve an inbound WhatsApp
-- Click-to-WhatsApp ad (WAHA externalAdReply.sourceID = the Meta Ad ID) back to:
--
--   Ad → Ad Set → Campaign (execution, per-platform) → Project campaign → Project
--
-- The MOS spine already exists and is wired to the /m workspace:
--   mos_campaigns (project_ids)  →  mos_campaign_executions (platform, platform_campaign_id)
--     →  mos_execution_ads (content_id)
-- This migration only ADDS: an ad-set level, external ids on the ad, uniqueness
-- on the external ids (so an incoming sourceID resolves to exactly one ad), the
-- resolver, and a self-heal that back-fills conversations whose ad arrived
-- before its ad record existed.
--
-- 100% additive / backward-compatible: new table, nullable columns, new indexes
-- and functions. Nothing the currently-deployed code reads or writes changes
-- shape. Safe to apply ahead of the code PR.
-- ============================================================================

BEGIN;

-- 1. Ad Set / Ad Group — the missing middle level. Two identity fields only
--    (name + external id), per the phase-1 "simple identity hierarchy" spec.
CREATE TABLE IF NOT EXISTS public.mos_ad_sets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id      uuid NOT NULL REFERENCES public.mos_campaign_executions(id) ON DELETE CASCADE,
  name              text NOT NULL,
  platform_adset_id text,                       -- external Ad Set / Ad Group id (Meta ad set id, etc.)
  status            text NOT NULL DEFAULT 'active',
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz
);
CREATE INDEX IF NOT EXISTS ix_mos_ad_sets_execution ON public.mos_ad_sets(execution_id);

-- keep updated_at fresh (mirrors the mos_* touch trigger convention)
CREATE OR REPLACE FUNCTION public.mos_ad_sets_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_mos_ad_sets_touch ON public.mos_ad_sets;
CREATE TRIGGER trg_mos_ad_sets_touch BEFORE UPDATE ON public.mos_ad_sets
  FOR EACH ROW EXECUTE FUNCTION public.mos_ad_sets_touch();

-- 2. External Ad ID + ad-set link on the ad. execution_id is kept so existing
--    ads (which hang directly off an execution) are untouched; ad_set_id is the
--    new optional parent.
ALTER TABLE public.mos_execution_ads
  ADD COLUMN IF NOT EXISTS platform_ad_id text,
  ADD COLUMN IF NOT EXISTS ad_set_id      uuid REFERENCES public.mos_ad_sets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_at    timestamptz;
CREATE INDEX IF NOT EXISTS ix_mos_exec_ads_ad_set ON public.mos_execution_ads(ad_set_id);

-- 3. Uniqueness on the external ids — the resolution keys. A sourceID must map
--    to exactly ONE ad, or attribution is ambiguous. Partial: only enforced
--    when the id is set and the row is live (Meta ids are globally unique).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_execution_ads_platform_ad_id
  ON public.mos_execution_ads (platform_ad_id)
  WHERE platform_ad_id IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_ad_sets_platform_adset_id
  ON public.mos_ad_sets (platform_adset_id)
  WHERE platform_adset_id IS NOT NULL AND archived_at IS NULL;

-- Campaign external id lives on the execution (which already carries `platform`).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_exec_platform_campaign_id
  ON public.mos_campaign_executions (platform, platform_campaign_id)
  WHERE platform_campaign_id IS NOT NULL;

-- 4. RLS — mirror the mos_execution_ads policies exactly (read / enter_metrics /
--    delete_records via wassell_mos_can).
ALTER TABLE public.mos_ad_sets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mos_ad_sets_read ON public.mos_ad_sets;
CREATE POLICY mos_ad_sets_read ON public.mos_ad_sets
  FOR SELECT USING (public.wassell_mos_can('read'));

DROP POLICY IF EXISTS mos_ad_sets_ins ON public.mos_ad_sets;
CREATE POLICY mos_ad_sets_ins ON public.mos_ad_sets
  FOR INSERT WITH CHECK (public.wassell_mos_can('enter_metrics'));

DROP POLICY IF EXISTS mos_ad_sets_upd ON public.mos_ad_sets;
CREATE POLICY mos_ad_sets_upd ON public.mos_ad_sets
  FOR UPDATE USING (public.wassell_mos_can('enter_metrics'))
  WITH CHECK (public.wassell_mos_can('enter_metrics'));

DROP POLICY IF EXISTS mos_ad_sets_del ON public.mos_ad_sets;
CREATE POLICY mos_ad_sets_del ON public.mos_ad_sets
  FOR DELETE USING (public.wassell_mos_can('delete_records'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mos_ad_sets TO authenticated;
GRANT ALL ON public.mos_ad_sets TO service_role;

-- 5. Resolver — sourceID (Meta Ad ID) → the full own-ads chain incl. project.
--    SECURITY DEFINER so the webhook (service role) and the app (authenticated)
--    both resolve identically, regardless of the caller's RLS.
CREATE OR REPLACE FUNCTION public.mos_resolve_ad(p_platform_ad_id text)
RETURNS TABLE (
  ad_id                uuid,
  ad_name              text,
  ad_set_id            uuid,
  ad_set_name          text,
  execution_id         uuid,
  platform             text,
  platform_campaign_id text,
  campaign_id          uuid,
  campaign_name        text,
  project_id           uuid,
  project_ids          jsonb,
  content_id           uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    a.id, a.label, a.ad_set_id, s.name, a.execution_id, e.platform, e.platform_campaign_id,
    c.id, c.name,
    COALESCE(c.project_id, NULLIF(c.project_ids->>0, '')::uuid),
    c.project_ids, a.content_id
  FROM public.mos_execution_ads a
  JOIN public.mos_campaign_executions e ON e.id = a.execution_id
  JOIN public.mos_campaigns c            ON c.id = e.campaign_id
  LEFT JOIN public.mos_ad_sets s         ON s.id = a.ad_set_id
  WHERE a.platform_ad_id = p_platform_ad_id
    AND a.archived_at IS NULL
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.mos_resolve_ad(text) TO authenticated, service_role;

-- 6. Self-heal — when an ad's external id is (re)set, back-fill any conversation
--    whose first_touch captured that ad id before the ad record existed. Keeps
--    "preserve raw, resolve later" honest. SECURITY DEFINER: it must update
--    chats records regardless of the caller's row scope.
CREATE OR REPLACE FUNCTION public.mos_reresolve_first_touch(p_platform_ad_id text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_chats_model uuid;
  v_resolved    jsonb;
  v_count       integer := 0;
BEGIN
  IF p_platform_ad_id IS NULL OR p_platform_ad_id = '' THEN RETURN 0; END IF;
  SELECT id INTO v_chats_model FROM public.models WHERE name = 'chats';
  IF v_chats_model IS NULL THEN RETURN 0; END IF;

  SELECT to_jsonb(r) - 'project_ids'
       || jsonb_build_object('resolved_at', now())
    INTO v_resolved
  FROM public.mos_resolve_ad(p_platform_ad_id) r
  LIMIT 1;
  IF v_resolved IS NULL THEN RETURN 0; END IF;

  UPDATE public.records
     SET data = jsonb_set(data, '{first_touch,resolved}', v_resolved, true)
   WHERE model_id = v_chats_model
     AND data->'first_touch'->>'ad_id' = p_platform_ad_id
     AND (data->'first_touch'->'resolved' IS NULL
          OR jsonb_typeof(data->'first_touch'->'resolved') = 'null');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;
GRANT EXECUTE ON FUNCTION public.mos_reresolve_first_touch(text) TO authenticated, service_role;

COMMIT;
