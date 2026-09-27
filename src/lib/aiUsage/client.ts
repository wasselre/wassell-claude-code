import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * AI spend + credit balances — browser client.
 *
 * `ai_usage`, `ai_price_book`, `ai_provider_accounts` and `ai_credit_entries`
 * are bespoke ops tables (NOT app models), so they can't ride the Zustand
 * records store. Reading them directly in a hook is the sanctioned pattern for
 * bespoke tables (same as `useFollowupSuggestions`). RLS gates every one of
 * them to admins, and all writes go through SECURITY DEFINER RPCs that do their
 * own admin check — the browser never writes these tables directly.
 *
 * WHY BALANCES ARE TYPED IN: none of the five providers (Anthropic, DeepSeek,
 * Moonshot, fal, Modal) exposes a balance an API key can read. So the operator
 * records what they loaded, and the app subtracts what it metered. That makes
 * `remaining_usd` only as good as the pricing behind it — which is why
 * `remaining_is_upper_bound` travels with it everywhere and the UI must show it.
 */

export interface AiSpendRow {
  day: string;
  area: string;
  call_site: string;
  provider: string;
  model: string;
  calls: number;
  errors: number;
  fallback_calls: number;
  input_tokens: number;
  output_tokens: number;
  unpriced_calls: number;
  cost_usd: number | null;
}

export interface AiUnpricedModel {
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  units: number | null;
  unit_kind: string | null;
  first_seen: string;
  last_seen: string;
}

const isOfflineMessage =
  'Supabase is not configured — AI usage cannot be read in offline mode.';

/** Throw before a write when there is no Supabase client (offline mode). */
function requireSupabase(): void {
  if (!supabase) throw new Error(isOfflineMessage);
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}


/**
 * The vendor's own number for each provider, and whether anything spent that
 * we did not meter.
 *
 * Since 2026-09-21 the vendor's reading IS the balance. The earlier model —
 * a hand-entered opening balance minus metered spend — was right only while
 * someone recorded every top-up, and nobody did (Anthropic read $0.06 left
 * against a real $99.63).
 *
 * "Unmetered" is now measured by comparing how far the vendor's balance FELL
 * across consecutive readings with what we metered over the same window. A
 * top-up makes the balance RISE, so it is detected and reported separately
 * rather than corrupting the comparison.
 *
 * Postpaid providers (Modal) are the mirror image: the vendor figure is this
 * billing cycle's spend, which rises; the alert is spend going OVER a line
 * rather than a balance going under one.
 *
 * ALWAYS read `verdict` before any number: several verdicts mean there is no
 * comparison to read at all.
 */
export interface AiBalanceCheck {
  provider: string;
  label: string;
  billing_mode: 'prepaid' | 'postpaid';
  low_balance_threshold: number | null;
  spend_alert_threshold: number | null;
  /** Balance (prepaid) or this cycle's spend (postpaid), from the vendor. */
  vendor_value_usd: number | null;
  vendor_value_at: string | null;
  vendor_value_source: string | null;
  probe_checked_at: string | null;
  probe_status: string | null;
  probe_source: string | null;
  probe_error: string | null;
  vendor_spent_24h: number | null;
  metered_24h: number | null;
  topups_24h: number | null;
  unmetered_24h: number | null;
  unpriced_calls_24h: number;
  needs_alert: boolean;
  verdict:
    | 'ok'
    | 'UNMETERED_SPEND'
    | 'LOW_BALANCE'
    | 'OVER_BUDGET'
    | 'stale'
    | 'no_reading'
    | 'unsupported';
}

export interface AiUsageData {
  spend: AiSpendRow[];
  unpriced: AiUnpricedModel[];
  checks: AiBalanceCheck[];
}

const EMPTY: AiUsageData = { spend: [], unpriced: [], checks: [] };

/**
 * Load everything the AI Usage page shows, in one pass.
 *
 * Errors are surfaced, never swallowed: a failed read returns an error string
 * the page renders instead of an empty state. An empty ledger and a broken read
 * look identical otherwise, and "you've spent nothing" is a dangerous thing to
 * show when the truth is "we couldn't ask".
 */
