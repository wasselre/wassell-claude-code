-- Tracked links: a units-list link can carry a CHOSEN set of units — the rep's
-- filtered selection in the units window, or the units the sales agent found
-- for the customer. The units page then shows only those (still limited to
-- units that are available when the customer opens it). NULL = every available
-- unit of the project, as before. Backward compatible: one nullable column.

ALTER TABLE public.tracked_links ADD COLUMN IF NOT EXISTS unit_ids uuid[];
