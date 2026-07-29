-- APPLIED TO PRODUCTION 2026-08-30 as migration `financing_v2_data_migration`.
-- Recorded here so the repo matches the database. NOT IDEMPOTENT — it INSERTs
-- rows; re-running it would duplicate the products, rules and scenarios. Check
-- `supabase_migrations.schema_migrations` before applying anywhere.
--
-- Move V1 data into V2. Nothing is deleted; V1 keeps its rows until the
-- separate cleanup plan runs.

-- ── Rules: 8 versioned rules -> 7 current rules ────────────────────────────
-- fee_cap and early_settlement are dropped as RULES because V2 does not compute
-- an APR (so the fee cap has no consumer) and does not model settlement.
INSERT INTO public.financing_rules (rule_key, label_ar, label_en, payload, source_url, citation, effective_from, last_verified_at)
SELECT r.rule_key, r.label_ar, r.label_en, v.payload, v.source_url, v.citation_ref, v.effective_from, CURRENT_DATE
FROM public.fin_regulatory_rules r
JOIN LATERAL (
  SELECT * FROM public.fin_regulatory_rule_versions vv
  WHERE vv.rule_id = r.id AND vv.is_active AND vv.effective_to IS NULL
  ORDER BY vv.effective_from DESC LIMIT 1
) v ON true
WHERE r.rule_key IN ('sama_dbr_bands','sama_qualifying_income','sama_credit_card_obligation','sama_ltv_ceilings')
ON CONFLICT (rule_key) DO NOTHING;

-- RETT arrives from the tax table, reshaped into the same rule envelope so the
-- engine reads ONE rules source instead of three.
INSERT INTO public.financing_rules (rule_key, label_ar, label_en, payload, source_url, citation, effective_from, last_verified_at)
SELECT 'zatca_rett', t.name_ar, t.name_en,
       jsonb_build_object('kind','rett','rate_pct', v.rate_pct,
                          'first_home_relief_cap', v.first_home_relief_cap,
                          'payer', v.payer),
       v.source_url, v.citation_ref, v.effective_from, CURRENT_DATE
FROM public.fin_tax_rules t
JOIN LATERAL (SELECT * FROM public.fin_tax_rule_versions vv
              WHERE vv.tax_rule_id = t.id AND vv.is_active
              ORDER BY vv.effective_from DESC LIMIT 1) v ON true
WHERE t.tax_key = 'rett'
ON CONFLICT (rule_key) DO NOTHING;

-- Sakani/REDF treatment as a compact rule. Amounts stay NULL — they were never
-- collectable from an official source and inventing one is the thing V1 refused
-- to do. V2 keeps that refusal.
INSERT INTO public.financing_rules (rule_key, label_ar, label_en, payload, source_url, citation, effective_from, last_verified_at)
VALUES ('sakani_redf_treatment', 'معالجة الدعم السكني وصندوق التنمية العقارية',
        'Sakani / REDF treatment',
        jsonb_build_object(
          'kind','support_treatment',
          'housing_support_counts_as_income', true,
          'supported_raises_total_dbr_ceiling', true,
          'published_amounts_available', false,
          'note','Documented MoH/REDF support may be counted in total monthly income for real-estate finance (SAMA Art. 14c), and a supported beneficiary gets the higher total-obligations ceiling (Art. 15c). Published subsidy AMOUNTS could not be collected from an official source and must not be quoted.'),
        'https://rulebook.sama.gov.sa/en/chapter-iv-quantitative-principles-responsible-lending',
        'SAMA Responsible Lending Principles, Arts. 14(c) and 15(c)',
        '2018-05-17', CURRENT_DATE)
ON CONFLICT (rule_key) DO NOTHING;

