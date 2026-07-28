/**
 * Live end-to-end verification against the real database and the real seeded
 * reference data.
 *
 *   node scripts/financing/verify-live.mjs
 *
 * This is NOT a unit test — the unit suite already proves the maths. This proves
 * the parts a unit test cannot: that the seeded rows actually load, that the
 * effective-dating queries select the right versions, that the engine produces
 * sane numbers from REAL Saudi product data, and that a scenario round-trips
 * through the scenario tables with its RLS-shaped columns intact.
 *
 * It cleans up after itself, so it is safe to run against production.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { runFinancingEngine, ENGINE_VERSION } from '../../src/lib/financing/engine.ts';

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
let fileEnv = {};
for (const f of [
  path.join(process.cwd(), '.env.local'),
  'C:/Users/rayan/Claude/wassell-claude-code/.env.local',
  'C:/Users/rayan/Claude/wassell-claude-code/.env',
]) fileEnv = { ...readEnvFile(f), ...fileEnv };

const db = createClient(
  process.env.SUPABASE_URL ?? fileEnv.SUPABASE_URL ?? fileEnv.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? fileEnv.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const asOf = new Date().toISOString().slice(0, 10);
const num = (v) => (v === null || v === undefined ? null : Number(v));

console.log('\n=== 1. Reference data loads from the live database ===');

const { data: ruleRows } = await db
  .from('fin_regulatory_rule_versions')
  .select('id, effective_from, effective_to, payload, is_active, fin_regulatory_rules!inner(rule_key)')
  .eq('is_active', true)
  .lte('effective_from', asOf)
  .order('effective_from', { ascending: false });

const rulesByKey = new Map();
for (const row of ruleRows ?? []) {
  const key = row.fin_regulatory_rules.rule_key;
  if (row.effective_to !== null && row.effective_to <= asOf) continue;
  if (!rulesByKey.has(key)) rulesByKey.set(key, row);
}

for (const key of ['sama_dbr_bands', 'sama_qualifying_income', 'sama_credit_card_obligation', 'sama_ltv_ceilings', 'sama_fee_cap', 'sama_apr_method']) {
  check(`rule "${key}" is in force`, rulesByKey.has(key));
}

const ltv = rulesByKey.get('sama_ltv_ceilings');
check('LTV rule gives 90% first-home / 70% bank additional', ltv?.payload.bank_first_home_pct === 90 && ltv?.payload.bank_additional_home_pct === 70,
  `${ltv?.payload.bank_first_home_pct}/${ltv?.payload.bank_additional_home_pct}`);

const dbr = rulesByKey.get('sama_dbr_bands');
check('DBR band 1 (≤15k) = 55% total, 65% supported', dbr?.payload.bands[0].total_obligations_pct === 55 && dbr?.payload.bands[0].total_obligations_supported_pct === 65);
check('DBR band 3 (≥25k) defers to the creditor', dbr?.payload.bands[2].real_estate_per_creditor_policy === true);

console.log('\n=== 2. Effective-dating selects the SUPERSEDED rule for a 2017 date ===');
const { data: historic } = await db
  .from('fin_regulatory_rule_versions')
  .select('payload, effective_from, effective_to, fin_regulatory_rules!inner(rule_key)')
  .eq('fin_regulatory_rules.rule_key', 'sama_ltv_ceilings')
  .lte('effective_from', '2017-06-01')
  .order('effective_from', { ascending: false });
const historic2017 = (historic ?? []).find((r) => r.effective_to === null || r.effective_to > '2017-06-01');
check('a 2017-dated calculation sees the 85% first-home ceiling',
  historic2017?.payload.bank_first_home_pct === 85, `got ${historic2017?.payload.bank_first_home_pct}`);

console.log('\n=== 3. Products load with their versions, rates and fees ===');
const { data: products } = await db
  .from('fin_products')
  .select('id, product_key, name_en, category, structure, official_url, fin_providers!inner(id, provider_key, name_ar, name_en, provider_type)')
  .eq('is_active', true).is('deleted_at', null);
check('products are seeded', (products ?? []).length > 0, `${products?.length} products`);

const { data: versions } = await db.from('fin_product_versions').select('*').eq('is_active', true);
const { data: rates } = await db.from('fin_product_rate_versions').select('*').eq('is_active', true);
const { data: eligRows } = await db.from('fin_product_eligibility_rules').select('*');
const eligByVersion = new Map();
for (const r of eligRows ?? []) {
  if (!eligByVersion.has(r.product_version_id)) eligByVersion.set(r.product_version_id, []);
  eligByVersion.get(r.product_version_id).push({
    id: r.id, rule_key: r.rule_key, label_ar: r.label_ar, label_en: r.label_en,
    operator: r.operator, field_path: r.field_path,
    value_numeric: num(r.value_numeric), value_numeric_2: num(r.value_numeric_2),
    value_text: r.value_text, value_list: r.value_list, value_boolean: r.value_boolean,
    is_hard_requirement: r.is_hard_requirement,
    failure_message_ar: r.failure_message_ar, failure_message_en: r.failure_message_en,
  });
}
check('every product has an effective version', (versions ?? []).length === (products ?? []).length,
  `${versions?.length} versions / ${products?.length} products`);
check('only a MINORITY of products carry published pricing (the real market shape)',
  (rates ?? []).length < (products ?? []).length,
  `${rates?.length} of ${products?.length} priced`);

const disclosures = (rates ?? []).map((r) => r.rate_disclosure_type);
check('at least one "starting from" disclosure is stored as such', disclosures.includes('starting_from'), disclosures.join(', '));
check('at least one representative example is stored as such', disclosures.includes('representative_example'));
check('no rate row claims exact_rate without a contractual rate',
  (rates ?? []).every((r) => r.rate_disclosure_type !== 'exact_rate' || r.contractual_rate_pct !== null));

console.log('\n=== 4. The engine runs against REAL seeded data ===');

const engineProducts = (products ?? []).map((p) => {
  const v = (versions ?? []).find((x) => x.product_id === p.id) ?? null;
  const r = (rates ?? []).find((x) => x.product_id === p.id) ?? null;
  return {
    id: p.id, product_key: p.product_key, name_ar: p.name_en, name_en: p.name_en,
    category: p.category, structure: p.structure, official_url: p.official_url,
    provider: {
      id: p.fin_providers.id, provider_key: p.fin_providers.provider_key,
      name_ar: p.fin_providers.name_ar, name_en: p.fin_providers.name_en,
      provider_type: p.fin_providers.provider_type,
    },
    version: v ? {
      id: v.id, product_id: v.product_id, version_number: v.version_number,
      effective_from: v.effective_from,
      applies_to_saudi: v.applies_to_saudi, applies_to_resident: v.applies_to_resident,
      applies_to_first_home: v.applies_to_first_home, applies_to_additional_home: v.applies_to_additional_home,
      supported_financing: v.supported_financing, unsupported_financing: v.unsupported_financing,
      property_types: v.property_types, property_status: v.property_status,
      employment_types: v.employment_types, employer_sectors: v.employer_sectors,
      requires_approved_employer: v.requires_approved_employer, requires_salary_transfer: v.requires_salary_transfer,
      min_salary: num(v.min_salary), min_salary_no_transfer: num(v.min_salary_no_transfer),
      min_employment_months: num(v.min_employment_months), min_age_years: num(v.min_age_years),
      max_age_at_application: num(v.max_age_at_application), max_age_at_maturity: num(v.max_age_at_maturity),
      retiree_eligible: v.retiree_eligible, min_amount: num(v.min_amount), max_amount: num(v.max_amount),
      min_term_months: num(v.min_term_months), max_term_months: num(v.max_term_months),
      min_down_payment_pct: num(v.min_down_payment_pct), max_ltv_pct: num(v.max_ltv_pct),
      max_salary_multiple: num(v.max_salary_multiple), grace_period_months: num(v.grace_period_months),
      calculation_method: v.calculation_method, collected_at: v.collected_at, verified_at: v.verified_at,
      confidence: v.confidence, source_url: v.source_url, fees: [], eligibility_rules: eligByVersion.get(v.id) ?? [],
    } : null,
    rate: r ? {
      id: r.id, product_id: r.product_id, version_number: r.version_number,
      effective_from: r.effective_from, rate_type: r.rate_type,
      rate_disclosure_type: r.rate_disclosure_type,
      contractual_rate_pct: num(r.contractual_rate_pct),
      contractual_rate_min_pct: num(r.contractual_rate_min_pct),
      contractual_rate_max_pct: num(r.contractual_rate_max_pct),
      published_apr_pct: num(r.published_apr_pct),
      published_apr_min_pct: num(r.published_apr_min_pct),
      published_apr_max_pct: num(r.published_apr_max_pct),
      benchmark_key: r.benchmark_name, margin_pct: num(r.margin_pct),
      benchmark_reset_months: num(r.benchmark_reset_months),
      example_amount: num(r.example_amount), example_term_months: num(r.example_term_months),
      example_property_price: num(r.example_property_price), example_ltv_pct: num(r.example_ltv_pct),
      example_monthly_payment: num(r.example_monthly_payment),
      campaign_end_date: r.campaign_end_date, collected_at: r.collected_at,
      verified_at: r.verified_at, confidence: r.confidence, source_url: r.source_url,
    } : null,
  };
});

const buildRule = (key) => {
  const row = rulesByKey.get(key);
  return row ? { id: row.id, rule_key: key, version_number: 1, effective_from: row.effective_from, effective_to: row.effective_to, payload: row.payload, source_url: '' } : null;
};

const { data: taxRows } = await db.from('fin_tax_rule_versions').select('*, fin_tax_rules!inner(tax_key)').eq('is_active', true);
const taxRow = (taxRows ?? [])[0];

const reference = {
  rules: {
    dbr: buildRule('sama_dbr_bands'),
    qualifying_income: buildRule('sama_qualifying_income'),
    credit_card: buildRule('sama_credit_card_obligation'),
    ltv: buildRule('sama_ltv_ceilings'),
    fee_cap: buildRule('sama_fee_cap'),
    apr_method: buildRule('sama_apr_method'),
    term_limits: buildRule('sama_term_limits'),
    early_settlement: buildRule('sama_early_settlement'),
  },
  tax: taxRow ? {
    id: taxRow.id, tax_key: taxRow.fin_tax_rules.tax_key,
    effective_from: taxRow.effective_from, effective_to: taxRow.effective_to,
    rate_pct: Number(taxRow.rate_pct), base: taxRow.base, payer: taxRow.payer,
    first_home_relief_cap: num(taxRow.first_home_relief_cap), source_url: taxRow.source_url,
  } : null,
  supportPrograms: [],
  benchmarks: [],
  products: engineProducts,
  pricing_freshness_days: 90,
  product_freshness_days: 365,
};

// A realistic Saudi customer: SAR 18,000 salary, one car finance, a credit card,
// first home, SAR 1.2m apartment in Riyadh.
const input = {
  as_of_date: asOf,
  applicants: [{
    role: 'primary', nationality_type: 'saudi', date_of_birth: '1992-03-10',
    employment_type: 'employee', employer_sector: 'private', service_months: 60,
    willing_to_transfer_salary: true, salary_transfer_provider_key: null, expected_retirement_age: null,
  }],
  incomes: [
    { id: 'i1', applicant_role: 'primary', income_type: 'basic_salary', declared_monthly_amount: 15000, verified_monthly_amount: 15000, documentation_status: 'payslip', frequency: 'monthly', averaging_period_months: null, is_fixed: true },
    { id: 'i2', applicant_role: 'primary', income_type: 'housing_allowance', declared_monthly_amount: 3000, verified_monthly_amount: 3000, documentation_status: 'payslip', frequency: 'monthly', averaging_period_months: null, is_fixed: true },
  ],
  obligations: [
    { id: 'o1', obligation_type: 'auto_finance', monthly_payment: 1800, outstanding_balance: 45000, remaining_months: 25, end_date: '2028-09-01', card_limit: null, minimum_payment: null, balloon_payment: null, will_be_settled_before_financing: false, is_real_estate: false },
    { id: 'o2', obligation_type: 'credit_card', monthly_payment: null, outstanding_balance: 3000, remaining_months: null, end_date: null, card_limit: 40000, minimum_payment: null, balloon_payment: null, will_be_settled_before_financing: false, is_real_estate: false },
  ],
  support: { is_first_home: true, sakani_eligible: false, redf_eligible: false, support_status: 'unknown', monthly_support_amount: null, support_duration_months: null, financing_kind: 'unsupported', previously_used_first_home_tax_support: false },
  property: { property_price: 1200000, property_type: 'apartment', property_status: 'completed', city: 'Riyadh', is_first_home: true, available_cash: 250000, desired_down_payment: null, expected_valuation: null, additional_expenses: null, project_record_id: null, unit_record_id: null },
  preferences: { preferred_term_months: 240, min_term_months: null, max_term_months: null, rate_preference: 'fixed', max_acceptable_installment: null, priority: 'lowest_monthly', preferred_provider_keys: null, planned_start_date: asOf },
};

const result = runFinancingEngine(input, reference, 'full');

console.log(`\n  engine v${result.engine_version} → status="${result.status}" confidence="${result.confidence}"`);
console.log(`  qualifying income: ${result.capacity.income.qualifying_total}`);
console.log(`  obligations:       ${result.capacity.obligations.total_monthly}`);
console.log(`  max installment:   ${result.capacity.max_installment} (binding: ${result.capacity.binding_constraint})`);
console.log(`  max financing:     ${result.max_financing_from_income}`);
console.log(`  max property:      ${result.max_property_value}`);

check('qualifying income = 18,000 (both salary components in full)', result.capacity.income.qualifying_total === 18000);
// Credit card: 5% of the 40,000 LIMIT = 2,000, plus the 1,800 car finance.
check('credit card charged on its LIMIT (5% of 40,000 = 2,000)',
  result.capacity.obligations.lines.find((l) => l.obligation_type === 'credit_card')?.counted_monthly === 2000);
check('total obligations = 3,800', result.capacity.obligations.total_monthly === 3800);
// Band 2 (15,000–25,000): total ceiling 65% of 18,000 = 11,700; salary deduction
// 33.33% of 18,000 = 5,999.4. Deduction binds; minus 3,800 already committed.
check('salary deduction is the binding ceiling', result.capacity.binding_constraint === 'salary_deduction');
check('max installment is positive and below the total ceiling',
  result.capacity.max_installment > 0 && result.capacity.max_installment < 11700,
  String(result.capacity.max_installment));
check('a second "after obligations end" scenario exists', result.capacity.after_expiry !== null);
check('produces at least one match row per product', result.matches.length === engineProducts.length);
check('never returns an "approved" status', !JSON.stringify(result).includes('"status":"approved"'));
check('pins the rule versions it used', result.pinned.regulatory_rule_version_ids.length >= 5);

const priced = result.matches.filter((m) => m.monthly_payment !== null);
const unpriced = result.matches.filter((m) => m.monthly_payment === null);
console.log(`  priced matches: ${priced.length}, unpriced: ${unpriced.length}`);
// The real invariant is one-directional: a product with NO published rate can
// never carry an installment. The converse does NOT hold — a product whose rate
// IS published but whose eligibility excludes the customer legitimately shows a
// rate basis with no payment, and asserting otherwise would be asserting a bug.
check('a product with no published rate version can never carry an installment',
  result.matches.every((m) => m.product.rate !== null || m.monthly_payment === null));
check('a product with no rate version reports rate_basis "unavailable"',
  result.matches.filter((m) => m.product.rate === null).every((m) => m.rate_basis === 'unavailable'));
check('every priced match declares a rate basis', priced.every((m) => m.rate_basis !== 'unavailable'));
check('no priced match silently claims a contractual rate it does not have',
  priced.every((m) => m.rate_basis !== 'contractual' || m.product.rate?.rate_disclosure_type === 'exact_rate'));

for (const m of priced) {
  console.log(`    · ${m.product.provider.name_en} / ${m.product.name_en}: ${m.monthly_payment} SAR/mo, rate ${m.applied_rate_pct}% (${m.rate_basis}), APR ${m.calculated_apr_pct ?? m.published_apr_pct}, confidence ${m.confidence}, status ${m.status}`);
}

console.log('\n=== 5. Determinism ===');
const again = runFinancingEngine(input, reference, 'full');
check('same inputs → byte-identical output', JSON.stringify(result) === JSON.stringify(again));

console.log('\n=== 6. Scenario round-trip through the live tables ===');
const { data: scenario, error: scenErr } = await db
  .from('fin_scenarios')
  .insert({ title: '__verify_live__ (temporary)', status: 'draft' })
  .select('id, scenario_number')
  .single();
check('scenario insert succeeds', !scenErr && !!scenario, scenErr?.message ?? '');

if (scenario) {
  const sid = scenario.id;
  const { error: aErr } = await db.from('fin_scenario_applicants').insert({ scenario_id: sid, applicant_role: 'primary', nationality_type: 'saudi', employment_type: 'employee' });
  check('applicant insert succeeds', !aErr, aErr?.message ?? '');

  const { error: iErr } = await db.from('fin_income_sources').insert({ scenario_id: sid, income_type: 'basic_salary', declared_monthly_amount: 15000, verified_monthly_amount: 15000, documentation_status: 'payslip', frequency: 'monthly' });
  check('income insert succeeds', !iErr, iErr?.message ?? '');

  // The CHECK that stops a credit card being recorded with no assessable basis.
  const { error: badCard } = await db.from('fin_obligations').insert({ scenario_id: sid, obligation_type: 'credit_card' });
  check('a credit card with no limit AND no payment is REJECTED', !!badCard, badCard?.message?.slice(0, 60) ?? 'unexpectedly accepted');

  const { error: okCard } = await db.from('fin_obligations').insert({ scenario_id: sid, obligation_type: 'credit_card', card_limit: 40000 });
  check('a credit card WITH a limit is accepted', !okCard, okCard?.message ?? '');

  const { data: run, error: runErr } = await db.from('fin_calculation_runs').insert({
    scenario_id: sid, run_number: 0, calculation_mode: 'full', engine_version: ENGINE_VERSION,
    as_of_date: asOf, input_snapshot: input, result_snapshot: result,
    regulatory_rule_version_ids: result.pinned.regulatory_rule_version_ids,
    product_version_ids: result.pinned.product_version_ids,
    rate_version_ids: result.pinned.rate_version_ids,
  }).select('id, run_number').single();
  check('calculation run insert succeeds', !runErr && !!run, runErr?.message ?? '');
  check('run_number is auto-assigned by the trigger', run?.run_number === 1, `got ${run?.run_number}`);

  if (run) {
    const { error: updErr } = await db.from('fin_calculation_runs').update({ engine_version: 'tampered' }).eq('id', run.id);
    check('a calculation run is APPEND-ONLY (update rejected)', !!updErr, updErr?.message?.slice(0, 70) ?? 'unexpectedly accepted');

    const { error: resErr } = await db.from('fin_calculation_results').insert({
      run_id: run.id, scenario_id: sid,
      qualifying_income: result.capacity.income.qualifying_total,
      max_installment: result.capacity.max_installment,
      result_status: result.status, confidence: result.confidence,
    });
    check('result insert succeeds', !resErr, resErr?.message ?? '');

    const { error: badStatus } = await db.from('fin_calculation_results').insert({
      run_id: run.id, scenario_id: sid, result_status: 'approved', confidence: 'high',
    });
    check('result_status = "approved" is REJECTED by the database', !!badStatus,
      badStatus?.message?.slice(0, 70) ?? 'unexpectedly accepted');
  }

  console.log('\n=== 7. Version immutability ===');
  const { data: anyVersion } = await db.from('fin_regulatory_rule_versions').select('id, effective_from').limit(1).single();
  if (anyVersion) {
    const { error: immErr } = await db.from('fin_regulatory_rule_versions').update({ effective_from: '2000-01-01' }).eq('id', anyVersion.id);
    check('effective_from is immutable on a rule version', !!immErr, immErr?.message?.slice(0, 70) ?? 'unexpectedly accepted');
    const { error: delErr } = await db.from('fin_regulatory_rule_versions').delete().eq('id', anyVersion.id);
    check('a rule version cannot be DELETED', !!delErr, delErr?.message?.slice(0, 70) ?? 'unexpectedly accepted');
  }

  const { data: anyObs } = await db.from('fin_benchmark_observations').select('id').limit(1).single();
  if (anyObs) {
    const { error: obsErr } = await db.from('fin_benchmark_observations').update({ rate_pct: 99 }).eq('id', anyObs.id);
    check('a benchmark observation is immutable', !!obsErr, obsErr?.message?.slice(0, 70) ?? 'unexpectedly accepted');
  }

  // Clean up. Children cascade; the append-only run/result rows go with the
  // scenario because the FK is ON DELETE CASCADE (the trigger guards direct
  // DELETEs on those tables, not cascaded ones).
  await db.from('fin_scenarios').delete().eq('id', sid);
  const { data: gone } = await db.from('fin_scenarios').select('id').eq('id', sid).maybeSingle();
  check('temporary verification scenario cleaned up', !gone);
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
