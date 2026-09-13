/**
 * Weekly paid refresh cycles — the worker half (campaign planning, 2026-09-13).
 *
 * Three idempotent sweeps, driven by `worker/src/marketing/refreshLane.ts`:
 *
 *   1. `sweepDecisionsDue`  — a cycle whose `decision_due_on` has arrived gets
 *      its slate RANKED (§7.6, `marketing/creativeRanking.ts`), the DEFAULT
 *      decision written onto `mos_refresh_cycles.decision`, its status moved to
 *      `deciding`, and ONE `mos_manual_tasks` row (`kind='refresh_decision'`,
 *      `action='decide_refresh'`) opened for the marketing manager, due on the
 *      refresh date. The machine never decides — it pre-ticks the boxes.
 *   2. `applyDueCycles`     — a `decided` cycle (or a `deciding` one past its
 *      refresh date when `planning.auto_apply_default_decision` is on) is
 *      applied: the SQL `mos_refresh_cycle_apply` moves the database state,
 *      then the Meta swap runs in ONE order that can never dip the slate:
 *          activate replacements → poll effective_status=ACTIVE (≤5 min)
 *          → only then pause the outgoing ads.
 *      Fewer replacements ready than required → activate what is ready, keep
 *      the BEST-ranked outgoing creatives running so the active count never
 *      falls under `planning.min_active_creatives`, mark the cycle `partial`
 *      and open a task naming what is missing and when it is now due.
 *   3. `syncDailyAdMetrics` — ONE batched `getInsightsDaily('ad', …)` call per
 *      hour fills `mos_ad_metrics_daily` (14-day backfill on an empty account),
 *      which is what the ranking reads. One call an hour keeps the
 *      `development_access` budget (300/hour) untouched.
 *
 * Idempotence is the whole design: every step is derived from the CURRENT row
 * state (slot status, Meta's `effective_status`, the open-task lookup), never
 * from "did I already do this". A worker that dies mid-swap is re-run and
 * simply finds fewer things left to do (plan §23 case 8).
 *
 * The worker is a standalone package and CANNOT import from `api/_lib` or
 * `src/`: `riyadhToday`, the planning-settings reader and the ranking-settings
 * reader below are deliberate COPIES of
 * `api/_lib/marketing/planning/snapshot.ts` (same posture as
 * `worker/src/imageGen.ts`). Change both together.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadMetaConfig, MetaMarketingClient, leadsFromActions,
  type MetaInsightRow,
} from './marketing/metaMarketingApi.js';
import {
  rankCreatives, RANKING_DEFAULTS,
  type Bilingual, type CreativeRow, type MetricTotals, type RankingResult, type RankingSettings,
} from './marketing/creativeRanking.js';

export interface RefreshDeps {
  supabase: SupabaseClient;
  log: (msg: string, extra?: unknown) => void;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Small shared helpers                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const numOf = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Civil "today" in Riyadh — COPY of `api/_lib/marketing/planning/snapshot.ts`. */
export function riyadhToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * "This table/function is not in the database yet." The planning migration is
 * a separate workstream, so every sweep must be able to say so once and idle
 * instead of erroring every four seconds.
 */
export function isMissingObject(err: { code?: string | null; message?: string } | null): boolean {
  if (!err) return false;
  const code = err.code ?? '';
  if (code === '42P01' || code === '42883' || code === 'PGRST202' || code === 'PGRST205') return true;
  const m = (err.message ?? '').toLowerCase();
  return m.includes('does not exist') || m.includes('could not find the table') || m.includes('could not find the function');
}

export interface PlanningSettings {
  refreshLoopEnabled: boolean;
  autoApplyDefaultDecision: boolean;
  minActiveCreatives: number;
  adsCreatedPaused: boolean;
}

export const PLANNING_FALLBACK: PlanningSettings = {
  refreshLoopEnabled: true,
  autoApplyDefaultDecision: false,
  minActiveCreatives: 5,
  adsCreatedPaused: true,
};

/** COPY of the `planning` half of `loadPlanningSettings` (API side). */
export async function loadPlanningSettings(sb: SupabaseClient): Promise<PlanningSettings> {
  const { data, error } = await sb.from('mos_settings').select('value').eq('key', 'planning').maybeSingle();
  if (error) {
    console.error('[refresh] mos_settings.planning read failed', error.code, error.message, '— using defaults');
    return PLANNING_FALLBACK;
  }
  const v = ((data as { value?: Record<string, unknown> } | null)?.value ?? {}) as Record<string, unknown>;
  const bool = (x: unknown, d: boolean): boolean => (typeof x === 'boolean' ? x : d);
  const min = Number(v.min_active_creatives);
  return {
    refreshLoopEnabled: bool(v.refresh_loop_enabled, true),
    autoApplyDefaultDecision: bool(v.auto_apply_default_decision, false),
    minActiveCreatives: Number.isFinite(min) && min >= 0 ? min : PLANNING_FALLBACK.minActiveCreatives,
    adsCreatedPaused: bool(v.ads_created_paused, true),
  };
}

