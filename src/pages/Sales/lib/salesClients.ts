// Sales-rep client tab logic for the My Clients workspace. Operates on resolved
// `ClientView`s (from the shared Clients resolver) enriched with related-record
// counts + a follow-up summary, so the tab predicates stay pure + testable.
//
// Tab → audience mapping (stages/statuses are the LIVE clients-model values):
//   all          → every assigned client.
//   interested   → active + early funnel: NOT yet serious (no visit, no
//                  appointment, no offer, no reservation, not a serious stage).
//   serious      → did more than ask: booked an appointment / visited / asked
//                  for or received an offer / has a reservation, or sits in a
//                  serious stage.
//   active       → still worth working: NOT unqualified / not-interested /
//                  inactive / long-no-response / lost / closed.
//   late         → has an overdue follow-up (scheduled before today, not done).
//   unqualified  → not useful for active selling: unqualified / not-interested /
//                  inactive / long-no-response / lost.

import type { AppModel, AppRecord } from '@/types';
import type { ClientView } from '@/pages/Clients/lib/clientView';
import { isClosedWon, isLostOrUnqualified } from '@/pages/Clients/lib/clientView';
import type { ClientFollowupSummary } from './myWork';
import { emptyFollowupSummary } from './myWork';

export type SalesClientTab = 'all' | 'interested' | 'serious' | 'active' | 'late' | 'unqualified';

export const SALES_TAB_ORDER: SalesClientTab[] = ['all', 'interested', 'serious', 'active', 'late', 'unqualified'];

export const SALES_TAB_LABELS: Record<SalesClientTab, { ar: string; en: string }> = {
  all: { ar: 'الكل / العملاء القدامى', en: 'All / Old Customers' },
  interested: { ar: 'عملاء مهتمون', en: 'Interested' },
  serious: { ar: 'عملاء جادون', en: 'Serious' },
  active: { ar: 'عملاء نشطون', en: 'Active' },
  late: { ar: 'عملاء متأخرون', en: 'Late' },
  unqualified: { ar: 'غير مؤهلون / غير نشطين', en: 'Unqualified / Inactive' },
};

// --- Live stage/status vocabularies (clients model) -------------------------

/** Terminal "failure / not-usable" stages. */
const LOST_STAGES = new Set(['غير مؤهل', 'خاسر']);
/** Stages that imply the client did more than ask for info. */
const SERIOUS_STAGES = new Set([
  'موعد زيارة',
  'زيارة',
  'متابعة بعد الزيارة',
  'عرض سعر',
  'حجز',
  'تمويل',
  'الإفراغ',
  'مغلق ناجح',
]);
/** Statuses that imply the client did more than ask for info. */
const SERIOUS_STATUSES = new Set([
  'تم حجز موعد',
  'تم تأكيد الحضور',
  'مهتم جدًا',
  'تم طلب عرض سعر',
  'تم إرسال عرض السعر',
  'تم توقيع عرض السعر',
  'تم استلام شيك الحجز',
  'تم إرسال نموذج الحجز',
  'تم توقيع نموذج الحجز',
  'تم الحجز',
  'بانتظار دفعة الحجز',
  'البنك',
  'التقييم',
  'تم إصدار نموذج الإفراغ',
  'تم الإفراغ',
]);
/** Statuses that make a client "inactive / not useful for active selling". */
const INACTIVE_STATUSES = new Set([
  'غير مهتم',
  'غير مؤهل',
  'بارد',
  'لا يوجد رد 10 مرات',
  'رقم خاطئ',
  'مكرر',
]);

export interface RelatedCounts {
  visits: number;
  appointments: number;
  offers: number;
  reservations: number;
  calls: number;
}

export const EMPTY_RELATED: RelatedCounts = { visits: 0, appointments: 0, offers: 0, reservations: 0, calls: 0 };

export interface SalesClient {
  view: ClientView;
  /** Human-facing Client ID (the `client_id` auto_id field), or null. */
  code: string | null;
  related: RelatedCounts;
  followup: ClientFollowupSummary;
}

// --- Predicates -------------------------------------------------------------

/** Pure junk that should never appear in working tabs (wrong number / dup). */
export function isJunk(sc: SalesClient): boolean {
  const st = sc.view.status ?? '';
  return st === 'رقم خاطئ' || st === 'مكرر';
}

/** Did the client take a serious action (beyond a basic inquiry)? */
export function isSerious(sc: SalesClient): boolean {
  if (sc.related.appointments > 0 || sc.related.visits > 0 || sc.related.offers > 0 || sc.related.reservations > 0) {
    return true;
  }
  const stage = sc.view.stage ?? '';
  const status = sc.view.status ?? '';
  return SERIOUS_STAGES.has(stage) || SERIOUS_STATUSES.has(status);
}