export function useAiUsage(days = 30) {
  const [data, setData] = useState<AiUsageData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!supabase) {
        // Offline mode. Say so rather than rendering zeros, which would read as
        // "nothing has been spent".
        setError(isOfflineMessage);
        setData(EMPTY);
        return;
      }
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const [spendRes, unpricedRes, checksRes] = await Promise.all([
        supabase.from('v_ai_usage_daily').select('*').gte('day', since).order('day', { ascending: false }),
        supabase.from('v_ai_usage_unpriced').select('*'),
        supabase.from('v_ai_balance_reconciliation').select('*').order('provider'),
      ]);

      const firstError = spendRes.error ?? unpricedRes.error ?? checksRes.error;
      if (firstError) throw new Error(firstError.message);

      setData({
        spend: ((spendRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
          day: String(r.day),
          area: String(r.area),
          call_site: String(r.call_site),
          provider: String(r.provider),
          model: String(r.model),
          calls: num(r.calls),
          errors: num(r.errors),
          fallback_calls: num(r.fallback_calls),
          input_tokens: num(r.input_tokens),
          output_tokens: num(r.output_tokens),
          unpriced_calls: num(r.unpriced_calls),
          cost_usd: numOrNull(r.cost_usd),
        })),
        unpriced: ((unpricedRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
          provider: String(r.provider),
          model: String(r.model),
          calls: num(r.calls),
          input_tokens: num(r.input_tokens),
          output_tokens: num(r.output_tokens),
          units: numOrNull(r.units),
          unit_kind: (r.unit_kind as string | null) ?? null,
          first_seen: String(r.first_seen),
          last_seen: String(r.last_seen),
        })),
        checks: ((checksRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
          provider: String(r.provider),
          label: String(r.label ?? r.provider),
          billing_mode: r.billing_mode === 'postpaid' ? 'postpaid' : 'prepaid',
          low_balance_threshold: numOrNull(r.low_balance_threshold),
          spend_alert_threshold: numOrNull(r.spend_alert_threshold),
          vendor_value_usd: numOrNull(r.vendor_value_usd),
          vendor_value_at: (r.vendor_value_at as string | null) ?? null,
          vendor_value_source: (r.vendor_value_source as string | null) ?? null,
          probe_checked_at: (r.probe_checked_at as string | null) ?? null,
          probe_status: (r.probe_status as string | null) ?? null,
          probe_source: (r.probe_source as string | null) ?? null,
          probe_error: (r.probe_error as string | null) ?? null,
          vendor_spent_24h: numOrNull(r.vendor_spent_24h),
          metered_24h: numOrNull(r.metered_24h),
          topups_24h: numOrNull(r.topups_24h),
          unmetered_24h: numOrNull(r.unmetered_24h),
          unpriced_calls_24h: num(r.unpriced_calls_24h),
          needs_alert: r.needs_alert === true,
          verdict: String(r.verdict) as AiBalanceCheck['verdict'],
        })),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[aiUsage] load failed:', msg);
      setError(msg);
      setData(EMPTY);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...data, loading, error, reload };
}

/**
 * ONE model call, exactly as it was recorded.
 *
 * Everything else on the page is an aggregate, and an aggregate cannot answer
 * "what actually ran, and did it work". A run row can: it carries the error
 * text of a failure, the fallback flag of a call that only happened because the
 * cheap provider fell over, and the latency of one that was slow.
 */
export interface AiRun {
  id: string;
  created_at: string;
  area: string;
  call_site: string;
  operation: string | null;
  provider: string;
  model: string;
  status: string;
  error: string | null;
  is_fallback: boolean;
  fallback_from: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  units: number | null;
  unit_kind: string | null;
  cost_usd: number | null;
  cost_known: boolean;
  latency_ms: number | null;
  entity_kind: string | null;
  entity_id: string | null;
  meta: Record<string, unknown> | null;
}

export interface RunsPage {
  runs: AiRun[];
  /** True when the provider returned a full page — there is more behind it. */
  hasMore: boolean;
}

/**
 * Read individual calls, newest first.
 *
 * Offset paging, not a cursor: the table is append-only and read newest-first,
 * so the only drift is a call recorded WHILE the operator pages, which would
 * show one row twice — acceptable, and far cheaper than the alternative here.
 * `ai_usage` is admin-read under RLS, so a non-admin gets an empty page rather
 * than a partial one.
 */
