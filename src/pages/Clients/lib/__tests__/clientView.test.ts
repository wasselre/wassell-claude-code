import { describe, it, expect } from 'vitest';
import {
  resolveClientView,
  isGenericMode,
  isDerivedReadOnly,
  isOverdue,
  hasNoNextAction,
  isClosedWon,
  isLostOrUnqualified,
  isAtRisk,
  isOpen,
  countRelatedByModelName,
  buildClientTimeline,
  DERIVED_READONLY_SLUGS,
} from '../clientView';
import { makeWorld, clientRecord, genericRecord } from './fixtures';

const NOW = Date.parse('2026-06-20T12:00:00Z');

describe('resolveClientView — sparse client', () => {
  it('returns null/empty for every fact without throwing', () => {
    const { ctx, clientsModel } = makeWorld();
    const client = clientRecord(clientsModel.id, {});
    ctx.records[clientsModel.id] = [client];

    const v = resolveClientView(client, ctx);
    expect(v.name).toBeNull();
    expect(v.phone).toBeNull();
    expect(v.ownerId).toBeNull();
    expect(v.ownerName).toBeNull();
    expect(v.stage).toBeNull();
    expect(v.status).toBeNull();
    expect(v.lifecycleHealth).toBeNull();
    expect(v.nextActionType).toBeNull();
    expect(v.nextActionDueAt).toBeNull();
    expect(v.nextFollowupId).toBeNull();
    expect(v.lastActivityAt).toBeNull();
    expect(v.lostReason).toBeNull();
    expect(v.lostAt).toBeNull();
    expect(v.latestVisitRating).toBeNull();
    expect(v.latestVisitRatedAt).toBeNull();
    expect(v.preferredUnitType).toEqual([]);
    expect(v.budget).toBeNull();
    expect(v.preferredCity).toBeNull();
    expect(v.preferredDirection).toEqual([]);
    expect(v.preferredDistrict).toBeNull();
    expect(v.preferredProjects).toEqual([]);
    expect(v.preferredMarketListings).toEqual([]);
  });
});

describe('resolveClientView — populated client', () => {
  it('resolves scalar facts and the owner name', () => {
    const { ctx, clientsModel } = makeWorld();
    const client = clientRecord(clientsModel.id, {
      client_name: 'Acme Buyer',
      phone_number: '+966555444333',
      client_owner: 'user-1',
      client_stage: 'زيارة',
      client_status: 'مهتم',
      lifecycle_health: 'overdue',
      next_action_type: 'call',
      next_action_due_at: '2026-06-10T09:00:00Z',
      budget: { min: 800000, max: 1200000 },
      preferred_unit_type: ['فيلا', 'شقة'],
      preferred_direction: ['شمال'],
    });
    ctx.records[clientsModel.id] = [client];

    const v = resolveClientView(client, ctx);
    expect(v.name).toBe('Acme Buyer');
    expect(v.phone).toBe('+966555444333');
    expect(v.ownerName).toBe('Salem');
    expect(v.stage).toBe('زيارة');
    expect(v.lifecycleHealth).toBe('overdue');
    expect(v.budget).toEqual({ min: 800000, max: 1200000 });
    expect(v.preferredUnitType).toEqual(['فيلا', 'شقة']);
    expect(v.preferredDirection).toEqual(['شمال']);
  });
});

describe('preferred_projects vs preferred_market_listings separation', () => {
  it('resolves each from its own target model and never cross-pollutes', () => {
    const { ctx, clientsModel, projectsModel, listingsModel } = makeWorld();
    ctx.records[projectsModel.id] = [genericRecord(projectsModel.id, 'proj-1', { project_name: 'Marina Towers' })];
    ctx.records[listingsModel.id] = [genericRecord(listingsModel.id, 'listing-1', { title: 'Aqar Villa 12' })];

    const client = clientRecord(clientsModel.id, {
      preferred_projects: ['proj-1'],
      preferred_market_listings: ['listing-1'],
    });
    ctx.records[clientsModel.id] = [client];

    const v = resolveClientView(client, ctx);
    expect(v.preferredProjects).toEqual([{ id: 'proj-1', name: 'Marina Towers' }]);
    expect(v.preferredMarketListings).toEqual([{ id: 'listing-1', name: 'Aqar Villa 12' }]);

    // The project id must never leak into the listings array, and vice versa.
    expect(v.preferredMarketListings.some((l) => l.id === 'proj-1')).toBe(false);
    expect(v.preferredProjects.some((p) => p.id === 'listing-1')).toBe(false);
  });

  it('keeps ids with unresolved names (target not loaded) — no fabrication', () => {
    const { ctx, clientsModel } = makeWorld();
    const client = clientRecord(clientsModel.id, { preferred_projects: ['missing-proj'] });
    ctx.records[clientsModel.id] = [client];
    const v = resolveClientView(client, ctx);
    expect(v.preferredProjects).toEqual([{ id: 'missing-proj', name: null }]);
  });
});

