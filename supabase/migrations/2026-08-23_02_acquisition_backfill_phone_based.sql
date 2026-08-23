-- ============================================================================
-- Client marketing acquisition — phone-based backfill (2026-08-23, follow-up)
--
-- Supersedes the client_link-based backfill in 2026-08-23_01. That backfill
-- keyed acquisition rows off the chat record's `data->>'client_link'`, which
-- the SPA/gateway rewrites over time — so a chat that was NOT linked at the
-- instant the first migration ran (or whose ad message predates the app code
-- deploy) was silently skipped. Live example: client CLT-0010 came from ad
-- mena52-V3 yet had no acquisition row, so the «كيف وصلنا هذا العميل» panel
-- was blank.
--
-- This catch-up matches on the PHONE instead — `find_client_id_by_phone`, the
-- SAME matcher the live webhook (mos_capture_ad_acquisition) uses, which is
-- robust to client_link being wiped. It attributes EXISTING clients only (it
-- does NOT create historical clients — that is the live webhook's job on the
-- next real ad inbound). Idempotent: NOT EXISTS on (client, ad).
--
-- Already run by hand on wassell-prod when the miss was found; re-applying is a
-- no-op there. Included so fresh environments / CI replay get the same result.
-- ============================================================================
BEGIN;

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
CROSS JOIN LATERAL (
  SELECT public.find_client_id_by_phone(m.from_phone) AS client_id
) cl
WHERE m.flow = 'in'
  AND m.meta->'ad'->'resolved' IS NOT NULL
  AND jsonb_typeof(m.meta->'ad'->'resolved') = 'object'
  AND m.from_phone IS NOT NULL
  AND cl.client_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.client_attributions e
    WHERE e.client_record_id = cl.client_id
      AND e.ad_id IS NOT DISTINCT FROM NULLIF(m.meta->'ad'->'resolved'->>'ad_id','')::uuid
  )
ORDER BY cl.client_id, (m.meta->'ad'->'resolved'->>'ad_id'), m.date ASC;

COMMIT;
