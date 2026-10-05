/** Binghatti's authenticated AVAILABLE inventory. This adapter only reads
 *  the capture produced by the portal recipe; no public prices or unit pages. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { mapFloor, mapUnitType, normUnitKey, num, numericUnitNumber } from './reconcile.js';
import type { CrmUnit, ReconcilePolicy, SourceProject, SourceUnit } from './types.js';

export const BINGHATTI_DEVELOPER_ID = '759fa833-e60e-4775-86ab-292005c8d517';
export const BINGHATTI_FX_RATE = 1.021103;
export const BINGHATTI_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const SQFT_TO_SQM = 0.09290304;
const PORTAL_ORIGIN = 'https://partners.binghatti.com';

export type BinghattiUnitTypeMap = Record<string, string | { zero?: string; other?: string }>;
export interface BinghattiOptions {
  /** Verified against the import; never choose whichever field is present. */
  areaBasis: 'net' | 'total';
  areaUnit: 'sqft' | 'sqm';
  unitTypeMap?: BinghattiUnitTypeMap;
}
export interface BinghattiItem {
  id: string;
  projectId: string;
  number: unknown;
  code: unknown;
  unitTypeId: unknown;
  unitTypeName: unknown;
  actualPrice: unknown;
  totalArea: unknown;
  netArea: unknown;
  bedroomsCount: unknown;
  floorNumber: unknown;
}
export interface BinghattiSnapshot {
  savedAt: string;
  fresh: boolean;
  complete: true;
  totalCount: number;
  byProject: Map<string, BinghattiItem[]>;
  unitTypeMap: BinghattiUnitTypeMap;
}

function identity(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id) ? id : null;
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function positive(value: unknown): number | null {
  const n = num(value);
  return n != null && n > 0 ? n : null;
}
function typeMap(value: unknown): BinghattiUnitTypeMap {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('binghatti unit_type_map must be an object');
  const out: BinghattiUnitTypeMap = {};
  for (const [id, raw] of Object.entries(value)) {
    const key = identity(id);
    const mapped = mapUnitType(typeof raw === 'string' ? raw : null);
    // An unrecognized type remains unknown; it can never enable a create.
    if (key && mapped) out[key] = mapped;
    else if (key && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const buckets = raw as Record<string, unknown>;
      const zero = mapUnitType(typeof buckets.zero === 'string' ? buckets.zero : null);
      const other = mapUnitType(typeof buckets.other === 'string' ? buckets.other : null);
      if (zero || other) out[key] = { ...(zero ? { zero } : {}), ...(other ? { other } : {}) };
    }
  }
  return out;
}

/** Reject malformed / truncated captures as a whole, including a duplicate
 *  page whose length happens to equal totalCount. No row may be dropped while
 *  still claiming this is a complete inventory. */
export function parseBinghattiSnapshot(raw: unknown, now = Date.now()): BinghattiSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('binghatti snapshot is not an object');
  const payload = raw as Record<string, unknown>;
  const provenance = payload.provenance as Record<string, unknown> | undefined;
  if (provenance?.trimmed === true || (provenance?.original_total_count != null && provenance.original_total_count !== payload.totalCount)) {
    throw new Error('binghatti snapshot is a trimmed fixture, not complete production inventory');
  }
  const savedAt = text(payload.saved_at);
  const savedTime = savedAt == null ? NaN : Date.parse(savedAt);
  if (!Number.isFinite(savedTime) || savedTime > now) throw new Error('binghatti snapshot has invalid / future saved_at');
  const total = payload.totalCount;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0
    || !Array.isArray(payload.items) || payload.items.length !== total) {
    throw new Error('binghatti snapshot is incomplete: items.length must equal totalCount');
  }
  const byProject = new Map<string, BinghattiItem[]>();
  const seen = new Set<string>();
  for (const [index, rawItem] of payload.items.entries()) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) throw new Error(`binghatti snapshot invalid row ${index}`);
    const row = rawItem as Record<string, unknown>;
    const id = identity(row.id), projectId = identity(row.projectId);
    if (!id || !projectId) throw new Error(`binghatti snapshot row ${index} lacks valid unit / project ids`);
    if (!text(row.code) && numericUnitNumber(row.number) == null) {
      throw new Error(`binghatti snapshot row ${index} lacks a stable code / unit number`);
    }
    // IDs are case-insensitive in the portal's UUID/numeric identity space.
    const distinctId = id.toLowerCase();
    if (seen.has(distinctId)) throw new Error(`binghatti snapshot duplicate unit id ${id}`);
    seen.add(distinctId);
    const item: BinghattiItem = {
      id, projectId, number: row.number, code: row.code, unitTypeId: row.unitTypeId, unitTypeName: row.unitTypeName,
      actualPrice: row.actualPrice, totalArea: row.totalArea, netArea: row.netArea,
      bedroomsCount: row.bedroomsCount, floorNumber: row.floorNumber,
    };
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), item]);
  }
  return {
    savedAt: savedAt!, fresh: now - savedTime < BINGHATTI_MAX_AGE_MS,
    complete: true, totalCount: total, byProject, unitTypeMap: typeMap(payload.unit_type_map),
  };
}

