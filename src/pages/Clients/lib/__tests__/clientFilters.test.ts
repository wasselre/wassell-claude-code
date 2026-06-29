import { describe, it, expect } from 'vitest';
import type { ClientView } from '../clientView';
import {
  EMPTY_FILTERS,
  clientMatchesFilters,
  filterClients,
  matchesView,
  computeKpis,
  compareByUrgency,
  filtersAreEmpty,
} from '../clientFilters';

const NOW = Date.parse('2026-06-20T12:00:00Z');

function view(partial: Partial<ClientView>): ClientView {
  return {
    id: 'c1',
    name: null,
    phone: null,
    ownerId: null,
    ownerName: null,
    stage: null,
    status: null,
    lifecycleHealth: null,
    nextActionType: null,
    nextActionDueAt: null,
    nextFollowupId: null,
    lastActivityAt: null,
    lostReason: null,
    lostAt: null,
    latestVisitRating: null,
    latestVisitRatedAt: null,
    preferredUnitType: [],
    budget: null,
    preferredCity: null,
    preferredDirection: [],
    preferredDistrict: null,
    preferredProjects: [],
    preferredMarketListings: [],
    counts: { followups: null, visits: null, appointments: null, calls: null },
    ...partial,
  };
}

describe('search filter', () => {
  it('matches by name (case-insensitive) and phone digits', () => {
    const v = view({ id: 'x', name: 'Mohammed Ali', phone: '+966 55 123 4567' });
    expect(clientMatchesFilters(v, { ...EMPTY_FILTERS, search: 'mohammed' }, NOW)).toBe(true);
    expect(clientMatchesFilters(v, { ...EMPTY_FILTERS, search: '0551234567' }, NOW)).toBe(true);
    expect(clientMatchesFilters(v, { ...EMPTY_FILTERS, search: '1234' }, NOW)).toBe(true);
    expect(clientMatchesFilters(v, { ...EMPTY_FILTERS, search: 'zzz' }, NOW)).toBe(false);
  });
});

describe('field filters', () => {
  it('filters by owner, stage, next action type, overdue, project/listing', () => {
    const v = view({
      ownerId: 'u1',
      stage: 'زيارة',
      nextActionType: 'call',
      lifecycleHealth: 'overdue',
      preferredProjects: [{ id: 'p1', name: 'Marina' }],
      preferredMarketListings: [{ id: 'l1', name: 'Villa' }],
    });
    expect(clientMatchesFilters(v, { ...EMPTY_FILTERS, ownerId: 'u1' }, NOW)).toBe(true);
    expect(clientMatchesFilters(v, { ...EMPTY_FILTERS, ownerId: 'u2' }, NOW)).toBe(false);
    expect(clientMatchesFilters(v, { ...EMPTY_FILTERS, stage: 'زيارة' }, NOW)).toBe(true);
    expect(clientMatchesFilters(v, { ...EMPTY_FILTERS, nextActionType: 'call' }, NOW)).toBe(true);
    expect(clientMatchesFilters(v, { ...EMPTY_FILTERS, overdueOnly: true }, NOW)).toBe(true);
    expect(clientMatchesFilters(v, { ...EMPTY_FILTERS, preferredProjectId: 'p1' }, NOW)).toBe(true);
    expect(clientMatchesFilters(v, { ...EMPTY_FILTERS, preferredProjectId: 'l1' }, NOW)).toBe(false);
    expect(clientMatchesFilters(v, { ...EMPTY_FILTERS, preferredMarketListingId: 'l1' }, NOW)).toBe(true);
  });

  it('filters by minimum visit rating', () => {
    expect(clientMatchesFilters(view({ latestVisitRating: 4 }), { ...EMPTY_FILTERS, minVisitRating: 4 }, NOW)).toBe(true);
    expect(clientMatchesFilters(view({ latestVisitRating: 2 }), { ...EMPTY_FILTERS, minVisitRating: 4 }, NOW)).toBe(false);
    expect(clientMatchesFilters(view({ latestVisitRating: null }), { ...EMPTY_FILTERS, minVisitRating: 1 }, NOW)).toBe(false);
  });

  it('segment open/lost/closed', () => {
    expect(clientMatchesFilters(view({ stage: 'زيارة' }), { ...EMPTY_FILTERS, segment: 'open' }, NOW)).toBe(true);
    expect(clientMatchesFilters(view({ stage: 'خاسر' }), { ...EMPTY_FILTERS, segment: 'lost' }, NOW)).toBe(true);
    expect(clientMatchesFilters(view({ stage: 'مغلق ناجح' }), { ...EMPTY_FILTERS, segment: 'closed' }, NOW)).toBe(true);
    expect(clientMatchesFilters(view({ stage: 'خاسر' }), { ...EMPTY_FILTERS, segment: 'open' }, NOW)).toBe(false);
  });
});

