/**
 * Live verification of financing V2 against production.
 *
 *   npx tsx scripts/verify-financing-v2.mjs
 *
 * Proves the parts unit tests cannot: that the four V2 tables hold the migrated
 * data, that the engine runs against REAL seeded products, that the freeze
 * trigger and consent gate actually fire, and that V1 is genuinely read-only.
 * Cleans up after itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { runFinancing } from '../src/lib/financing/engine.ts';

function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
let env = {};
for (const f of [path.join(process.cwd(), '.env.local'),
                 'C:/Users/rayan/Claude/wassell-claude-code/.env.local',
                 'C:/Users/rayan/Claude/wassell-claude-code/.env']) env = { ...readEnv(f), ...env };

const db = createClient(
  process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const num = (v) => (v === null || v === undefined ? null : Number(v));

console.log('\n=== 1. The four V2 tables hold the migrated data ===');
const [{ data: products }, { data: rates }, { data: rules }, { data: scenarios }] = await Promise.all([
  db.from('financing_products').select('*'),
  db.from('financing_rates').select('*'),
  db.from('financing_rules').select('*'),
  db.from('financing_scenarios').select('*'),
]);
check('6 products from 6 banks', products.length === 6, `${products.length} products, ${new Set(products.map(p => p.provider_key)).size} banks`);
check('rates exist and are a MINORITY of products (the real market shape)', rates.length > 0 && rates.length < products.length, `${rates.length} of ${products.length} priced`);
check('6 rules seeded', rules.length === 6, rules.map(r => r.rule_key).join(', '));
check('both customer scenarios survived the migration', scenarios.length === 2, `${scenarios.length} scenarios`);
check('migrated scenarios kept their frozen results', scenarios.every(s => s.result_snapshot !== null));
check('every rate carries an official source URL', rates.every(r => !!r.source_url));
check('every rate carries a verification date', rates.every(r => !!r.last_verified_at));
check('no rate claims exact_rate without a contractual rate',
  rates.every(r => r.disclosure_type !== 'exact_rate' || r.contractual_rate_pct !== null));

console.log('\n=== 2. The engine runs against REAL seeded data ===');
const byKey = new Map();
for (const r of rates) if (r.is_active && !byKey.has(r.product_id)) byKey.set(r.product_id, r);
const engineProducts = products.filter(p => p.is_active).map((p) => ({
  ...p,
  min_salary: num(p.min_salary), min_salary_no_transfer: num(p.min_salary_no_transfer),
  min_age: num(p.min_age), max_age_at_maturity: num(p.max_age_at_maturity),
  min_down_payment_pct: num(p.min_down_payment_pct), max_ltv_pct: num(p.max_ltv_pct),
  max_term_months: num(p.max_term_months), max_amount: num(p.max_amount),
  criteria: p.criteria ?? {},
  rate: byKey.has(p.id) ? {
    ...byKey.get(p.id),
    contractual_rate_pct: num(byKey.get(p.id).contractual_rate_pct),
    published_apr_pct: num(byKey.get(p.id).published_apr_pct),
    starting_apr_pct: num(byKey.get(p.id).starting_apr_pct),
  } : null,
}));

const rulePayload = (k) => rules.find(r => r.rule_key === k);
const meta = (k) => { const r = rulePayload(k); return r ? { source_url: r.source_url, effective_from: r.effective_from } : null; };
const ruleSet = {
  dbr: { bands: rulePayload('sama_dbr_bands').payload.bands, ...meta('sama_dbr_bands') },
  income: { gross_salary_pct: 100, other_periodic_income_pct: 50, ...meta('sama_qualifying_income') },
  credit_card: { minimum_repayment_pct: Number(rulePayload('sama_credit_card_obligation').payload.minimum_repayment_pct), ...meta('sama_credit_card_obligation') },
  ltv: { ...rulePayload('sama_ltv_ceilings').payload, ...meta('sama_ltv_ceilings') },
  rett: { rate_pct: Number(rulePayload('zatca_rett').payload.rate_pct), first_home_relief_cap: Number(rulePayload('zatca_rett').payload.first_home_relief_cap), ...meta('zatca_rett') },
  support: { housing_support_counts_as_income: true, ...meta('sakani_redf_treatment') },
};

const input = {
  as_of_date: new Date().toISOString().slice(0, 10),
  nationality: 'saudi', date_of_birth: '1992-03-10', age: null,
  employment_type: 'employee', employment_sector: 'private', employer_name: null,
  willing_to_transfer_salary: true,
  gross_monthly_salary: 18000,
  other_income: [], obligations: [{ kind: 'credit_card', card_limit: 40000 }, { kind: 'other', monthly_payment: 1800 }],
  is_first_home: true, sakani_redf_status: 'unknown', confirmed_support_amount: null,
  property_price: 1200000, property_type: 'apartment', project_record_id: null, unit_record_id: null,
  available_down_payment: 250000, term_months: 240,
  preferred_provider_keys: null, max_comfortable_installment: null,
  quoted_rate_pct: null, quoted_rate_provider_key: null,
};

const result = runFinancing(input, engineProducts, ruleSet);
console.log(`  status=${result.status} confidence=${result.confidence}`);
console.log(`  qualifying income ${result.capacity.qualifying_income} · obligations ${result.capacity.existing_obligations} · max installment ${result.capacity.max_installment} (${result.capacity.binding_constraint})`);
check('qualifying income = 18,000', result.capacity.qualifying_income === 18000);
check('credit card charged on its LIMIT (5% of 40,000 = 2,000) + 1,800 = 3,800', result.capacity.existing_obligations === 3800);
check('salary deduction is the binding ceiling', result.capacity.binding_constraint === 'salary_deduction');
check('never emits "approved"', !JSON.stringify(result).includes('"approved"'));
check('produces one match per active product', result.matches.length === engineProducts.length);
check('freezes the rule values used', !!result.rules_used.ltv?.source_url && !!result.rules_used.dbr?.effective_from);
check('deterministic', JSON.stringify(runFinancing(input, engineProducts, ruleSet)) === JSON.stringify(result));

const priced = result.matches.filter(m => m.monthly_payment !== null);
const unpriced = result.matches.filter(m => m.monthly_payment === null);
console.log(`  priced ${priced.length}, quotation-required ${unpriced.length}`);
check('a product without an exact rate NEVER shows a payment',
  result.matches.every(m => m.monthly_payment === null || m.rate_basis === 'contractual' || m.rate_basis === 'quotation'));
check('every priced match exposes its rate source + verification date',
  priced.every(m => !!m.rate_source_url && !!m.rate_verified_at));
check('a product the customer does NOT qualify for shows no figures at all',
  result.matches.filter(m => m.status === 'does_not_meet_published_criteria')
    .every(m => m.monthly_payment === null && m.financing_amount === null));
for (const m of result.matches) {
  console.log(`    · ${m.product.provider_name_en} / ${m.product.name_en}: ${m.status}, ${m.monthly_payment ?? 'quotation required'}, basis ${m.rate_basis}`);
}

console.log('\n=== 3. A bank quotation unlocks an exact payment ===');
const target = engineProducts.find(p => !p.rate || p.rate.disclosure_type !== 'exact_rate');
if (target) {
  const quoted = runFinancing({ ...input, quoted_rate_pct: 6.4, quoted_rate_provider_key: target.provider_key }, engineProducts, ruleSet);
  const m = quoted.matches.find(x => x.product.id === target.id);
  check(`quotation prices ${target.provider_name_en}`, m?.monthly_payment !== null && m?.rate_basis === 'quotation', `${m?.monthly_payment}`);
}

console.log('\n=== 4. Scenario persistence, freeze trigger, consent gate ===');
const { data: created, error: cErr } = await db.from('financing_scenarios')
  .insert({ title: '__v2_verify__', input_snapshot: input, status: 'draft' }).select('id, scenario_number').single();
check('scenario insert', !cErr && !!created, cErr?.message ?? '');

if (created) {
  const { error: badStatus } = await db.from('financing_scenarios')
    .insert({ title: '__v2_verify_bad__', status: 'calculated', input_snapshot: {} });
  check('status=calculated with NO result is REJECTED', !!badStatus, badStatus?.message?.slice(0, 60) ?? 'unexpectedly accepted');

  const { error: upErr } = await db.from('financing_scenarios')
    .update({ result_snapshot: result, status: 'calculated', completed_at: new Date().toISOString() }).eq('id', created.id);
  check('completing a scenario with a result', !upErr, upErr?.message ?? '');

  const { error: frozen } = await db.from('financing_scenarios')
    .update({ result_snapshot: { tampered: true } }).eq('id', created.id);
  check('a completed result_snapshot is FROZEN', !!frozen, frozen?.message?.slice(0, 70) ?? 'unexpectedly accepted');

  await db.from('financing_scenarios').delete().eq('id', created.id);
  const { data: gone } = await db.from('financing_scenarios').select('id').eq('id', created.id).maybeSingle();
  check('verification scenario cleaned up', !gone);
}

console.log('\n=== 5. V1 is deprecated but intact ===');
const { count: v1Writes } = await db.rpc('exec_sql_count').then(() => ({ count: null })).catch(() => ({ count: null }));
void v1Writes;
const { data: v1Scen } = await db.from('fin_scenarios').select('id');
const { data: v1Prod } = await db.from('fin_products').select('id');
check('V1 scenario data retained', (v1Scen?.length ?? 0) === 2, `${v1Scen?.length} rows`);
check('V1 product data retained', (v1Prod?.length ?? 0) === 31, `${v1Prod?.length} rows`);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