/** Still worth working: not terminal/lost/closed and not an inactive status. */
export function isActive(sc: SalesClient): boolean {
  const stage = sc.view.stage ?? '';
  const status = sc.view.status ?? '';
  if (LOST_STAGES.has(stage)) return false;
  if (isClosedWon(sc.view)) return false;
  if (sc.view.lifecycleHealth === 'closed') return false;
  if (INACTIVE_STATUSES.has(status)) return false;
  return true;
}

/** Early-funnel interested: active, but no serious action yet. */
export function isInterested(sc: SalesClient): boolean {
  return isActive(sc) && !isSerious(sc);
}

/** Not useful for active selling. */
export function isUnqualifiedInactive(sc: SalesClient): boolean {
  const stage = sc.view.stage ?? '';
  const status = sc.view.status ?? '';
  return LOST_STAGES.has(stage) || INACTIVE_STATUSES.has(status) || isLostOrUnqualified(sc.view);
}

/** Has an overdue follow-up (scheduled before today, not completed). */
export function isLate(sc: SalesClient): boolean {
  return sc.followup.late;
}

export function matchesSalesTab(sc: SalesClient, tab: SalesClientTab): boolean {
  switch (tab) {
    case 'interested':
      return isInterested(sc);
    case 'serious':
      return isSerious(sc) && !isJunk(sc);
    case 'active':
      return isActive(sc);
    case 'late':
      return isLate(sc);
    case 'unqualified':
      return isUnqualifiedInactive(sc);
    case 'all':
    default:
      return true;
  }
}

// --- Related-records index --------------------------------------------------

/**
 * Build a clientId → RelatedCounts index in one pass per related model. Each
 * related model links to clients through a lookup field whose
 * `lookup_model_id` is the clients model; we discover that slug per model so a
 * Builder rename degrades gracefully. Counts are keyed by the resolved bucket
 * (visits / appointments / offers / reservations / calls).
 */
const RELATED_MODEL_BUCKET: Record<string, keyof RelatedCounts> = {
  visits: 'visits',
  appointments: 'appointments',
  offer_prices: 'offers',
  reservations: 'reservations',
  phone_calls: 'calls',
};

function clientLookupSlugs(model: AppModel, clientsModelId: string): string[] {
  return model.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => f.type === 'lookup' && f.lookup_model_id === clientsModelId)
    .map((f) => f.name);
}

export function buildRelatedCountsIndex(
  models: AppModel[],
  records: Record<string, AppRecord[]>,
  clientsModelId: string,
): Map<string, RelatedCounts> {
  const index = new Map<string, RelatedCounts>();
  const bump = (clientId: string, bucket: keyof RelatedCounts) => {
    let c = index.get(clientId);
    if (!c) {
      c = { visits: 0, appointments: 0, offers: 0, reservations: 0, calls: 0 };
      index.set(clientId, c);
    }
    c[bucket] += 1;
  };

  for (const [modelName, bucket] of Object.entries(RELATED_MODEL_BUCKET)) {
    const model = models.find((m) => m.name === modelName);
    if (!model) continue;
    const slugs = clientLookupSlugs(model, clientsModelId);
    if (!slugs.length) continue;
    for (const r of records[model.id] ?? []) {
      const seen = new Set<string>();
      for (const slug of slugs) {
        const v = (r.data as Record<string, unknown>)[slug];
        const ids = Array.isArray(v) ? v : [v];
        for (const id of ids) {
          if (typeof id === 'string' && id && !seen.has(id)) {
            seen.add(id);
            bump(id, bucket);
          }
        }
      }
    }
  }
  return index;
}

/** Combine resolved views with the related + follow-up indexes. */
export function enrichClients(
  views: ClientView[],
  relatedIndex: Map<string, RelatedCounts>,
  followupIndex: Map<string, ClientFollowupSummary>,
  codeById?: Map<string, string | null>,
): SalesClient[] {
  return views.map((view) => ({
    view,
    code: codeById?.get(view.id) ?? null,
    related: relatedIndex.get(view.id) ?? EMPTY_RELATED,
    followup: followupIndex.get(view.id) ?? emptyFollowupSummary(),
  }));
}

export interface SalesTabCounts {
  all: number;
  interested: number;
  serious: number;
  active: number;
  late: number;
  unqualified: number;
}

/** Per-tab counts for the tab badges. */
export function computeTabCounts(clients: SalesClient[]): SalesTabCounts {
  const counts: SalesTabCounts = { all: clients.length, interested: 0, serious: 0, active: 0, late: 0, unqualified: 0 };
  for (const sc of clients) {
    if (matchesSalesTab(sc, 'interested')) counts.interested += 1;
    if (matchesSalesTab(sc, 'serious')) counts.serious += 1;
    if (matchesSalesTab(sc, 'active')) counts.active += 1;
    if (matchesSalesTab(sc, 'late')) counts.late += 1;
    if (matchesSalesTab(sc, 'unqualified')) counts.unqualified += 1;
  }
  return counts;
}