describe('lifecycle predicates', () => {
  const base = { stage: null, lifecycleHealth: null, nextFollowupId: null, nextActionDueAt: null, status: null, latestVisitRating: null } as const;

  it('isOverdue: lifecycle flag, past due, future due, closed', () => {
    expect(isOverdue({ ...base, lifecycleHealth: 'overdue' }, NOW)).toBe(true);
    expect(isOverdue({ ...base, nextActionDueAt: '2026-06-10T00:00:00Z' }, NOW)).toBe(true);
    expect(isOverdue({ ...base, nextActionDueAt: '2026-07-10T00:00:00Z' }, NOW)).toBe(false);
    expect(isOverdue({ ...base, lifecycleHealth: 'closed', nextActionDueAt: '2026-06-10T00:00:00Z' }, NOW)).toBe(false);
    expect(isOverdue(base, NOW)).toBe(false);
  });

  it('hasNoNextAction: lifecycle flag, no followup+no due, has followup', () => {
    expect(hasNoNextAction({ ...base, lifecycleHealth: 'no_next_action' })).toBe(true);
    expect(hasNoNextAction(base)).toBe(true);
    expect(hasNoNextAction({ ...base, nextFollowupId: 'fu-1' })).toBe(false);
    expect(hasNoNextAction({ ...base, lifecycleHealth: 'closed' })).toBe(false);
  });

  it('closed-won / lost / at-risk / open by stage + status', () => {
    expect(isClosedWon({ stage: 'مغلق ناجح' })).toBe(true);
    expect(isLostOrUnqualified({ stage: 'خاسر' })).toBe(true);
    expect(isLostOrUnqualified({ stage: 'غير مؤهل' })).toBe(true);
    expect(isAtRisk({ latestVisitRating: 2, status: null })).toBe(true);
    expect(isAtRisk({ latestVisitRating: 5, status: null })).toBe(false);
    expect(isAtRisk({ latestVisitRating: null, status: 'زار مشروعًا آخر — للمراجعة' })).toBe(true);
    expect(isOpen({ stage: 'زيارة', lifecycleHealth: 'on_track' })).toBe(true);
    expect(isOpen({ stage: 'خاسر', lifecycleHealth: null })).toBe(false);
    expect(isOpen({ stage: 'زيارة', lifecycleHealth: 'closed' })).toBe(false);
  });
});

describe('derived read-only fields', () => {
  it('flags every derived slug and excludes ordinary preference fields', () => {
    for (const slug of DERIVED_READONLY_SLUGS) {
      expect(isDerivedReadOnly(slug)).toBe(true);
    }
    expect(isDerivedReadOnly('budget')).toBe(false);
    expect(isDerivedReadOnly('preferred_projects')).toBe(false);
    expect(isDerivedReadOnly('client_name')).toBe(false);
  });

  it('covers exactly the nine documented derived fields', () => {
    expect([...DERIVED_READONLY_SLUGS].sort()).toEqual(
      [
        'last_activity_at',
        'latest_visit_rated_at',
        'latest_visit_rating',
        'lifecycle_health',
        'lost_at',
        'lost_reason',
        'next_action_due_at',
        'next_action_type',
        'next_followup_id',
      ].sort(),
    );
  });
});

describe('isGenericMode (?generic=1 escape hatch)', () => {
  it('detects the flag from a query string or params', () => {
    expect(isGenericMode('?generic=1')).toBe(true);
    expect(isGenericMode('generic=1')).toBe(true);
    expect(isGenericMode(new URLSearchParams('generic=1'))).toBe(true);
    expect(isGenericMode('?generic=0')).toBe(false);
    expect(isGenericMode('?foo=bar')).toBe(false);
    expect(isGenericMode('')).toBe(false);
    expect(isGenericMode(null)).toBe(false);
  });
});

describe('related counts + timeline', () => {
  it('counts linked follow-ups, null when the model is absent', () => {
    const { ctx, clientsModel, followupsModel } = makeWorld();
    const client = clientRecord(clientsModel.id, {});
    ctx.records[clientsModel.id] = [client];
    ctx.records[followupsModel.id] = [
      genericRecord(followupsModel.id, 'fu-1', { client_link: client.id, scheduled_datetime: '2026-06-05T10:00:00Z', notes: 'Called', followup_status: 'completed' }),
      genericRecord(followupsModel.id, 'fu-2', { client_link: 'someone-else' }),
    ];
    expect(countRelatedByModelName(ctx, client.id, 'followups')).toBe(1);
    expect(countRelatedByModelName(ctx, client.id, 'visits')).toBeNull(); // model absent

    const timeline = buildClientTimeline(ctx, client.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.modelName).toBe('followups');
    expect(timeline[0]?.href).toBe(`/model/followups/fu-1`);
    expect(timeline[0]?.date).toBe('2026-06-05T10:00:00Z');
  });
});
