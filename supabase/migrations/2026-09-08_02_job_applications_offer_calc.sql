-- Job applications — offer cost-calculator inputs (2026-09-08, follow-up)
-- ============================================================================
-- The offer card now projects what a candidate would cost us per month/year:
--
--   company commission per sale = avg sale price × company commission %
--   rep commission per sale     = company commission per sale × rep commission %
--   monthly commission          = rep commission per sale × sales per month
--   monthly cost                = base salary + monthly commission
--
-- The rep's % (`offer_commission`) and salary already live on the row; these
-- three columns persist the scenario assumptions so the projection (and the
-- generated offer PDF) is reproducible from any browser. All nullable; the UI
-- falls back to defaults (1,250,000 SAR / 2.5 %) when unset.
-- ============================================================================

ALTER TABLE public.job_applications
  ADD COLUMN IF NOT EXISTS offer_sales_per_month        numeric,  -- expected closed sales / month
  ADD COLUMN IF NOT EXISTS offer_avg_sale_price         numeric,  -- SAR, average unit sale price assumed
  ADD COLUMN IF NOT EXISTS offer_company_commission_pct numeric;  -- % of sale price the COMPANY earns

COMMENT ON COLUMN public.job_applications.offer_sales_per_month        IS 'Scenario input: expected closed sales per month for the cost projection.';
COMMENT ON COLUMN public.job_applications.offer_avg_sale_price         IS 'Scenario input: average unit sale price (SAR) assumed in the cost projection.';
COMMENT ON COLUMN public.job_applications.offer_company_commission_pct IS 'Scenario input: % of the sale price the company earns as commission (rep % applies to this).';
