-- ============================================================================
-- One message per old lead (operator, 2026-10-05).
--
-- The AI's ordinary follow-up drafts (up to 30 a day) were also being written
-- for campaign leads whose campaign day is still ahead — 25 of 27 drafts in the
-- queue on 2026-10-05 were for leads due 6–8 October, so each would have had
-- a message today AND their campaign message on their day.
--
-- 1. ai_followup_candidates: the ordinary pass skips any lead still 'planned'
--    (day not reached). Re-emitted from 2026-10-05_13 with only that condition.
-- 2. The pending ordinary drafts for those leads are expired (kept, visible).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.ai_followup_candidates(p_limit int DEFAULT 10, p_campaign boolean DEFAULT NULL)
 RETURNS TABLE (followup_id uuid, client_id uuid, chat_wid text, chat_record_id uuid, attempt int, due_at timestamptz, campaign text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH m AS (
    SELECT (SELECT id FROM public.models WHERE name = 'followups' LIMIT 1) AS followups,
           (SELECT id FROM public.models WHERE name = 'chats' LIMIT 1)     AS chats
  ), f AS (
    SELECT r.id,
           (r.data->>'client_id')::uuid AS client_id,
           COALESCE(NULLIF(r.data->>'whatsapp_attempt_number', '')::int, 1) AS attempt,
           public.try_timestamptz(r.data->>'scheduled_datetime') AS due,
           NULLIF(r.data->>'campaign_message', '') AS campaign
      FROM public.records r, m
     WHERE r.model_id = m.followups
       AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') = 'open'
       AND COALESCE(r.data->>'whatsapp_state', '') = ''
       AND COALESCE(r.data->>'sent_at', '') = ''
       AND ( (jsonb_typeof(r.data->'followup_type') = 'array'  AND r.data->'followup_type' ? 'whatsapp_follow_up')
          OR (jsonb_typeof(r.data->'followup_type') = 'string' AND r.data->>'followup_type' = 'whatsapp_follow_up') )
       AND r.data->>'client_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND public.try_timestamptz(r.data->>'scheduled_datetime') <= now()
       AND (p_campaign IS NULL
            OR (p_campaign AND COALESCE(r.data->>'campaign_message', '') <> '')
            OR (NOT p_campaign AND COALESCE(r.data->>'campaign_message', '') = ''))
  )
  SELECT f.id, f.client_id, ch.wid, ch.id, f.attempt, f.due, f.campaign
    FROM f
    CROSS JOIN m
    JOIN public.records cl ON cl.id = f.client_id
    JOIN LATERAL (
      SELECT c.id, c.data->>'wid' AS wid, c.data AS cdata
        FROM public.records c
       WHERE c.model_id = m.chats AND c.data->>'client_link' = f.client_id::text AND COALESCE(c.data->>'wid', '') <> ''
       ORDER BY c.updated_at DESC
       LIMIT 1
    ) ch ON true
   WHERE COALESCE(cl.data->>'client_stage', '') NOT IN ('خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار', 'طلب غير مجاب')
     AND COALESCE(ch.cdata->>'ai_paused', 'false') <> 'true'
     AND NOT EXISTS (SELECT 1 FROM public.ai_actions a
                      WHERE a.kind = 'followup_message' AND a.followup_id = f.id AND a.round_key = f.attempt::text)
     AND EXISTS (SELECT 1 FROM public.chat_messages mi WHERE mi.chat_wid = ch.wid AND mi.flow = 'in')
     AND (f.campaign IS NOT NULL OR
          (SELECT ml.flow FROM public.chat_messages ml
            WHERE ml.chat_wid = ch.wid AND ml.kind NOT IN ('reaction', 'call_log', 'e2e_notification', 'notification', 'notification_template', 'revoked')
            ORDER BY ml.date DESC LIMIT 1) IS DISTINCT FROM 'in')
     AND NOT EXISTS (SELECT 1 FROM public.chat_messages mr WHERE mr.chat_wid = ch.wid AND mr.date > now() - interval '2 hours')
     AND (f.campaign IS NOT NULL OR NOT EXISTS (
       SELECT 1 FROM public.records t
        WHERE t.model_id = m.followups
          AND t.data->>'client_id' = f.client_id::text
          AND COALESCE(NULLIF(t.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
          AND ( t.data->'followup_type' ?| ARRAY['appointment_booking_call', 'no_show_recovery_call']
             OR t.data->>'followup_type' IN ('appointment_booking_call', 'no_show_recovery_call') )))
     -- A campaign lead whose day has not come yet gets NO ordinary follow-up:
     -- their campaign message is their next message (operator, 2026-10-05).
     AND (f.campaign IS NOT NULL OR NOT EXISTS (
       SELECT 1 FROM public.sales_campaign_leads l
        WHERE l.client_id = f.client_id AND l.status = 'planned'))
   ORDER BY (f.campaign IS NOT NULL) DESC, f.due ASC
   LIMIT GREATEST(1, LEAST(p_limit, 50));
$function$;

UPDATE public.ai_actions a
   SET status = 'expired', updated_at = now(),
       error = 'old-lead campaign: this client gets their campaign message on their day instead'
  FROM public.sales_campaign_leads l
 WHERE a.status = 'pending' AND a.kind = 'followup_message'
   AND a.context->>'campaign' IS NULL
   AND l.client_id = a.client_id AND l.status = 'planned';

COMMIT;