export async function loadBinghattiSnapshot(
  supabase: SupabaseClient,
  portalRecordId: string,
  now = Date.now(),
): Promise<BinghattiSnapshot | null> {
  if (!identity(portalRecordId)) throw new Error('binghatti capture requires a valid portal record id');
  const { data, error } = await supabase.storage.from('portal-registrations')
    .download(`inventory/${portalRecordId}/units.json`);
  if (error || !data) {
    if (error && !/not found|Object not found|404/i.test(error.message)) throw new Error(`binghatti snapshot: ${error.message}`);
    return null;
  }
  let raw: unknown;
  try { raw = JSON.parse(await data.text()); }
  catch (err) { throw new Error(`binghatti snapshot JSON: ${(err as Error).message}`); }
  return parseBinghattiSnapshot(raw, now);
}

/** One token may contain several portal projects for a single CRM project. */
export function binghattiProjectId(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.origin !== PORTAL_ORIGIN || !/^\/Properties\/?$/i.test(parsed.pathname)) return null;
  const values = [...parsed.searchParams.getAll('projectId'), ...parsed.searchParams.getAll('projectIds')];
  return projectIds(values.flatMap((value) => value.split(',')))?.join(',') ?? null;
}
function projectIds(raw: readonly unknown[]): string[] | null {
  if (!raw.length) return null;
  const ids = raw.map(identity);
  if (ids.some((id) => !id)) return null;
  return [...new Set(ids as string[])];
}
export function binghattiProjectIdFromRow(row: Record<string, unknown>): string | null {
  if (row.source_project_ids != null) {
    return Array.isArray(row.source_project_ids) ? projectIds(row.source_project_ids)?.join(',') ?? null : null;
  }
  return binghattiProjectId(row.source_url);
}
export function binghattiOptionsOf(row: Record<string, unknown>): BinghattiOptions {
  if (row.binghatti_area_basis !== 'net' && row.binghatti_area_basis !== 'total') {
    throw new Error('binghatti requires verified binghatti_area_basis (net / total)');
  }
  if (row.binghatti_area_unit !== 'sqft' && row.binghatti_area_unit !== 'sqm') {
    throw new Error('binghatti requires verified binghatti_area_unit (sqft / sqm)');
  }
  return { areaBasis: row.binghatti_area_basis, areaUnit: row.binghatti_area_unit, unitTypeMap: typeMap(row.unit_type_map) };
}

export function binghattiUnit(item: BinghattiItem, options: BinghattiOptions): SourceUnit {
  const aed = positive(item.actualPrice);
  const net = positive(item.netArea), total = positive(item.totalArea);
  const chosen = options.areaBasis === 'net' ? net : total;
  const bedrooms = num(item.bedroomsCount);
  const typeId = identity(item.unitTypeId);
  const typeMapping = typeId ? options.unitTypeMap?.[typeId] : null;
  const mappedType = mapUnitType(typeof typeMapping === 'string' ? typeMapping : typeMapping?.[bedrooms === 0 ? 'zero' : 'other']);
  // Zero bedrooms states studio only for a known residential type. It never
  // turns an unknown id or a zero-bedroom office into a residential unit.
  const unitType = bedrooms === 0 && (mappedType === 'شقة' || mappedType === 'استوديو') ? 'استوديو' : mappedType;
  return {
    sourceId: item.id, unitModel: text(item.code), unitCode: text(item.code),
    unitNumber: numericUnitNumber(item.number), status: 'available',
    price: aed == null ? null : Math.round(aed * BINGHATTI_FX_RATE),
    sourcePrice: aed, sourceCurrency: aed == null ? null : 'AED', sourceFxRate: aed == null ? null : BINGHATTI_FX_RATE,
    area: chosen == null ? null : Math.round(chosen * (options.areaUnit === 'sqft' ? SQFT_TO_SQM : 1) * 100) / 100,
    sourceNetArea: net, sourceTotalArea: total, sourceAreaUnit: options.areaUnit,
    bedrooms: bedrooms != null && Number.isInteger(bedrooms) && bedrooms >= 0 ? bedrooms : null,
    floor: mapFloor(item.floorNumber),
    sourceFloor: item.floorNumber == null ? null : String(item.floorNumber),
    sourceUnitType: text(item.unitTypeName) ?? typeId, sourceUnitTypeId: typeId,
    unitType,
  };
}

