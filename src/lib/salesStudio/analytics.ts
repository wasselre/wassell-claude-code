// Sales Studio funnel analytics — REAL metrics computed in-memory from the
// store's records for a COHORT of clients (a process, a process version, or an
// experiment group). No invented numbers: a metric that can't be computed from
// the available data is returned `available:false` with a reason, never faked.
//
// "Reached a milestone" is approximated as: the client's CURRENT stage is at or
// past the milestone stage, OR the client has a linked downstream record of that
// kind (appointment / visit / offer / reservation / financing / ownership). We
// only have the client's current stage (no stage history), so this is an honest
// "ever reached" lower bound — documented, not hidden.

import type { AppRecord } from '@/types';
import { DEFAULT_SALES_PROCESS } from '@/lib/salesProcess';
import { readFollowupType } from '@/pages/Followups/lib/followupContext';
import { computeNoNextAction } from '@/pages/Sales/lib/queueViews';

export interface MetricResult {
  value: number | null;
  available: boolean;
  reason?: string;        // why unavailable
  numerator?: number;
  denominator?: number;
  /** 'rate' (0..1), 'count', or 'days'. */
  unit: 'rate' | 'count' | 'days';
}

export type FunnelMetricKey =
  | 'lead_count'
  | 'appointment_booking_rate'
  | 'appointment_confirmation_rate'
  | 'visit_rate'
  | 'offer_request_rate'
  | 'reservation_rate'
  | 'financing_started_rate'
  | 'closed_won_rate'
  | 'lost_rate'
  | 'unqualified_rate'
  | 'whatsapp_response_rate'
  | 'no_answer_rate'
  | 'touches_per_client'
  | 'time_to_appointment'
  | 'time_to_offer'
  | 'time_to_close'
  | 'no_next_action_count'
  | 'rep_workload';

export type SalesFunnelResult = Record<FunnelMetricKey, MetricResult>;

export interface FunnelDownstream {
  appointments?: AppRecord[];
  visits?: AppRecord[];
  offers?: AppRecord[];
  reservations?: AppRecord[];
  financing?: AppRecord[];
  ownership?: AppRecord[];
}

export interface FunnelContext {
  followups: AppRecord[];
  downstream?: FunnelDownstream;
  now: number;
}

// Stage order from the canonical config (Arabic stage values). Keyed by plain
// string so a raw client_stage value can be looked up without a union cast.
const STAGE_ORDER = new Map<string, number>(DEFAULT_SALES_PROCESS.stages.map((s) => [s.value, s.order]));
const ORDER_APPOINTMENT = 2; // موعد زيارة
const ORDER_VISIT = 3;       // زيارة
const ORDER_OFFER = 5;       // عرض سعر
const ORDER_RESERVATION = 6; // حجز
const ORDER_FINANCING = 7;   // تمويل
const CLOSED_WON = 'مغلق ناجح';
const LOST = 'خاسر';
const UNQUALIFIED = 'غير مؤهل';
const CONFIRMED_STATUS = 'تم تأكيد الحضور';

const DAY_MS = 24 * 3600 * 1000;

function readLinkClientId(r: AppRecord): string | null {
  const v = r.data.client_id;
  if (Array.isArray(v)) return (v[0] as string) ?? null;
  return typeof v === 'string' ? v : null;
}

