-- Marketing OS — GOAL success measures: a goal now carries the SAME multi-measure
-- success criteria as a campaign (2026-08-09).
--
-- Same storage shape as mos_campaigns.success_measures: a jsonb array of
--   { type_key, label_ar, label_en, direction, unit, source, threshold }
-- rows, snapshotted from the mos_measure_types registry at save time so a later
-- rename/archive never rewrites history and every read renders without a join.
-- The first row is the MAIN measure (what the card headlines).
--
-- Unlike campaigns there is NO back-compat scalar pair (goals never had one),
-- and no live-actuals rollup — a goal's measures are targets; progress reads
-- come later if ever needed.
--
-- Additive, idempotent (safe to re-run).

BEGIN;

ALTER TABLE public."mos_goals"
  ADD COLUMN IF NOT EXISTS "success_measures" jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
