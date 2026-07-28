-- WA-03 — scope WhatsApp message visibility to the conversations a user may see.
--
-- chat_messages had ONE policy: `SELECT USING (true)` for every authenticated
-- user. All customer message bodies — prices, negotiations, personal details,
-- shared locations — were readable by anyone with a login, plus a live Realtime
-- feed of new ones, while `records` (the conversation itself) enforced
-- scope-evaluating policies. The list was scoped; the contents were not.
--
-- Concretely at the time of the fix: one ACTIVE non-admin user had
-- view_scope_class 'none' on the chats model — unable to open a single
-- conversation in the UI — and could still read all 2,959 messages.
--
-- The rule is "the messages of the chats you can see": an EXISTS against
-- `records`, which carries its own RLS, so this composes with the existing
-- scope engine instead of duplicating it.
--
-- Fast path first: wassell_view_scope_class returns 'all' for admins and any
-- profile without a filtered view_scope, 'none' for no access — decided once
-- per statement with no per-row work. Only a 'filtered' profile pays per row.
--
-- Measured on production data before applying (EXPLAIN ANALYZE inside a
-- rolled-back transaction, 50-row thread page):
--   fast path ('all')            7.3 ms — subplan never executed
--   forced worst case (EXISTS)  10.5 ms — 50 loops of a records PK lookup
--
-- Verified after applying, per real user under the authenticated role:
--   5 users, scope 'all'  → 2,959 messages / 16 AI replies (unchanged)
--   1 user,  scope 'none' →     0 messages /  0 AI replies (was: everything)
--
-- Realtime: Supabase evaluates RLS per subscriber for postgres_changes, so this
-- scopes the live feed too. Deliberately NOT solved in the UI.

CREATE OR REPLACE FUNCTION public.wassell_chat_scope_class()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
  SELECT public.wassell_view_scope_class(
           (SELECT auth.uid()),
           (SELECT id FROM public.models WHERE name = 'chats' LIMIT 1))
$$;

COMMENT ON FUNCTION public.wassell_chat_scope_class() IS
  'WA-03: the caller''s view-scope class for the chats model, as a per-statement fast path for WhatsApp RLS.';

DROP POLICY IF EXISTS chat_messages_select ON public.chat_messages;
CREATE POLICY chat_messages_select ON public.chat_messages
  FOR SELECT TO authenticated
  USING (
    CASE public.wassell_chat_scope_class()
      WHEN 'all'  THEN true
      WHEN 'none' THEN false
      ELSE EXISTS (SELECT 1 FROM public.records r WHERE r.id = chat_messages.conversation_record_id)
    END
  );

DROP POLICY IF EXISTS whatsapp_ai_replies_select ON public.whatsapp_ai_replies;
CREATE POLICY whatsapp_ai_replies_select ON public.whatsapp_ai_replies
  FOR SELECT TO authenticated
  USING (
    CASE public.wassell_chat_scope_class()
      WHEN 'all'  THEN true
      WHEN 'none' THEN false
      ELSE EXISTS (
        SELECT 1 FROM public.records r
        JOIN public.models m ON m.id = r.model_id AND m.name = 'chats'
        WHERE r.data->>'wid' = whatsapp_ai_replies.chat_wid)
    END
  );

DROP POLICY IF EXISTS whatsapp_ai_sessions_select ON public.whatsapp_ai_sessions;
CREATE POLICY whatsapp_ai_sessions_select ON public.whatsapp_ai_sessions
  FOR SELECT TO authenticated
  USING (
    CASE public.wassell_chat_scope_class()
      WHEN 'all'  THEN true
      WHEN 'none' THEN false
      ELSE EXISTS (
        SELECT 1 FROM public.records r
        JOIN public.models m ON m.id = r.model_id AND m.name = 'chats'
        WHERE r.data->>'wid' = whatsapp_ai_sessions.chat_wid)
    END
  );