export async function fetchRuns(opts: {
  limit: number;
  offset?: number;
  callSite?: string | null;
  failedOnly?: boolean;
}): Promise<RunsPage> {
  if (!supabase) throw new Error(isOfflineMessage);
  const from = opts.offset ?? 0;
  let q = supabase
    .from('ai_usage')
    .select('id, created_at, area, call_site, operation, provider, model, status, error, is_fallback, fallback_from, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, units, unit_kind, cost_usd, cost_known, latency_ms, entity_kind, entity_id, meta')
    .order('created_at', { ascending: false })
    .range(from, from + opts.limit - 1);
  if (opts.callSite) q = q.eq('call_site', opts.callSite);
  if (opts.failedOnly) q = q.neq('status', 'ok');

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Record<string, unknown>[];
  return {
    runs: rows.map((r) => ({
      id: String(r.id),
      created_at: String(r.created_at),
      area: String(r.area),
      call_site: String(r.call_site),
      operation: (r.operation as string | null) ?? null,
      provider: String(r.provider),
      model: String(r.model),
      status: String(r.status),
      error: (r.error as string | null) ?? null,
      is_fallback: r.is_fallback === true,
      fallback_from: (r.fallback_from as string | null) ?? null,
      input_tokens: num(r.input_tokens),
      output_tokens: num(r.output_tokens),
      cache_read_tokens: num(r.cache_read_tokens),
      cache_write_tokens: num(r.cache_write_tokens),
      units: numOrNull(r.units),
      unit_kind: (r.unit_kind as string | null) ?? null,
      cost_usd: numOrNull(r.cost_usd),
      cost_known: r.cost_known === true,
      latency_ms: numOrNull(r.latency_ms),
      entity_kind: (r.entity_kind as string | null) ?? null,
      entity_id: (r.entity_id as string | null) ?? null,
      meta: (r.meta as Record<string, unknown> | null) ?? null,
    })),
    hasMore: rows.length === opts.limit,
  };
}

/**
 * Set a model's price and re-cost history. Returns how many existing rows just
 * became costed — the number that makes "I entered one rate and 3,500 calls
 * gained a price" visible.
 */