function ms(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

function rate(num: number, den: number, unit: MetricResult['unit'] = 'rate'): MetricResult {
  if (den <= 0) return { value: null, available: false, reason: 'no_leads', numerator: num, denominator: den, unit };
  return { value: num / den, available: true, numerator: num, denominator: den, unit };
}

function unavailable(reason: string, unit: MetricResult['unit'] = 'rate'): MetricResult {
  return { value: null, available: false, reason, unit };
}

function clientIdSet(records: AppRecord[] | undefined, cohort: Set<string>): Set<string> {
  const out = new Set<string>();
  if (!records) return out;
  for (const r of records) {
    const cid = readLinkClientId(r);
    if (cid && cohort.has(cid)) out.add(cid);
  }
  return out;
}

/** Average days between client.created_at and the EARLIEST linked downstream record. */
function avgDaysToEvent(
  cohortClients: AppRecord[],
  events: AppRecord[] | undefined,
  cohort: Set<string>,
): MetricResult {
  if (!events || events.length === 0) return unavailable('no_event_records', 'days');
  const earliestByClient = new Map<string, number>();
  for (const e of events) {
    const cid = readLinkClientId(e);
    if (!cid || !cohort.has(cid)) continue;
    const t = ms(e.created_at) ?? ms(e.data.created_at);
    if (t == null) continue;
    const prev = earliestByClient.get(cid);
    if (prev == null || t < prev) earliestByClient.set(cid, t);
  }
  const clientCreated = new Map(cohortClients.map((c) => [c.id, ms(c.created_at)]));
  let sum = 0, n = 0;
  for (const [cid, eventT] of earliestByClient) {
    const created = clientCreated.get(cid);
    if (created == null) continue;
    const days = (eventT - created) / DAY_MS;
    if (days >= 0) { sum += days; n++; }
  }
  if (n === 0) return unavailable('no_dated_events', 'days');
  return { value: sum / n, available: true, numerator: n, denominator: cohortClients.length, unit: 'days' };
}

/**
 * Compute the full funnel for a cohort of client records.
 */
export function computeSalesFunnel(cohortClients: AppRecord[], ctx: FunnelContext): SalesFunnelResult {
  const cohort = new Set(cohortClients.map((c) => c.id));
  const leads = cohortClients.length;
  const ds = ctx.downstream ?? {};

  // Downstream presence sets (client ids with a linked record of each kind).
  const hasAppt = clientIdSet(ds.appointments, cohort);
  const hasVisit = clientIdSet(ds.visits, cohort);
  const hasOffer = clientIdSet(ds.offers, cohort);
  const hasReservation = clientIdSet(ds.reservations, cohort);
  const hasFinancing = clientIdSet(ds.financing, cohort);
  const hasOwnership = clientIdSet(ds.ownership, cohort);

  const stageOrderOf = (c: AppRecord) => STAGE_ORDER.get(c.data.client_stage as string) ?? -1;

  let reachedAppt = 0, confirmed = 0, reachedVisit = 0, reachedOffer = 0,
      reachedReservation = 0, reachedFinancing = 0, closedWon = 0, lost = 0, unqualified = 0;

  for (const c of cohortClients) {
    const ord = stageOrderOf(c);
    const status = c.data.client_status as string;
    const id = c.id;
    if (ord >= ORDER_APPOINTMENT || hasAppt.has(id)) reachedAppt++;
    if (status === CONFIRMED_STATUS || ord >= ORDER_VISIT || hasVisit.has(id)) confirmed++;
    if (ord >= ORDER_VISIT || hasVisit.has(id)) reachedVisit++;
    if (ord >= ORDER_OFFER || hasOffer.has(id)) reachedOffer++;
    if (ord >= ORDER_RESERVATION || hasReservation.has(id)) reachedReservation++;
    if (ord >= ORDER_FINANCING || hasFinancing.has(id)) reachedFinancing++;
    if ((c.data.client_stage as string) === CLOSED_WON || hasOwnership.has(id)) closedWon++;
    if ((c.data.client_stage as string) === LOST) lost++;
    if ((c.data.client_stage as string) === UNQUALIFIED) unqualified++;
  }

  // Follow-up-derived metrics (cohort-scoped).
  const cohortFollowups = ctx.followups.filter((f) => {
    const cid = readLinkClientId(f);
    return cid != null && cohort.has(cid);
  });

  const RESPONSE_OUTCOMES = new Set([
    'interested', 'request_offer', 'appointment_booked', 'recontact_later', 'wrong_time', 'not_interested',
  ]);
  let waSent = 0, waResponded = 0, bookingCompleted = 0, bookingNoAnswer = 0, openFollowups = 0;
  const reps = new Set<string>();
  for (const f of cohortFollowups) {
    const d = f.data;
    const type = readFollowupType(d);
    const status = (d.followup_status as string) || 'open';
    const cr = d.call_result as string;
    const rep = d.sales_rep as string;
    if (rep) reps.add(rep);
    if (status === 'open' || status === 'in_progress') openFollowups++;
    if (type === 'whatsapp_follow_up') {
      const sent = !!d.whatsapp_state || status === 'completed';
      if (sent) waSent++;
      if (status === 'completed' && RESPONSE_OUTCOMES.has(cr)) waResponded++;
    }
    if (type === 'appointment_booking_call' && status === 'completed') {
      bookingCompleted++;
      if (cr === 'no_answer') bookingNoAnswer++;
    }
  }

  const noNextAction = computeNoNextAction(cohortClients, ctx.followups).length;

  return {
    lead_count: { value: leads, available: true, unit: 'count' },
    appointment_booking_rate: rate(reachedAppt, leads),
    appointment_confirmation_rate: rate(confirmed, leads),
    visit_rate: rate(reachedVisit, leads),
    offer_request_rate: rate(reachedOffer, leads),
    reservation_rate: rate(reachedReservation, leads),
    financing_started_rate: rate(reachedFinancing, leads),
    closed_won_rate: rate(closedWon, leads),
    lost_rate: rate(lost, leads),
    unqualified_rate: rate(unqualified, leads),
    whatsapp_response_rate: waSent > 0
      ? rate(waResponded, waSent)
      : unavailable('no_whatsapp_followups'),
    no_answer_rate: bookingCompleted > 0
      ? rate(bookingNoAnswer, bookingCompleted)
      : unavailable('no_booking_calls'),
    touches_per_client: leads > 0
      ? { value: cohortFollowups.length / leads, available: true, numerator: cohortFollowups.length, denominator: leads, unit: 'count' }
      : unavailable('no_leads', 'count'),
    time_to_appointment: avgDaysToEvent(cohortClients, ds.appointments, cohort),
    time_to_offer: avgDaysToEvent(cohortClients, ds.offers, cohort),
    time_to_close: avgDaysToEvent(cohortClients, ds.ownership, cohort),
    no_next_action_count: { value: noNextAction, available: true, unit: 'count' },
    rep_workload: reps.size > 0
      ? { value: openFollowups / reps.size, available: true, numerator: openFollowups, denominator: reps.size, unit: 'count' }
      : unavailable('no_reps', 'count'),
  };
}

// ── experiment comparison ─────────────────────────────────────────────────────

/** Metrics where a HIGHER number is better (the rest are guardrails: lower better). */
const HIGHER_IS_BETTER = new Set<FunnelMetricKey>([
  'appointment_booking_rate', 'appointment_confirmation_rate', 'visit_rate',
  'offer_request_rate', 'reservation_rate', 'financing_started_rate',
  'closed_won_rate', 'whatsapp_response_rate',
]);
// For time_to_* a LOWER number is better (faster).

const MIN_SAMPLE = 30;          // below this per group, call it inconclusive
const REL_THRESHOLD = 0.05;     // 5% relative change to call a direction

export type ExperimentRecommendation =
  | 'promote_variant'
  | 'reject_variant'
  | 'keep_testing'
  | 'inconclusive';

export interface MetricComparison {
  key: FunnelMetricKey;
  control: MetricResult;
  variant: MetricResult;
  /** signed relative delta (variant - control)/control, or null when n/a. */
  delta_rel: number | null;
  /** true when variant is directionally better on this metric. */
  variant_better: boolean | null;
}

export interface ExperimentComparison {
  primary_metric: FunnelMetricKey | null;
  primary: MetricComparison | null;
  guardrail_warnings: Array<{ key: FunnelMetricKey; message_ar: string; message_en: string }>;
  recommendation: ExperimentRecommendation;
  low_sample: boolean;
  winner: 'control' | 'variant' | 'tie' | null;
}

function compareMetric(key: FunnelMetricKey, control: MetricResult, variant: MetricResult): MetricComparison {
  if (!control.available || !variant.available || control.value == null || variant.value == null || control.value === 0) {
    const variant_better = control.value != null && variant.value != null
      ? (HIGHER_IS_BETTER.has(key) ? variant.value > control.value
         : key.startsWith('time_to') ? variant.value < control.value
         : variant.value < control.value)
      : null;
    return { key, control, variant, delta_rel: null, variant_better };
  }
  const delta_rel = (variant.value - control.value) / control.value;
  const higherBetter = HIGHER_IS_BETTER.has(key);
  const lowerBetter = !higherBetter; // guardrails + time_to_*
  const variant_better = higherBetter ? variant.value > control.value : lowerBetter ? variant.value < control.value : null;
  return { key, control, variant, delta_rel, variant_better };
}

const GUARDRAIL_KEYS: FunnelMetricKey[] = [
  'lost_rate', 'unqualified_rate', 'no_answer_rate', 'no_next_action_count', 'touches_per_client', 'rep_workload',
];

const METRIC_LABEL: Partial<Record<FunnelMetricKey, { ar: string; en: string }>> = {
  lost_rate: { ar: 'نسبة الخسارة', en: 'Lost rate' },
  unqualified_rate: { ar: 'نسبة غير المؤهلين', en: 'Unqualified rate' },
  no_answer_rate: { ar: 'نسبة عدم الرد', en: 'No-answer rate' },
  no_next_action_count: { ar: 'بدون إجراء تالٍ', en: 'No next action' },
  touches_per_client: { ar: 'لمسات لكل عميل', en: 'Touches per client' },
  rep_workload: { ar: 'حمل المندوب', en: 'Rep workload' },
};

export function compareExperiment(
  control: SalesFunnelResult,
  variant: SalesFunnelResult,
  primaryMetric: FunnelMetricKey | null,
  guardrails: FunnelMetricKey[],
): ExperimentComparison {
  const controlN = control.lead_count.value ?? 0;
  const variantN = variant.lead_count.value ?? 0;
  const low_sample = controlN < MIN_SAMPLE || variantN < MIN_SAMPLE;

  const primary = primaryMetric ? compareMetric(primaryMetric, control[primaryMetric], variant[primaryMetric]) : null;

  const guardrail_warnings: ExperimentComparison['guardrail_warnings'] = [];
  const checkSet = new Set<FunnelMetricKey>([...GUARDRAIL_KEYS, ...guardrails]);
  for (const key of checkSet) {
    const cmp = compareMetric(key, control[key], variant[key]);
    // Guardrail breach = variant is WORSE (variant_better === false) by > threshold.
    if (cmp.variant_better === false && cmp.delta_rel != null && Math.abs(cmp.delta_rel) > REL_THRESHOLD) {
      const lbl = METRIC_LABEL[key] ?? { ar: key, en: key };
      guardrail_warnings.push({
        key,
        message_ar: `تحذير حارس: ${lbl.ar} أسوأ في المجموعة المتغيّرة بنسبة ${Math.round(Math.abs(cmp.delta_rel) * 100)}%`,
        message_en: `Guardrail: ${lbl.en} is worse in the variant by ${Math.round(Math.abs(cmp.delta_rel) * 100)}%`,
      });
    }
  }

  let recommendation: ExperimentRecommendation = 'keep_testing';
  let winner: ExperimentComparison['winner'] = null;
  if (low_sample) {
    recommendation = 'inconclusive';
  } else if (primary && primary.delta_rel != null) {
    const meaningful = Math.abs(primary.delta_rel) > REL_THRESHOLD;
    if (meaningful && primary.variant_better && guardrail_warnings.length === 0) {
      recommendation = 'promote_variant';
      winner = 'variant';
    } else if (meaningful && primary.variant_better === false) {
      recommendation = 'reject_variant';
      winner = 'control';
    } else if (meaningful && primary.variant_better && guardrail_warnings.length > 0) {
      recommendation = 'keep_testing'; // better primary but guardrail breach → don't promote yet
      winner = 'variant';
    } else {
      recommendation = 'keep_testing';
      winner = 'tie';
    }
  }

  return {
    primary_metric: primaryMetric,
    primary,
    guardrail_warnings,
    recommendation,
    low_sample,
    winner,
  };
}

export const RECOMMENDATION_LABEL: Record<ExperimentRecommendation, { ar: string; en: string }> = {
  promote_variant: { ar: 'رقّ المجموعة المتغيّرة', en: 'Promote variant' },
  reject_variant: { ar: 'ارفض المجموعة المتغيّرة', en: 'Reject variant' },
  keep_testing: { ar: 'واصل الاختبار', en: 'Keep testing' },
  inconclusive: { ar: 'غير حاسم (عينة صغيرة)', en: 'Inconclusive (low sample)' },
};
