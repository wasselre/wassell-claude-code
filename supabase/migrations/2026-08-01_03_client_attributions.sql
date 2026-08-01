-- ============================================================================
-- Marketing OS — client attributions: the immutable ledger that ties a CRM
-- client to the marketing spend object that brought them in, plus the
-- effective-row view and the campaign outcome derivation.
--
-- Runs AFTER 2026-08-01_02_mos_domain_batch.sql (reads mos_settings.attribution).
--
-- WHY IMMUTABLE, AND HOW THAT IS ENFORCED
-- An attribution ledger you can edit is an attribution ledger nobody trusts.
-- Corrections are made by APPENDING a new row whose supersedes_id points at
-- the row it corrects — the old row stays, the audit trail stays. Enforced
-- three deep: (1) RLS grants no UPDATE and no DELETE policy, so authenticated
-- callers simply cannot; (2) a BEFORE UPDATE OR DELETE trigger raises
-- MOS:ATTRIBUTION_IMMUTABLE, which also binds service-role code paths that
-- bypass RLS; (3) client_attributions_effective hides superseded rows so
-- readers see the corrected state by default.
--
-- WHY client_record_id HAS NO FK
-- It references records.id of the CRM client row — but frozen models move
-- their rows OUT of the unified `records` table into dedicated tables, which
-- would break a hard FK (and cascading deletes would silently eat the
-- ledger). Same posture as mos_content.project_id.
--
-- Idempotent: re-running is a no-op.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. client_attributions — append-only ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.client_attributions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- records.id of the CRM client. NO FK on purpose: frozen models move rows
  -- out of `records` into their own tables, and a hard FK (plus cascade)
  -- would either break on freeze or silently delete ledger rows.
  client_record_id  uuid NOT NULL,
  -- RESTRICT on all three spend objects: deleting a campaign/execution/ad
  -- must never take the attribution ledger down with it.
  campaign_id       uuid REFERENCES public.mos_campaigns(id)           ON DELETE RESTRICT,
  execution_id      uuid REFERENCES public.mos_campaign_executions(id) ON DELETE RESTRICT,
  ad_id             uuid REFERENCES public.mos_execution_ads(id)       ON DELETE RESTRICT,
  touch_type        text NOT NULL DEFAULT 'first',
  occurred_at       timestamptz NOT NULL,
  source            text NOT NULL,
  note              text,
  -- Audited corrections APPEND a new row pointing at the row they correct.
  supersedes_id     uuid REFERENCES public.client_attributions(id),
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- At least one spend object must be named, or the row attributes nothing.
  CHECK (campaign_id IS NOT NULL OR execution_id IS NOT NULL OR ad_id IS NOT NULL)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_attributions_touch_check') THEN
    ALTER TABLE public.client_attributions ADD CONSTRAINT client_attributions_touch_check
      CHECK (touch_type IN ('first','last'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_attributions_source_check') THEN
    ALTER TABLE public.client_attributions ADD CONSTRAINT client_attributions_source_check
      CHECK (source IN ('lead_form','manual','import'));
  END IF;
END $$;

COMMENT ON TABLE public.client_attributions IS
  'Append-only ledger linking CRM clients to marketing spend objects. Never '
  'updated or deleted — corrections append a superseding row. See header.';

CREATE INDEX IF NOT EXISTS idx_client_attributions_client    ON public.client_attributions(client_record_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_client_attributions_campaign  ON public.client_attributions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_client_attributions_execution ON public.client_attributions(execution_id);
CREATE INDEX IF NOT EXISTS idx_client_attributions_ad        ON public.client_attributions(ad_id);
CREATE INDEX IF NOT EXISTS idx_client_attributions_supersedes ON public.client_attributions(supersedes_id);

ALTER TABLE public.client_attributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_attributions_read ON public.client_attributions;
CREATE POLICY client_attributions_read ON public.client_attributions
  FOR SELECT TO authenticated
  USING (public.wassell_mos_can('read'));

DROP POLICY IF EXISTS client_attributions_ins ON public.client_attributions;
CREATE POLICY client_attributions_ins ON public.client_attributions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.wassell_mos_can('enter_metrics')
    OR public.wassell_mos_can('approve_budget')
  );

-- NO UPDATE and NO DELETE policies (immutability layer 1) ...

-- ... and layer 2: a trigger that also binds service-role code, which
-- bypasses RLS. Belt and braces.
CREATE OR REPLACE FUNCTION public.mos_tg_attribution_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'MOS:ATTRIBUTION_IMMUTABLE — client_attributions is append-only; correct by inserting a row with supersedes_id';
END $$;

DROP TRIGGER IF EXISTS client_attributions_immutable_tg ON public.client_attributions;
CREATE TRIGGER client_attributions_immutable_tg
  BEFORE UPDATE OR DELETE ON public.client_attributions
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_attribution_immutable();

-- ---------------------------------------------------------------------------
-- 2. client_attributions_effective — the correction chain, resolved
-- ---------------------------------------------------------------------------
-- The latest state of the ledger: every row that no other row supersedes.
-- Readers default to this view; the raw table is the audit trail.

CREATE OR REPLACE VIEW public.client_attributions_effective
WITH (security_invoker = true) AS
SELECT a.*
FROM public.client_attributions a
WHERE NOT EXISTS (
  SELECT 1 FROM public.client_attributions b WHERE b.supersedes_id = a.id
);

COMMENT ON VIEW public.client_attributions_effective IS
  'Attribution ledger with superseded (corrected) rows hidden. This is the '
  'default read surface; the base table is the full audit trail.';

-- ---------------------------------------------------------------------------
-- 3. mos_campaign_outcomes — what did this campaign actually produce?
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: CRM records are read through unified_records,
-- so the CALLER's record-level RLS decides which outcomes are visible — an
-- agent sees outcomes only for records they may see.
--
-- CRM model ids (unfrozen: JSONB rows read via unified_records):
--   appointments  b032a675-6237-4436-9783-a1a253855f74
--     data->>'appointment_status', data->>'appointment_date', data->>'client_id'
--   visits        372ed642-3753-40b4-9dd7-e8390f91b1f8
--     data->>'scheduled_datetime', data->>'client_id'
--     (the visits model has NO status field — every in-window visit counts)
--   reservations  5a1e0ffe-0000-4000-8000-000000000002
--     data->>'reservation_amount', data->>'reservation_date',
--     data->>'payment_status', data->>'client_id'
--     (the live reservations model has NO cancelled state, so the
--      exclude_cancelled setting currently excludes nothing here;
--      appointments DO honor it — see the NOT IN filter below)

CREATE OR REPLACE FUNCTION public.mos_campaign_outcomes(p_campaign_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $function$
WITH cfg AS (
  SELECT
    COALESCE(
      (SELECT (value->>'window_days')::int
         FROM public.mos_settings WHERE key = 'attribution'), 90)      AS window_days,
    COALESCE(
      (SELECT (value->>'exclude_cancelled')::boolean
         FROM public.mos_settings WHERE key = 'attribution'), true)    AS exclude_cancelled
),
attributed AS (
  -- Effective FIRST-touch rows for this campaign: linked to the campaign
  -- directly, to one of its executions, or to an ad of one of its executions.
  SELECT a.client_record_id, a.occurred_at
  FROM public.client_attributions_effective a
  WHERE a.touch_type = 'first'
    AND (
      a.campaign_id = p_campaign_id
      OR a.execution_id IN (
        SELECT e.id FROM public.mos_campaign_executions e
        WHERE e.campaign_id = p_campaign_id)
      OR a.ad_id IN (
        SELECT ad.id FROM public.mos_execution_ads ad
        JOIN public.mos_campaign_executions e ON e.id = ad.execution_id
        WHERE e.campaign_id = p_campaign_id)
    )
),
-- Unique attributed clients; the CRM link is data->>'client_id' = records.id::text.
clients AS (
  SELECT DISTINCT client_record_id FROM attributed
),
appt AS (
  SELECT DISTINCT r.id
  FROM public.unified_records r
  JOIN attributed a ON a.client_record_id::text = r.data->>'client_id'
  CROSS JOIN cfg
  WHERE r.model_id = 'b032a675-6237-4436-9783-a1a253855f74'::uuid
    AND public.try_timestamptz(r.data->>'appointment_date')
          BETWEEN a.occurred_at
              AND a.occurred_at + make_interval(days => cfg.window_days)
    -- Appointments honor exclude_cancelled (see header note).
    AND (NOT cfg.exclude_cancelled
         OR r.data->>'appointment_status' NOT IN ('cancelled','no_show'))
),
vis AS (
  SELECT DISTINCT r.id
  FROM public.unified_records r
  JOIN attributed a ON a.client_record_id::text = r.data->>'client_id'
  CROSS JOIN cfg
  WHERE r.model_id = '372ed642-3753-40b4-9dd7-e8390f91b1f8'::uuid
    AND public.try_timestamptz(r.data->>'scheduled_datetime')
          BETWEEN a.occurred_at
              AND a.occurred_at + make_interval(days => cfg.window_days)
),
res AS (
  SELECT DISTINCT r.id, public.try_numeric(r.data->>'reservation_amount') AS amount
  FROM public.unified_records r
  JOIN attributed a ON a.client_record_id::text = r.data->>'client_id'
  CROSS JOIN cfg
  WHERE r.model_id = '5a1e0ffe-0000-4000-8000-000000000002'::uuid
    AND public.try_timestamptz(r.data->>'reservation_date')
          BETWEEN a.occurred_at
              AND a.occurred_at + make_interval(days => cfg.window_days)
)
SELECT jsonb_build_object(
  'attributed_clients', (SELECT count(*) FROM clients),   -- unique clients
  'appointments',       (SELECT count(*) FROM appt),      -- event count
  'visits',             (SELECT count(*) FROM vis),       -- event count (no status on the model)
  'reservations',       (SELECT count(*) FROM res),       -- unique events
  'reservation_value',  (SELECT COALESCE(sum(amount), 0) FROM res),
  'window_days',        (SELECT window_days FROM cfg),
  'touch',              'first',
  'computed_at',        now()
);
$function$;

GRANT EXECUTE ON FUNCTION public.mos_campaign_outcomes(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Validation — the immutability trigger must exist before we commit
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'client_attributions_immutable_tg'
      AND tgrelid = 'public.client_attributions'::regclass
  ) THEN
    RAISE EXCEPTION 'MOS:IMMUTABILITY_TRIGGER_MISSING — client_attributions_immutable_tg was not created';
  END IF;
END $$;

COMMIT;
