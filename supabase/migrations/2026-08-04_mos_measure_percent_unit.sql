-- Marketing OS — allow a success measure's UNIT to be a percentage.
--
-- Success measures already carry a `unit` of 'count' (a bare number) or
-- 'currency' (riyals). The UI now also offers 'percent' (renders "٪ أو أكثر" /
-- "% or more"), so the CHECK constraint on `mos_measure_types.unit` must accept
-- it. Widen-only: existing rows are all 'count'/'currency' and stay valid.
--
-- The per-campaign snapshot (`mos_campaigns.success_measures[].unit`) is a jsonb
-- value with no DB constraint — the API sanitizer is its gate — so nothing to
-- alter there.
--
-- Additive, idempotent (safe to re-run).

BEGIN;

ALTER TABLE public."mos_measure_types"
  DROP CONSTRAINT IF EXISTS "mos_measure_types_unit_chk";

ALTER TABLE public."mos_measure_types"
  ADD CONSTRAINT "mos_measure_types_unit_chk"
  CHECK (unit IN ('count', 'currency', 'percent'));

COMMIT;
