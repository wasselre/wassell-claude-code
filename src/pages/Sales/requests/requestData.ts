/**
 * Pure helpers for the Unanswered Requests tab: which requests are open, what
 * the client asked for (the facts the office message is built from), and which
 * units / projects an office already offered for a request.
 */
import type { AppModel, AppRecord } from '@/types';
import { geoName, modelByName, type ProjectStoreSlices } from '@/lib/projects/projectView';
import type { RequestFacts } from '@/lib/officeOutreach/message';

/** Closing statuses — mirrors LogUnansweredRequestModal + the SQL partial index. */
export const CLOSED_REQUEST_STATUSES = new Set(['fulfilled', 'client_dropped']);

export const firstId = (v: unknown): string | null =>
  Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : null) : typeof v === 'string' && v ? v : null;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;

const rangeOf = (v: unknown): { min: number | null; max: number | null } => {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return { min: num(o.min), max: num(o.max) };
  }
  return { min: null, max: null };
};

/** A user id out of an assignee value (string, {user_id|id}, or an array of those). */
export function ownerIdOf(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const id = ownerIdOf(x);
      if (id) return id;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const id = o.user_id ?? o.id;
    return typeof id === 'string' && id ? id : null;
  }
  return typeof v === 'string' && v ? v : null;
}

export function isOpenRequest(r: AppRecord): boolean {
  return !CLOSED_REQUEST_STATUSES.has(String((r.data as Record<string, unknown>).request_status ?? 'received'));
}

export function clientOf(request: AppRecord, clientsById: Map<string, AppRecord>): AppRecord | null {
  const id = firstId((request.data as Record<string, unknown>).client_id);
  return id ? clientsById.get(id) ?? null : null;
}

/** The client's included place labels, de-duplicated, in the client's order. */
export function requestedPlaces(client: AppRecord | null): string[] {
  const items = (client?.data as Record<string, unknown> | undefined)?.location_items;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    if (o.polarity === 'exclude') continue;
    const label = typeof o.district_label === 'string' ? o.district_label
      : typeof o.label === 'string' ? o.label : null;
    if (label && label.trim() && !out.includes(label.trim())) out.push(label.trim());
  }
  return out;
}

export function requestFacts(request: AppRecord, client: AppRecord | null, store: ProjectStoreSlices): RequestFacts {
  const c = (client?.data ?? {}) as Record<string, unknown>;
  const r = request.data as Record<string, unknown>;
  const types = Array.isArray(c.preferred_unit_type) ? c.preferred_unit_type.filter((x): x is string => typeof x === 'string') : [];
  const cityId = firstId((c.location as Record<string, unknown> | undefined)?.city ?? null);
  const budget = rangeOf(c.budget);
  const beds = rangeOf(c.preferred_bedrooms);
  const area = rangeOf(c.preferred_area);
  return {
    unitTypes: types,
    places: requestedPlaces(client),
    city: cityId ? geoName(store, 'cities', cityId) : null,
    budgetMin: budget.min, budgetMax: budget.max,
    bedroomsMin: beds.min, bedroomsMax: beds.max,
    areaMin: area.min, areaMax: area.max,
    notes: typeof r.request_notes === 'string' ? r.request_notes : null,
  };
}

export interface RequestOffering {
  kind: 'unit' | 'project';
  record: AppRecord;
  officeId: string | null;
}

/** Units and projects created from an office's offer for this request. */
export function offeringsFor(requestId: string, store: ProjectStoreSlices): RequestOffering[] {
  const out: RequestOffering[] = [];
  const units = modelByName(store.models, 'units');
  const projects = modelByName(store.models, 'all_projects');
  const push = (m: AppModel | undefined, kind: 'unit' | 'project') => {
    if (!m) return;
    for (const rec of store.records[m.id] ?? []) {
      const d = rec.data as Record<string, unknown>;
      if (firstId(d.source_request_id) === requestId) out.push({ kind, record: rec, officeId: firstId(d.source_office_id) });
    }
  };
  push(projects, 'project');
  push(units, 'unit');
  return out;
}

export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null;
}
