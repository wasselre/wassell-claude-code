-- Meta Marketing API → MOS sync (OUR ad account)
-- ============================================================================
-- Pulls the Wassel ad account's Campaign → Ad Set → Ad tree + insights from the
-- Meta Marketing API and upserts it into the LIVE Marketing-OS spine by external
-- id, then self-heals Click-to-WhatsApp lead attribution:
--
--   Meta campaign  → mos_campaign_executions (platform='meta', platform_campaign_id)
--   Meta ad set    → mos_ad_sets             (platform_adset_id)
--   Meta ad        → mos_execution_ads       (platform_ad_id) ─┐
--                                                              └─ mos_reresolve_first_touch()
--
-- "Meta is source of truth" (user decision 2026-08-16): every synced row hangs
-- under a single per-account HOLDER mos_campaigns (ref='meta-sync:act_<id>',
-- project unlinked — a human links each synced execution to its real project
-- campaign in the Campaign Tree). The sync OWNS that holder: on each run it
-- prunes children whose external id vanished from Meta. It NEVER touches rows
-- outside the holder, so hand-built campaigns on other platforms are safe.
--
-- Idempotent: upsert by the external ids (which carry partial-unique indexes
-- from 2026-08-16_paid_ads_identity_and_attribution.sql), so re-running is a
-- no-op-plus-metrics-refresh. Additive schema (one new table + functions).
-- ============================================================================

BEGIN;

