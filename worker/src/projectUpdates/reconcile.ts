/**
 * The ONE reconciler every project-update source goes through.
 *
 * Pure: (CRM units, source snapshot, policy) → patches + creates + stats. No
 * I/O, so every rule here is unit-tested (projectUpdates.test.ts) and the dry
 * run shows exactly what a live run would write.
 *
 * Rules (from the unit_updates migration_instructions the manual runs used):
 *  - join on the normalised unit code (`unit_model`); fall back to
 *    (building_number, unit_number) only when that pair is unique on BOTH sides.
 *    A source unit that matches two CRM units is skipped and reported — never
 *    guessed.
 *  - status: the source's status wins when it states one.
 *  - price: overwritten only when the source shows a real price (> 0). A source
 *    that shows none («عند الطلب») leaves the CRM price alone.
 *  - a CRM unit the source does not list: left alone, or marked sold when the
 *    source is a complete "available units" list (policy.absentAvailable).
 *  - a source unit with no CRM match: a newly released unit → created, with
 *    components / facade / parking copied from the closest sibling.
 */

import type {
  CrmUnit,
  ReconcilePolicy,
  ReconcileResult,
  SourceUnit,
  UnitCreate,
  UnitPatch,
  UnitStatus,
} from './types.js';

const AR_DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

export function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d] ?? d);
}

/** «17 - A» → «17-A», «( وحدة العرض )» stripped, leading zeros dropped per
 *  number («A01» → «A1»), Latin upper-cased. Two codes that normalise equal are
 *  the same unit. */
export function normUnitKey(raw: unknown): string {
  if (raw == null) return '';
  let s = toAsciiDigits(String(raw));
  s = s.replace(/\([^)]*\)/g, ' ');           // «( وحدة العرض )»
  s = s.replace(/[\s‏‎ ]+/g, ''); // all whitespace + bidi marks
  s = s.replace(/[–—_]/g, '-');
  s = s.replace(/\d+/g, (n) => String(parseInt(n, 10)));
  return s.toUpperCase();
}

export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = toAsciiDigits(v).replace(/[,\s٬]/g, '').replace(/٫/g, '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function crmStatus(d: Record<string, unknown>): string {
  return typeof d.unit_status === 'string' ? d.unit_status : '';
}

function bnKey(building: unknown, unit: unknown): string | null {
  const b = building == null ? '' : normUnitKey(building);
  const u = num(unit);
  if (!b || u == null) return null;
  return `${b}#${u}`;
}

/** Map a source's free-text unit type to the units.unit_type option value. */
export function mapUnitType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[إأآ]/g, 'ا');
  if (/بنتهاوس|بنت هاوس|penthouse/i.test(s)) return 'بنتهاوس';
  if (/تاون|town/i.test(s)) return 'تاون هاوس';
  if (/دبلكس|دوبلكس|duplex/i.test(s)) return 'دبلكس';
  if (/فيلا|فلة|فله|villa/i.test(s)) return 'فيلا';
  if (/شقة|شقه|apartment|flat/i.test(s)) return 'شقة';
  if (/دور|floor/i.test(s)) return 'دور';
  return null;
}

const FLOOR_WORDS: Array<[RegExp, string]> = [
  [/ارضي|أرضي|ground/i, 'ارضي'],
  // «روف» only as a word of its own — «معروف» (known) contains the same letters.
  [/(?:^|[\s\-_])(?:ال)?روف(?:$|[\s\-_])|سطح|ملحق|roof/i, 'الروف'],
  [/اول|أول|first/i, 'اول'],
  [/ثاني|second/i, 'ثاني'],
  [/ثالث|third/i, 'ثالث'],
];

/** Map a source floor ("2", "الدور الأول", "Ground") to a units.floor option. */
export function mapFloor(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const s = toAsciiDigits(String(raw));
  const n = s.match(/^\s*(\d{1,2})\s*$/);
  if (n) {
    const v = parseInt(n[1]!, 10);
    if (v === 0) return 'ارضي';
    return v >= 1 && v <= 23 ? String(v) : null;
  }
  for (const [re, val] of FLOOR_WORDS) if (re.test(s)) return val;
  return null;
}