/** `mos_settings.ranking` (contract §6) with the PROPOSED defaults. */
export async function loadRankingSettings(sb: SupabaseClient): Promise<RankingSettings> {
  const { data, error } = await sb.from('mos_settings').select('value').eq('key', 'ranking').maybeSingle();
  if (error) {
    console.error('[refresh] mos_settings.ranking read failed', error.code, error.message, '— using defaults');
    return RANKING_DEFAULTS;
  }
  const v = ((data as { value?: Record<string, unknown> } | null)?.value ?? {}) as Record<string, unknown>;
  const pick = (x: unknown, d: number): number => {
    const n = Number(x);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    minSpendSar: pick(v.min_spend_sar, RANKING_DEFAULTS.minSpendSar),
    minImpressions: pick(v.min_impressions, RANKING_DEFAULTS.minImpressions),
    fatigueFrequency: pick(v.fatigue_frequency, RANKING_DEFAULTS.fatigueFrequency),
    fatigueCtrDropPct: pick(v.fatigue_ctr_drop_pct, RANKING_DEFAULTS.fatigueCtrDropPct),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Rows                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

export interface RefreshCycleRow {
  id: string;
  execution_id: string;
  round: number;
  refresh_on: string | null;
  ready_by: string | null;
  production_start_on: string | null;
  decision_due_on: string | null;
  status: string;
  decision: Record<string, unknown> | null;
}

interface AdRow {
  id: string;
  execution_id: string;
  content_id: string | null;
  label: string | null;
  platform_ad_id: string | null;
  status: string | null;
  placement_variant: string | null;
  pair_id: string | null;
  slot_id: string | null;
  created_at: string | null;
  activated_at: string | null;
}

const AD_FIELDS = 'id, execution_id, content_id, label, platform_ad_id, status, placement_variant, pair_id, slot_id, created_at, activated_at';

interface SlotRow {
  id: string;
  execution_id: string;
  cycle_id: string | null;
  slot_index: number | null;
  kind: string;
  status: string;
  content_id: string | null;
  ad_row_id: string | null;
  activate_on: string | null;
}

const SLOT_FIELDS = 'id, execution_id, cycle_id, slot_index, kind, status, content_id, ad_row_id, activate_on';

/* ────────────────────────────────────────────────────────────────────────── */
/* Tasks                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/** The marketing manager who owns refresh decisions. */
async function resolveMarketingManager(sb: SupabaseClient): Promise<string | null> {
  const roleRes = await sb.from('roles').select('id').eq('key', 'mos_marketing_manager').maybeSingle();
  if (roleRes.error) {
    console.error('[refresh] roles read failed:', roleRes.error.message);
    return null;
  }
  const roleId = str((roleRes.data as { id?: unknown } | null)?.id);
  if (!roleId) {
    console.error('[refresh] no mos_marketing_manager role row — a refresh decision has no owner');
    return null;
  }
  const usersRes = await sb.from('users').select('id, role_assignments').eq('is_active', true).order('id');
  if (usersRes.error) {
    console.error('[refresh] users read failed:', usersRes.error.message);
    return null;
  }
  for (const u of (usersRes.data ?? []) as Array<{ id: string; role_assignments: unknown }>) {
    const assigned = Array.isArray(u.role_assignments) ? u.role_assignments : [];
    // `role_assignments` is a jsonb array of ids OR of {role_id} objects — both
    // shapes exist in the wild (see api/_lib/workflowRunner.ts).
    const holds = assigned.some((a) => (typeof a === 'string' ? a === roleId : str((a as { role_id?: unknown })?.role_id) === roleId));
    if (holds) return u.id;
  }
  console.error('[refresh] no active user holds mos_marketing_manager — refresh decision tasks cannot be assigned');
  return null;
}

/**
 * One open task per (kind, entity). Re-running the sweep refreshes the title
 * and details of the open row instead of stacking duplicates.
 */
async function upsertEntityTask(sb: SupabaseClient, args: {
  kind: 'refresh_decision' | 'plan_conflict' | 'ad_failed';
  action: string;
  entityKind: string;
  entityId: string;
  title: string;
  details: string;
  assigneeUserId: string | null;
  dueAt: string | null;
  contentId?: string | null;
  campaignId?: string | null;
}, log: RefreshDeps['log']): Promise<void> {
  const now = new Date().toISOString();
  const open = await sb.from('mos_manual_tasks').select('id')
    .eq('kind', args.kind).eq('entity_id', args.entityId).eq('status', 'open')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (open.error) {
    console.error(`[refresh] ${args.kind} task read failed:`, open.error.code, open.error.message);
    return;
  }
  if (open.data) {
    const upd = await sb.from('mos_manual_tasks')
      .update({ title: args.title.slice(0, 200), details: args.details.slice(0, 2000), due_at: args.dueAt, updated_at: now })
      .eq('id', (open.data as { id: string }).id);
    if (upd.error) console.error(`[refresh] ${args.kind} task refresh failed:`, upd.error.message);
    else log(`${args.kind} task refreshed for ${args.entityKind} ${args.entityId}`);
    return;
  }
  if (!args.assigneeUserId) {
    console.error(`[refresh] ${args.kind} task NOT opened for ${args.entityKind} ${args.entityId} — no assignee could be resolved`);
    return;
  }
  const ins = await sb.from('mos_manual_tasks').insert({
    kind: args.kind,
    action: args.action,
    entity_kind: args.entityKind,
    entity_id: args.entityId,
    ref_id: args.entityId,
    title: args.title.slice(0, 200),
    details: args.details.slice(0, 2000),
    assignee_user_id: args.assigneeUserId,
    created_by_user_id: args.assigneeUserId,
    content_id: args.contentId ?? null,
    campaign_id: args.campaignId ?? null,
    status: 'open',
    due_at: args.dueAt,
  });
  if (ins.error) console.error(`[refresh] ${args.kind} task insert failed:`, ins.error.code, ins.error.message);
  else log(`${args.kind} task opened for ${args.entityKind} ${args.entityId}`);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 1. Decision sweep                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

interface DailyMetricRow {
  ad_row_id: string; day: string;
  spend: number | null; impressions: number | null; clicks: number | null;
  leads: number | null; reach: number | null; frequency: number | null;
}

/**
 * Window totals from the daily rows.
 *
 * MUST stay identical to the SQL `mos_creative_window_metrics` (same migration
 * as the tables): sums for spend/impressions/clicks/leads/reach and **max** for
 * frequency. Frequency is not additive (reach overlaps between days) and reach
 * summed across days over-counts unique people — but the number the manager
 * reads in the UI comes from that SQL function, so the worker's decision must
 * be computed from the SAME definition. One recipe, two implementations: drift
 * means the screen and the decision disagree.
 */
function totalsOf(rows: DailyMetricRow[]): MetricTotals {
  let spend = 0, impressions = 0, clicks = 0, leads = 0, reach = 0, frequency = 0;
  for (const r of rows) {
    spend += numOf(r.spend);
    impressions += numOf(r.impressions);
    clicks += numOf(r.clicks);
    leads += numOf(r.leads);
    reach += numOf(r.reach);
    frequency = Math.max(frequency, numOf(r.frequency));
  }
  return { spend, impressions, clicks, leads, reach, frequency };
}

/** The [since, until] window a cycle is judged on, plus the one before it. */
export function windowsFor(cycle: RefreshCycleRow, previousRefreshOn: string | null, executionStart: string | null): {
  current: { since: string; until: string };
  previous: { since: string; until: string };
} {
  const until = cycle.decision_due_on ?? riyadhToday();
  const start = previousRefreshOn ?? executionStart ?? addDays(until, -6);
  const since = daysBetween(start, until) >= 0 ? start : addDays(until, -6);
  const span = Math.max(1, daysBetween(since, until) + 1);
  return {
    current: { since, until },
    previous: { since: addDays(since, -span), until: addDays(since, -1) },
  };
}

/**
 * Rank one cycle's slate and write the DEFAULT decision. Returns the ranking so
 * the caller can log/report it; never touches Meta.
 */
export async function decideCycle(
  deps: RefreshDeps, cycle: RefreshCycleRow, settings: RankingSettings,
): Promise<RankingResult | null> {
  const { supabase: sb, log } = deps;

  const execRes = await sb.from('mos_campaign_executions')
    .select('id, campaign_id, starts_on').eq('id', cycle.execution_id).maybeSingle();
  if (execRes.error) {
    console.error('[refresh] execution read failed:', execRes.error.message);
    return null;
  }
  const exec = execRes.data as { id: string; campaign_id: string | null; starts_on: string | null } | null;

  const prevRes = await sb.from('mos_refresh_cycles')
    .select('refresh_on').eq('execution_id', cycle.execution_id).lt('round', cycle.round)
    .order('round', { ascending: false }).limit(1).maybeSingle();
  if (prevRes.error) console.error('[refresh] previous cycle read failed:', prevRes.error.message);
  const previousRefreshOn = str((prevRes.data as { refresh_on?: unknown } | null)?.refresh_on);

  const adsRes = await sb.from('mos_execution_ads').select(AD_FIELDS)
    .eq('execution_id', cycle.execution_id).is('archived_at', null);
  if (adsRes.error) {
    console.error('[refresh] execution ads read failed:', adsRes.error.message);
    return null;
  }
  const allAds = (adsRes.data ?? []) as AdRow[];
  // The slate = the PRIMARY rows on Meta (a 'story' shadow is the same creative
  // in a second ad set and is swapped with its primary, never ranked on its own).
  const onMeta = allAds.filter((a) => a.platform_ad_id && a.placement_variant !== 'story');
  const running = onMeta.filter((a) => a.status === 'running');
  const slate = running.length > 0 ? running : onMeta;
  if (running.length === 0 && onMeta.length > 0) {
    log(`cycle ${cycle.id}: no ad row is marked running — ranking all ${onMeta.length} ads on Meta instead`);
  }
  if (slate.length === 0) {
    log(`cycle ${cycle.id}: the child campaign has no creative on Meta — nothing to rank`);
  }

  const w = windowsFor(cycle, previousRefreshOn, exec?.starts_on ?? null);
  const ids = slate.map((a) => a.id);
  let metrics: DailyMetricRow[] = [];
  if (ids.length > 0) {
    const mRes = await sb.from('mos_ad_metrics_daily')
      .select('ad_row_id, day, spend, impressions, clicks, leads, reach, frequency')
      .in('ad_row_id', ids).gte('day', w.previous.since).lte('day', w.current.until);
    if (mRes.error) {
      console.error('[refresh] mos_ad_metrics_daily read failed:', mRes.error.code, mRes.error.message);
      return null;
    }
    metrics = (mRes.data ?? []) as DailyMetricRow[];
  }
  const inWindow = (r: DailyMetricRow, from: string, to: string): boolean => r.day >= from && r.day <= to;

  const rows: CreativeRow[] = slate.map((a) => ({
    adRowId: a.id,
    contentId: a.content_id,
    label: a.label,
    slotId: a.slot_id,
    createdAt: a.activated_at ?? a.created_at,
    current: totalsOf(metrics.filter((m) => m.ad_row_id === a.id && inWindow(m, w.current.since, w.current.until))),
    previous: totalsOf(metrics.filter((m) => m.ad_row_id === a.id && inWindow(m, w.previous.since, w.previous.until))),
  }));

  const ranking = rankCreatives(rows, w.current, settings);

  const decision = {
    ...(cycle.decision ?? {}),
    computed_at: new Date().toISOString(),
    source: 'default',
    window: ranking.window,
    settings: ranking.settings,
    ranked: ranking.ranked,
    unranked: ranking.unranked,
    default_keep: ranking.defaultKeep,
    default_replace: ranking.defaultReplace,
    // `keep` / `replace` are what APPLY reads; until a human decides they are
    // the defaults, so an auto-apply and a human confirm take the same path.
    keep: ranking.defaultKeep ? [ranking.defaultKeep] : [],
    replace: ranking.defaultReplace,
    reasons: ranking.reasons,
    summary: ranking.summary,
  };

  const upd = await sb.from('mos_refresh_cycles')
    .update({ decision, status: 'deciding', updated_at: new Date().toISOString() })
    .eq('id', cycle.id).in('status', ['scheduled', 'producing', 'ready']);
  if (upd.error) {
    console.error('[refresh] cycle decision write failed:', upd.error.code, upd.error.message);
    return null;
  }

  const readySlots = await sb.from('mos_creative_slots').select(SLOT_FIELDS).eq('cycle_id', cycle.id);
  if (readySlots.error) console.error('[refresh] cycle slots read failed:', readySlots.error.message);
  const slots = (readySlots.data ?? []) as SlotRow[];
  const readyCount = slots.filter((s) => s.status === 'ready').length;

  const manager = await resolveMarketingManager(sb);
  const dueAt = cycle.refresh_on ? `${cycle.refresh_on}T06:00:00.000Z` : null; // 09:00 Riyadh
  await upsertEntityTask(sb, {
    kind: 'refresh_decision',
    action: 'decide_refresh',
    entityKind: 'refresh_cycle',
    entityId: cycle.id,
    title: `قرار تحديث التصاميم — الجولة ${cycle.round} (${cycle.refresh_on ?? 'بلا تاريخ'})`,
    details: [
      ranking.summary.ar,
      ranking.summary.en,
      `البدائل الجاهزة: ${readyCount}/${slots.length}. / Ready replacements: ${readyCount} of ${slots.length}.`,
    ].join('\n'),
    assigneeUserId: manager,
    dueAt,
    campaignId: exec?.campaign_id ?? null,
  }, log);

  log(`cycle ${cycle.id} round ${cycle.round}: ranked ${ranking.ranked.length}, unranked ${ranking.unranked.length}, default keep=${ranking.defaultKeep ?? 'none'} replace=${ranking.defaultReplace.length} → deciding`);
  return ranking;
}

export async function sweepDecisionsDue(deps: RefreshDeps): Promise<number> {
  const { supabase: sb, log } = deps;
  const today = riyadhToday();
  const res = await sb.from('mos_refresh_cycles')
    .select('id, execution_id, round, refresh_on, ready_by, production_start_on, decision_due_on, status, decision')
    .lte('decision_due_on', today)
    .in('status', ['scheduled', 'producing', 'ready'])
    .order('decision_due_on', { ascending: true });
  if (res.error) {
    if (isMissingObject(res.error)) throw new MissingPlanningSchemaError(`mos_refresh_cycles: ${res.error.message}`);
    console.error('[refresh] due-cycle read failed:', res.error.code, res.error.message);
    return 0;
  }
  const cycles = (res.data ?? []) as RefreshCycleRow[];
  if (cycles.length === 0) return 0;
  const settings = await loadRankingSettings(sb);
  let done = 0;
  for (const c of cycles) {
    const r = await decideCycle(deps, c, settings);
    if (r) done += 1;
  }
  if (done > 0) log(`decision sweep: ${done}/${cycles.length} cycle(s) moved to deciding`);
  return done;
}

/** Thrown when the planning tables are not in this database yet. */
export class MissingPlanningSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingPlanningSchemaError';
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 2. Apply sweep — the swap                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const ACTIVE_POLL_MS = 10_000;
const ACTIVE_DEADLINE_MS = 5 * 60_000;

interface SwapPlan {
  /** Ready replacement ad rows to activate, in slot order. */
  activate: AdRow[];
  /** Outgoing ad rows the decision replaces, BEST-RANKED FIRST. */
  outgoing: AdRow[];
  /** How many replacements the decision asked for. */
  required: number;
}

/**
 * What the swap must do. The SQL `mos_refresh_cycle_apply` result is preferred
 * when it names the rows (`activate` / `pause`, or `to_activate` / `to_pause`);
 * otherwise the plan is DERIVED from the cycle's slots and its decision — so a
 * database whose RPC only moves statuses still swaps correctly.
 */
export function readApplyResult(applyResult: unknown): { activate: string[]; pause: string[] } | null {
  if (!applyResult || typeof applyResult !== 'object' || Array.isArray(applyResult)) return null;
  const o = applyResult as Record<string, unknown>;
  const ids = (v: unknown): string[] => (Array.isArray(v)
    ? v.map((x) => (typeof x === 'string' ? x : str((x as { ad_row_id?: unknown })?.ad_row_id))).filter((x): x is string => !!x)
    : []);
  const activate = ids(o.activate ?? o.to_activate ?? o.activated);
  const pause = ids(o.pause ?? o.to_pause ?? o.retire ?? o.retired);
  if (activate.length === 0 && pause.length === 0) return null;
  return { activate, pause };
}

async function buildSwapPlan(
  sb: SupabaseClient, cycle: RefreshCycleRow, applyResult: unknown, log: RefreshDeps['log'],
): Promise<SwapPlan> {
  const adsRes = await sb.from('mos_execution_ads').select(AD_FIELDS)
    .eq('execution_id', cycle.execution_id).is('archived_at', null);
  if (adsRes.error) throw new Error(`execution ads read: ${adsRes.error.message}`);
  const ads = (adsRes.data ?? []) as AdRow[];
  const byId = new Map(ads.map((a) => [a.id, a]));

  const slotsRes = await sb.from('mos_creative_slots').select(SLOT_FIELDS).eq('cycle_id', cycle.id)
    .order('slot_index', { ascending: true });
  if (slotsRes.error) throw new Error(`creative slots read: ${slotsRes.error.message}`);
  const slots = (slotsRes.data ?? []) as SlotRow[];

  const decision = (cycle.decision ?? {}) as Record<string, unknown>;
  const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const replaceIds = listOf(decision.replace).length > 0 ? listOf(decision.replace) : listOf(decision.default_replace);
  const rankedOrder = Array.isArray(decision.ranked)
    ? (decision.ranked as Array<{ adRowId?: unknown }>).map((r) => str(r?.adRowId)).filter((x): x is string => !!x)
    : [];

  const explicit = readApplyResult(applyResult);
  const activateIds = explicit?.activate.length
    ? explicit.activate
    : slots.filter((s) => s.ad_row_id && (s.status === 'ready' || s.status === 'active')).map((s) => s.ad_row_id as string);
  const pauseIds = explicit?.pause.length ? explicit.pause : replaceIds;
  if (explicit) log(`cycle ${cycle.id}: mos_refresh_cycle_apply named ${explicit.activate.length} to activate and ${explicit.pause.length} to pause`);

  const activate = activateIds.map((id) => byId.get(id)).filter((a): a is AdRow => !!a && !!a.platform_ad_id);
  const outgoing = pauseIds
    .map((id) => byId.get(id))
    .filter((a): a is AdRow => !!a && !!a.platform_ad_id && !activateIds.includes(a.id))
    // Best-ranked first, so "keep the best running" is just "pause from the end".
    .sort((a, b) => {
      const ia = rankedOrder.indexOf(a.id); const ib = rankedOrder.indexOf(b.id);
      return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
    });

  const requiredSlots = slots.filter((s) => s.kind === 'replacement' || s.kind === 'fifth').length;
  return { activate, outgoing, required: requiredSlots > 0 ? requiredSlots : pauseIds.length };
}

/** Every Meta ad id behind one Wassel ad row: the primary and its story shadow. */
function metaIdsOf(row: AdRow, all: AdRow[]): string[] {
  const out = [row.platform_ad_id].filter((x): x is string => !!x);
  for (const a of all) {
    if (a.pair_id === row.id && a.placement_variant === 'story' && a.platform_ad_id) out.push(a.platform_ad_id);
  }
  return out;
}

/**
 * Apply ONE cycle. The order is the contract:
 *   1. activate every ready replacement (and its story shadow);
 *   2. poll `effective_status` until ACTIVE — up to 5 minutes;
 *   3. ONLY THEN pause outgoing ads, and only as many as keeps the active count
 *      at or above `min_active_creatives`.
 * A replacement that never reaches ACTIVE never causes its counterpart to be
 * paused — step 3 simply has one fewer slot to spend.
 */
export async function applyCycle(
  deps: RefreshDeps, meta: MetaMarketingClient, cycle: RefreshCycleRow, planning: PlanningSettings,
): Promise<'applied' | 'partial' | 'skipped'> {
  const { supabase: sb, log } = deps;
  const now = (): string => new Date().toISOString();

  const rpc = await sb.rpc('mos_refresh_cycle_apply', { p_cycle_id: cycle.id });
  if (rpc.error) {
    if (isMissingObject(rpc.error)) throw new MissingPlanningSchemaError(`mos_refresh_cycle_apply: ${rpc.error.message}`);
    console.error(`[refresh] mos_refresh_cycle_apply(${cycle.id}) failed:`, rpc.error.code, rpc.error.message);
    return 'skipped';
  }

  const adsRes = await sb.from('mos_execution_ads').select(AD_FIELDS)
    .eq('execution_id', cycle.execution_id).is('archived_at', null);
  if (adsRes.error) {
    console.error('[refresh] execution ads read failed:', adsRes.error.message);
    return 'skipped';
  }
  const allAds = (adsRes.data ?? []) as AdRow[];
  const plan = await buildSwapPlan(sb, cycle, rpc.data, log);
  if (plan.activate.length === 0 && plan.outgoing.length === 0) {
    log(`cycle ${cycle.id}: nothing to swap (no ready replacement, nothing marked for replacement)`);
    return 'skipped';
  }

  // ── 1. activate ────────────────────────────────────────────────────────
  const attempted: AdRow[] = [];
  const activationErrors: string[] = [];
  for (const row of plan.activate) {
    const ids = metaIdsOf(row, allAds);
    try {
      for (const metaId of ids) await meta.setStatus(metaId, 'ACTIVE');
      attempted.push(row);
      log(`cycle ${cycle.id}: activation requested for ad row ${row.id} (${ids.join(', ')})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[refresh] activation failed for ad row ${row.id}:`, msg);
      activationErrors.push(`${row.label ?? row.id}: ${msg}`);
    }
  }

  // ── 2. verify ACTIVE before anything is paused ─────────────────────────
  const active: AdRow[] = [];
  if (attempted.length > 0) {
    const deadline = Date.now() + ACTIVE_DEADLINE_MS;
    const pending = new Map(attempted.map((a) => [a.id, a]));
    for (;;) {
      for (const [id, row] of [...pending]) {
        try {
          const v = await meta.getAdIssues(row.platform_ad_id as string);
          if (v.issues.length > 0) {
            activationErrors.push(`${row.label ?? id}: ${v.issues.join('; ')}`);
            pending.delete(id);
            console.error(`[refresh] replacement ${id} was flagged by Meta after activation: ${v.issues.join('; ')}`);
            continue;
          }
          if (v.status === 'ACTIVE') { active.push(row); pending.delete(id); }
        } catch (e) {
          console.error(`[refresh] effective_status poll failed for ${id}:`, e instanceof Error ? e.message : e);
        }
      }
      if (pending.size === 0 || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, ACTIVE_POLL_MS));
    }
    for (const [id, row] of pending) {
      activationErrors.push(`${row.label ?? id}: لم يصل إلى ACTIVE خلال ٥ دقائق / did not reach ACTIVE within 5 minutes`);
    }
  }

  // ── 3. pause outgoing — never below the minimum active count ───────────
  const runningNow = allAds.filter((a) => a.placement_variant !== 'story' && a.status === 'running').length;
  const activeAfter = runningNow + active.filter((a) => a.status !== 'running').length;
  const headroom = Math.max(0, activeAfter - planning.minActiveCreatives);
  const pauseCount = Math.min(active.length, plan.outgoing.length, headroom);
  // Best-ranked outgoing stay running: pause from the end of the ranked list.
  const toPause = plan.outgoing.slice(plan.outgoing.length - pauseCount);
  if (pauseCount < Math.min(active.length, plan.outgoing.length)) {
    log(`cycle ${cycle.id}: min_active_creatives=${planning.minActiveCreatives} caps the swap at ${pauseCount} pause(s) (active after activation ≈ ${activeAfter})`);
  }

  const paused: AdRow[] = [];
  for (const row of toPause) {
    const ids = metaIdsOf(row, allAds);
    try {
      for (const metaId of ids) await meta.setStatus(metaId, 'PAUSED');
      paused.push(row);
      log(`cycle ${cycle.id}: paused outgoing ad row ${row.id} (${ids.join(', ')})`);
    } catch (e) {
      console.error(`[refresh] pausing ${row.id} failed:`, e instanceof Error ? e.message : e);
    }
  }

  // ── 4. write the new state ─────────────────────────────────────────────
  for (const [i, row] of active.entries()) {
    const counterpart = paused[i] ?? null;
    const upd = await sb.from('mos_execution_ads')
      .update({ status: 'running', activated_at: row.activated_at ?? now(), updated_at: now() })
      .eq('id', row.id);
    if (upd.error) console.error(`[refresh] ad row ${row.id} activate write failed:`, upd.error.message);
    if (row.slot_id) {
      const s = await sb.from('mos_creative_slots')
        .update({ status: 'active', activated_at: now(), updated_at: now() }).eq('id', row.slot_id);
      if (s.error) console.error(`[refresh] slot ${row.slot_id} activate write failed:`, s.error.message);
    }
    if (counterpart) {
      const link = await sb.from('mos_execution_ads')
        .update({ replaced_by_ad_row_id: row.id, updated_at: now() }).eq('id', counterpart.id);
      if (link.error) console.error(`[refresh] replaced_by link failed for ${counterpart.id}:`, link.error.message);
    }
  }
  for (const row of paused) {
    const upd = await sb.from('mos_execution_ads')
      .update({ status: 'paused', retired_at: now(), updated_at: now() }).eq('id', row.id);
    if (upd.error) console.error(`[refresh] ad row ${row.id} pause write failed:`, upd.error.message);
    if (row.slot_id) {
      const s = await sb.from('mos_creative_slots')
        .update({ status: 'retired', retired_at: now(), updated_at: now() }).eq('id', row.slot_id);
      if (s.error) console.error(`[refresh] slot ${row.slot_id} retire write failed:`, s.error.message);
    }
  }

  // ── 5. cycle outcome ───────────────────────────────────────────────────
  const missing = Math.max(0, plan.required - active.length);
  const outcome: 'applied' | 'partial' = missing === 0 && activationErrors.length === 0 ? 'applied' : 'partial';
  const decision = {
    ...((cycle.decision ?? {}) as Record<string, unknown>),
    applied: active.map((a) => a.id),
    paused: paused.map((a) => a.id),
    activation_errors: activationErrors,
    applied_at: now(),
  };
  const upd = await sb.from('mos_refresh_cycles')
    .update({ status: outcome, decision, updated_at: now() }).eq('id', cycle.id);
  if (upd.error) console.error(`[refresh] cycle ${cycle.id} status write failed:`, upd.error.message);

  if (outcome === 'partial') {
    const manager = await resolveMarketingManager(sb);
    const readyDates = await nextReadyDates(sb, cycle);
    const detail: Bilingual = {
      ar: `تأخر ${missing} من بدائل التحديث. المفعّل: ${active.length} من ${plan.required}. ${readyDates.ar}${activationErrors.length ? ` أخطاء: ${activationErrors.join(' | ')}` : ''}`,
      en: `${missing} refresh replacement(s) are late. Activated ${active.length} of ${plan.required}. ${readyDates.en}${activationErrors.length ? ` Errors: ${activationErrors.join(' | ')}` : ''}`,
    };
    await upsertEntityTask(sb, {
      kind: 'plan_conflict',
      action: 'review_partial_refresh',
      entityKind: 'refresh_cycle',
      entityId: cycle.id,
      title: `تأخر ${missing} من بدائل التحديث — الجولة ${cycle.round}`,
      details: `${detail.ar}\n${detail.en}`,
      assigneeUserId: manager,
      dueAt: cycle.refresh_on ? `${cycle.refresh_on}T06:00:00.000Z` : null,
    }, log);
  }

  log(`cycle ${cycle.id}: ${outcome} — activated ${active.length}, paused ${paused.length}, missing ${missing}`);
  return outcome;
}

/** "What is missing and when it is now due" for the partial-cycle task. */
async function nextReadyDates(sb: SupabaseClient, cycle: RefreshCycleRow): Promise<Bilingual> {
  const res = await sb.from('mos_creative_slots').select(SLOT_FIELDS).eq('cycle_id', cycle.id)
    .not('status', 'in', '("active","ready","released")');
  if (res.error) {
    console.error('[refresh] pending-slot read failed:', res.error.message);
    return { ar: '', en: '' };
  }
  const slots = (res.data ?? []) as SlotRow[];
  if (slots.length === 0) return { ar: '', en: '' };
  const contentIds = slots.map((s) => s.content_id).filter((x): x is string => !!x);
  const dueByContent = new Map<string, string>();
  if (contentIds.length > 0) {
    const plans = await sb.from('mos_content_plan').select('content_id, required_ready_at').in('content_id', contentIds);
    if (plans.error) console.error('[refresh] mos_content_plan read failed:', plans.error.message);
    for (const p of (plans.data ?? []) as Array<{ content_id: string; required_ready_at: string | null }>) {
      if (p.required_ready_at) dueByContent.set(p.content_id, p.required_ready_at.slice(0, 10));
    }
  }
  const parts = slots.map((s) => {
    const due = (s.content_id ? dueByContent.get(s.content_id) : null) ?? s.activate_on ?? null;
    return `#${s.slot_index ?? '?'} (${s.status}) → ${due ?? 'بلا تاريخ / no date'}`;
  });
  return {
    ar: `المتبقّي: ${parts.join('، ')}.`,
    en: `Outstanding: ${parts.join('; ')}.`,
  };
}

export async function applyDueCycles(deps: RefreshDeps, meta: MetaMarketingClient, planning: PlanningSettings): Promise<number> {
  const { supabase: sb, log } = deps;
  const today = riyadhToday();
  // `decided` = a human confirmed. `applying` = a previous run died mid-swap and
  // must be resumed (idempotent). `deciding` past its refresh date is applied
  // only when the operator turned auto-apply on.
  const statuses = ['decided', 'applying'];
  if (planning.autoApplyDefaultDecision) statuses.push('deciding');
  const res = await sb.from('mos_refresh_cycles')
    .select('id, execution_id, round, refresh_on, ready_by, production_start_on, decision_due_on, status, decision')
    .in('status', statuses)
    .order('refresh_on', { ascending: true });
  if (res.error) {
    if (isMissingObject(res.error)) throw new MissingPlanningSchemaError(`mos_refresh_cycles: ${res.error.message}`);
    console.error('[refresh] apply-cycle read failed:', res.error.code, res.error.message);
    return 0;
  }
  const cycles = ((res.data ?? []) as RefreshCycleRow[]).filter((c) => (
    c.status !== 'deciding' || (c.refresh_on != null && c.refresh_on <= today)
  ));
  let applied = 0;
  for (const c of cycles) {
    if (c.status === 'deciding') {
      log(`cycle ${c.id}: auto_apply_default_decision is ON and ${c.refresh_on} has arrived — applying the DEFAULT decision`);
    }
    const outcome = await applyCycle(deps, meta, c, planning);
    if (outcome !== 'skipped') applied += 1;
  }
  return applied;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 3. Daily per-ad metrics                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/** One insights call an hour is plenty for a daily series, and it keeps the
 *  `development_access` budget (300 calls/hour) essentially untouched. */
export const METRICS_MIN_INTERVAL_MS = 60 * 60_000;
export const METRICS_BACKFILL_DAYS = 14;

export interface MetricsSyncOutcome {
  skipped: boolean;
  reason?: string;
  since?: string;
  until?: string;
  rows?: number;
  upserted?: number;
}

/**
 * Pull ONE batched day-by-day insights window for the whole ad account and
 * upsert it into `mos_ad_metrics_daily`. Idempotent: the PK is
 * `(ad_row_id, day)` and every run re-pulls yesterday as well, so late
 * attribution corrects itself instead of freezing the first number Meta said.
 */
export async function syncDailyAdMetrics(deps: RefreshDeps, meta: MetaMarketingClient): Promise<MetricsSyncOutcome> {
  const { supabase: sb, log } = deps;
  const today = riyadhToday();

  const last = await sb.from('mos_ad_metrics_daily')
    .select('day, synced_at').order('synced_at', { ascending: false }).limit(1).maybeSingle();
  if (last.error) {
    if (isMissingObject(last.error)) throw new MissingPlanningSchemaError(`mos_ad_metrics_daily: ${last.error.message}`);
    console.error('[refresh] metrics watermark read failed:', last.error.code, last.error.message);
    return { skipped: true, reason: 'watermark read failed' };
  }
  const watermark = last.data as { day: string; synced_at: string | null } | null;
  if (watermark?.synced_at) {
    const age = Date.now() - Date.parse(watermark.synced_at);
    if (Number.isFinite(age) && age < METRICS_MIN_INTERVAL_MS) {
      return { skipped: true, reason: `synced ${Math.round(age / 60_000)} min ago` };
    }
  }

  // No rows at all → the 14-day backfill. Otherwise re-pull from the day
  // before the watermark (late conversions land on their original day).
  const since = watermark?.day ? addDays(watermark.day, -1) : addDays(today, -(METRICS_BACKFILL_DAYS - 1));
  const rows = await meta.getInsightsDaily('ad', since, today);
  log(`metrics: ${rows.length} ad-day row(s) from Meta for ${since} → ${today}${watermark ? '' : ' (first run: 14-day backfill)'}`);
  if (rows.length === 0) return { skipped: false, since, until: today, rows: 0, upserted: 0 };

  const metaAdIds = [...new Set(rows.map((r) => r.ad_id).filter((x): x is string => !!x))];
  const adRows = await sb.from('mos_execution_ads').select('id, platform_ad_id')
    .in('platform_ad_id', metaAdIds);
  if (adRows.error) {
    console.error('[refresh] ad-row lookup failed:', adRows.error.message);
    return { skipped: true, reason: 'ad-row lookup failed' };
  }
  const rowIdByMetaId = new Map(
    ((adRows.data ?? []) as Array<{ id: string; platform_ad_id: string | null }>)
      .filter((a) => a.platform_ad_id)
      .map((a) => [a.platform_ad_id as string, a.id]),
  );

  const syncedAt = new Date().toISOString();
  const payload = rows.flatMap((r: MetaInsightRow) => {
    const adRowId = r.ad_id ? rowIdByMetaId.get(r.ad_id) : undefined;
    const day = str((r as { date_start?: unknown }).date_start);
    if (!adRowId || !day) return [];
    return [{
      ad_row_id: adRowId,
      day,
      spend: numOf(r.spend),
      impressions: numOf(r.impressions),
      clicks: numOf(r.clicks),
      leads: leadsFromActions(r.actions),
      reach: numOf(r.reach),
      frequency: numOf(r.frequency),
      synced_at: syncedAt,
    }];
  });
  const unmatched = rows.length - payload.length;
  if (unmatched > 0) {
    // Ads that exist on Meta but not in our tables (hand-made in Ads Manager,
    // or synced later) are NOT an error — but they are worth saying out loud,
    // because a large number means the sync is missing rows.
    log(`metrics: ${unmatched} row(s) had no matching mos_execution_ads row (ads made outside the app?)`);
  }
  if (payload.length === 0) return { skipped: false, since, until: today, rows: rows.length, upserted: 0 };

  const up = await sb.from('mos_ad_metrics_daily').upsert(payload, { onConflict: 'ad_row_id,day' });
  if (up.error) {
    console.error('[refresh] mos_ad_metrics_daily upsert failed:', up.error.code, up.error.message);
    return { skipped: true, reason: `upsert failed: ${up.error.message}` };
  }
  log(`metrics: upserted ${payload.length} ad-day row(s)`);
  return { skipped: false, since, until: today, rows: rows.length, upserted: payload.length };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* One tick                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export interface RefreshTickResult {
  decided: number;
  applied: number;
  metrics: MetricsSyncOutcome | null;
  /** Sweeps whose table or function is not in this database yet. */
  missing: string[];
}

/**
 * ONE pass of all three sweeps. The lane calls this; keeping it here makes the
 * lane a scheduler and nothing else.
 *
 * Each sweep is independent: an object the planning migration has not created
 * yet (e.g. `mos_refresh_cycle_apply` lands after the tables) disables THAT
 * sweep only. The whole lane backs off only when every sweep it could run is
 * missing its schema.
 */
export async function runRefreshCycleTick(deps: RefreshDeps): Promise<RefreshTickResult> {
  const planning = await loadPlanningSettings(deps.supabase);
  if (!planning.refreshLoopEnabled) {
    return { decided: 0, applied: 0, metrics: { skipped: true, reason: 'planning.refresh_loop_enabled is off' }, missing: [] };
  }
  const cfg = loadMetaConfig();
  const meta = cfg ? new MetaMarketingClient(cfg) : null;
  if (!meta) deps.log('apply + metrics skipped — the worker has no Meta credentials (decisions still run)');

  const missing: string[] = [];
  /** Run one sweep; a missing object disables that sweep, never the lane. */
  const guarded = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof MissingPlanningSchemaError) {
        missing.push(`${label}: ${e.message}`);
        return fallback;
      }
      throw e;
    }
  };

  const decided = await guarded('decisions', () => sweepDecisionsDue(deps), 0);
  const applied = meta ? await guarded('apply', () => applyDueCycles(deps, meta, planning), 0) : 0;
  const metrics = meta ? await guarded('metrics', () => syncDailyAdMetrics(deps, meta), null as MetricsSyncOutcome | null) : null;

  const attempted = 1 + (meta ? 2 : 0);
  if (missing.length >= attempted) {
    throw new MissingPlanningSchemaError(missing.join(' | '));
  }
  return { decided, applied, metrics, missing };
}
