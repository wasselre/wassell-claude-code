import { normalizePhoneDigits } from '@/lib/haberchat/normalize';
import {
  hasNoNextAction,
  isAtRisk,
  isClosedWon,
  isLostOrUnqualified,
  isOpen,
  isOverdue,
  type ClientView,
} from './clientView';

/**
 * Pure filtering, KPI, and view-preset logic for the Clients list. Operates on
 * already-resolved `ClientView[]` so it's fast and unit-testable.
 */

export type ClientListView = 'queue' | 'all' | 'at_risk' | 'closed_lost';

export type LifecycleSegment = 'all' | 'open' | 'lost' | 'closed';

export interface ClientFilters {
  search: string;
  ownerId: string | null;
  lifecycleHealth: string | null;
  stage: string | null;
  status: string | null;
  nextActionType: string | null;
  overdueOnly: boolean;
  noNextActionOnly: boolean;
  city: string | null;
  district: string | null;
  preferredUnitType: string | null;
  preferredProjectId: string | null;
  preferredMarketListingId: string | null;
  minVisitRating: number | null;
  segment: LifecycleSegment;
}

export const EMPTY_FILTERS: ClientFilters = {
  search: '',
  ownerId: null,
  lifecycleHealth: null,
  stage: null,
  status: null,
  nextActionType: null,
  overdueOnly: false,
  noNextActionOnly: false,
  city: null,
  district: null,
  preferredUnitType: null,
  preferredProjectId: null,
  preferredMarketListingId: null,
  minVisitRating: null,
  segment: 'all',
};

/** True when no filter is active (used to show "showing all" hints). */
export function filtersAreEmpty(f: ClientFilters): boolean {
  return (
    !f.search.trim() &&
    !f.ownerId &&
    !f.lifecycleHealth &&
    !f.stage &&
    !f.status &&
    !f.nextActionType &&
    !f.overdueOnly &&
    !f.noNextActionOnly &&
    !f.city &&
    !f.district &&
    !f.preferredUnitType &&
    !f.preferredProjectId &&
    !f.preferredMarketListingId &&
    f.minVisitRating === null &&
    f.segment === 'all'
  );
}

// ---------------------------------------------------------------------------
// View presets
// ---------------------------------------------------------------------------

/**
 * The base predicate for each saved view:
 *  - queue       → open + actionable (overdue OR no next action), worst first.
 *  - all         → everyone.
 *  - at_risk     → at-risk (bad visit rating / "visited another project").
 *  - closed_lost → terminal (closed-won or lost/unqualified).
 */