-- ── Products: 31 -> the focused set from six named banks ───────────────────
-- Selection rule: one flagship residential product per bank, preferring the
-- variant with the most complete published eligibility. Quality over coverage.
INSERT INTO public.financing_products (
  provider_key, provider_name_ar, provider_name_en, provider_type,
  product_key, name_ar, name_en, is_active,
  supported_financing, property_types, nationality, employment_sectors,
  min_salary, min_salary_no_transfer, min_age, max_age_at_maturity,
  requires_salary_transfer, first_home_applicable, additional_home_applicable,
  min_down_payment_pct, max_ltv_pct, max_term_months, max_amount,
  criteria, official_url, last_verified_at, notes, confidence)
SELECT
  pr.provider_key, pr.name_ar, pr.name_en,
  CASE WHEN pr.provider_type = 'real_estate_finance_company'
       THEN 'real_estate_finance_company' ELSE 'bank' END,
  p.product_key, p.name_ar, p.name_en, true,
  CASE WHEN pv.supported_financing IS TRUE AND pv.unsupported_financing IS FALSE THEN 'supported'
       WHEN pv.unsupported_financing IS TRUE AND pv.supported_financing IS FALSE THEN 'unsupported'
       ELSE 'both' END,
  pv.property_types,
  CASE WHEN pv.applies_to_saudi IS TRUE AND pv.applies_to_resident IS TRUE THEN ARRAY['saudi','resident']
       WHEN pv.applies_to_saudi IS TRUE  AND COALESCE(pv.applies_to_resident,false) IS FALSE THEN ARRAY['saudi']
       WHEN pv.applies_to_resident IS TRUE AND COALESCE(pv.applies_to_saudi,false) IS FALSE THEN ARRAY['resident']
       ELSE NULL END,
  pv.employer_sectors,
  pv.min_salary, pv.min_salary_no_transfer, pv.min_age_years, pv.max_age_at_maturity,
  pv.requires_salary_transfer, pv.applies_to_first_home, pv.applies_to_additional_home,
  pv.min_down_payment_pct, pv.max_ltv_pct, pv.max_term_months, pv.max_amount,
  COALESCE(jsonb_strip_nulls(jsonb_build_object(
    'min_employment_months', pv.min_employment_months,
    'required_documents', to_jsonb(pv.required_documents),
    'structure', p.structure,
    'category', p.category)), '{}'::jsonb),
  p.official_url, CURRENT_DATE, pv.conditions_notes, pv.confidence
FROM public.fin_products p
JOIN public.fin_providers pr ON pr.id = p.provider_id
JOIN LATERAL (SELECT * FROM public.fin_product_versions v
              WHERE v.product_id = p.id AND v.is_active
              ORDER BY v.effective_from DESC LIMIT 1) pv ON true
WHERE (pr.provider_key, p.product_key) IN (
  ('alrajhi','home_finance'),
  ('riyad','readymade_property'),
  ('bsf','ready_units'),
  ('albilad','subsidised_home'),
  ('alinma','ready_unit'),
  ('snb','__none__')            -- SNB publishes no usable product detail; see notes below
)
ON CONFLICT (provider_key, product_key) DO NOTHING;

-- SAB's REDF-subsidised product carries the most complete published pricing of
-- any product collected, so it takes the sixth slot instead of SNB, which
-- publishes no residential eligibility or pricing at all.
INSERT INTO public.financing_products (
  provider_key, provider_name_ar, provider_name_en, provider_type,
  product_key, name_ar, name_en, is_active, supported_financing,
  min_down_payment_pct, max_ltv_pct, criteria, official_url, last_verified_at, notes, confidence)
SELECT pr.provider_key, pr.name_ar, pr.name_en, 'bank',
       p.product_key, p.name_ar, p.name_en, true, 'supported',
       pv.min_down_payment_pct, pv.max_ltv_pct,
       jsonb_build_object('structure', p.structure, 'category', p.category),
       p.official_url, CURRENT_DATE, pv.conditions_notes, pv.confidence
FROM public.fin_products p
JOIN public.fin_providers pr ON pr.id = p.provider_id
JOIN LATERAL (SELECT * FROM public.fin_product_versions v
              WHERE v.product_id = p.id AND v.is_active
              ORDER BY v.effective_from DESC LIMIT 1) pv ON true