-- 1. Sync state / kill switch — one row per ad account. ------------------------
CREATE TABLE IF NOT EXISTS public.mos_meta_sync_state (
  ad_account_id      text PRIMARY KEY,          -- numeric, no act_ prefix
  is_enabled         boolean NOT NULL DEFAULT true,
  holder_campaign_id uuid REFERENCES public.mos_campaigns(id) ON DELETE SET NULL,
  currency           text,
  last_synced_at     timestamptz,
  last_result        jsonb,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.mos_meta_sync_state_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_mos_meta_sync_state_touch ON public.mos_meta_sync_state;
CREATE TRIGGER trg_mos_meta_sync_state_touch BEFORE UPDATE ON public.mos_meta_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.mos_meta_sync_state_touch();

ALTER TABLE public.mos_meta_sync_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mos_meta_sync_state_read ON public.mos_meta_sync_state;
CREATE POLICY mos_meta_sync_state_read ON public.mos_meta_sync_state
  FOR SELECT USING (public.wassell_mos_can('read'));
GRANT SELECT ON public.mos_meta_sync_state TO authenticated;
GRANT ALL ON public.mos_meta_sync_state TO service_role;

-- 2. Status mappers (Meta effective_status → MOS status enums). ----------------
CREATE OR REPLACE FUNCTION public.mos_meta_exec_status(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE upper(coalesce(p,''))
    WHEN 'ACTIVE'          THEN 'running'
    WHEN 'PAUSED'          THEN 'paused'
    WHEN 'CAMPAIGN_PAUSED' THEN 'paused'
    WHEN 'ADSET_PAUSED'    THEN 'paused'
    WHEN 'ARCHIVED'        THEN 'ended'
    WHEN 'DELETED'         THEN 'ended'
    ELSE 'draft' END;
$$;

CREATE OR REPLACE FUNCTION public.mos_meta_ad_status(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE upper(coalesce(p,''))
    WHEN 'ACTIVE' THEN 'running'
    WHEN 'PAUSED'          THEN 'paused'
    WHEN 'CAMPAIGN_PAUSED' THEN 'paused'
    WHEN 'ADSET_PAUSED'    THEN 'paused'
    WHEN 'DISAPPROVED'     THEN 'paused'
    WHEN 'ARCHIVED'        THEN 'paused'
    WHEN 'DELETED'         THEN 'paused'
    ELSE 'waiting' END;
$$;

-- 3. The sync applier. Takes the normalized tree fetched by the API layer and
--    upserts it atomically, prunes vanished children, and re-resolves leads.
--    SECURITY DEFINER: the sync runs server-side and must write regardless of
--    the caller's RLS (same posture as mos_resolve_ad).
--
--    p_campaigns : [{id,name,objective,status,daily_budget,lifetime_budget,spend,impressions,clicks,leads}]
--    p_ad_sets   : [{id,campaign_id,name,status}]
--    p_ads       : [{id,campaign_id,adset_id,name,status,spend,impressions,clicks,leads}]
--    budgets are Meta MINOR units (halalas) → stored as major SAR (÷100);
--    insights spend is already major SAR.
CREATE OR REPLACE FUNCTION public.mos_meta_sync_apply(
  p_account_id  text,
  p_holder_name text,
  p_currency    text,
  p_campaigns   jsonb,
  p_ad_sets     jsonb,
  p_ads         jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_holder_ref text := 'meta-sync:act_' || p_account_id;
  v_holder     uuid;
  rec          jsonb;
  v_exec       uuid;
  v_adset      uuid;
  v_healed     int := 0;
  v_h          int;
  v_pruned_ads int := 0;
  v_pruned_sets int := 0;
  v_pruned_execs int := 0;
  v_camp_ids   text[] := '{}';
  v_adset_ids  text[] := '{}';
  v_ad_ids     text[] := '{}';
  aid          text;
BEGIN
  -- holder campaign (find or create by ref) -----------------------------------
  SELECT id INTO v_holder FROM mos_campaigns WHERE ref = v_holder_ref;
  IF v_holder IS NULL THEN
    INSERT INTO mos_campaigns (ref, name, kind, objective, status, note)
    VALUES (v_holder_ref, p_holder_name, 'paid', 'leads', 'active',
            'Auto-created holder for Meta-synced campaigns. Link each execution to its real project campaign.')
    RETURNING id INTO v_holder;
  END IF;

  -- campaigns → executions ----------------------------------------------------
  FOR rec IN SELECT value FROM jsonb_array_elements(coalesce(p_campaigns,'[]'::jsonb)) AS t(value) LOOP
    v_camp_ids := array_append(v_camp_ids, rec->>'id');
    -- NOTE: campaign_id is deliberately NOT overwritten on update — once a human
    -- re-parents a synced execution under a real project campaign (the "link to
    -- project" action), later syncs must preserve that link, not drag it back to
    -- the holder. campaign_id = holder is set only on INSERT (new executions).
    UPDATE mos_campaign_executions SET
      label       = rec->>'name',
      status      = mos_meta_exec_status(rec->>'status'),
      budget      = NULLIF(coalesce(rec->>'daily_budget', rec->>'lifetime_budget'),'')::numeric / 100.0,
      spend       = NULLIF(rec->>'spend','')::numeric,
      impressions = NULLIF(rec->>'impressions','')::int,
      clicks      = NULLIF(rec->>'clicks','')::int,
      leads       = NULLIF(rec->>'leads','')::int,
      source      = 'api',
      updated_at  = now()
    WHERE platform = 'meta' AND platform_campaign_id = rec->>'id'
    RETURNING id INTO v_exec;

    IF v_exec IS NULL THEN
      INSERT INTO mos_campaign_executions
        (campaign_id, platform, platform_campaign_id, label, status, source,
         budget, spend, impressions, clicks, leads)
      VALUES (v_holder, 'meta', rec->>'id', rec->>'name',
              mos_meta_exec_status(rec->>'status'), 'api',
              NULLIF(coalesce(rec->>'daily_budget', rec->>'lifetime_budget'),'')::numeric / 100.0,
              NULLIF(rec->>'spend','')::numeric, NULLIF(rec->>'impressions','')::int,
              NULLIF(rec->>'clicks','')::int, NULLIF(rec->>'leads','')::int);
    END IF;
  END LOOP;

  -- ad sets -------------------------------------------------------------------
  FOR rec IN SELECT value FROM jsonb_array_elements(coalesce(p_ad_sets,'[]'::jsonb)) AS t(value) LOOP
    v_adset_ids := array_append(v_adset_ids, rec->>'id');
    SELECT id INTO v_exec FROM mos_campaign_executions
      WHERE platform = 'meta' AND platform_campaign_id = rec->>'campaign_id';
    IF v_exec IS NULL THEN CONTINUE; END IF;

    UPDATE mos_ad_sets SET
      execution_id = v_exec,
      name         = rec->>'name',
      status       = CASE WHEN mos_meta_exec_status(rec->>'status') = 'running' THEN 'active' ELSE 'paused' END,
      updated_at   = now()
    WHERE platform_adset_id = rec->>'id'
    RETURNING id INTO v_adset;

    IF v_adset IS NULL THEN
      INSERT INTO mos_ad_sets (execution_id, name, platform_adset_id, status)
      VALUES (v_exec, rec->>'name', rec->>'id',
              CASE WHEN mos_meta_exec_status(rec->>'status') = 'running' THEN 'active' ELSE 'paused' END);
    END IF;
  END LOOP;

  -- ads -----------------------------------------------------------------------
  FOR rec IN SELECT value FROM jsonb_array_elements(coalesce(p_ads,'[]'::jsonb)) AS t(value) LOOP
    v_ad_ids := array_append(v_ad_ids, rec->>'id');
    SELECT id INTO v_exec FROM mos_campaign_executions
      WHERE platform = 'meta' AND platform_campaign_id = rec->>'campaign_id';
    IF v_exec IS NULL THEN CONTINUE; END IF;
    SELECT id INTO v_adset FROM mos_ad_sets WHERE platform_adset_id = rec->>'adset_id';

    UPDATE mos_execution_ads SET
      execution_id = v_exec,
      ad_set_id    = v_adset,
      label        = rec->>'name',
      status       = mos_meta_ad_status(rec->>'status'),
      spend        = NULLIF(rec->>'spend','')::numeric,
      impressions  = NULLIF(rec->>'impressions','')::int,
      clicks       = NULLIF(rec->>'clicks','')::int,
      leads        = NULLIF(rec->>'leads','')::int,
      updated_at   = now()
    WHERE platform_ad_id = rec->>'id';

    IF NOT FOUND THEN
      INSERT INTO mos_execution_ads
        (execution_id, ad_set_id, platform_ad_id, label, status, spend, impressions, clicks, leads)
      VALUES (v_exec, v_adset, rec->>'id', rec->>'name', mos_meta_ad_status(rec->>'status'),
              NULLIF(rec->>'spend','')::numeric, NULLIF(rec->>'impressions','')::int,
              NULLIF(rec->>'clicks','')::int, NULLIF(rec->>'leads','')::int);
    END IF;
  END LOOP;

  -- prune vanished children WITHIN the holder only ----------------------------
  WITH d AS (
    DELETE FROM mos_execution_ads a USING mos_campaign_executions e
    WHERE a.execution_id = e.id AND e.campaign_id = v_holder AND e.platform = 'meta'
      AND a.platform_ad_id IS NOT NULL AND NOT (a.platform_ad_id = ANY(v_ad_ids))
    RETURNING 1) SELECT count(*) INTO v_pruned_ads FROM d;

  WITH d AS (
    DELETE FROM mos_ad_sets s USING mos_campaign_executions e
    WHERE s.execution_id = e.id AND e.campaign_id = v_holder AND e.platform = 'meta'
      AND s.platform_adset_id IS NOT NULL AND NOT (s.platform_adset_id = ANY(v_adset_ids))
    RETURNING 1) SELECT count(*) INTO v_pruned_sets FROM d;

  WITH d AS (
    DELETE FROM mos_campaign_executions e
    WHERE e.campaign_id = v_holder AND e.platform = 'meta'
      AND e.platform_campaign_id IS NOT NULL AND NOT (e.platform_campaign_id = ANY(v_camp_ids))
    RETURNING 1) SELECT count(*) INTO v_pruned_execs FROM d;

  -- self-heal lead attribution for every synced ad ----------------------------
  FOREACH aid IN ARRAY v_ad_ids LOOP
    v_h := public.mos_reresolve_first_touch(aid);
    v_healed := v_healed + coalesce(v_h, 0);
  END LOOP;

  -- record run state ----------------------------------------------------------
  INSERT INTO mos_meta_sync_state (ad_account_id, holder_campaign_id, currency, last_synced_at, last_result, last_error)
  VALUES (p_account_id, v_holder, p_currency, now(),
          jsonb_build_object(
            'campaigns', jsonb_array_length(coalesce(p_campaigns,'[]'::jsonb)),
            'ad_sets',   jsonb_array_length(coalesce(p_ad_sets,'[]'::jsonb)),
            'ads',       jsonb_array_length(coalesce(p_ads,'[]'::jsonb)),
            'healed',    v_healed,
            'pruned_ads', v_pruned_ads, 'pruned_ad_sets', v_pruned_sets, 'pruned_executions', v_pruned_execs),
          NULL)
  ON CONFLICT (ad_account_id) DO UPDATE SET
    holder_campaign_id = EXCLUDED.holder_campaign_id,
    currency           = EXCLUDED.currency,
    last_synced_at     = EXCLUDED.last_synced_at,
    last_result        = EXCLUDED.last_result,
    last_error         = NULL;

  RETURN (SELECT last_result FROM mos_meta_sync_state WHERE ad_account_id = p_account_id)
         || jsonb_build_object('holder_campaign_id', v_holder);
END; $$;

GRANT EXECUTE ON FUNCTION public.mos_meta_sync_apply(text, text, text, jsonb, jsonb, jsonb) TO service_role;

-- 4. Force re-resolve for the "link execution → project" action. Unlike
--    mos_reresolve_first_touch (fills NULL only), this OVERWRITES every
--    chat_messages resolution for the execution's ads, so re-linking an
--    execution to a different project campaign updates the frozen snapshots.
CREATE OR REPLACE FUNCTION public.mos_meta_force_reresolve_execution(p_execution_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0;
BEGIN
  UPDATE public.chat_messages cm
  SET meta = jsonb_set(
        cm.meta, '{ad,resolved}',
        (SELECT to_jsonb(r) - 'project_ids' || jsonb_build_object('resolved_at', now())
         FROM public.mos_resolve_ad(cm.meta->'ad'->>'ad_id') r LIMIT 1),
        true)
  WHERE cm.meta->'ad'->>'ad_id' IN (
          SELECT a.platform_ad_id FROM public.mos_execution_ads a
          WHERE a.execution_id = p_execution_id AND a.platform_ad_id IS NOT NULL
        )
    AND EXISTS (SELECT 1 FROM public.mos_resolve_ad(cm.meta->'ad'->>'ad_id'));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;
GRANT EXECUTE ON FUNCTION public.mos_meta_force_reresolve_execution(uuid) TO service_role;

-- 5. Seed the new manage_paid_ads capability to the marketing roles that already
--    manage settings (admins pass via the wassell_is_admin bypass). Capabilities
--    are DATA in role_capabilities; this is idempotent.
INSERT INTO public.role_capabilities (role_id, capability)
SELECT r.id, 'manage_paid_ads' FROM public.roles r
WHERE r.domain = 'marketing'
  AND EXISTS (SELECT 1 FROM public.role_capabilities rc
              WHERE rc.role_id = r.id AND rc.capability = 'manage_settings')
ON CONFLICT (role_id, capability) DO NOTHING;

COMMIT;
