/**
 * POST /api/financing — the whole server surface for financing V2.
 *
 * Every call runs on the CALLER'S JWT, never service-role. The four
 * `financing_*` tables carry RLS, so the database is the authorization
 * boundary: a user who cannot see a scenario physically cannot read it, even by
 * calling this endpoint directly.
 *
 * The engine runs HERE, not in the browser, so the stored snapshot is
 * authoritative and a stale bundle cannot shape a customer's numbers.
 *
 * Actions: reference · scenario_list · scenario_get · scenario_save ·
 *          calculate · convert_to_case · record_consent ·
 *          admin_product_save · admin_rate_add · admin_rate_stale ·
 *          admin_product_retire · admin_rules
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { runFinancing, CALCULATION_VERSION } from '../src/lib/financing/engine.js';
import type { FinancingInput, FinancingProduct, RuleSet } from '../src/lib/financing/types.js';

export const config = { runtime: 'edge' };

/** The existing `financing` CRM model — the conversion target, unchanged. */
const FINANCING_MODEL_ID = '5a1e0ffe-0000-4000-8000-000000000003';

const PRODUCT_EDITABLE = [
  'provider_key', 'provider_name_ar', 'provider_name_en', 'provider_type',
  'product_key', 'name_ar', 'name_en', 'is_active', 'supported_financing',
  'property_types', 'nationality', 'employment_sectors', 'employment_types',
  'min_salary', 'min_salary_no_transfer', 'min_age', 'max_age_at_maturity',
  'requires_salary_transfer', 'first_home_applicable', 'additional_home_applicable',
  'min_down_payment_pct', 'max_ltv_pct', 'max_term_months', 'max_amount',
  'criteria', 'official_url', 'last_verified_at', 'notes', 'confidence',
] as const;

const RATE_EDITABLE = [
  'product_id', 'disclosure_type', 'rate_type', 'contractual_rate_pct',
  'published_apr_pct', 'starting_apr_pct', 'example', 'effective_from',
  'expires_at', 'source_url', 'last_verified_at', 'confidence', 'notes',
] as const;

const SCENARIO_EDITABLE = [
  'title', 'client_record_id', 'project_record_id', 'unit_record_id',
  'status', 'assigned_user_id', 'input_snapshot', 'selected_product_id',
] as const;

function pick(src: unknown, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!src || typeof src !== 'object') return out;
  const o = src as Record<string, unknown>;
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  return out;
}

function scopedClient(req: Request): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '', 'x-wassell-service': 'api:financing' } },
  });
}

