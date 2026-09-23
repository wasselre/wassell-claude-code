-- ============================================================================
-- Auto-register ad leads in a lead portal (2026-09-23)
--
-- Until now a client reached a developer's / marketer's broker portal only when
-- a rep clicked "Register in portal". For portals that sign in WITHOUT a code
-- (Riva: email + password), nothing in the run needs a person, so ad leads for
-- the projects such a portal covers are now registered automatically:
--
--   client_attributions (the "which ad did they come from" ledger the client
--   profile already shows)  →  ad → execution → campaign → project
--   →  every ACTIVE lead portal covering that project whose new
--      `auto_register` switch is on  →  portal_registration_jobs (origin='auto')
--
-- The sweep itself is /api/cron/portal-auto-register (every 5 min). This
-- migration adds:
--   1. `auto_register` checkbox on the lead_portals model (off by default —
--      opting a portal in is a data edit, not a deploy).
--   2. portal_registration_jobs.origin ('manual'|'auto') + attribution_id, so
--      the history and the logs can tell a button press from the sweep.
--   3. portal_auto_register_candidates(p_since) — the recent ad-attributed
--      clients with the project their ad is for, resolved EXACTLY like
--      mos_client_acquisition (the client-profile panel), service-role only.
--   4. Turns the switch ON for the Riva portal (its recipe has no OTP step and
--      has completed real registrations from the button since 2026-09-16).
-- Backward-compatible: the deployed code ignores the new column/field.
-- ============================================================================

BEGIN;

-- ── 1. auto_register field on lead_portals (guarded, idempotent) ────────────
DO $$
DECLARE
  v_sec_idx int;
  v_sec_id  text;
  v_n       int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.models WHERE name = 'lead_portals') THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.models m,
      jsonb_array_elements(m.schema->'sections') s,
      jsonb_array_elements(s->'fields') f
    WHERE m.name = 'lead_portals' AND f->>'name' = 'auto_register'
  ) THEN
    RETURN;
  END IF;

  -- The "Sign-in & automation" section (order 1); fall back to the last one.
  SELECT (o.ord - 1)::int, o.sec->>'id', jsonb_array_length(o.sec->'fields')
    INTO v_sec_idx, v_sec_id, v_n
  FROM public.models m,
       jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS o(sec, ord)
  WHERE m.name = 'lead_portals'
  ORDER BY (o.sec->>'label_en' = 'Sign-in & automation') DESC, o.ord DESC
  LIMIT 1;

  UPDATE public.models
     SET schema = jsonb_set(
       schema,
       ARRAY['sections', v_sec_idx::text, 'fields'],
       (schema->'sections'->v_sec_idx->'fields') || jsonb_build_array(jsonb_build_object(
         'id', gen_random_uuid()::text,
         'name', 'auto_register',
         'type', 'checkbox',
         'label_ar', 'تسجيل عملاء الإعلانات تلقائياً',
         'label_en', 'Auto-register ad leads',
         'required', false,
         'order', v_n,
         'section_id', v_sec_id,
         'width', 'half',
         'show_in_table', true,
         'default_value', false
       ))
     )
   WHERE name = 'lead_portals';
END $$;

-- ── 2. origin + attribution on the job row ──────────────────────────────────
ALTER TABLE public.portal_registration_jobs
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS attribution_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portal_registration_jobs_origin_check') THEN
    ALTER TABLE public.portal_registration_jobs
      ADD CONSTRAINT portal_registration_jobs_origin_check CHECK (origin IN ('manual','auto'));
  END IF;
END $$;

COMMENT ON COLUMN public.portal_registration_jobs.origin IS
  'manual = a rep pressed "Register in portal"; auto = /api/cron/portal-auto-register registered an ad lead.';
COMMENT ON COLUMN public.portal_registration_jobs.attribution_id IS
  'For origin=auto: the client_attributions row (the ad touch) that triggered the run.';

-- ── 3. candidates: recent ad-attributed clients + their ad's project ────────
CREATE OR REPLACE FUNCTION public.portal_auto_register_candidates(p_since timestamptz)
RETURNS TABLE (
  attribution_id    uuid,
  client_record_id  uuid,
  project_record_id uuid,
  campaign_id       uuid,
  occurred_at       timestamptz,
  created_at        timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- Same ad → execution → campaign → project chain as mos_client_acquisition,
  -- so "the project the profile says this ad was for" and "the project we
  -- register for" can never disagree.
  SELECT e.id,
         e.client_record_id,
         COALESCE(c.project_id, NULLIF(c.project_ids->>0, '')::uuid),
         c.id,
         e.occurred_at,
         e.created_at
    FROM public.client_attributions_effective e
    LEFT JOIN public.mos_execution_ads       ad ON ad.id = e.ad_id
    LEFT JOIN public.mos_campaign_executions ex ON ex.id = COALESCE(e.execution_id, ad.execution_id)
    LEFT JOIN public.mos_campaigns           c  ON c.id  = COALESCE(e.campaign_id, ex.campaign_id)
   WHERE e.created_at >= p_since
     AND COALESCE(c.project_id, NULLIF(c.project_ids->>0, '')::uuid) IS NOT NULL
   ORDER BY e.created_at;
$$;
REVOKE ALL ON FUNCTION public.portal_auto_register_candidates(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_auto_register_candidates(timestamptz) TO service_role;

-- ── 4. Riva: switch it on (guarded — a fresh DB has no portal rows) ─────────
UPDATE public.records
   SET data = data || jsonb_build_object('auto_register', true)
 WHERE model_id = '1ead0000-0000-4000-8000-000000000001'
   AND data->>'login_url' = 'https://riva.sa/broker/login'
   AND COALESCE(data->>'otp_channel', 'none') = 'none'
   AND (data->>'auto_register') IS DISTINCT FROM 'true';

COMMIT;
