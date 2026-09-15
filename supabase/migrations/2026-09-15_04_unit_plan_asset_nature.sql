-- «أصلي» (real) means the image came out of a CAMERA. A floor plan is a drawing
-- and never did. 4,605 unit plans carried asset_nature='real'.
--
-- Root cause (fixed the same day in worker/src/runEnrichmentJob.ts): the
-- enrichment prompt handed the model a bare list of labels for primary_category
-- and asset_nature, while acquisition_source / production_state / usage_rights
-- each carried an explicit «استدلّ: … → …» rule. The two most consequential
-- fields were the only ones with no decision rule.
--
-- This UPDATE is deterministic — it depends on the category, not on the pixels —
-- so it needs no re-read. The separate design-vs-raw_photo question DOES need
-- one and is deliberately left alone here.
-- Pre-change values: public._backup_unit_plan_nature_20260915.
UPDATE public.files
   SET asset_nature = 'graphic_design', updated_at = now()
 WHERE primary_category = 'unit_plan' AND asset_nature = 'real';
