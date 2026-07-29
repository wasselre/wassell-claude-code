/**
 * POST /api/financing
 *
 * The Saudi real-estate financing calculator's single action-dispatch endpoint.
 *
 * AUTH POSTURE — every call runs on the CALLER'S JWT, never service-role.
 * Customer financial data (salaries, debts, card limits) is the most sensitive
 * data in this application, and the `fin_*` RLS policies are the authorization
 * boundary: a user who cannot see a scenario physically cannot read its income
 * rows, its results, or its cash flows, even by calling this endpoint directly
 * with a hand-made request. There is no service-role escape hatch here.
 *
 * WHY THE ENGINE RUNS SERVER-SIDE: the calculation must be reproducible and
 * auditable. Running it in the browser would mean the stored result was
 * whatever the client chose to send, and a stale bundle would silently produce
 * numbers from an old rule set. The browser sends INPUTS; the server reads the
 * effective-dated reference data, runs the deterministic engine, and writes an
 * immutable run with the version ids it pinned.
 *
 * Actions
 *   dashboard          → recent scenarios, queues, data health
 *   reference          → providers/products/rules for the admin + comparison UI
 *   scenario_list      → scenarios, filterable by client/project/unit
 *   scenario_get       → one scenario with all its child rows + latest result
 *   scenario_save      → create/update a scenario and its children (draft-safe)
 *   scenario_delete    → soft delete
 *   scenario_duplicate → copy a scenario for a what-if
 *   calculate          → run the engine, persist an immutable run + result
 *   convert_to_case    → create a `financing` CRM record from a scenario
 *   admin_*            → reference-data governance (admin only, via RLS)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { runFinancingEngine, ENGINE_VERSION } from '../src/lib/financing/engine.js';
import type {
  EngineInput,
  EngineReference,
  ProductRef,
  RuleSet,
  SupportProgramVersion,
  TaxRuleVersion,
} from '../src/lib/financing/types.js';

export const config = { runtime: 'edge' };

/** The `financing` CRM model — the conversion target. */
const FINANCING_MODEL_ID = '5a1e0ffe-0000-4000-8000-000000000003';

/** Freshness policy. Pricing ages far faster than a regulation. */
const PRICING_FRESHNESS_DAYS = 90;
const PRODUCT_FRESHNESS_DAYS = 365;

/** Columns a caller may set on a scenario. Anything not listed here — ids,
 *  consent stamps, conversion links — is set by the server or not at all. */
const SCENARIO_EDITABLE = [
  'title', 'client_record_id', 'client_model_id', 'project_record_id', 'unit_record_id',
  'offer_record_id', 'reservation_record_id', 'status', 'is_preferred',
  'assigned_specialist_user_id', 'wizard_step', 'wizard_state', 'notes',
] as const;

const APPLICANT_EDITABLE = [
  'applicant_role', 'display_name', 'nationality_type', 'date_of_birth', 'gender',
  'marital_status', 'dependants_count', 'city_of_residence', 'employment_type',
  'employer_sector', 'employer_name', 'employer_classification', 'job_title',
  'employment_start_date', 'service_months', 'military_rank', 'retirement_date',
  'expected_retirement_age', 'salary_transfer_bank_provider_id', 'salary_transfer_bank_name',
  'willing_to_transfer_salary', 'preferred_provider_ids', 'has_declared_credit_issues',
  'credit_issues_note',
] as const;

const INCOME_EDITABLE = [
  'applicant_id', 'income_type', 'label', 'declared_monthly_amount', 'verified_monthly_amount',
  'documentation_status', 'frequency', 'averaging_period_months', 'is_fixed', 'notes',
] as const;

const OBLIGATION_EDITABLE = [
  'applicant_id', 'obligation_type', 'provider_name', 'provider_id', 'monthly_payment',
  'outstanding_balance', 'original_amount', 'remaining_months', 'end_date', 'card_limit',
  'card_outstanding', 'minimum_payment', 'balloon_payment', 'will_be_settled_before_financing',
  'settlement_note', 'verification_status', 'notes',
] as const;

const SUPPORT_EDITABLE = [
  'is_first_home', 'sakani_eligible', 'redf_eligible', 'support_program_id',
  'monthly_support_amount', 'support_duration_months', 'support_cap_amount', 'support_status',
  'previously_used_first_home_benefit', 'previously_used_first_home_tax_support',
  'financing_kind', 'certificate_reference', 'notes',
] as const;

const PROPERTY_EDITABLE = [
  'source_kind', 'project_record_id', 'unit_record_id', 'property_price', 'property_type',
  'property_status', 'city', 'district', 'developer_name', 'project_name', 'property_age_years',
  'expected_handover_date', 'construction_stage', 'is_first_home', 'available_cash',
  'desired_down_payment', 'expected_valuation', 'additional_expenses', 'notes',
] as const;

const PREFERENCES_EDITABLE = [
  'preferred_term_months', 'min_term_months', 'max_term_months', 'rate_preference',
  'structure_preference', 'payment_shape', 'max_acceptable_installment', 'priority',
  'salary_transfer_preference', 'preferred_provider_ids', 'planned_start_date', 'notes',
] as const;

function pick(src: unknown, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!src || typeof src !== 'object') return out;
  const o = src as Record<string, unknown>;
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  return out;
}

/** A client scoped to the CALLER's JWT — RLS decides what it can touch. */
function scopedClient(req: Request): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase env vars missing');
  return createClient(url, anonKey, {
    auth: { persistSession: false },
    global: {
      headers: {
        Authorization: req.headers.get('Authorization') ?? '',
        'x-wassell-service': 'api:financing',
      },
    },
  });
}

