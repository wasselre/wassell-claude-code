-- Partial expression indexes for the Sales Assistant's market_listings AREA
-- pre-filter (api/_lib/matchAgent.ts → matchProjectsCore → loadMarketByFilter,
-- which queries unified_records with `.in('data->>district_lookup'|'city_lookup', ids)`).
--
-- Without these, the filtered read nested-loop-scanned all ~46k market rows per
-- recommendation in created_at order (~624ms on the first page, OFFSET-compounding
-- to many seconds for dense areas). With them the planner index-scans only the
-- matching rows then sorts once (~70ms/page, flat across pages — measured live
-- on the النرجس case: 16,871 in-area listings).
--
-- Partial = scoped to the market_listings model id so the indexes stay small and
-- never touch other models' rows. market_listings is UNFROZEN (lives in `records`).
--
-- Applied to wassell-prod via the management API on 2026-06-27 (this file records
-- it for reproducibility / other environments). Idempotent.
CREATE INDEX IF NOT EXISTS idx_records_market_district_lookup
  ON public.records ((data->>'district_lookup'))
  WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede';

CREATE INDEX IF NOT EXISTS idx_records_market_city_lookup
  ON public.records ((data->>'city_lookup'))
  WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede';
