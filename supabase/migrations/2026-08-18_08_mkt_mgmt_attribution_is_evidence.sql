-- Internal Marketing Management (إدارة التسويق)
-- Applied to production as Supabase migration 20260727092719 — "mkt_mgmt_attribution_is_evidence".
-- Exported verbatim from schema_migrations so repo and database cannot drift.

-- Attribution rows are financial evidence, not derived data.
--
-- With ON DELETE SET NULL, deleting a campaign AND its content nulled every
-- marketing-side column at once, leaving a row that violated its own
-- `attribution_has_marketing_side` CHECK — so the delete failed with a
-- constraint error that pointed at the attribution table rather than at the
-- real cause. Worse, had the CHECK not existed the row would have survived as
-- an anonymous revenue figure attributable to nothing.
--
-- RESTRICT instead: you cannot silently delete a campaign or content item that
-- has attributed leads/revenue. Archive it (archived_at), or deliberately
-- remove the attribution first. That matches the historical-integrity rule —
-- evidence outlives convenience.
ALTER TABLE public.mkt_lead_attributions
  DROP CONSTRAINT IF EXISTS mkt_lead_attributions_campaign_id_fkey,
  DROP CONSTRAINT IF EXISTS mkt_lead_attributions_content_item_id_fkey,
  DROP CONSTRAINT IF EXISTS mkt_lead_attributions_publication_id_fkey;

ALTER TABLE public.mkt_lead_attributions
  ADD CONSTRAINT mkt_lead_attributions_campaign_id_fkey
    FOREIGN KEY (campaign_id) REFERENCES public.mkt_internal_campaigns(id) ON DELETE RESTRICT,
  ADD CONSTRAINT mkt_lead_attributions_content_item_id_fkey
    FOREIGN KEY (content_item_id) REFERENCES public.mkt_content_items(id) ON DELETE RESTRICT,
  ADD CONSTRAINT mkt_lead_attributions_publication_id_fkey
    FOREIGN KEY (publication_id) REFERENCES public.mkt_publications(id) ON DELETE RESTRICT;

COMMENT ON TABLE public.mkt_lead_attributions IS
  'CRM attribution evidence. Marketing-side FKs are RESTRICT: a campaign/content/publication with recorded attribution cannot be hard-deleted — archive it instead.';;