/** public.users.id for the authenticated auth.uid(). */
async function appUserId(db: SupabaseClient, authUid: string): Promise<string | null> {
  const { data } = await db.from('users').select('id').eq('auth_uid', authUid).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// Reference-data loading: turn database rows into the engine's input shape.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load the rule set EFFECTIVE ON a given date.
 *
 * `asOf` is what makes a historical replay possible: re-running a six-month-old
 * scenario with its original as_of_date selects the rule versions that were in
 * force then, not today's.
 */
async function loadRuleSet(db: SupabaseClient, asOf: string): Promise<RuleSet> {
  const keys = [
    'sama_dbr_bands', 'sama_qualifying_income', 'sama_credit_card_obligation',
    'sama_ltv_ceilings', 'sama_fee_cap', 'sama_apr_method', 'sama_term_limits',
    'sama_early_settlement',
  ];
  const { data, error } = await db
    .from('fin_regulatory_rule_versions')
    .select('id, version_number, effective_from, effective_to, payload, citation_ref, source_url, is_active, fin_regulatory_rules!inner(rule_key, is_active)')
    .lte('effective_from', asOf)
    .eq('is_active', true)
    .order('effective_from', { ascending: false });
  if (error) throw new Error(`rule load: ${error.message}`);

  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const rule = row.fin_regulatory_rules as { rule_key: string; is_active: boolean };
    if (!rule?.is_active) continue;
    const to = row.effective_to as string | null;
    if (to !== null && to <= asOf) continue; // window already closed on asOf
    if (!byKey.has(rule.rule_key)) byKey.set(rule.rule_key, { ...row, rule_key: rule.rule_key });
  }

  const build = (key: string) => {
    const row = byKey.get(key);
    if (!row) return null;
    return {
      id: row.id as string,
      rule_key: key,
      version_number: row.version_number as number,
      effective_from: row.effective_from as string,
      effective_to: (row.effective_to as string | null) ?? null,
      payload: row.payload,
      citation_ref: (row.citation_ref as string | null) ?? null,
      source_url: row.source_url as string,
    };
  };

  void keys;
  return {
    dbr: build('sama_dbr_bands'),
    qualifying_income: build('sama_qualifying_income'),
    credit_card: build('sama_credit_card_obligation'),
    ltv: build('sama_ltv_ceilings'),
    fee_cap: build('sama_fee_cap'),
    apr_method: build('sama_apr_method'),
    term_limits: build('sama_term_limits'),
    early_settlement: build('sama_early_settlement'),
  } as RuleSet;
}

async function loadTaxRule(db: SupabaseClient, asOf: string): Promise<TaxRuleVersion | null> {
  const { data } = await db
    .from('fin_tax_rule_versions')
    .select('id, effective_from, effective_to, rate_pct, base, payer, first_home_relief_cap, source_url, is_active, fin_tax_rules!inner(tax_key)')
    .eq('is_active', true)
    .lte('effective_from', asOf)
    .order('effective_from', { ascending: false });
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const to = row.effective_to as string | null;
    if (to !== null && to <= asOf) continue;
    return {
      id: row.id as string,
      tax_key: (row.fin_tax_rules as { tax_key: string }).tax_key,
      effective_from: row.effective_from as string,
      effective_to: to,
      rate_pct: Number(row.rate_pct),
      base: row.base as TaxRuleVersion['base'],
      payer: (row.payer as TaxRuleVersion['payer']) ?? null,
      first_home_relief_cap: row.first_home_relief_cap === null ? null : Number(row.first_home_relief_cap),
      source_url: row.source_url as string,
    };
  }
  return null;
}

async function loadSupportPrograms(db: SupabaseClient, asOf: string): Promise<SupportProgramVersion[]> {
  const { data } = await db
    .from('fin_support_program_versions')
    .select('*, fin_support_programs!inner(program_key, program_type)')
    .eq('is_active', true)
    .lte('effective_from', asOf);
  const out: SupportProgramVersion[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const to = row.effective_to as string | null;
    if (to !== null && to <= asOf) continue;
    const prog = row.fin_support_programs as { program_key: string; program_type: string };
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    out.push({
      id: row.id as string,
      program_key: prog.program_key,
      program_type: prog.program_type,
      effective_from: row.effective_from as string,
      effective_to: to,
      monthly_support_amount: num(row.monthly_support_amount),
      support_duration_months: num(row.support_duration_months),
      support_cap_amount: num(row.support_cap_amount),
      subsidised_principal_cap: num(row.subsidised_principal_cap),
      down_payment_grant_amount: num(row.down_payment_grant_amount),
      max_property_value: num(row.max_property_value),
      figures_verified: row.figures_verified === true,
      source_url: row.source_url as string,
    });
  }
  return out;
}