const SIBLING_COPY_KEYS = ['unit_components', 'facade', 'parking_space', 'elevator_status'] as const;

/** The CRM unit a NEW unit should borrow its layout fields from: same type,
 *  same bedrooms, closest area. Returns null when nothing is close enough. */
export function pickSibling(crm: CrmUnit[], src: SourceUnit): CrmUnit | null {
  const type = mapUnitType(src.unitType ?? null);
  let best: CrmUnit | null = null;
  let bestScore = Infinity;
  for (const u of crm) {
    const d = u.data;
    if (type && d.unit_type && d.unit_type !== type) continue;
    if (src.bedrooms != null && num(d.bedrooms) != null && num(d.bedrooms) !== src.bedrooms) continue;
    const a = num(d.unit_area);
    const score = src.area != null && a != null ? Math.abs(a - src.area) : 1000;
    if (score < bestScore) { bestScore = score; best = u; }
  }
  return best;
}

export function reconcile(
  crm: CrmUnit[],
  source: SourceUnit[],
  policy: ReconcilePolicy,
  ctx: { projectId: string; developerId: string | null; projectName: string; sourceLabel: string; today: string },
): ReconcileResult {
  const byModel = new Map<string, CrmUnit[]>();
  const byBn = new Map<string, CrmUnit[]>();
  for (const u of crm) {
    const k = normUnitKey(u.data.unit_model);
    if (k) byModel.set(k, [...(byModel.get(k) ?? []), u]);
    const b = bnKey(u.data.building_number, u.data.unit_number);
    if (b) byBn.set(b, [...(byBn.get(b) ?? []), u]);
  }
  const srcBnCount = new Map<string, number>();
  for (const s of source) {
    const b = bnKey(s.buildingNumber, s.unitNumber);
    if (b) srcBnCount.set(b, (srcBnCount.get(b) ?? 0) + 1);
  }

  const updates: UnitPatch[] = [];
  const creates: UnitCreate[] = [];
  const ambiguous: string[] = [];
  const matchedIds = new Set<string>();
  const seenSrc = new Set<string>();
  let statusChanges = 0, toSoldOrReserved = 0, priceChanges = 0, matched = 0;

  for (const s of source) {
    const mk = normUnitKey(s.unitModel);
    const label = s.unitModel ?? s.sourceId ?? '?';
    // The same unit listed twice by the source (unstable pagination) → once.
    const dedupeKey = mk || `id:${s.sourceId}`;
    if (seenSrc.has(dedupeKey)) continue;
    seenSrc.add(dedupeKey);

    let hits = mk ? byModel.get(mk) ?? [] : [];
    if (hits.length === 0) {
      const b = bnKey(s.buildingNumber, s.unitNumber);
      if (b && srcBnCount.get(b) === 1) hits = byBn.get(b) ?? [];
    }
    if (hits.length > 1) { ambiguous.push(label); continue; }

    if (hits.length === 1) {
      const u = hits[0]!;
      matched++;
      matchedIds.add(u.id);
      const patch: Record<string, unknown> = {};
      const reasons: string[] = [];
      const cur = crmStatus(u.data);
      if (s.status && s.status !== cur) {
        patch.unit_status = s.status;
        reasons.push(`status ${cur || '∅'} → ${s.status}`);
        statusChanges++;
        if ((s.status === 'sold' || s.status === 'reserved') && cur === 'available') toSoldOrReserved++;
      }
      if (policy.updatePrices && s.price != null && s.price > 0) {
        const curPrice = num(u.data.total_price);
        if (curPrice == null || Math.abs(curPrice - s.price) >= 1) {
          patch.total_price = s.price;
          reasons.push(`price ${curPrice ?? '∅'} → ${s.price}`);
          priceChanges++;
        }
      }
      if (Object.keys(patch).length) {
        updates.push({ kind: 'update', unitId: u.id, label: String(u.data.unit_model ?? u.data.unit_code ?? u.id), patch, reasons });
      }
      continue;
    }

    if (!policy.createMissing) continue;
    // A unit the source lists as sold that we never had is history, not a
    // release — don't import it.
    if (s.status === 'sold') continue;
    const sib = pickSibling(crm, s);
    const data: Record<string, unknown> = {
      project_id: ctx.projectId,
      unit_source: 'project',
      unit_model: s.unitModel ?? undefined,
      unit_status: s.status ?? 'available',
    };
    if (ctx.developerId) data.developer_id = ctx.developerId;
    if (s.buildingNumber) data.building_number = s.buildingNumber;
    if (s.unitNumber != null) data.unit_number = s.unitNumber;
    const t = mapUnitType(s.unitType ?? null) ?? (sib?.data.unit_type as string | undefined) ?? null;
    if (t) data.unit_type = t;
    if (s.price != null && s.price > 0) data.total_price = s.price;
    if (s.area != null && s.area > 0) data.unit_area = s.area;
    if (s.bedrooms != null) data.bedrooms = s.bedrooms;
    if (s.bathrooms != null) data.bathrooms = s.bathrooms;
    const fl = mapFloor(s.floor);
    if (fl) data.floor = fl;
    const noteLines = [`${label} — ${ctx.projectName} (${ctx.sourceLabel}، ${ctx.today} — وحدة جديدة/مُفرجة، أُضيفت تلقائياً)`];
    if (s.description) noteLines.push(`مواصفات المصدر: ${s.description}`);
    if (sib) {
      for (const k of SIBLING_COPY_KEYS) if (sib.data[k] != null) data[k] = sib.data[k];
      if (data.bathrooms == null && sib.data.bathrooms != null) data.bathrooms = sib.data.bathrooms;
      noteLines.push(`(المكونات منسوخة من الوحدة المشابهة ${String(sib.data.unit_model ?? sib.data.unit_code ?? '')})`);
    }
    data.notes = noteLines.join('\n');
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
    creates.push({ kind: 'create', label, data, source: s });
  }

  const missingFromSource: string[] = [];
  for (const u of crm) {
    if (matchedIds.has(u.id)) continue;
    const label = String(u.data.unit_model ?? u.data.unit_code ?? u.id);
    if (policy.absentAvailable === 'sold' && crmStatus(u.data) === 'available') {
      updates.push({ kind: 'update', unitId: u.id, label, patch: { unit_status: 'sold' }, reasons: ['not in the source list → sold'] });
      statusChanges++;
      toSoldOrReserved++;
    } else {
      missingFromSource.push(label);
    }
  }

  return {
    updates,
    creates,
    missingFromSource,
    ambiguous,
    stats: {
      sourceUnits: seenSrc.size,
      crmUnits: crm.length,
      matched,
      statusChanges,
      toSoldOrReserved,
      priceChanges,
    },
  };
}

/** The safety brake. A run that would flip more than `share` of a project's
 *  CRM units from available to sold/reserved (and at least `minUnits` of them)
 *  is far more likely a broken parse than a real sell-out week → HOLD it. */
export function brakeReason(
  r: ReconcileResult,
  opts: { share: number; minUnits: number },
): string | null {
  const n = r.stats.toSoldOrReserved;
  if (n >= opts.minUnits && r.stats.crmUnits > 0 && n / r.stats.crmUnits > opts.share) {
    return `would mark ${n} of ${r.stats.crmUnits} units sold/reserved in one run (limit ${Math.round(opts.share * 100)}%)`;
  }
  if (r.stats.sourceUnits === 0 && r.stats.crmUnits > 0) {
    return 'the source returned no units for a project that has units — a failed page, not an empty project';
  }
  return null;
}

export type { UnitStatus };
