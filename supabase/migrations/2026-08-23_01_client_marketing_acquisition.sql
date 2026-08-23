-- ============================================================================
-- Client marketing acquisition (2026-08-23)
--
-- Turns the dormant `client_attributions` ledger (2026-08-01) into a live
-- acquisition/source system that ties every ad-sourced client to the marketing
-- Ad that brought them in — WITHOUT copying marketing data onto the client. The
-- Ad remains the hub (mos_resolve_ad → content / project / ad set / execution /
-- campaign / platform); the ledger stores only ids + when + how.
--
-- Conceptually:  Client → Acquisition (ledger row) → Ad → Marketing hierarchy.
--
-- This migration:
--   1. Adds `channel` (paid_ad | organic | referral | direct | other) so the
--      same ledger later carries non-paid sources, and relaxes the
--      spend-object CHECK so only paid_ad rows must name an ad/execution/campaign.
--   2. mos_capture_ad_acquisition() — the WEBHOOK entry point: find-or-create the
--      client by canonical phone, tag its source Promotion (ترويج), and append a
--      first/last-touch paid_ad ledger row. SECURITY DEFINER (service role).
--   3. mos_client_acquisition() — the SALES read surface: resolves a client's
--      effective ledger rows LIVE through the Ad to a simple, useful shape
--      (channel, platform, campaign, project, ad, content, offer, when). Gated on
--      the caller being allowed to VIEW the client (NOT on a marketing role), so
--      a sales rep with no MOS capability can still see their own lead's origin.
--   4. Backfills first-touch rows for existing ad-resolved conversations that are
--      already linked to a client (does NOT resurrect historical leads as new
--      clients — that is the live webhook path's job).
--
-- Backward-compatible: additive column + new functions + additive backfill on a
-- ledger nothing reads yet. Safe to apply before the app code ships.
-- Idempotent: re-running is a no-op.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. channel column + channel-aware spend-object CHECK
-- ---------------------------------------------------------------------------

ALTER TABLE public.client_attributions
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'paid_ad';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_attributions_channel_check') THEN
    ALTER TABLE public.client_attributions ADD CONSTRAINT client_attributions_channel_check
      CHECK (channel IN ('paid_ad','organic','referral','direct','other'));
  END IF;
END $$;

-- The original CHECK (`client_attributions_check`) demanded a spend object on
-- EVERY row. That is right for paid ads but wrong for organic/referral/direct,
-- which have no ad. Replace it with a channel-aware one.
ALTER TABLE public.client_attributions DROP CONSTRAINT IF EXISTS client_attributions_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_attributions_channel_spend_check') THEN
    ALTER TABLE public.client_attributions ADD CONSTRAINT client_attributions_channel_spend_check
      CHECK (channel <> 'paid_ad'
             OR campaign_id IS NOT NULL OR execution_id IS NOT NULL OR ad_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_client_attributions_channel ON public.client_attributions(channel);

COMMENT ON COLUMN public.client_attributions.channel IS
  'Acquisition channel: paid_ad | organic | referral | direct | other. '
  'paid_ad rows MUST name a spend object (ad/execution/campaign); others need not.';

-- The effective view was defined `SELECT a.*` BEFORE `channel` existed, and a
-- view's column list is frozen at creation — so it does not expose the new
-- column until re-expanded. CREATE OR REPLACE re-runs `a.*` and appends channel.
CREATE OR REPLACE VIEW public.client_attributions_effective
WITH (security_invoker = true) AS
SELECT a.*
FROM public.client_attributions a
WHERE NOT EXISTS (
  SELECT 1 FROM public.client_attributions b WHERE b.supersedes_id = a.id
);

-- ---------------------------------------------------------------------------
-- 2. mos_capture_ad_acquisition — webhook find-or-create + tag + attribute
-- ---------------------------------------------------------------------------
-- Called by api/webhook/waha.ts on an inbound message that resolved to one of
-- our paid ads (chat_messages.meta.ad.resolved). Runs BEFORE the chat is bumped,
-- so the client exists + is matchable in time for reconcile_inbound_whatsapp to
-- create the "your turn" follow-up task (the normal sales process kicks off).
--
-- SECURITY DEFINER: it creates a client and reads across all clients regardless
-- of the caller's RLS — the caller is the service-role webhook.
CREATE OR REPLACE FUNCTION public.mos_capture_ad_acquisition(
  p_phone          text,
  p_resolved       jsonb,
  p_occurred_at    timestamptz DEFAULT now(),
  p_suggested_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_clients_model uuid;
  v_client_id     uuid;
  v_ad_id         uuid := NULLIF(p_resolved->>'ad_id','')::uuid;
  v_exec_id       uuid := NULLIF(p_resolved->>'execution_id','')::uuid;
  v_camp_id       uuid := NULLIF(p_resolved->>'campaign_id','')::uuid;
  v_touch         text;
  v_name          text;
  v_note          text;
BEGIN
  IF p_phone IS NULL OR public.ksa_phone_canon(p_phone) IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_clients_model FROM public.models WHERE name = 'clients' LIMIT 1;
  IF v_clients_model IS NULL THEN RETURN NULL; END IF;

  -- Find-or-create the client by canonical phone (the matcher the app uses).
  v_client_id := public.find_client_id_by_phone(p_phone);

  IF v_client_id IS NULL THEN
    v_client_id := gen_random_uuid();
    v_name := COALESCE(NULLIF(btrim(p_suggested_name), ''), regexp_replace(p_phone, '[^0-9+]', '', 'g'));
    INSERT INTO public.records (id, model_id, data, created_by_user_id)
    VALUES (v_client_id, v_clients_model,
      jsonb_build_object(
        'client_name',     v_name,
        'phone_number',    p_phone,
        'client_stage',    'جديد',
        'client_sources',  jsonb_build_array('ترويج'),
        'creation_source', 'ad_inbound'
      ), NULL);
  ELSE
    -- Existing client → ensure the Promotion source tag is present (additive).
    UPDATE public.records
       SET data = jsonb_set(data, '{client_sources}',
             COALESCE(data->'client_sources','[]'::jsonb) || jsonb_build_array('ترويج'))
     WHERE id = v_client_id
       AND NOT (COALESCE(data->'client_sources','[]'::jsonb) ? 'ترويج');
  END IF;

  -- Append the acquisition row — only when a spend object resolved, and only
  -- once per (client, ad). first-touch iff the client has no prior effective row.
  IF v_ad_id IS NOT NULL OR v_exec_id IS NOT NULL OR v_camp_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_attributions_effective e
      WHERE e.client_record_id = v_client_id
        AND ( (v_ad_id   IS NOT NULL AND e.ad_id        = v_ad_id)
           OR (v_ad_id   IS NULL AND v_exec_id IS NOT NULL AND e.execution_id = v_exec_id)
           OR (v_ad_id   IS NULL AND v_exec_id IS NULL AND v_camp_id IS NOT NULL AND e.campaign_id = v_camp_id) )
    ) THEN
      SELECT CASE WHEN EXISTS (
               SELECT 1 FROM public.client_attributions_effective e
               WHERE e.client_record_id = v_client_id
             ) THEN 'last' ELSE 'first' END
        INTO v_touch;
      v_note := left(concat_ws(' · ',
                  NULLIF(p_resolved->>'campaign_name',''),
                  NULLIF(p_resolved->>'ad_name','')), 500);
      INSERT INTO public.client_attributions
        (client_record_id, campaign_id, execution_id, ad_id, touch_type,
         occurred_at, source, channel, note, created_by_user_id)
      VALUES
        (v_client_id, v_camp_id, v_exec_id, v_ad_id, v_touch,
         p_occurred_at, 'lead_form', 'paid_ad', v_note, NULL);
    END IF;
  END IF;

  RETURN v_client_id;
END; $$;

REVOKE ALL ON FUNCTION public.mos_capture_ad_acquisition(text, jsonb, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mos_capture_ad_acquisition(text, jsonb, timestamptz, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. mos_client_acquisition — the Sales read surface (live-resolved)
-- ---------------------------------------------------------------------------
-- Returns a client's effective acquisition rows, each resolved LIVE through the
-- Ad to the marketing hierarchy — nothing is stored on the client. Gated on the
-- caller being allowed to VIEW the client (not on a marketing capability), so a
-- sales rep sees their own lead's origin. SECURITY DEFINER because it reads the
-- ledger (marketing-RLS-gated) and the marketing tables on the caller's behalf.
CREATE OR REPLACE FUNCTION public.mos_client_acquisition(p_client_record_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rec public.records%ROWTYPE;
  v_out jsonb;
BEGIN
  -- Visibility gate. clients is unfrozen (JSONB in records); fetch the row and
  -- run the same evaluator the record RLS uses. Fail closed.
  SELECT * INTO v_rec FROM public.records WHERE id = p_client_record_id;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
  IF public.wassell_can_view_record(auth.uid(), v_rec) IS NOT TRUE THEN
    RAISE EXCEPTION 'MOS:ACQUISITION_FORBIDDEN — not permitted to view this client';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.occurred_at), '[]'::jsonb)
    INTO v_out
  FROM (
    SELECT
      e.id,
      e.occurred_at,
      e.touch_type,
      e.channel,
      e.source,
      e.note,
      ex.platform                                   AS platform,
      e.ad_id,
      ad.label                                      AS ad_name,
      s.name                                        AS ad_set_name,
      COALESCE(e.execution_id, ad.execution_id)     AS execution_id,
      ex.label                                      AS execution_label,
      COALESCE(e.campaign_id, ex.campaign_id)       AS campaign_id,
      c.name                                        AS campaign_name,
      c.offer                                       AS offer,
      COALESCE(c.project_id, NULLIF(c.project_ids->>0,'')::uuid) AS project_id,
      pr.data->>'project_name'                      AS project_name,
      COALESCE(ad.content_id, ex.content_id)        AS content_id,
      co.title                                      AS content_title
    FROM public.client_attributions_effective e
    LEFT JOIN public.mos_execution_ads       ad ON ad.id = e.ad_id
    LEFT JOIN public.mos_ad_sets             s  ON s.id  = ad.ad_set_id
    LEFT JOIN public.mos_campaign_executions ex ON ex.id = COALESCE(e.execution_id, ad.execution_id)
    LEFT JOIN public.mos_campaigns           c  ON c.id  = COALESCE(e.campaign_id, ex.campaign_id)
    LEFT JOIN public.mos_content             co ON co.id = COALESCE(ad.content_id, ex.content_id)
    LEFT JOIN public.unified_records         pr ON pr.id = COALESCE(c.project_id, NULLIF(c.project_ids->>0,'')::uuid)
    WHERE e.client_record_id = p_client_record_id
  ) t;

  RETURN v_out;
END; $$;

REVOKE ALL ON FUNCTION public.mos_client_acquisition(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mos_client_acquisition(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Backfill — existing ad-resolved conversations already linked to a client
-- ---------------------------------------------------------------------------
-- One first-touch paid_ad row per (linked client, ad), taken from the EARLIEST
-- message that resolved that ad. Only touches conversations already linked to a
-- client — historical leads are not resurrected as new clients here.
INSERT INTO public.client_attributions
  (client_record_id, campaign_id, execution_id, ad_id, touch_type,
   occurred_at, source, channel, note, created_by_user_id)
SELECT DISTINCT ON (cl.client_id, (m.meta->'ad'->'resolved'->>'ad_id'))
  cl.client_id,
  NULLIF(m.meta->'ad'->'resolved'->>'campaign_id','')::uuid,
  NULLIF(m.meta->'ad'->'resolved'->>'execution_id','')::uuid,
  NULLIF(m.meta->'ad'->'resolved'->>'ad_id','')::uuid,
  'first',
  m.date,
  'lead_form',
  'paid_ad',
  left(concat_ws(' · ',
    NULLIF(m.meta->'ad'->'resolved'->>'campaign_name',''),
    NULLIF(m.meta->'ad'->'resolved'->>'ad_name','')), 500),
  NULL
FROM public.chat_messages m
JOIN public.records ch
  ON ch.id = m.conversation_record_id
 AND ch.model_id = (SELECT id FROM public.models WHERE name = 'chats')
CROSS JOIN LATERAL (SELECT NULLIF(ch.data->>'client_link','')::uuid AS client_id) cl
WHERE m.meta->'ad'->'resolved' IS NOT NULL
  AND jsonb_typeof(m.meta->'ad'->'resolved') = 'object'
  AND ch.data->>'client_link' ~* '^[0-9a-f-]{36}$'
  AND cl.client_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.client_attributions e
    WHERE e.client_record_id = cl.client_id
      AND e.ad_id IS NOT DISTINCT FROM NULLIF(m.meta->'ad'->'resolved'->>'ad_id','')::uuid
  )
ORDER BY cl.client_id, (m.meta->'ad'->'resolved'->>'ad_id'), m.date ASC;

-- ---------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_attributions_channel_spend_check') THEN
    RAISE EXCEPTION 'channel-aware spend CHECK was not created';
  END IF;
  IF to_regprocedure('public.mos_capture_ad_acquisition(text, jsonb, timestamptz, text)') IS NULL THEN
    RAISE EXCEPTION 'mos_capture_ad_acquisition was not created';
  END IF;
  IF to_regprocedure('public.mos_client_acquisition(uuid)') IS NULL THEN
    RAISE EXCEPTION 'mos_client_acquisition was not created';
  END IF;
END $$;

COMMIT;
