-- Conversation cards only from recent chats (2026-10-10): an old AI reading is
-- not a decision to put in front of the agent today. Filtering in SQL keeps a
-- backlog of old ready readings from crowding the newest ones out of the page.
CREATE OR REPLACE FUNCTION public.next_step_conversation_candidates(p_quiet_minutes int, p_limit int DEFAULT 30)
RETURNS SETOF public.chat_outcome_suggestions
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.* FROM public.chat_outcome_suggestions s
   WHERE s.status = 'ready'
     AND s.followup_id IS NOT NULL
     AND s.suggested_outcome IS NOT NULL
     AND s.last_message_at <= now() - make_interval(mins => GREATEST(p_quiet_minutes, 1))
     AND s.last_message_at > now() - interval '3 days'
     AND NOT EXISTS (SELECT 1 FROM public.next_step_reviews v
                      WHERE v.status = 'pending' AND v.suggestion_id = s.id)
   ORDER BY s.last_message_at ASC
   LIMIT GREATEST(1, LEAST(p_limit, 100));
$function$;
REVOKE ALL ON FUNCTION public.next_step_conversation_candidates(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_step_conversation_candidates(int, int) TO service_role;