export async function setModelPrice(input: {
  provider: string;
  model: string;
  inputPerM?: number | null;
  outputPerM?: number | null;
  cacheReadPerM?: number | null;
  cacheWritePerM?: number | null;
  unitPrice?: number | null;
  unitKind?: string | null;
  source?: string | null;
}): Promise<number> {
  requireSupabase();
  const { data, error } = await supabase!.rpc('ai_price_set', {
    p_provider: input.provider,
    p_model: input.model,
    p_input_per_m: input.inputPerM ?? null,
    p_output_per_m: input.outputPerM ?? null,
    p_cache_read_per_m: input.cacheReadPerM ?? null,
    p_cache_write_per_m: input.cacheWritePerM ?? null,
    p_unit_price: input.unitPrice ?? null,
    p_unit_kind: input.unitKind ?? null,
    p_source: input.source ?? 'entered in Settings → AI Usage',
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

// ---------------------------------------------------------------------------
// Aggregation (pure — lives here so it can be tested without a DOM)
// ---------------------------------------------------------------------------

/** What one provider cost us over the window the page loaded. */
export interface ProviderSpend {
  /** Priced cost only. With `unpricedCalls > 0` this is a FLOOR, not a total. */
  cost: number;
  calls: number;
  unpricedCalls: number;
  /** Average per day across the whole window, not across days that had traffic. */
  perDay: number;
}

/**
 * Fold the daily rows into one bucket per provider.
 *
 * This is OUR side of the comparison: what the app recorded. The money LEFT
 * comes from the vendor's own reading (`AiBalanceCheck.vendor_value_usd`) and
 * is never computed from these numbers — that was the old hand-entered model,
 * which drifted from reality the moment anyone topped up without recording it,
 * and on 2026-09-27 was showing Anthropic at -$0.21 while the console held
 * $99.34.
 */
export function summarizeProviderSpend(rows: AiSpendRow[], days = 30): Record<string, ProviderSpend> {
  const out: Record<string, ProviderSpend> = {};
  for (const r of rows) {
    const b = (out[r.provider] ??= { cost: 0, calls: 0, unpricedCalls: 0, perDay: 0 });
    b.cost += r.cost_usd ?? 0;
    b.calls += r.calls;
    b.unpricedCalls += r.unpriced_calls;
  }
  const span = Math.max(1, days);
  for (const b of Object.values(out)) b.perDay = b.cost / span;
  return out;
}

export interface SpendBucket { cost: number; calls: number; unpriced: number }
export interface SpendSummary {
  cost: number;
  calls: number;
  unpricedCalls: number;
  areas: [string, SpendBucket][];
  sites: [string, SpendBucket & { area: string }][];
}

/**
 * Fold daily rows into per-area and per-call-site totals, biggest spend first.
 *
 * A null `cost_usd` contributes 0 to the money but the row's `unpriced_calls`
 * still lands in the bucket — so a bucket can honestly read "$0.00 from 400
 * calls we cannot price" rather than silently looking free.
 */
export function summarizeSpend(rows: AiSpendRow[], topSites = 12): SpendSummary {
  const byArea = new Map<string, SpendBucket>();
  const bySite = new Map<string, SpendBucket & { area: string }>();
  let cost = 0;
  let calls = 0;
  let unpricedCalls = 0;

  for (const r of rows) {
    const c = r.cost_usd ?? 0;
    cost += c;
    calls += r.calls;
    unpricedCalls += r.unpriced_calls;

    const a = byArea.get(r.area) ?? { cost: 0, calls: 0, unpriced: 0 };
    a.cost += c; a.calls += r.calls; a.unpriced += r.unpriced_calls;
    byArea.set(r.area, a);

    const site = bySite.get(r.call_site) ?? { cost: 0, calls: 0, unpriced: 0, area: r.area };
    site.cost += c; site.calls += r.calls; site.unpriced += r.unpriced_calls;
    bySite.set(r.call_site, site);
  }

  const byCostThenCalls = <T extends SpendBucket>(a: [string, T], b: [string, T]) =>
    b[1].cost - a[1].cost || b[1].calls - a[1].calls;

  return {
    cost,
    calls,
    unpricedCalls,
    areas: [...byArea.entries()].sort(byCostThenCalls),
    sites: [...bySite.entries()].sort(byCostThenCalls).slice(0, topSites),
  };
}

/** USD with two decimals and a thousands separator. Western digits, per house style. */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** USD for figures that can be fractions of a cent (per-call costs). */
export function usdPrecise(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return usd(n);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export const AREA_LABELS: Record<string, { ar: string; en: string }> = {
  sales: { ar: 'المبيعات', en: 'Sales' },
  translation: { ar: 'الترجمة', en: 'Translation' },
  marketing: { ar: 'التسويق', en: 'Marketing' },
  competitors: { ar: 'متابعة المنافسين', en: 'Competitor tracking' },
  internal: { ar: 'أدوات داخلية', en: 'Internal tools' },
  website: { ar: 'الموقع', en: 'Website' },
};

/** Localised area name, falling back to the raw slug for an area added later. */
export function areaLabel(area: string, isAr: boolean): string {
  const l = AREA_LABELS[area];
  return l ? (isAr ? l.ar : l.en) : area;
}

export const PROVIDER_LABELS: Record<string, { ar: string; en: string; billing: string }> = {
  anthropic: { ar: 'Anthropic', en: 'Anthropic', billing: 'console.anthropic.com' },
  deepseek: { ar: 'DeepSeek', en: 'DeepSeek', billing: 'platform.deepseek.com' },
  moonshot: { ar: 'Moonshot (Kimi)', en: 'Moonshot (Kimi)', billing: 'platform.moonshot.ai' },
  fal: { ar: 'fal.ai', en: 'fal.ai', billing: 'fal.ai/dashboard' },
  modal: { ar: 'Modal', en: 'Modal', billing: 'modal.com' },
  runner: { ar: 'اشتراك Claude', en: 'Claude subscription', billing: 'no API charge' },
};
