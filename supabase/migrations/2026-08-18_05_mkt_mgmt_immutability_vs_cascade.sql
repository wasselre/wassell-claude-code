-- Internal Marketing Management (إدارة التسويق)
-- Applied to production as Supabase migration 20260727092334 — "mkt_mgmt_immutability_vs_cascade".
-- Exported verbatim from schema_migrations so repo and database cannot drift.

-- Immutability guards must not make the parent undeletable.
--
-- Postgres deletes the parent row first, THEN fires FK cascades — so inside a
-- child's BEFORE DELETE trigger the parent is already gone. That distinguishes
-- the two cases exactly:
--   parent still present → somebody is tampering with history/versions directly → BLOCK
--   parent already gone  → this is the cascade cleaning up → ALLOW
-- UPDATE stays blocked unconditionally; rewriting history is never legitimate.
CREATE OR REPLACE FUNCTION public.mkt_tg_history_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'mkt_content_status_history is append-only — status history is never rewritten'
      USING ERRCODE='check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mkt_content_items i WHERE i.id = OLD.content_item_id) THEN
    RAISE EXCEPTION 'status history cannot be deleted while its content item exists (archive the item instead)'
      USING ERRCODE='check_violation';
  END IF;
  RETURN OLD;   -- cascade cleanup
END $$;

DROP TRIGGER IF EXISTS mkt_history_immutable_tg ON public.mkt_content_status_history;
CREATE TRIGGER mkt_history_immutable_tg
  BEFORE UPDATE OR DELETE ON public.mkt_content_status_history
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_history_append_only();

CREATE OR REPLACE FUNCTION public.mkt_tg_version_no_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF OLD.is_locked
     AND EXISTS (SELECT 1 FROM public.mkt_content_items i WHERE i.id = OLD.content_item_id) THEN
    RAISE EXCEPTION 'approved/published version % (%) cannot be deleted — supersede it instead',
      OLD.version_number, OLD.version_type USING ERRCODE='check_violation';
  END IF;
  RETURN OLD;
END $$;;