export function matchesView(view: ClientView, key: ClientListView, now: number = Date.now()): boolean {
  switch (key) {
    case 'queue':
      return isOpen(view) && (isOverdue(view, now) || hasNoNextAction(view));
    case 'at_risk':
      return isAtRisk(view) && !isClosedWon(view) && !isLostOrUnqualified(view);
    case 'closed_lost':
      return isClosedWon(view) || isLostOrUnqualified(view) || view.lifecycleHealth === 'closed';
    case 'all':
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Field filters
// ---------------------------------------------------------------------------

function matchesSearch(view: ClientView, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const name = (view.name ?? '').toLowerCase();
  if (name.includes(q)) return true;
  // Phone: digits-only compare so format differences don't block the match.
  // Strip a KSA local leading zero ("0551…" → "551…") so a locally-typed
  // number still matches a stored E.164 ("+966551…").
  const qDigits = normalizePhoneDigits(q).replace(/^0+/, '');
  if (qDigits.length >= 3) {
    const pDigits = normalizePhoneDigits(view.phone);
    if (pDigits && pDigits.includes(qDigits)) return true;
  }
  return false;
}

function matchesSegment(view: ClientView, segment: LifecycleSegment): boolean {
  switch (segment) {
    case 'open':
      return isOpen(view);
    case 'lost':
      return isLostOrUnqualified(view);
    case 'closed':
      return isClosedWon(view) || view.lifecycleHealth === 'closed';
    case 'all':
    default:
      return true;
  }
}

/** Apply the full filter set to a resolved client. `now` injectable for tests. */
export function clientMatchesFilters(view: ClientView, f: ClientFilters, now: number = Date.now()): boolean {
  if (!matchesSearch(view, f.search)) return false;
  if (f.ownerId && view.ownerId !== f.ownerId) return false;
  if (f.lifecycleHealth && view.lifecycleHealth !== f.lifecycleHealth) return false;
  if (f.stage && view.stage !== f.stage) return false;
  if (f.status && view.status !== f.status) return false;
  if (f.nextActionType && view.nextActionType !== f.nextActionType) return false;
  if (f.overdueOnly && !isOverdue(view, now)) return false;
  if (f.noNextActionOnly && !hasNoNextAction(view)) return false;
  if (f.city && view.preferredCity !== f.city) return false;
  if (f.district && (view.preferredDistrict ?? '').split('، ').indexOf(f.district) === -1) return false;
  if (f.preferredUnitType && !view.preferredUnitType.includes(f.preferredUnitType)) return false;
  if (f.preferredProjectId && !view.preferredProjects.some((p) => p.id === f.preferredProjectId)) return false;
  if (f.preferredMarketListingId && !view.preferredMarketListings.some((l) => l.id === f.preferredMarketListingId)) return false;
  if (f.minVisitRating !== null) {
    if (view.latestVisitRating === null || view.latestVisitRating < f.minVisitRating) return false;
  }
  if (!matchesSegment(view, f.segment)) return false;
  return true;
}

/** Filter a list through a view preset AND the field filters. */
export function filterClients(views: ClientView[], viewKey: ClientListView, filters: ClientFilters, now: number = Date.now()): ClientView[] {
  return views.filter((v) => matchesView(v, viewKey, now) && clientMatchesFilters(v, filters, now));
}

// ---------------------------------------------------------------------------
// Sorting (Sales Queue = most urgent first)
// ---------------------------------------------------------------------------

/**
 * Urgency rank for the Sales Queue: overdue first (oldest due first), then
 * no-next-action, then everyone else by soonest due. Stable for ties.
 */
export function compareByUrgency(a: ClientView, b: ClientView, now: number = Date.now()): number {
  const rank = (v: ClientView): number => {
    if (isOverdue(v, now)) return 0;
    if (hasNoNextAction(v)) return 1;
    return 2;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  const da = a.nextActionDueAt ? Date.parse(a.nextActionDueAt) : Infinity;
  const db = b.nextActionDueAt ? Date.parse(b.nextActionDueAt) : Infinity;
  const va = Number.isFinite(da) ? da : Infinity;
  const vb = Number.isFinite(db) ? db : Infinity;
  return va - vb;
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

export interface ClientKpis {
  total: number;
  open: number;
  overdue: number;
  noNextAction: number;
  closedWon: number;
  lostUnqualified: number;
  atRisk: number;
  withVisitRating: number;
}

/** Compute the top-of-page KPI counts from a resolved list. `now` injectable. */
export function computeKpis(views: ClientView[], now: number = Date.now()): ClientKpis {
  const kpis: ClientKpis = {
    total: views.length,
    open: 0,
    overdue: 0,
    noNextAction: 0,
    closedWon: 0,
    lostUnqualified: 0,
    atRisk: 0,
    withVisitRating: 0,
  };
  for (const v of views) {
    if (isOpen(v)) kpis.open += 1;
    if (isOverdue(v, now)) kpis.overdue += 1;
    if (hasNoNextAction(v)) kpis.noNextAction += 1;
    if (isClosedWon(v)) kpis.closedWon += 1;
    if (isLostOrUnqualified(v)) kpis.lostUnqualified += 1;
    if (isAtRisk(v)) kpis.atRisk += 1;
    if (typeof v.latestVisitRating === 'number' && v.latestVisitRating > 0) kpis.withVisitRating += 1;
  }
  return kpis;
}