export async function fetchBinghattiProject(
  ids: string | readonly string[],
  snapshot: BinghattiSnapshot | null,
  options: BinghattiOptions,
): Promise<SourceProject> {
  if (!snapshot?.complete || !snapshot.fresh) throw new Error('binghatti requires a complete inventory captured less than 36 hours ago');
  const selected = projectIds(typeof ids === 'string' ? ids.split(',') : ids);
  if (!selected) throw new Error('binghatti requires valid mapped portal project ids');
  if (!options || !['net', 'total'].includes(options.areaBasis) || !['sqft', 'sqm'].includes(options.areaUnit)) {
    throw new Error('binghatti requires a verified area basis and source area unit');
  }
  const mergedOptions = { ...options, unitTypeMap: { ...snapshot.unitTypeMap, ...options.unitTypeMap } };
  const units = selected.flatMap((id) => (snapshot.byProject.get(id) ?? []).map((item) => binghattiUnit(item, mergedOptions)));
  const numberCounts = new Map<number, number>();
  for (const unit of units) if (unit.unitNumber != null) numberCounts.set(unit.unitNumber, (numberCounts.get(unit.unitNumber) ?? 0) + 1);
  // A code-less release needs a repeatable fallback identity. Reject this
  // project before creating it if merged phases share that number, rather
  // than adding a row that later weekly runs can never identify uniquely.
  if (units.some((unit) => !unit.unitCode && unit.unitNumber != null && numberCounts.get(unit.unitNumber)! > 1)) {
    throw new Error('binghatti project has a code-less unit with a non-unique fallback number');
  }
  return {
    sourceId: selected.join(','), name: '', url: `${PORTAL_ORIGIN}/Properties?projectId=${selected.join(',')}`,
    units, declaredTotal: units.length,
    meta: {
      source_project_ids: selected, snapshot_saved_at: snapshot.savedAt, snapshot_total: snapshot.totalCount,
      snapshot_complete: true, snapshot_fresh: true, absent_means_sold: true,
      area_basis: options.areaBasis, area_unit: options.areaUnit,
      unknown_unit_type_ids: [...new Set(units.filter((unit) => !unit.unitType).map((unit) => unit.sourceUnitTypeId ?? '?'))],
    },
  };
}

/** Derive a type only from exact, unique developer-code joins. Bedroom-zero
 *  and other rows have separate evidence buckets, so one studio never maps
 *  all the apartments sharing its portal type id to studios. */
export async function enrichBinghattiTypes(src: SourceProject, crm: CrmUnit[]): Promise<void> {
  const byCode = new Map<string, CrmUnit[]>();
  for (const unit of crm) {
    const code = normUnitKey(unit.data.developer_unit_code);
    if (code) byCode.set(code, [...(byCode.get(code) ?? []), unit]);
  }
  const sourceCount = new Map<string, number>();
  for (const unit of src.units) {
    const code = normUnitKey(unit.unitCode);
    if (code) sourceCount.set(code, (sourceCount.get(code) ?? 0) + 1);
  }
  const evidence = new Map<string, Set<string>>();
  const bucket = (unit: SourceUnit) => `${unit.sourceUnitTypeId}:${unit.bedrooms === 0 ? 'zero' : 'other'}`;
  for (const unit of src.units) {
    if (!unit.sourceUnitTypeId) continue;
    const code = normUnitKey(unit.unitCode), hits = byCode.get(code) ?? [];
    if (hits.length !== 1 || sourceCount.get(code) !== 1) continue;
    const type = mapUnitType(typeof hits[0]!.data.unit_type === 'string' ? hits[0]!.data.unit_type as string : null);
    if (!type) continue;
    const key = bucket(unit);
    const values = evidence.get(key) ?? new Set<string>();
    values.add(type);
    evidence.set(key, values);
  }
  for (const unit of src.units) {
    if (unit.unitType || !unit.sourceUnitTypeId) continue;
    const values = evidence.get(bucket(unit));
    if (values?.size === 1) unit.unitType = [...values][0]!;
  }
  if (src.meta) {
    src.meta.unknown_unit_type_ids = [...new Set(src.units.filter((unit) => !unit.unitType).map((unit) => unit.sourceUnitTypeId ?? '?'))];
    src.meta.conflicting_unit_type_ids = [...evidence.entries()].filter(([, values]) => values.size > 1).map(([key]) => key);
  }
}

export function binghattiPolicy(scope: string, src: SourceProject): ReconcilePolicy {
  return {
    absentAvailable: scope !== 'status_only' && src.meta?.absent_means_sold === true ? 'sold' : 'leave',
    createMissing: scope !== 'status_only', updatePrices: scope !== 'status_only',
    forwardOnly: scope === 'status_only', keepReserved: true, matchByUnitNumber: true,
  };
}
