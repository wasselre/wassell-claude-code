import { describe, it, expect } from 'vitest';
import type { AppModel, AppRecord } from '@/types';
import type { ClientView } from '@/pages/Clients/lib/clientView';
import type { ClientFollowupSummary } from '../myWork';
import {
  buildRelatedCountsIndex,
  isInterested,
  isSerious,
  isActive,
  isUnqualifiedInactive,
  matchesSalesTab,
  EMPTY_RELATED,
  type SalesClient,
  type RelatedCounts,
} from '../salesClients';

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

const noFollowup: ClientFollowupSummary = { late: false, latest: null, next: null, openCount: 0 };

function sc(v: Partial<ClientView>, related: Partial<RelatedCounts> = {}, followup = noFollowup): SalesClient {
  return { view: view(v), code: null, related: { ...EMPTY_RELATED, ...related }, followup };
}

describe('sales client tab predicates', () => {
  it('interested = active early-funnel client with no serious action', () => {
    const c = sc({ stage: 'جديد', status: 'مهتم' });
    expect(isInterested(c)).toBe(true);
    expect(isSerious(c)).toBe(false);
    expect(matchesSalesTab(c, 'interested')).toBe(true);
  });

  it('a client with an appointment is serious, not interested', () => {
    const c = sc({ stage: 'جديد', status: 'مهتم' }, { appointments: 1 });
    expect(isSerious(c)).toBe(true);
    expect(isInterested(c)).toBe(false);
  });

  it('a client who visited is serious', () => {
    expect(isSerious(sc({ stage: 'متابعة بعد الزيارة' }, { visits: 1 }))).toBe(true);
  });

  it('an offer/reservation makes a client serious', () => {
    expect(isSerious(sc({ stage: 'عرض سعر' }, { offers: 1 }))).toBe(true);
    expect(isSerious(sc({ stage: 'حجز' }, { reservations: 1 }))).toBe(true);
  });

  it('serious stages count even without related records', () => {
    expect(isSerious(sc({ stage: 'موعد زيارة' }))).toBe(true);
    expect(isSerious(sc({ stage: 'تمويل' }))).toBe(true);
  });

  it('active excludes lost / unqualified / inactive statuses + closed', () => {
    expect(isActive(sc({ stage: 'زيارة', status: 'مهتم جدًا' }))).toBe(true);
    expect(isActive(sc({ stage: 'خاسر' }))).toBe(false);
    expect(isActive(sc({ stage: 'غير مؤهل' }))).toBe(false);
    expect(isActive(sc({ stage: 'مغلق ناجح' }))).toBe(false);
    expect(isActive(sc({ stage: 'جديد', status: 'بارد' }))).toBe(false);
    expect(isActive(sc({ stage: 'جديد', status: 'لا يوجد رد 10 مرات' }))).toBe(false);
    expect(isActive(sc({ stage: 'جديد', lifecycleHealth: 'closed' }))).toBe(false);
  });

  it('unqualified/inactive captures lost + the inactive statuses', () => {
    expect(isUnqualifiedInactive(sc({ stage: 'خاسر' }))).toBe(true);
    expect(isUnqualifiedInactive(sc({ stage: 'غير مؤهل' }))).toBe(true);
    expect(isUnqualifiedInactive(sc({ status: 'غير مهتم' }))).toBe(true);
    expect(isUnqualifiedInactive(sc({ status: 'بارد' }))).toBe(true);
    expect(isUnqualifiedInactive(sc({ stage: 'زيارة', status: 'مهتم جدًا' }))).toBe(false);
  });

  it('late tab follows the follow-up summary late flag', () => {
    const lateClient = sc({ stage: 'زيارة' }, {}, { ...noFollowup, late: true });
    expect(matchesSalesTab(lateClient, 'late')).toBe(true);
    expect(matchesSalesTab(sc({ stage: 'زيارة' }), 'late')).toBe(false);
  });

  it('serious tab drops junk (wrong number / duplicate)', () => {
    const junk = sc({ stage: 'عرض سعر', status: 'رقم خاطئ' }, { offers: 1 });
    expect(matchesSalesTab(junk, 'serious')).toBe(false);
  });

  it('all tab matches everything', () => {
    expect(matchesSalesTab(sc({ stage: 'خاسر' }), 'all')).toBe(true);
  });
});

// --- Related-counts index ---------------------------------------------------

function lookupModel(name: string, slug: string, clientsModelId: string): AppModel {
  return {
    id: `${name}-model`,
    name,
    label_ar: name,
    label_en: name,
    icon: 'X',
    color: '#000',
    schema: {
      sections: [
        {
          id: 's',
          label_ar: 's',
          label_en: 's',
          order: 0,
          is_base: true,
          fields: [
            { id: 'f', name: slug, label_ar: slug, label_en: slug, type: 'lookup', required: false, order: 0, lookup_model_id: clientsModelId },
          ],
        },
      ],
      section_selector_field_id: null,
    },
  } as unknown as AppModel;
}

function rec(modelId: string, data: Record<string, unknown>, id: string): AppRecord {
  return { id, model_id: modelId, data, created_by_user_id: 'u', created_at: '', updated_at: '', version: 1 };
}

describe('buildRelatedCountsIndex', () => {
  it('counts related records per client across the sales models', () => {
    const CLIENTS = 'clients-model';
    const visits = lookupModel('visits', 'client_id', CLIENTS);
    const appointments = lookupModel('appointments', 'client_id', CLIENTS);
    const offers = lookupModel('offer_prices', 'client_id', CLIENTS);
    const reservations = lookupModel('reservations', 'client_id', CLIENTS);

    const records: Record<string, AppRecord[]> = {
      [visits.id]: [rec(visits.id, { client_id: 'c1' }, 'v1'), rec(visits.id, { client_id: 'c1' }, 'v2'), rec(visits.id, { client_id: 'c2' }, 'v3')],
      [appointments.id]: [rec(appointments.id, { client_id: 'c1' }, 'a1')],
      [offers.id]: [rec(offers.id, { client_id: 'c2' }, 'o1')],
      [reservations.id]: [],
    };

    const idx = buildRelatedCountsIndex([visits, appointments, offers, reservations], records, CLIENTS);
    expect(idx.get('c1')).toEqual({ visits: 2, appointments: 1, offers: 0, reservations: 0, calls: 0 });
    expect(idx.get('c2')).toEqual({ visits: 1, appointments: 0, offers: 1, reservations: 0, calls: 0 });
  });
});
