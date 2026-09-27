-- Link a sent WhatsApp message to the project it is about, so the chat thread can
-- show finder-style action buttons (View details / Add to client options / View
-- units) on a project message. Nothing existing carries this: outbound rows keep
-- a `reference` that is NOT the project id, and `meta` is unused — so the link is
-- recorded EXPLICITLY at send time (the gateway returns the message id) by both
-- the bot (aiSendProject, service-role) and the rep (sendChatMessage → RPC).
-- Going-forward only: old messages have no link and show no buttons.
--
-- Never raises SQLSTATE 40001/40P01 (see CLAUDE.md).

CREATE TABLE IF NOT EXISTS public.chat_message_projects (
  message_wid text PRIMARY KEY,          -- chat_messages.id (WA message id)
  chat_wid    text NOT NULL,             -- conversation wid (thread lookup)
  project_id  uuid NOT NULL,             -- all_projects (master) record id
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_message_projects_chat ON public.chat_message_projects(chat_wid);

ALTER TABLE public.chat_message_projects ENABLE ROW LEVEL SECURITY;

-- Staff-only app: any authenticated user who can see the chats can read the link.
-- (chat_messages themselves are already visible to authenticated staff.) Writes
-- go through the SECURITY DEFINER RPC below, so no INSERT policy is granted.
DROP POLICY IF EXISTS chat_message_projects_select ON public.chat_message_projects;
CREATE POLICY chat_message_projects_select ON public.chat_message_projects
  FOR SELECT TO authenticated USING (true);

-- Upsert one link. SECURITY DEFINER so both the rep (authenticated) and the bot
-- (service_role) can record it without a table-level INSERT grant. Idempotent:
-- re-linking the same message is a no-op update.
CREATE OR REPLACE FUNCTION public.link_message_project(
  p_message_wid text, p_chat_wid text, p_project_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF coalesce(p_message_wid,'') = '' OR coalesce(p_chat_wid,'') = '' OR p_project_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.chat_message_projects (message_wid, chat_wid, project_id)
  VALUES (p_message_wid, p_chat_wid, p_project_id)
  ON CONFLICT (message_wid) DO UPDATE SET project_id = EXCLUDED.project_id;
END $$;

REVOKE ALL ON FUNCTION public.link_message_project(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_message_project(text, text, uuid) TO authenticated, service_role;
