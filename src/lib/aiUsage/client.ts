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

export interface AiAccountBalance {
  id: string;
  provider: string;
  label: string;
  currency: string;
  is_active: boolean;
  low_balance_threshold: number | null;
  notes: string | null;
  credited_usd: number;
  tracking_since: string | null;
  last_topup_at: string | null;
  entry_count: number;
  spent_usd: number;
  remaining_usd: number;
  pct_used: number | null;
  unpriced_calls: number;
  total_calls: number;
  /** Some metered usage could not be priced — `remaining_usd` is a ceiling, not a figure. */
  remaining_is_upper_bound: boolean;
  is_low: boolean;
}

export interface AiAccountRunway {
  account_id: string;
  provider: string;
  spent_30d: number;
  unpriced_30d: number;
  avg_daily_usd: number;
  remaining_usd: number;
  /** null = no spend in the last 30 days, or nothing left to burn. */
  days_remaining: number | null;
}

export interface AiCreditEntry {
  id: string;
  account_id: string;
  kind: 'opening' | 'topup' | 'adjustment';
  amount_usd: number;
  effective_at: string;
  note: string | null;
  created_at: string;
}

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
 * Postgres returns `numeric` as a STRING through PostgREST (it is arbitrary
 * precision and would lose digits as a JS float). Coercing here rather than at
 * each render site is what stops `"90.50" - 0` style bugs downstream.
 */
function normalizeBalance(r: Record<string, unknown>): AiAccountBalance {
  return {
    id: String(r.id),
    provider: String(r.provider),
    label: String(r.label),
    currency: String(r.currency ?? 'USD'),
    is_active: Boolean(r.is_active),
    low_balance_threshold: numOrNull(r.low_balance_threshold),
    notes: (r.notes as string | null) ?? null,
    credited_usd: num(r.credited_usd),
    tracking_since: (r.tracking_since as string | null) ?? null,
    last_topup_at: (r.last_topup_at as string | null) ?? null,
    entry_count: num(r.entry_count),
    spent_usd: num(r.spent_usd),
    remaining_usd: num(r.remaining_usd),
    pct_used: numOrNull(r.pct_used),
    unpriced_calls: num(r.unpriced_calls),
    total_calls: num(r.total_calls),
    remaining_is_upper_bound: Boolean(r.remaining_is_upper_bound),
    is_low: Boolean(r.is_low),
  };
}

/**
 * Our computed remaining beside the provider's REAL balance.
 *
 * This is the only figure on the page that can catch spend the ledger never
 * saw. `ai_usage` reports the call sites somebody wired; starting from the
 * vendor's own balance catches the ones nobody did — which on 2026-09-15 was
 * an operator-run calibration batch worth 20x the app's whole daily spend.
 *
 * ALWAYS read `verdict` before `drift_usd`: most rows cannot support a
 * comparison at all, and a bare number would be read as though they could.
 */
export interface AiBalanceCheck {
  provider: string;
  label: string;
  ours_remaining_usd: number;
  provider_balance_usd: number | null;
  drift_usd: number | null;
  probe_checked_at: string | null;
  probe_source: string | null;
  probe_status: string | null;
  probe_error: string | null;
  verdict:
    | 'match'
    | 'UNMETERED_SPEND'
    | 'credit_added'
    | 'ours_is_upper_bound'
    | 'no_probe'
    | 'not_tracked'
    | 'stale_probe';
}

export interface AiUsageData {
  balances: AiAccountBalance[];
  runway: Record<string, AiAccountRunway>;
  spend: AiSpendRow[];
  unpriced: AiUnpricedModel[];
  checks: AiBalanceCheck[];
}