async function appUserId(db: SupabaseClient, authUid: string): Promise<string | null> {
  const { data } = await db.from('users').select('id').eq('auth_uid', authUid).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Load active products with their current rate. One query each, joined in JS —
 *  six products does not warrant a view. */
async function loadProducts(db: SupabaseClient): Promise<FinancingProduct[]> {
  const [{ data: products, error }, { data: rates }] = await Promise.all([
    db.from('financing_products').select('*').eq('is_active', true).is('retired_at', null).order('provider_name_en'),
    db.from('financing_rates').select('*').eq('is_active', true).order('effective_from', { ascending: false }),
  ]);
  if (error) throw new Error(`product load: ${error.message}`);

  const rateByProduct = new Map<string, Record<string, unknown>>();
  for (const r of (rates ?? []) as Array<Record<string, unknown>>) {
    if (!rateByProduct.has(r.product_id as string)) rateByProduct.set(r.product_id as string, r);
  }

  return ((products ?? []) as Array<Record<string, unknown>>).map((p) => {
    const r = rateByProduct.get(p.id as string);
    return {
      id: p.id as string,
      provider_key: p.provider_key as string,
      provider_name_ar: p.provider_name_ar as string,
      provider_name_en: p.provider_name_en as string,
      provider_type: p.provider_type as FinancingProduct['provider_type'],
      product_key: p.product_key as string,
      name_ar: p.name_ar as string,
      name_en: p.name_en as string,
      supported_financing: (p.supported_financing as FinancingProduct['supported_financing']) ?? null,
      property_types: (p.property_types as string[] | null) ?? null,
      nationality: (p.nationality as FinancingProduct['nationality']) ?? null,
      employment_sectors: (p.employment_sectors as FinancingProduct['employment_sectors']) ?? null,
      employment_types: (p.employment_types as FinancingProduct['employment_types']) ?? null,
      min_salary: num(p.min_salary),
      min_salary_no_transfer: num(p.min_salary_no_transfer),
      min_age: num(p.min_age),
      max_age_at_maturity: num(p.max_age_at_maturity),
      requires_salary_transfer: (p.requires_salary_transfer as boolean | null) ?? null,
      first_home_applicable: (p.first_home_applicable as boolean | null) ?? null,
      additional_home_applicable: (p.additional_home_applicable as boolean | null) ?? null,
      min_down_payment_pct: num(p.min_down_payment_pct),
      max_ltv_pct: num(p.max_ltv_pct),
      max_term_months: num(p.max_term_months),
      max_amount: num(p.max_amount),
      criteria: (p.criteria as Record<string, unknown>) ?? {},
      official_url: (p.official_url as string | null) ?? null,
      last_verified_at: (p.last_verified_at as string | null) ?? null,
      notes: (p.notes as string | null) ?? null,
      confidence: p.confidence as FinancingProduct['confidence'],
      rate: r
        ? {
            id: r.id as string,
            disclosure_type: r.disclosure_type as never,
            rate_type: r.rate_type as never,
            contractual_rate_pct: num(r.contractual_rate_pct),
            published_apr_pct: num(r.published_apr_pct),
            starting_apr_pct: num(r.starting_apr_pct),
            example: (r.example as FinancingProduct['rate'] extends null ? never : never) ?? null,
            effective_from: r.effective_from as string,
            expires_at: (r.expires_at as string | null) ?? null,
            source_url: r.source_url as string,
            last_verified_at: r.last_verified_at as string,
            confidence: r.confidence as 'high' | 'medium' | 'low',
            marked_stale: r.marked_stale === true,
            notes: (r.notes as string | null) ?? null,
          }
        : null,
    } as FinancingProduct;
  });
}

/** Load the six rule rows into the shape the engine reads. */
async function loadRules(db: SupabaseClient): Promise<RuleSet> {
  const { data, error } = await db.from('financing_rules').select('*').eq('is_active', true);
  if (error) throw new Error(`rule load: ${error.message}`);
  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of (data ?? []) as Array<Record<string, unknown>>) byKey.set(r.rule_key as string, r);

  const meta = (key: string) => {
    const r = byKey.get(key);
    return r ? { source_url: r.source_url as string, effective_from: r.effective_from as string } : null;
  };
  const payload = (key: string) => (byKey.get(key)?.payload ?? null) as Record<string, unknown> | null;

  const dbrP = payload('sama_dbr_bands');
  const incP = payload('sama_qualifying_income');
  const cardP = payload('sama_credit_card_obligation');
  const ltvP = payload('sama_ltv_ceilings');
  const rettP = payload('zatca_rett');
  const supP = payload('sakani_redf_treatment');

  return {
    dbr: dbrP && meta('sama_dbr_bands') ? { bands: dbrP.bands as never, ...meta('sama_dbr_bands')! } : null,
    income: incP && meta('sama_qualifying_income')
      ? {
          gross_salary_pct: Number(incP.gross_salary_pct ?? 100),
          other_periodic_income_pct: Number(incP.other_periodic_income_pct ?? 50),
          ...meta('sama_qualifying_income')!,
        }
      : null,
    credit_card: cardP && meta('sama_credit_card_obligation')
      ? { minimum_repayment_pct: Number(cardP.minimum_repayment_pct ?? 5), ...meta('sama_credit_card_obligation')! }
      : null,
    ltv: ltvP && meta('sama_ltv_ceilings')
      ? {
          bank_first_home_pct: Number(ltvP.bank_first_home_pct),
          bank_additional_home_pct: Number(ltvP.bank_additional_home_pct),
          finance_company_first_home_pct: Number(ltvP.finance_company_first_home_pct),
          finance_company_additional_home_pct: Number(ltvP.finance_company_additional_home_pct),
          first_home_citizens_only: ltvP.first_home_citizens_only === true,
          ...meta('sama_ltv_ceilings')!,
        }
      : null,
    rett: rettP && meta('zatca_rett')
      ? {
          rate_pct: Number(rettP.rate_pct),
          first_home_relief_cap: rettP.first_home_relief_cap === null ? null : Number(rettP.first_home_relief_cap),
          ...meta('zatca_rett')!,
        }
      : null,
    support: supP && meta('sakani_redf_treatment')
      ? { housing_support_counts_as_income: supP.housing_support_counts_as_income === true, ...meta('sakani_redf_treatment')! }
      : null,
  };
}

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
        // ── Reference data for the wizard + admin ─────────────────────────
        case 'reference': {
          const [products, rules] = await Promise.all([loadProducts(db), loadRules(db)]);
          return jsonOk({ products, rules });
        }

        // ── Scenarios ─────────────────────────────────────────────────────
        case 'scenario_list': {
          let q = db.from('financing_scenarios').select('*').is('deleted_at', null)
            .order('updated_at', { ascending: false }).limit(Number(body.limit ?? 100));
          if (body.client_record_id) q = q.eq('client_record_id', String(body.client_record_id));
          if (body.project_record_id) q = q.eq('project_record_id', String(body.project_record_id));
          const { data, error } = await q;
          if (error) return jsonError(400, error.message);
          return jsonOk({ scenarios: data ?? [] });
        }

        case 'scenario_get': {
          const { data, error } = await db.from('financing_scenarios').select('*')
            .eq('id', String(body.scenario_id ?? '')).is('deleted_at', null).maybeSingle();
          if (error) return jsonError(400, error.message);
          if (!data) return jsonError(404, 'scenario not found or not permitted');
          return jsonOk({ scenario: data });
        }

        case 'scenario_save': {
          const me = await appUserId(db, user.userId);
          const patch = pick(body.scenario, SCENARIO_EDITABLE);
          const id = body.scenario_id ? String(body.scenario_id) : null;

          if (!id) {
            const { data, error } = await db.from('financing_scenarios')
              .insert({ ...patch, created_by_user_id: me, owner_user_id: patch.owner_user_id ?? me })
              .select('id').single();
            if (error) return jsonError(400, error.message);
            return jsonOk({ scenario_id: (data as { id: string }).id });
          }
          const { error } = await db.from('financing_scenarios').update(patch).eq('id', id);
          if (error) return jsonError(400, error.message);
          return jsonOk({ scenario_id: id });
        }

        // ── The calculation ───────────────────────────────────────────────
        case 'calculate': {
          const id = String(body.scenario_id ?? '');
          if (!id) return jsonError(400, 'scenario_id required');

          const { data: scenario, error: sErr } = await db.from('financing_scenarios')
            .select('*').eq('id', id).is('deleted_at', null).maybeSingle();
          if (sErr) return jsonError(400, sErr.message);
          if (!scenario) return jsonError(404, 'scenario not found or not permitted');

          const row = scenario as Record<string, unknown>;
          if (row.completed_at) {
            // The snapshot is frozen by trigger; say so rather than 500ing.
            return jsonError(409, 'This scenario is already completed and its result is frozen. Duplicate it to recalculate.');
          }

          const [products, rules] = await Promise.all([loadProducts(db), loadRules(db)]);
          const input = { ...(row.input_snapshot as object), as_of_date: today } as FinancingInput;
          const result = runFinancing(input, products, rules);

          const { error: uErr } = await db.from('financing_scenarios').update({
            input_snapshot: input as unknown as Record<string, unknown>,
            result_snapshot: result as unknown as Record<string, unknown>,
            calculation_version: CALCULATION_VERSION,
            status: 'calculated',
            selected_product_id: result.selected?.product.id ?? null,
            completed_at: new Date().toISOString(),
          }).eq('id', id);
          if (uErr) return jsonError(400, uErr.message);

          return jsonOk({ result });
        }

        case 'record_consent': {
          const me = await appUserId(db, user.userId);
          const granted = body.granted === true;
          const { error } = await db.from('financing_scenarios').update({
            consent_to_share: granted,
            consent_recorded_at: granted ? new Date().toISOString() : null,
            consent_recorded_by_user_id: granted ? me : null,
          }).eq('id', String(body.scenario_id ?? ''));
          if (error) return jsonError(400, error.message);
          return jsonOk({ ok: true });
        }

        // ── Convert to the EXISTING financing case (workflow unchanged) ───
        case 'convert_to_case': {
          const id = String(body.scenario_id ?? '');
          const { data: scenario, error } = await db.from('financing_scenarios')
            .select('*').eq('id', id).is('deleted_at', null).maybeSingle();
          if (error) return jsonError(400, error.message);
          if (!scenario) return jsonError(404, 'scenario not found or not permitted');
          const row = scenario as Record<string, unknown>;

          // Consent gate — enforced server-side so a direct API call cannot skip it.
          if (row.consent_to_share !== true) {
            return jsonError(409,
              'Customer consent to share financing information with a provider has not been recorded. Record consent before converting this scenario into a financing case.');
          }

          const me = await appUserId(db, user.userId);
          const result = row.result_snapshot as Record<string, unknown> | null;
          const selected = result?.selected as Record<string, unknown> | null;
          const product = selected?.product as Record<string, unknown> | null;

          const { data: newRecordId, error: rpcErr } = await db.rpc('record_save', {
            p_model_id: FINANCING_MODEL_ID,
            p_id: null,
            p_data: {
              client_id: row.client_record_id ?? null,
              project_id: row.project_record_id ?? null,
              financing_status: 'documents_required',
              bank_name: (product?.provider_name_ar as string) ?? null,
              requested_amount: num(selected?.financing_amount),
              submitted_date: today,
              notes: `Created from financing scenario #${row.scenario_number}. Indicative only — subject to bank underwriting.`,
            },
            p_created_by: me,
            p_expected_version: null,
          });
          if (rpcErr) return jsonError(400, `record_save: ${rpcErr.message}`);

          await db.from('financing_scenarios')
            .update({ status: 'converted', financing_case_record_id: newRecordId as string })
            .eq('id', id);

          return jsonOk({ financing_record_id: newRecordId });
        }

        // ── Admin: product / rate / rule maintenance ──────────────────────
        // Writes go through the caller's JWT, so the admin-only RLS policy is
        // the gate. A non-admin gets a database refusal, not a hidden button.
        case 'admin_data': {
          const [{ data: products }, { data: rates }, { data: rules }] = await Promise.all([
            db.from('financing_products').select('*').order('provider_name_en'),
            db.from('financing_rates').select('*').order('effective_from', { ascending: false }),
            db.from('financing_rules').select('*').order('rule_key'),
          ]);
          return jsonOk({ products: products ?? [], rates: rates ?? [], rules: rules ?? [] });
        }

        case 'admin_product_save': {
          const patch = pick(body.product, PRODUCT_EDITABLE);
          const id = body.product_id ? String(body.product_id) : null;
          if (!id) {
            const { data, error } = await db.from('financing_products').insert(patch).select('id').single();
            if (error) return jsonError(403, error.message);
            return jsonOk({ product_id: (data as { id: string }).id });
          }
          const { error } = await db.from('financing_products').update(patch).eq('id', id);
          if (error) return jsonError(403, error.message);
          return jsonOk({ product_id: id });
        }

        case 'admin_rate_add': {
          const me = await appUserId(db, user.userId);
          const patch = pick(body.rate, RATE_EDITABLE);
          if (!patch.product_id) return jsonError(400, 'product_id required');
          if (!patch.source_url) return jsonError(400, 'an official source URL is required for every rate');
          // Version history: retire the current rate, then insert the new one.
          await db.from('financing_rates').update({ is_active: false }).eq('product_id', String(patch.product_id)).eq('is_active', true);
          const { data, error } = await db.from('financing_rates')
            .insert({ ...patch, created_by_user_id: me }).select('id').single();
          if (error) return jsonError(403, error.message);
          return jsonOk({ rate_id: (data as { id: string }).id });
        }

        case 'admin_rate_stale': {
          const { error } = await db.from('financing_rates')
            .update({ marked_stale: body.stale !== false }).eq('id', String(body.rate_id ?? ''));
          if (error) return jsonError(403, error.message);
          return jsonOk({ ok: true });
        }

        case 'admin_product_retire': {
          const restore = body.restore === true;
          const { error } = await db.from('financing_products').update({
            is_active: restore,
            retired_at: restore ? null : new Date().toISOString(),
          }).eq('id', String(body.product_id ?? ''));
          if (error) return jsonError(403, error.message);
          return jsonOk({ ok: true });
        }

        default:
          return jsonError(400, `unknown action: ${action}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Fail loud: a swallowed error here would show a rep an empty comparison
      // and read as "no products match".
      console.error('[api/financing]', action, message);
      return jsonError(500, message);
    }
  });
}
