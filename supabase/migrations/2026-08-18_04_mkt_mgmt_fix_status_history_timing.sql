-- Internal Marketing Management (إدارة التسويق)
-- Applied to production as Supabase migration 20260727092238 — "mkt_mgmt_fix_status_history_timing".
-- Exported verbatim from schema_migrations so repo and database cannot drift.

-- BEFORE-INSERT could not write history: the parent row does not exist yet, so
-- the FK on mkt_content_status_history fails on every content insert. Split the
-- concerns — validation must stay BEFORE (it has to be able to reject the write),
-- history must be AFTER (the parent must exist to reference).
CREATE OR REPLACE FUNCTION public.mkt_tg_content_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT public.mkt_content_status_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'invalid content status transition: % -> % (content %)',
        OLD.status, NEW.status, OLD.content_number USING ERRCODE='check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_tg_content_status_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO public.mkt_content_status_history(content_item_id, from_status, to_status, changed_by_user_id, reason)
    VALUES (NEW.id, NULL, NEW.status,
            COALESCE(NEW.created_by_user_id, public.wassell_app_user_id(auth.uid())), 'created');
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.mkt_content_status_history(content_item_id, from_status, to_status, changed_by_user_id, reason)
    VALUES (NEW.id, OLD.status, NEW.status, public.wassell_app_user_id(auth.uid()),
            NULLIF(current_setting('wassell.status_reason', true),''));
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS mkt_content_status_tg ON public.mkt_content_items;
CREATE TRIGGER mkt_content_status_tg
  BEFORE INSERT OR UPDATE ON public.mkt_content_items
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_content_status();

DROP TRIGGER IF EXISTS mkt_content_status_history_tg ON public.mkt_content_items;
CREATE TRIGGER mkt_content_status_history_tg
  AFTER INSERT OR UPDATE ON public.mkt_content_items
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_content_status_history();;