const EMPTY: AiUsageData = { balances: [], runway: {}, spend: [], unpriced: [], checks: [] };

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
      const [balancesRes, runwayRes, spendRes, unpricedRes, checksRes] = await Promise.all([
        supabase.from('v_ai_account_balances').select('*').order('provider'),
        supabase.from('v_ai_account_runway').select('*'),
        supabase.from('v_ai_usage_daily').select('*').gte('day', since).order('day', { ascending: false }),
        supabase.from('v_ai_usage_unpriced').select('*'),
        supabase.from('v_ai_balance_reconciliation').select('*').order('provider'),
      ]);

      const firstError =
        balancesRes.error ?? runwayRes.error ?? spendRes.error ?? unpricedRes.error ?? checksRes.error;
      if (firstError) throw new Error(firstError.message);

      const runway: Record<string, AiAccountRunway> = {};
      for (const r of (runwayRes.data ?? []) as Record<string, unknown>[]) {
        runway[String(r.account_id)] = {
          account_id: String(r.account_id),
          provider: String(r.provider),
          spent_30d: num(r.spent_30d),
          unpriced_30d: num(r.unpriced_30d),
          avg_daily_usd: num(r.avg_daily_usd),
          remaining_usd: num(r.remaining_usd),
          days_remaining: numOrNull(r.days_remaining),
        };
      }

      setData({
        balances: ((balancesRes.data ?? []) as Record<string, unknown>[]).map(normalizeBalance),
        runway,
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
          ours_remaining_usd: num(r.ours_remaining_usd),
          provider_balance_usd: numOrNull(r.provider_balance_usd),
          drift_usd: numOrNull(r.drift_usd),
          probe_checked_at: (r.probe_checked_at as string | null) ?? null,
          probe_source: (r.probe_source as string | null) ?? null,
          probe_status: (r.probe_status as string | null) ?? null,
          probe_error: (r.probe_error as string | null) ?? null,
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

/** Credit history for one account, newest first. */
export async function fetchCreditEntries(accountId: string): Promise<AiCreditEntry[]> {
  requireSupabase();
  const { data, error } = await supabase!
    .from('ai_credit_entries')
    .select('*')
    .eq('account_id', accountId)
    .order('effective_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    account_id: String(r.account_id),
    kind: r.kind as AiCreditEntry['kind'],
    amount_usd: num(r.amount_usd),
    effective_at: String(r.effective_at),
    note: (r.note as string | null) ?? null,
    created_at: String(r.created_at),
  }));
}

/** Record money going IN to an account. Throws on failure — callers toast it. */
export async function addCredit(input: {
  accountId: string;
  amountUsd: number;
  kind?: AiCreditEntry['kind'];
  effectiveAt?: string;
  note?: string;
}): Promise<string> {
  requireSupabase();
  const { data, error } = await supabase!.rpc('ai_credit_add', {
    p_account_id: input.accountId,
    p_amount_usd: input.amountUsd,
    p_kind: input.kind ?? 'topup',
    p_effective_at: input.effectiveAt ?? new Date().toISOString(),
    p_note: input.note ?? null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function deleteCredit(entryId: string): Promise<void> {
  requireSupabase();
  const { error } = await supabase!.rpc('ai_credit_delete', { p_entry_id: entryId });
  if (error) throw new Error(error.message);
}

export async function saveAccount(input: {
  id?: string;
  provider: string;
  label: string;
  threshold?: number | null;
  notes?: string | null;
  isActive?: boolean;
}): Promise<string> {
  requireSupabase();
  const { data, error } = await supabase!.rpc('ai_account_upsert', {
    p_provider: input.provider,
    p_label: input.label,
    p_id: input.id ?? null,
    p_threshold: input.threshold ?? null,
    p_notes: input.notes ?? null,
    p_is_active: input.isActive ?? true,
  });
  if (error) throw new Error(error.message);
  return String(data);
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

export interface AccountTotals {
  remaining: number;
  credited: number;
  spent: number;
  trackedCount: number;
  untrackedCount: number;
  /** Any tracked account resting on unpriced usage — `remaining` is a ceiling. */
  anyUpperBound: boolean;
  lowCount: number;
}

/**
 * Roll accounts into the headline figures.
 *
 * Accounts with no credit entries are EXCLUDED from every total: an untracked
 * account has no balance, and counting its zero would report "you have $0 left"
 * for something nobody has entered yet.
 */
export function summarizeAccounts(balances: AiAccountBalance[]): AccountTotals {
  const tracked = balances.filter((b) => b.entry_count > 0);
  return {
    remaining: tracked.reduce((s, b) => s + b.remaining_usd, 0),
    credited: tracked.reduce((s, b) => s + b.credited_usd, 0),
    spent: tracked.reduce((s, b) => s + b.spent_usd, 0),
    trackedCount: tracked.length,
    untrackedCount: balances.length - tracked.length,
    anyUpperBound: tracked.some((b) => b.remaining_is_upper_bound),
    lowCount: tracked.filter((b) => b.is_low).length,
  };
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