WHERE pr.provider_key = 'sab' AND p.product_key = 'home_equity_redf_subsidised'
ON CONFLICT (provider_key, product_key) DO NOTHING;

-- ── Rates for the products that carry one ──────────────────────────────────
INSERT INTO public.financing_rates (
  product_id, disclosure_type, rate_type, contractual_rate_pct,
  published_apr_pct, starting_apr_pct, example,
  effective_from, source_url, last_verified_at, confidence, notes)
SELECT np.id,
  CASE rv.rate_disclosure_type
    WHEN 'exact_rate' THEN 'exact_rate'
    WHEN 'representative_example' THEN 'representative_example'
    WHEN 'starting_from' THEN 'starting_from'
    ELSE 'quotation_required' END,
  CASE WHEN rv.rate_type = 'variable' THEN 'variable' ELSE 'fixed' END,
  rv.contractual_rate_pct,
  CASE WHEN rv.rate_disclosure_type = 'representative_example' THEN rv.published_apr_pct END,
  CASE WHEN rv.rate_disclosure_type = 'starting_from' THEN rv.published_apr_pct END,
  jsonb_strip_nulls(jsonb_build_object(
    'property_price', rv.example_property_price,
    'ltv_pct', rv.example_ltv_pct,
    'term_months', rv.example_term_months,
    'monthly_payment', rv.example_monthly_payment,
    'note', rv.rate_assumptions)),
  rv.effective_from, rv.source_url, CURRENT_DATE, rv.confidence, rv.applicability_notes
FROM public.fin_product_rate_versions rv
JOIN public.fin_products p  ON p.id = rv.product_id
JOIN public.fin_providers pr ON pr.id = p.provider_id
JOIN public.financing_products np
  ON np.provider_key = pr.provider_key AND np.product_key = p.product_key
WHERE rv.is_active;

-- ── Scenarios: carry the REAL customer rows across ─────────────────────────
-- Child tables collapse into input_snapshot; the V1 run's frozen result becomes
-- result_snapshot. These two rows are live customer work and must survive.
INSERT INTO public.financing_scenarios (
  id, title, client_record_id, project_record_id, unit_record_id,
  status, owner_user_id, assigned_user_id, created_by_user_id,
  input_snapshot, result_snapshot, calculation_version,
  consent_to_share, consent_recorded_at, consent_recorded_by_user_id,
  created_at, completed_at)
SELECT
  s.id, NULLIF(s.title,''), s.client_record_id, s.project_record_id, s.unit_record_id,
  CASE s.status WHEN 'converted' THEN 'converted'
                WHEN 'archived'  THEN 'archived'
                WHEN 'draft'     THEN 'draft'
                ELSE 'calculated' END,
  s.owner_user_id, s.assigned_specialist_user_id, s.created_by_user_id,
  COALESCE(run.input_snapshot, '{}'::jsonb),
  run.result_snapshot,
  run.engine_version,
  s.consent_to_share_with_provider, s.consent_recorded_at, s.consent_recorded_by_user_id,
  s.created_at,
  CASE WHEN run.id IS NOT NULL THEN run.created_at END
FROM public.fin_scenarios s
LEFT JOIN LATERAL (
  SELECT * FROM public.fin_calculation_runs r
  WHERE r.scenario_id = s.id AND r.status = 'completed'
  ORDER BY r.run_number DESC LIMIT 1
) run ON true
WHERE s.deleted_at IS NULL
ON CONFLICT (id) DO NOTHING;

-- Any scenario that never completed keeps status 'draft' so the
-- calculated_has_result CHECK holds.
UPDATE public.financing_scenarios SET status = 'draft'
WHERE result_snapshot IS NULL AND status NOT IN ('draft','archived');

SELECT
  (SELECT count(*) FROM financing_products)  AS products,
  (SELECT count(*) FROM financing_rates)     AS rates,
  (SELECT count(*) FROM financing_rules)     AS rules,
  (SELECT count(*) FROM financing_scenarios) AS scenarios;