/** Assemble every active product with its effective version, rate and fees. */
async function loadProducts(db: SupabaseClient, asOf: string): Promise<ProductRef[]> {
  const { data: products, error } = await db
    .from('fin_products')
    .select('id, product_key, name_ar, name_en, category, structure, official_url, is_active, fin_providers!inner(id, provider_key, name_ar, name_en, provider_type, is_active)')
    .eq('is_active', true)
    .is('deleted_at', null);
  if (error) throw new Error(`product load: ${error.message}`);
  const rows = (products ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const productIds = rows.map((r) => r.id as string);

  const [{ data: versions }, { data: rates }] = await Promise.all([
    db.from('fin_product_versions').select('*').in('product_id', productIds).eq('is_active', true).lte('effective_from', asOf).order('effective_from', { ascending: false }),
    db.from('fin_product_rate_versions').select('*').in('product_id', productIds).eq('is_active', true).lte('effective_from', asOf).order('effective_from', { ascending: false }),
  ]);

  const versionRows = (versions ?? []) as Array<Record<string, unknown>>;
  const versionIds = versionRows.map((v) => v.id as string);
  const [{ data: fees }, { data: eligibility }] = versionIds.length
    ? await Promise.all([
        db.from('fin_product_fee_rules').select('*').in('product_version_id', versionIds),
        db.from('fin_product_eligibility_rules').select('*').in('product_version_id', versionIds),
      ])
    : [{ data: [] as Array<Record<string, unknown>> }, { data: [] as Array<Record<string, unknown>> }];

  const feesByVersion = new Map<string, Array<Record<string, unknown>>>();
  for (const f of (fees ?? []) as Array<Record<string, unknown>>) {
    const k = f.product_version_id as string;
    if (!feesByVersion.has(k)) feesByVersion.set(k, []);
    feesByVersion.get(k)!.push(f);
  }
  const rulesByVersion = new Map<string, Array<Record<string, unknown>>>();
  for (const r of (eligibility ?? []) as Array<Record<string, unknown>>) {
    const k = r.product_version_id as string;
    if (!rulesByVersion.has(k)) rulesByVersion.set(k, []);
    rulesByVersion.get(k)!.push(r);
  }

  const pickEffective = <T extends Record<string, unknown>>(list: T[], productId: string): T | null => {
    for (const row of list) {
      if (row.product_id !== productId) continue;
      const to = row.effective_to as string | null;
      if (to !== null && to <= asOf) continue;
      const campaignEnd = row.campaign_end_date as string | undefined;
      if (campaignEnd && campaignEnd < asOf) continue; // an expired campaign is not current pricing
      return row;
    }
    return null;
  };

  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

  return rows.map((p) => {
    const provider = p.fin_providers as Record<string, unknown>;
    const v = pickEffective(versionRows, p.id as string);
    const r = pickEffective((rates ?? []) as Array<Record<string, unknown>>, p.id as string);
    return {
      id: p.id as string,
      product_key: p.product_key as string,
      name_ar: p.name_ar as string,
      name_en: p.name_en as string,
      category: p.category as string,
      structure: (p.structure as string | null) ?? null,
      official_url: (p.official_url as string | null) ?? null,
      provider: {
        id: provider.id as string,
        provider_key: provider.provider_key as string,
        name_ar: provider.name_ar as string,
        name_en: provider.name_en as string,
        provider_type: provider.provider_type as ProductRef['provider']['provider_type'],
      },
      version: v
        ? {
            id: v.id as string,
            product_id: v.product_id as string,
            version_number: v.version_number as number,
            effective_from: v.effective_from as string,
            applies_to_saudi: v.applies_to_saudi as boolean | null,
            applies_to_resident: v.applies_to_resident as boolean | null,
            applies_to_first_home: v.applies_to_first_home as boolean | null,
            applies_to_additional_home: v.applies_to_additional_home as boolean | null,
            supported_financing: v.supported_financing as boolean | null,
            unsupported_financing: v.unsupported_financing as boolean | null,
            property_types: (v.property_types as ProductRef['version'] extends null ? never : never) ?? null,
            property_status: (v.property_status as never) ?? null,
            employment_types: (v.employment_types as never) ?? null,
            employer_sectors: (v.employer_sectors as never) ?? null,
            requires_approved_employer: v.requires_approved_employer as boolean | null,
            requires_salary_transfer: v.requires_salary_transfer as boolean | null,
            min_salary: num(v.min_salary),
            min_salary_no_transfer: num(v.min_salary_no_transfer),
            min_employment_months: num(v.min_employment_months),
            min_age_years: num(v.min_age_years),
            max_age_at_application: num(v.max_age_at_application),
            max_age_at_maturity: num(v.max_age_at_maturity),
            retiree_eligible: v.retiree_eligible as boolean | null,
            min_amount: num(v.min_amount),
            max_amount: num(v.max_amount),
            min_term_months: num(v.min_term_months),
            max_term_months: num(v.max_term_months),
            min_down_payment_pct: num(v.min_down_payment_pct),
            max_ltv_pct: num(v.max_ltv_pct),
            max_salary_multiple: num(v.max_salary_multiple),
            grace_period_months: num(v.grace_period_months),
            calculation_method: v.calculation_method as never,
            collected_at: v.collected_at as string,
            verified_at: (v.verified_at as string | null) ?? null,
            confidence: v.confidence as 'high' | 'medium' | 'low',
            source_url: v.source_url as string,
            fees: (feesByVersion.get(v.id as string) ?? []).map((f) => ({
              id: f.id as string,
              fee_type: f.fee_type as never,
              label_ar: (f.label_ar as string | null) ?? null,
              label_en: f.label_en as string,
              amount_fixed: num(f.amount_fixed),
              amount_pct: num(f.amount_pct),
              pct_base: (f.pct_base as never) ?? null,
              cap_amount: num(f.cap_amount),
              floor_amount: num(f.floor_amount),
              is_mandatory: f.is_mandatory === true,
              include_in_apr: f.include_in_apr === true,
              payable_upfront: f.payable_upfront === true,
            })),
            eligibility_rules: (rulesByVersion.get(v.id as string) ?? []).map((r) => ({
              id: r.id as string,
              rule_key: r.rule_key as string,
              label_ar: (r.label_ar as string | null) ?? null,
              label_en: r.label_en as string,
              operator: r.operator as never,
              field_path: r.field_path as string,
              value_numeric: num(r.value_numeric),
              value_numeric_2: num(r.value_numeric_2),
              value_text: (r.value_text as string | null) ?? null,
              value_list: (r.value_list as string[] | null) ?? null,
              value_boolean: (r.value_boolean as boolean | null) ?? null,
              is_hard_requirement: r.is_hard_requirement === true,
              failure_message_ar: (r.failure_message_ar as string | null) ?? null,
              failure_message_en: (r.failure_message_en as string | null) ?? null,
            })),
          }
        : null,
      rate: r
        ? {
            id: r.id as string,
            product_id: r.product_id as string,
            version_number: r.version_number as number,
            effective_from: r.effective_from as string,
            rate_type: r.rate_type as never,
            rate_disclosure_type: r.rate_disclosure_type as never,
            contractual_rate_pct: num(r.contractual_rate_pct),
            contractual_rate_min_pct: num(r.contractual_rate_min_pct),
            contractual_rate_max_pct: num(r.contractual_rate_max_pct),
            published_apr_pct: num(r.published_apr_pct),
            published_apr_min_pct: num(r.published_apr_min_pct),
            published_apr_max_pct: num(r.published_apr_max_pct),
            benchmark_key: (r.benchmark_name as string | null) ?? null,
            margin_pct: num(r.margin_pct),
            benchmark_reset_months: num(r.benchmark_reset_months),
            example_amount: num(r.example_amount),
            example_term_months: num(r.example_term_months),
            example_property_price: num(r.example_property_price),
            example_ltv_pct: num(r.example_ltv_pct),
            example_monthly_payment: num(r.example_monthly_payment),
            campaign_end_date: (r.campaign_end_date as string | null) ?? null,
            collected_at: r.collected_at as string,
            verified_at: (r.verified_at as string | null) ?? null,
            confidence: r.confidence as 'high' | 'medium' | 'low',
            source_url: r.source_url as string,
          }
        : null,
    } as ProductRef;
  });
}

async function loadBenchmarks(db: SupabaseClient) {
  const { data } = await db
    .from('fin_benchmark_observations')
    .select('id, observation_date, rate_pct, source_url, fin_benchmarks!inner(benchmark_key)')
    .order('observation_date', { ascending: false })
    .limit(200);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    benchmark_key: (row.fin_benchmarks as { benchmark_key: string }).benchmark_key,
    observation_date: row.observation_date as string,
    rate_pct: Number(row.rate_pct),
    source_url: row.source_url as string,
  }));
}

