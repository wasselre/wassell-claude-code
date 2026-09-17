import { describe, it, expect } from 'vitest';
import type { AppModel, AppRecord } from '@/types';
import type { ClientViewCtx } from '@/pages/Clients/lib/clientView';
import {
  buildActiveClientDemand, clientsInterestedInProject, computeOpportunityGaps,
} from '../demandAggregation';

// Minimal clients model — resolveClientView reads stage/status/lifecycle from
// RAW data, so an empty-schema model is enough to exercise the active filter.
const clientsModel = { id: 'm-clients', name: 'clients', schema: { sections: [] } } as unknown as AppModel;
const ctx: ClientViewCtx = { models: [clientsModel], records: {}, users: [], language: 'en' };

function client(id: string, data: Record<string, unknown>): AppRecord {
  return { id, model_id: 'm-clients', data } as unknown as AppRecord;
}
function project(id: string, data: Record<string, unknown>): AppRecord {
  return { id, model_id: 'm-all', data } as unknown as AppRecord;
}

// An unambiguously ACTIVE base client (early-funnel, interested).
const activeBase = { client_stage: 'موعد زيارة', client_status: 'مهتم', location: { district: ['d1'] } };

describe('buildActiveClientDemand — canonical active filter', () => {
  it('includes an active client and captures its demand atoms', () => {
    const c = client('c1', { ...activeBase, preferred_unit_type: ['شقة'], budget: { min: 500000, max: 900000 }, preferred_projects: ['p9'] });
    const d = buildActiveClientDemand([c], ctx, []);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ clientId: 'c1', districtIds: ['d1'], unitTypes: ['شقة'], preferredProjectIds: ['p9'] });
    expect(d[0]!.budget).toEqual({ min: 500000, max: 900000 });
  });

  it('EXCLUDES lost/unqualified STAGES', () => {
    for (const stage of ['خاسر', 'غير مؤهل']) {
      expect(buildActiveClientDemand([client('x', { ...activeBase, client_stage: stage })], ctx, [])).toHaveLength(0);
    }
  });

  it('EXCLUDES the closed-won stage', () => {
    expect(buildActiveClientDemand([client('x', { ...activeBase, client_stage: 'مغلق ناجح' })], ctx, [])).toHaveLength(0);
  });

  it('EXCLUDES lifecycle_health = closed', () => {
    expect(buildActiveClientDemand([client('x', { ...activeBase, lifecycle_health: 'closed' })], ctx, [])).toHaveLength(0);
  });

  it('EXCLUDES every inactive STATUS', () => {
    for (const status of ['غير مهتم', 'غير مؤهل', 'بارد', 'لا يوجد رد 10 مرات', 'رقم خاطئ', 'مكرر']) {
      expect(buildActiveClientDemand([client('x', { ...activeBase, client_status: status })], ctx, [])).toHaveLength(0);
    }
  });

  it('folds a preferred project’s district into the client’s demand districts', () => {
    const p = project('p9', { location: { district: ['d2'] } });
    const c = client('c1', { ...activeBase, location: { district: ['d1'] }, preferred_projects: ['p9'] });
    const d = buildActiveClientDemand([c], ctx, [p]);
    expect(d[0]!.districtIds.sort()).toEqual(['d1', 'd2']);
  });
});

describe('clientsInterestedInProject', () => {
  const demand = buildActiveClientDemand([
    client('c-pref', { ...activeBase, preferred_projects: ['p1'] }),
    client('c-dist', { ...activeBase, location: { district: ['d1'] } }),
    client('c-none', { ...activeBase, location: { district: ['d9'] } }),
  ], ctx, []);
  it('matches by preferred project and by district, with reasons', () => {
    const res = clientsInterestedInProject(demand, 'p1', ['d1']);
    const byId = Object.fromEntries(res.map((r) => [r.client.clientId, r.reason]));
    expect(byId['c-pref']).toBe('preferred');
    expect(byId['c-dist']).toBe('district');
    expect(byId['c-none']).toBeUndefined();
  });
});

describe('computeOpportunityGaps', () => {
  it('ranks by unmet demand and keeps the contributing client ids', () => {
    const demand = buildActiveClientDemand([
      client('c1', { ...activeBase, location: { district: ['d1'] }, budget: { min: 2000000, max: 3000000 } }),
      client('c2', { ...activeBase, location: { district: ['d1'] }, budget: { min: 2000000, max: 3000000 } }),
    ], ctx, []);
    // d1 has one project but ZERO available units → both clients unsatisfied.
    const projects = [project('pA', { location: { district: ['d1'] }, available_units: 0, available_price_range: { min: 500000, max: 800000 } })];
    const gaps = computeOpportunityGaps(demand, projects, new Set());
    const d1 = gaps.find((g) => g.districtId === 'd1')!;
    expect(d1.demandCount).toBe(2);
    expect(d1.availableUnits).toBe(0);
    expect(d1.unsatisfiedClientIds.sort()).toEqual(['c1', 'c2']);
    expect(d1.severity).toBe(2);
  });

  it('counts a client as satisfied when an available project overlaps their budget', () => {
    const demand = buildActiveClientDemand([
      client('c1', { ...activeBase, location: { district: ['d1'] }, budget: { min: 500000, max: 900000 } }),
    ], ctx, []);
    const projects = [project('pA', { location: { district: ['d1'] }, available_units: 5, available_price_range: { min: 600000, max: 850000 } })];
    const gaps = computeOpportunityGaps(demand, projects, new Set());
    const d1 = gaps.find((g) => g.districtId === 'd1')!;
    expect(d1.availableUnits).toBe(5);
    expect(d1.unsatisfiedClientIds).toEqual([]);
    expect(d1.severity).toBe(0);
  });
});