describe('view presets', () => {
  const overdueOpen = view({ stage: 'زيارة', lifecycleHealth: 'overdue' });
  const noAction = view({ stage: 'زيارة', lifecycleHealth: 'no_next_action' });
  const onTrack = view({ stage: 'زيارة', lifecycleHealth: 'on_track', nextFollowupId: 'fu1', nextActionDueAt: '2026-07-01T00:00:00Z' });
  const lost = view({ stage: 'خاسر' });
  const atRisk = view({ stage: 'زيارة', latestVisitRating: 1 });

  it('queue = open + actionable', () => {
    expect(matchesView(overdueOpen, 'queue', NOW)).toBe(true);
    expect(matchesView(noAction, 'queue', NOW)).toBe(true);
    expect(matchesView(onTrack, 'queue', NOW)).toBe(false);
    expect(matchesView(lost, 'queue', NOW)).toBe(false);
  });
  it('at_risk and closed_lost', () => {
    expect(matchesView(atRisk, 'at_risk', NOW)).toBe(true);
    expect(matchesView(lost, 'at_risk', NOW)).toBe(false);
    expect(matchesView(lost, 'closed_lost', NOW)).toBe(true);
    expect(matchesView(onTrack, 'closed_lost', NOW)).toBe(false);
  });
  it('all matches everything', () => {
    [overdueOpen, noAction, onTrack, lost, atRisk].forEach((v) => expect(matchesView(v, 'all', NOW)).toBe(true));
  });

  it('filterClients composes view + filters', () => {
    const list = [overdueOpen, noAction, onTrack, lost, atRisk];
    const q = filterClients(list, 'queue', EMPTY_FILTERS, NOW);
    expect(q).toContain(overdueOpen);
    expect(q).toContain(noAction);
    expect(q).not.toContain(onTrack);
    expect(q).not.toContain(lost);
  });
});

describe('KPIs', () => {
  it('counts each segment', () => {
    const list = [
      view({ stage: 'زيارة', lifecycleHealth: 'overdue' }),
      view({ stage: 'زيارة', lifecycleHealth: 'no_next_action' }),
      view({ stage: 'مغلق ناجح' }),
      view({ stage: 'خاسر' }),
      // at-risk by rating but still actively managed (has a next action)
      view({ stage: 'زيارة', lifecycleHealth: 'on_track', nextFollowupId: 'fu', nextActionDueAt: '2026-07-01T00:00:00Z', latestVisitRating: 1 }),
    ];
    const k = computeKpis(list, NOW);
    expect(k.total).toBe(5);
    expect(k.overdue).toBe(1);
    expect(k.noNextAction).toBe(1);
    expect(k.closedWon).toBe(1);
    expect(k.lostUnqualified).toBe(1);
    expect(k.atRisk).toBe(1);
    expect(k.withVisitRating).toBe(1);
    // open = not terminal: the 3 visit-stage rows (overdue, no_next_action, at-risk)
    expect(k.open).toBe(3);
  });
});

describe('urgency sort', () => {
  it('overdue first (oldest due), then no-action, then soonest due', () => {
    const overdueOld = view({ id: 'a', lifecycleHealth: 'overdue', nextActionDueAt: '2026-06-01T00:00:00Z' });
    const overdueNew = view({ id: 'b', lifecycleHealth: 'overdue', nextActionDueAt: '2026-06-10T00:00:00Z' });
    const none = view({ id: 'c', lifecycleHealth: 'no_next_action' });
    const future = view({ id: 'd', lifecycleHealth: 'on_track', nextFollowupId: 'x', nextActionDueAt: '2026-07-01T00:00:00Z' });
    const sorted = [future, none, overdueNew, overdueOld].sort((x, y) => compareByUrgency(x, y, NOW));
    expect(sorted.map((v) => v.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('filtersAreEmpty', () => {
  it('true for the empty filter set, false once a filter is set', () => {
    expect(filtersAreEmpty(EMPTY_FILTERS)).toBe(true);
    expect(filtersAreEmpty({ ...EMPTY_FILTERS, search: 'x' })).toBe(false);
    expect(filtersAreEmpty({ ...EMPTY_FILTERS, segment: 'open' })).toBe(false);
  });
});