async function loadReference(db: SupabaseClient, asOf: string): Promise<EngineReference> {
  const [rules, tax, supportPrograms, products, benchmarks] = await Promise.all([
    loadRuleSet(db, asOf),
    loadTaxRule(db, asOf),
    loadSupportPrograms(db, asOf),
    loadProducts(db, asOf),
    loadBenchmarks(db),
  ]);
  return {
    rules,
    tax,
    supportPrograms,
    products,
    benchmarks,
    pricing_freshness_days: PRICING_FRESHNESS_DAYS,
    product_freshness_days: PRODUCT_FRESHNESS_DAYS,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Scenario → engine input
// ────────────────────────────────────────────────────────────────────────────

async function loadScenarioBundle(db: SupabaseClient, scenarioId: string) {
  const { data: scenario, error } = await db
    .from('fin_scenarios')
    .select('*')
    .eq('id', scenarioId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new Error(`scenario load: ${error.message}`);
  if (!scenario) return null; // RLS denial and "does not exist" are the same to the caller

  const [applicants, incomes, obligations, support, property, preferences] = await Promise.all([
    db.from('fin_scenario_applicants').select('*').eq('scenario_id', scenarioId).order('applicant_role'),
    db.from('fin_income_sources').select('*').eq('scenario_id', scenarioId).order('created_at'),
    db.from('fin_obligations').select('*').eq('scenario_id', scenarioId).order('created_at'),
    db.from('fin_scenario_support').select('*').eq('scenario_id', scenarioId).maybeSingle(),
    db.from('fin_property_scenarios').select('*').eq('scenario_id', scenarioId).maybeSingle(),
    db.from('fin_preferences').select('*').eq('scenario_id', scenarioId).maybeSingle(),
  ]);

  return {
    scenario: scenario as Record<string, unknown>,
    applicants: (applicants.data ?? []) as Array<Record<string, unknown>>,
    incomes: (incomes.data ?? []) as Array<Record<string, unknown>>,
    obligations: (obligations.data ?? []) as Array<Record<string, unknown>>,
    support: (support.data ?? null) as Record<string, unknown> | null,
    property: (property.data ?? null) as Record<string, unknown> | null,
    preferences: (preferences.data ?? null) as Record<string, unknown> | null,
  };
}

/** Obligation types that count against the REAL-ESTATE side of the DBR split. */
const REAL_ESTATE_OBLIGATIONS = new Set(['mortgage', 'development_fund']);

function toEngineInput(bundle: NonNullable<Awaited<ReturnType<typeof loadScenarioBundle>>>, asOf: string): EngineInput {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const support = bundle.support;
  const property = bundle.property;
  const prefs = bundle.preferences;

  return {
    as_of_date: asOf,
    applicants: bundle.applicants.map((a) => ({
      role: a.applicant_role as 'primary' | 'co_borrower',
      nationality_type: (a.nationality_type as never) ?? null,
      date_of_birth: (a.date_of_birth as string | null) ?? null,
      employment_type: (a.employment_type as never) ?? null,
      employer_sector: (a.employer_sector as never) ?? null,
      service_months: num(a.service_months),
      willing_to_transfer_salary: (a.willing_to_transfer_salary as boolean | null) ?? null,
      salary_transfer_provider_key: null,
      expected_retirement_age: num(a.expected_retirement_age),
    })),
    incomes: bundle.incomes.map((i) => ({
      id: i.id as string,
      applicant_role:
        bundle.applicants.find((a) => a.id === i.applicant_id)?.applicant_role === 'co_borrower'
          ? 'co_borrower'
          : 'primary',
      income_type: i.income_type as never,
      declared_monthly_amount: num(i.declared_monthly_amount),
      verified_monthly_amount: num(i.verified_monthly_amount),
      documentation_status: i.documentation_status as never,
      frequency: i.frequency as never,
      averaging_period_months: num(i.averaging_period_months),
      is_fixed: i.is_fixed === true,
    })),
    obligations: bundle.obligations.map((o) => ({
      id: o.id as string,
      obligation_type: o.obligation_type as never,
      monthly_payment: num(o.monthly_payment),
      outstanding_balance: num(o.outstanding_balance),
      remaining_months: num(o.remaining_months),
      end_date: (o.end_date as string | null) ?? null,
      card_limit: num(o.card_limit),
      minimum_payment: num(o.minimum_payment),
      balloon_payment: num(o.balloon_payment),
      will_be_settled_before_financing: o.will_be_settled_before_financing === true,
      is_real_estate: REAL_ESTATE_OBLIGATIONS.has(o.obligation_type as string),
    })),
    support: {
      is_first_home: (support?.is_first_home as boolean | null) ?? null,
      sakani_eligible: (support?.sakani_eligible as boolean | null) ?? null,
      redf_eligible: (support?.redf_eligible as boolean | null) ?? null,
      support_status: (support?.support_status as never) ?? 'unknown',
      monthly_support_amount: num(support?.monthly_support_amount),
      support_duration_months: num(support?.support_duration_months),
      financing_kind: (support?.financing_kind as never) ?? 'unknown',
      previously_used_first_home_tax_support:
        (support?.previously_used_first_home_tax_support as boolean | null) ?? null,
    },
    property: {
      property_price: num(property?.property_price),
      property_type: (property?.property_type as never) ?? null,
      property_status: (property?.property_status as never) ?? null,
      city: (property?.city as string | null) ?? null,
      is_first_home: (property?.is_first_home as boolean | null) ?? null,
      available_cash: num(property?.available_cash),
      desired_down_payment: num(property?.desired_down_payment),
      expected_valuation: num(property?.expected_valuation),
      additional_expenses: num(property?.additional_expenses),
      project_record_id: (property?.project_record_id as string | null) ?? null,
      unit_record_id: (property?.unit_record_id as string | null) ?? null,
    },
    preferences: {
      preferred_term_months: num(prefs?.preferred_term_months),
      min_term_months: num(prefs?.min_term_months),
      max_term_months: num(prefs?.max_term_months),
      rate_preference: (prefs?.rate_preference as never) ?? null,
      max_acceptable_installment: num(prefs?.max_acceptable_installment),
      priority: (prefs?.priority as never) ?? null,
      preferred_provider_keys: null,
      planned_start_date: (prefs?.planned_start_date as string | null) ?? null,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────────────────

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed');
  return withAuth(req, async (user) => {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const action = String(body.action ?? '');
    const db = scopedClient(req);
    const today = new Date().toISOString().slice(0, 10);

    try {
      switch (action) {
        // ── Dashboard ────────────────────────────────────────────────────
        case 'dashboard': {
          const [scenarios, issues, issueCount, runs, products, staleRates] = await Promise.all([
            db.from('fin_scenarios').select('id, scenario_number, title, status, client_record_id, project_record_id, unit_record_id, is_preferred, updated_at, owner_user_id, assigned_specialist_user_id').is('deleted_at', null).order('updated_at', { ascending: false }).limit(30),
            db.from('fin_data_validation_issues').select('id, severity, issue_type, message_en, message_ar, entity_type, created_at').eq('status', 'open').order('severity').order('created_at', { ascending: false }).limit(40),
            // A SEPARATE count. The list above is capped at 40 for display, and
            // using its length as the KPI silently under-reports the moment a
            // 41st issue appears — telling an admin the queue is smaller than it
            // is, which is the one direction this number must never be wrong in.
            db.from('fin_data_validation_issues').select('id', { count: 'exact', head: true }).eq('status', 'open'),
            db.from('fin_data_refresh_runs').select('*').order('started_at', { ascending: false }).limit(5),
            db.from('fin_products').select('id, is_active').eq('is_active', true).is('deleted_at', null),
            db.from('fin_product_rate_versions').select('id, verified_at, collected_at').eq('is_active', true).is('effective_to', null),
          ]);

          const rateRows = (staleRates.data ?? []) as Array<{ verified_at: string | null; collected_at: string }>;
          const stale = rateRows.filter((r) => {
            const ref = r.verified_at ?? r.collected_at;
            const ageDays = (Date.now() - Date.parse(ref)) / 86_400_000;
            return ageDays > PRICING_FRESHNESS_DAYS;
          }).length;

          const productCount = (products.data ?? []).length;
          const openIssueTotal = issueCount.count ?? (issues.data ?? []).length;
          return jsonOk({
            scenarios: scenarios.data ?? [],
            issues: issues.data ?? [],
            // Tell the client the list was truncated instead of letting it infer
            // completeness from an array that quietly stops at 40.
            issues_truncated: openIssueTotal > (issues.data ?? []).length,
            runs: runs.data ?? [],
            health: {
              active_products: productCount,
              products_with_pricing: rateRows.length,
              pricing_coverage_pct: productCount > 0 ? Math.round((rateRows.length / productCount) * 100) : 0,
              stale_pricing: stale,
              open_issues: openIssueTotal,
              last_refresh: (runs.data ?? [])[0] ?? null,
            },
          });
        }

        // ── Reference data (comparison + admin) ──────────────────────────
        case 'reference': {
          const asOf = String(body.as_of ?? today);
          const [products, rules, tax, programs, benchmarks] = await Promise.all([
            loadProducts(db, asOf),
            loadRuleSet(db, asOf),
            loadTaxRule(db, asOf),
            loadSupportPrograms(db, asOf),
            loadBenchmarks(db),
          ]);
          const { data: providers } = await db.from('fin_providers').select('*').is('deleted_at', null).order('name_en');
          return jsonOk({ products, rules, tax, programs, benchmarks, providers: providers ?? [] });
        }

        // ── Scenarios ────────────────────────────────────────────────────
        case 'scenario_list': {
          let q = db
            .from('fin_scenarios')
            .select('*')
            .is('deleted_at', null)
            .order('updated_at', { ascending: false })
            .limit(Number(body.limit ?? 100));
          if (body.client_record_id) q = q.eq('client_record_id', String(body.client_record_id));
          if (body.project_record_id) q = q.eq('project_record_id', String(body.project_record_id));
          if (body.unit_record_id) q = q.eq('unit_record_id', String(body.unit_record_id));
          if (body.status) q = q.eq('status', String(body.status));
          const { data, error } = await q;
          if (error) return jsonError(400, error.message);
          return jsonOk({ scenarios: data ?? [] });
        }

        case 'scenario_get': {
          const id = String(body.scenario_id ?? '');
          if (!id) return jsonError(400, 'scenario_id required');
          const bundle = await loadScenarioBundle(db, id);
          if (!bundle) return jsonError(404, 'scenario not found or not permitted');
          const [runs, results, matches, notes] = await Promise.all([
            db.from('fin_calculation_runs').select('id, run_number, calculation_mode, engine_version, as_of_date, created_at, status').eq('scenario_id', id).order('run_number', { ascending: false }).limit(20),
            db.from('fin_calculation_results').select('*').eq('scenario_id', id).order('created_at', { ascending: false }).limit(1),
            db.from('fin_product_match_results').select('*').eq('scenario_id', id).order('created_at', { ascending: false }).limit(60),
            db.from('fin_scenario_notes').select('*').eq('scenario_id', id).order('created_at', { ascending: false }),
          ]);
          const latestRun = (runs.data ?? [])[0] as { id: string } | undefined;
          let latestSnapshot: unknown = null;
          if (latestRun) {
            const { data } = await db.from('fin_calculation_runs').select('result_snapshot').eq('id', latestRun.id).maybeSingle();
            latestSnapshot = (data as { result_snapshot: unknown } | null)?.result_snapshot ?? null;
          }
          return jsonOk({
            ...bundle,
            runs: runs.data ?? [],
            latest_result: (results.data ?? [])[0] ?? null,
            latest_snapshot: latestSnapshot,
            matches: (matches.data ?? []).filter((m) => !latestRun || (m as { run_id: string }).run_id === latestRun.id),
            notes: notes.data ?? [],
          });
        }

        case 'scenario_save': {
          const meId = await appUserId(db, user.userId);
          const scenarioId = body.scenario_id ? String(body.scenario_id) : null;
          const patch = pick(body.scenario, SCENARIO_EDITABLE);

          let id = scenarioId;
          if (!id) {
            const { data, error } = await db
              .from('fin_scenarios')
              .insert({ ...patch, created_by_user_id: meId, owner_user_id: patch.owner_user_id ?? meId })
              .select('id')
              .single();
            if (error) return jsonError(400, error.message);
            id = (data as { id: string }).id;
            await db.from('fin_audit_events').insert({
              scenario_id: id, entity_type: 'fin_scenarios', entity_id: id, event_type: 'scenario_created',
              actor_user_id: meId, actor_email: user.email, summary_en: 'Financing scenario created',
              summary_ar: 'تم إنشاء سيناريو تمويل',
            });
          } else if (Object.keys(patch).length > 0) {
            const { error } = await db.from('fin_scenarios').update(patch).eq('id', id);
            if (error) return jsonError(400, error.message);
            await db.from('fin_audit_events').insert({
              scenario_id: id, entity_type: 'fin_scenarios', entity_id: id, event_type: 'scenario_updated',
              actor_user_id: meId, actor_email: user.email, changed_fields: Object.keys(patch),
              summary_en: 'Financing scenario updated', summary_ar: 'تم تحديث سيناريو التمويل',
            });
          }

          // Child collections are REPLACED wholesale when supplied. The wizard
          // owns the whole list at once, and a merge-by-id protocol would let a
          // half-saved step leave an orphan income row silently inflating a
          // customer's capacity.
          const replaceCollection = async (
            table: string,
            rows: unknown,
            allowed: readonly string[],
          ): Promise<string | null> => {
            if (!Array.isArray(rows)) return null;
            const { error: delErr } = await db.from(table).delete().eq('scenario_id', id);
            if (delErr) return delErr.message;
            if (rows.length === 0) return null;
            const payload = rows.map((r) => ({ ...pick(r, allowed), scenario_id: id }));
            const { error } = await db.from(table).insert(payload);
            return error?.message ?? null;
          };

          // Applicants first: income/obligation rows reference applicant ids.
          if (Array.isArray(body.applicants)) {
            const err = await replaceCollection('fin_scenario_applicants', body.applicants, APPLICANT_EDITABLE);
            if (err) return jsonError(400, `applicants: ${err}`);
          }
          for (const [table, rows, allowed] of [
            ['fin_income_sources', body.incomes, INCOME_EDITABLE],
            ['fin_obligations', body.obligations, OBLIGATION_EDITABLE],
          ] as const) {
            const err = await replaceCollection(table, rows, allowed);
            if (err) return jsonError(400, `${table}: ${err}`);
          }

          // Singletons upsert on scenario_id.
          for (const [table, payload, allowed] of [
            ['fin_scenario_support', body.support, SUPPORT_EDITABLE],
            ['fin_property_scenarios', body.property, PROPERTY_EDITABLE],
            ['fin_preferences', body.preferences, PREFERENCES_EDITABLE],
          ] as const) {
            if (!payload) continue;
            const { error } = await db
              .from(table)
              .upsert({ ...pick(payload, allowed), scenario_id: id }, { onConflict: 'scenario_id' });
            if (error) return jsonError(400, `${table}: ${error.message}`);
          }

          return jsonOk({ scenario_id: id });
        }

        case 'scenario_delete': {
          const id = String(body.scenario_id ?? '');
          if (!id) return jsonError(400, 'scenario_id required');
          const meId = await appUserId(db, user.userId);
          const { error } = await db.from('fin_scenarios').update({ deleted_at: new Date().toISOString() }).eq('id', id);
          if (error) return jsonError(400, error.message);
          await db.from('fin_audit_events').insert({
            scenario_id: id, entity_type: 'fin_scenarios', entity_id: id, event_type: 'scenario_deleted',
            actor_user_id: meId, actor_email: user.email,
            summary_en: 'Financing scenario deleted', summary_ar: 'تم حذف سيناريو التمويل',
          });
          return jsonOk({ ok: true });
        }

        case 'scenario_duplicate': {
          const id = String(body.scenario_id ?? '');
          const bundle = await loadScenarioBundle(db, id);
          if (!bundle) return jsonError(404, 'scenario not found or not permitted');
          const meId = await appUserId(db, user.userId);
          const s = bundle.scenario;
          const { data: created, error } = await db
            .from('fin_scenarios')
            .insert({
              title: String(body.title ?? `${s.title ?? 'Scenario'} (copy)`),
              client_record_id: s.client_record_id, client_model_id: s.client_model_id,
              project_record_id: s.project_record_id, unit_record_id: s.unit_record_id,
              status: 'draft', duplicated_from_scenario_id: id,
              owner_user_id: meId, created_by_user_id: meId,
              // A copy is NOT preferred and carries NO consent — both are
              // decisions about the original, not facts that travel.
              is_preferred: false, consent_to_share_with_provider: false,
              wizard_step: s.wizard_step, wizard_state: s.wizard_state,
            })
            .select('id')
            .single();
          if (error) return jsonError(400, error.message);
          const newId = (created as { id: string }).id;

          const applicantIdMap = new Map<string, string>();
          for (const a of bundle.applicants) {
            const { data } = await db
              .from('fin_scenario_applicants')
              .insert({ ...pick(a, APPLICANT_EDITABLE), scenario_id: newId })
              .select('id')
              .single();
            if (data) applicantIdMap.set(a.id as string, (data as { id: string }).id);
          }
          for (const i of bundle.incomes) {
            await db.from('fin_income_sources').insert({
              ...pick(i, INCOME_EDITABLE), scenario_id: newId,
              applicant_id: applicantIdMap.get(i.applicant_id as string) ?? null,
            });
          }
          for (const o of bundle.obligations) {
            await db.from('fin_obligations').insert({
              ...pick(o, OBLIGATION_EDITABLE), scenario_id: newId,
              applicant_id: applicantIdMap.get(o.applicant_id as string) ?? null,
            });
          }
          if (bundle.support) await db.from('fin_scenario_support').insert({ ...pick(bundle.support, SUPPORT_EDITABLE), scenario_id: newId });
          if (bundle.property) await db.from('fin_property_scenarios').insert({ ...pick(bundle.property, PROPERTY_EDITABLE), scenario_id: newId });
          if (bundle.preferences) await db.from('fin_preferences').insert({ ...pick(bundle.preferences, PREFERENCES_EDITABLE), scenario_id: newId });

          return jsonOk({ scenario_id: newId });
        }

        // ── The calculation ──────────────────────────────────────────────
        case 'calculate': {
          const id = String(body.scenario_id ?? '');
          if (!id) return jsonError(400, 'scenario_id required');
          const bundle = await loadScenarioBundle(db, id);
          if (!bundle) return jsonError(404, 'scenario not found or not permitted');

          const asOf = String(body.as_of ?? today);
          const mode = (String(body.mode ?? 'full') as 'affordability' | 'property_payment' | 'comparison' | 'full');
          const started = Date.now();

          const reference = await loadReference(db, asOf);
          const input = toEngineInput(bundle, asOf);
          const result = runFinancingEngine(input, reference, mode);
          const meId = await appUserId(db, user.userId);

          // The run is IMMUTABLE and pins every version it read. This row is
          // what makes a six-month-old customer conversation reproducible.
          const { data: run, error: runErr } = await db
            .from('fin_calculation_runs')
            .insert({
              scenario_id: id,
              run_number: 0, // trigger assigns the real number
              calculation_mode: mode,
              engine_version: ENGINE_VERSION,
              as_of_date: asOf,
              input_snapshot: input as unknown as Record<string, unknown>,
              result_snapshot: result as unknown as Record<string, unknown>,
              regulatory_rule_version_ids: result.pinned.regulatory_rule_version_ids,
              support_program_version_ids: result.pinned.support_program_version_ids,
              tax_rule_version_ids: result.pinned.tax_rule_version_ids,
              product_version_ids: result.pinned.product_version_ids,
              rate_version_ids: result.pinned.rate_version_ids,
              benchmark_observation_ids: result.pinned.benchmark_observation_ids,
              status: 'completed',
              duration_ms: Date.now() - started,
              created_by_user_id: meId,
            })
            .select('id, run_number')
            .single();
          if (runErr) return jsonError(400, `run insert: ${runErr.message}`);
          const runId = (run as { id: string }).id;

          const selected = result.selected;
          await db.from('fin_calculation_results').insert({
            run_id: runId,
            scenario_id: id,
            declared_income: result.capacity.income.declared_total,
            verified_income: result.capacity.income.verified_total,
            qualifying_income: result.capacity.income.qualifying_total,
            existing_obligations_monthly: result.capacity.obligations.total_monthly,
            current_dbr_pct: result.capacity.current_dbr_pct,
            max_installment: result.capacity.max_installment,
            binding_constraint: result.capacity.binding_constraint,
            max_financing_amount: result.max_financing_from_income,
            max_property_value: result.max_property_value,
            required_down_payment: selected?.down_payment ?? null,
            upfront_cash_total: selected?.upfront?.total ?? null,
            projected_dbr_pct: selected?.projected_dbr_pct ?? null,
            ltv_pct: selected?.ltv_pct ?? null,
            selected_monthly_payment: selected?.monthly_payment ?? null,
            selected_total_repayment: selected?.total_repayment ?? null,
            selected_financing_cost: selected?.financing_cost ?? null,
            selected_apr_pct: selected?.calculated_apr_pct ?? selected?.published_apr_pct ?? null,
            apr_basis: selected?.apr_basis ?? 'unavailable',
            result_status: result.status,
            confidence: result.confidence,
            capacity_reducers: result.capacity.capacity_reducers,
            missing_information: result.missing,
            assumptions: result.assumptions,
          });

          // Per-product rows for the comparison grid + their cash flows.
          let rank = 0;
          for (const m of result.matches) {
            const { data: matchRow } = await db
              .from('fin_product_match_results')
              .insert({
                run_id: runId,
                scenario_id: id,
                product_id: m.product.id,
                provider_id: m.product.provider.id,
                product_version_id: m.product.version?.id ?? null,
                rate_version_id: m.product.rate?.id ?? null,
                match_status: m.status,
                match_reasons: m.match_reasons,
                exclusion_reasons: m.exclusion_reasons,
                unknown_criteria: m.unknown_criteria,
                estimated_monthly_payment: m.monthly_payment,
                estimated_total_cost: m.total_repayment,
                estimated_financing_amount: m.financing_amount,
                required_down_payment: m.down_payment,
                required_upfront_cash: m.upfront?.total ?? null,
                applied_term_months: m.term_months,
                applied_rate_pct: m.applied_rate_pct,
                rate_basis: m.rate_basis,
                published_apr_pct: m.published_apr_pct,
                calculated_apr_pct: m.calculated_apr_pct,
                max_ltv_pct: m.max_ltv_pct,
                confidence: m.confidence,
                data_age_days: m.data_age_days,
                is_stale: m.is_stale,
                sort_rank: rank++,
              })
              .select('id')
              .single();

            // Only the selected product's full schedule is stored: persisting
            // 360 rows for every one of 20 products would be tens of thousands
            // of rows per calculation for numbers nobody opens.
            if (matchRow && selected && m.product.id === selected.product.id && m.cash_flows.length > 0) {
              const flows = m.cash_flows.map((f) => ({
                match_result_id: (matchRow as { id: string }).id,
                run_id: runId,
                sequence: f.sequence,
                flow_date: f.date,
                flow_type: f.type,
                amount: f.amount,
                direction: f.direction,
                principal_component: f.principal_component,
                profit_component: f.profit_component,
                outstanding_balance: f.outstanding_balance,
                included_in_apr: f.included_in_apr,
                label: f.label,
              }));
              for (let i = 0; i < flows.length; i += 200) {
                await db.from('fin_cash_flows').insert(flows.slice(i, i + 200));
              }
            }
          }

          await db.from('fin_scenarios').update({ status: 'calculated' }).eq('id', id);
          await db.from('fin_audit_events').insert({
            scenario_id: id, entity_type: 'fin_calculation_runs', entity_id: runId,
            event_type: 'calculation_run', actor_user_id: meId, actor_email: user.email,
            summary_en: `Calculation run ${(run as { run_number: number }).run_number} — ${result.status}`,
            summary_ar: `تشغيل احتساب رقم ${(run as { run_number: number }).run_number}`,
            details: { mode, engine_version: ENGINE_VERSION, status: result.status, confidence: result.confidence },
          });

          return jsonOk({ run_id: runId, result });
        }

        // ── Convert to a financing case ──────────────────────────────────
        case 'convert_to_case': {
          const id = String(body.scenario_id ?? '');
          const bundle = await loadScenarioBundle(db, id);
          if (!bundle) return jsonError(404, 'scenario not found or not permitted');
          const productId = body.product_id ? String(body.product_id) : null;
          const meId = await appUserId(db, user.userId);

          // Consent gate: an indicative estimate needs none, but creating a
          // financing case is the step that puts customer financial data in
          // front of a provider. Refusing without explicit consent is the
          // PDPL-aligned behaviour, and it is enforced here rather than in the
          // UI so a direct API call cannot bypass it.
          if (bundle.scenario.consent_to_share_with_provider !== true) {
            return jsonError(
              409,
              'Customer consent to share financing information with a provider has not been recorded. Record consent before converting this scenario into a financing case.',
            );
          }

          const { data: match } = productId
            ? await db.from('fin_product_match_results').select('*').eq('scenario_id', id).eq('product_id', productId).order('created_at', { ascending: false }).limit(1).maybeSingle()
            : { data: null };

          const { data: provider } = productId
            ? await db.from('fin_products').select('fin_providers!inner(name_ar, name_en)').eq('id', productId).maybeSingle()
            : { data: null };
          // PostgREST returns an embedded relation as an ARRAY or an OBJECT
          // depending on how it infers cardinality; normalise both rather than
          // asserting one shape and getting `undefined` in production.
          const embedded = (provider as { fin_providers?: unknown } | null)?.fin_providers;
          const providerRow = (Array.isArray(embedded) ? embedded[0] : embedded) as
            | { name_ar?: string; name_en?: string }
            | undefined;
          const providerName = providerRow?.name_ar ?? providerRow?.name_en ?? null;

          const m = match as Record<string, unknown> | null;
          const recordData: Record<string, unknown> = {
            client_id: bundle.scenario.client_record_id ?? null,
            project_id: bundle.scenario.project_record_id ?? null,
            financing_status: 'documents_required',
            bank_name: providerName,
            requested_amount: m?.estimated_financing_amount ?? null,
            submitted_date: today,
            notes: `Created from financing scenario #${bundle.scenario.scenario_number}. Indicative only — subject to bank underwriting.`,
          };

          // Written through record_save so the frozen/unfrozen dispatch, the
          // triggers and the version bump all behave exactly as they do for a
          // record created in the CRM UI.
          const { data: newRecordId, error: rpcErr } = await db.rpc('record_save', {
            p_model_id: FINANCING_MODEL_ID,
            p_id: null,
            p_data: recordData,
            p_created_by: meId,
            p_expected_version: null,
          });
          if (rpcErr) return jsonError(400, `record_save: ${rpcErr.message}`);

          await db
            .from('fin_scenarios')
            .update({ status: 'converted', financing_case_record_id: newRecordId as string })
            .eq('id', id);

          // Missing-document tasks: what the chosen product publishes as
          // required, so the specialist starts from the bank's own list.
          let requiredDocuments: string[] = [];
          if (m?.product_version_id) {
            const { data: docs } = await db
              .from('fin_product_document_requirements')
              .select('label_en, label_ar')
              .eq('product_version_id', m.product_version_id as string);
            requiredDocuments = ((docs ?? []) as Array<{ label_en: string }>).map((d) => d.label_en);
          }

          await db.from('fin_audit_events').insert({
            scenario_id: id, entity_type: 'financing_case', entity_id: newRecordId as string,
            event_type: 'converted_to_case', actor_user_id: meId, actor_email: user.email,
            summary_en: 'Financing scenario converted to a financing case',
            summary_ar: 'تم تحويل سيناريو التمويل إلى ملف تمويل',
            details: { product_id: productId, required_documents: requiredDocuments.length },
          });

          return jsonOk({ financing_record_id: newRecordId, required_documents: requiredDocuments });
        }

        case 'record_consent': {
          const id = String(body.scenario_id ?? '');
          const granted = body.granted === true;
          const meId = await appUserId(db, user.userId);
          const { error } = await db
            .from('fin_scenarios')
            .update({
              consent_to_share_with_provider: granted,
              consent_recorded_at: granted ? new Date().toISOString() : null,
              consent_recorded_by_user_id: granted ? meId : null,
              consent_note: body.note ? String(body.note) : null,
            })
            .eq('id', id);
          if (error) return jsonError(400, error.message);
          await db.from('fin_audit_events').insert({
            scenario_id: id, entity_type: 'fin_scenarios', entity_id: id,
            event_type: granted ? 'consent_granted' : 'consent_withdrawn',
            actor_user_id: meId, actor_email: user.email,
            summary_en: granted ? 'Customer consent recorded' : 'Customer consent withdrawn',
            summary_ar: granted ? 'تم تسجيل موافقة العميل' : 'تم سحب موافقة العميل',
          });
          return jsonOk({ ok: true });
        }

        case 'note_add': {
          const meId = await appUserId(db, user.userId);
          const { error } = await db.from('fin_scenario_notes').insert({
            scenario_id: String(body.scenario_id ?? ''),
            body: String(body.body ?? ''),
            is_internal: body.is_internal !== false,
            author_user_id: meId,
          });
          if (error) return jsonError(400, error.message);
          return jsonOk({ ok: true });
        }

        // ── Admin: reference-data governance ─────────────────────────────
        // These write through the caller's JWT, so the admin-only RLS write
        // policy is the gate. A non-admin gets a database refusal, not a
        // hidden button.
        case 'admin_data': {
          const [providers, products, versions, rates, rules, issues, reviews, runs, sources] = await Promise.all([
            db.from('fin_providers').select('*').is('deleted_at', null).order('name_en'),
            db.from('fin_products').select('*').is('deleted_at', null).order('product_key'),
            db.from('fin_product_versions').select('*').order('effective_from', { ascending: false }),
            db.from('fin_product_rate_versions').select('*').order('effective_from', { ascending: false }),
            db.from('fin_regulatory_rule_versions').select('*, fin_regulatory_rules!inner(rule_key, label_ar, label_en, authority, category)').order('effective_from', { ascending: false }),
            db.from('fin_data_validation_issues').select('*').order('created_at', { ascending: false }).limit(200),
            db.from('fin_manual_review_queue').select('*').eq('status', 'pending').order('created_at', { ascending: false }),
            db.from('fin_data_refresh_runs').select('*').order('started_at', { ascending: false }).limit(20),
            db.from('fin_sources').select('*').order('authority_rank').order('publisher'),
          ]);
          return jsonOk({
            providers: providers.data ?? [], products: products.data ?? [],
            product_versions: versions.data ?? [], rate_versions: rates.data ?? [],
            rule_versions: rules.data ?? [], issues: issues.data ?? [],
            reviews: reviews.data ?? [], runs: runs.data ?? [], sources: sources.data ?? [],
          });
        }

        case 'admin_issue_update': {
          const meId = await appUserId(db, user.userId);
          const { error } = await db
            .from('fin_data_validation_issues')
            .update({
              status: String(body.status ?? 'acknowledged'),
              resolution_note: body.note ? String(body.note) : null,
              resolved_by_user_id: meId,
              resolved_at: new Date().toISOString(),
            })
            .eq('id', String(body.issue_id ?? ''));
          if (error) return jsonError(403, error.message);
          return jsonOk({ ok: true });
        }

        case 'admin_review_decide': {
          const meId = await appUserId(db, user.userId);
          const decision = String(body.decision ?? '');
          if (decision !== 'approved' && decision !== 'rejected') return jsonError(400, 'decision must be approved or rejected');
          if (!body.note) {
            // A manual override without a stated reason is exactly the kind of
            // unattributable change the versioning exists to prevent.
            return jsonError(400, 'a reason is required for a manual data decision');
          }
          const { error } = await db
            .from('fin_manual_review_queue')
            .update({ status: decision, decided_by_user_id: meId, decided_at: new Date().toISOString(), decision_note: String(body.note) })
            .eq('id', String(body.review_id ?? ''));
          if (error) return jsonError(403, error.message);
          return jsonOk({ ok: true });
        }

        case 'admin_product_retire': {
          const { error } = await db
            .from('fin_products')
            .update({
              is_active: body.restore === true ? true : false,
              retired_at: body.restore === true ? null : new Date().toISOString(),
              retired_reason: body.restore === true ? null : String(body.reason ?? 'retired by admin'),
            })
            .eq('id', String(body.product_id ?? ''));
          if (error) return jsonError(403, error.message);
          return jsonOk({ ok: true });
        }

        case 'admin_version_history': {
          const productId = String(body.product_id ?? '');
          const [versions, rates] = await Promise.all([
            db.from('fin_product_versions').select('*').eq('product_id', productId).order('version_number', { ascending: false }),
            db.from('fin_product_rate_versions').select('*').eq('product_id', productId).order('version_number', { ascending: false }),
          ]);
          return jsonOk({ versions: versions.data ?? [], rates: rates.data ?? [] });
        }

        default:
          return jsonError(400, `unknown action: ${action}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Fail loud — a swallowed error here would mean a rep sees an empty
      // comparison and reads it as "no products match".
      console.error('[api/financing]', action, message);
      return jsonError(500, message);
    }
  });
}
