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

const STATUS_RANK: Record<string, number> = { under_construction: 0, available: 1, reserved: 2, sold: 3 };

function crmStatus(d: Record<string, unknown>): string {
  return typeof d.unit_status === 'string' ? d.unit_status : '';
}

function part(v: unknown): string {
  return v == null ? '' : normUnitKey(v);
}

/**
 * The identifiers a unit can be matched on, most specific first. Developers
 * name units differently: Riva quotes a unique code («32 - B»), Al-Ramz a block
 * + building + floor («بلك 53 عمارة 17 الدور الأول»), and a booking post a
 * building + flat number («مبنى 6 | شقة 2»). `unit_model` is NOT always an id —
 * on Al-Ramz projects it is the layout type (D, C1…) shared by dozens of units —
 * so every key is used only when it points at exactly ONE unit on each side.
 */
type KeyFn = (x: {
  code: unknown; model: unknown; block: unknown; building: unknown; unit: unknown; floor: unknown;
}) => string | null;

const MATCH_KEYS: Array<[string, KeyFn]> = [
  ['code', (x) => (part(x.code) ? `c:${part(x.code)}` : null)],
  ['model', (x) => (part(x.model) ? `m:${part(x.model)}` : null)],
  ['block_unit', (x) => (part(x.block) && num(x.unit) != null ? `bu:${part(x.block)}#${num(x.unit)}` : null)],
  ['building_unit', (x) => (part(x.building) && num(x.unit) != null ? `gu:${part(x.building)}#${num(x.unit)}` : null)],
  ['block_building_floor', (x) => {
    const f = mapFloor(x.floor);
    return part(x.block) && part(x.building) && f ? `bgf:${part(x.block)}#${part(x.building)}#${f}` : null;
  }],
  ['building_floor', (x) => {
    const f = mapFloor(x.floor);
    return part(x.building) && f ? `gf:${part(x.building)}#${f}` : null;
  }],
];

/** Portal numbers such as OF112 / TA1106 are numeric after a Latin prefix.
 *  Reject everything else; extracting arbitrary digits can join wrong units. */
export function numericUnitNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = toAsciiDigits(raw).trim();
  if (!/^[a-z]*\d+$/i.test(text)) return null;
  const value = Number(text.replace(/^[a-z]+/i, ''));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Never write an FX price with only part of its evidence. Adapters that do
 *  not state a foreign price keep the existing SAR-only behavior. */
export function sourcePriceFields(s: SourceUnit): Record<string, unknown> | null {
  if (s.sourcePrice == null && s.sourceCurrency == null && s.sourceFxRate == null) return null;
  if (!(s.sourcePrice != null && Number.isFinite(s.sourcePrice) && s.sourcePrice > 0)
    || !(s.sourceFxRate != null && Number.isFinite(s.sourceFxRate) && s.sourceFxRate > 0)
    || typeof s.sourceCurrency !== 'string' || !/^[A-Z]{3}$/.test(s.sourceCurrency)
    || s.price == null || !Number.isFinite(s.price) || s.price <= 0 || s.price !== Math.round(s.sourcePrice * s.sourceFxRate)) {
    throw new Error(`invalid source price / FX provenance for ${sourceLabel(s)}`);
  }
  return { source_price: s.sourcePrice, source_currency: s.sourceCurrency, source_fx_rate: s.sourceFxRate };
}

const NUMBER_MATCH_KEY: [string, KeyFn] = ['unit_number', (x) => {
  const n = numericUnitNumber(x.unit);
  return n == null ? null : `n:${n}`;
}];

/** How a source unit is named in logs: its code, else block/building/floor. */
/** The key that says "this is the same source unit": its own id, else EVERY
 *  identity field. The label alone is not enough — a sheet row whose code
 *  field carried the layout letter («A», «C1») collapsed 67 ستون الندى rows
 *  into ~20 (2026-10-05). */
/** A layout / model letter («A», «C1», «QQ», «A-1») — shared by many units,
 *  never a unit's own code. */
export function isLayoutLetter(v: string): boolean {
  return /^[A-Za-z]{1,2}\d?(-\d)?$/.test(v.trim());
}

export function sourceUnitKey(s: SourceUnit): string {
  if (s.sourceId) return `id:${s.sourceId}`;
  return ['l', normUnitKey(sourceLabel(s)), part(s.block) ?? '', part(s.buildingNumber) ?? '',
    s.unitNumber ?? '', mapFloor(s.floor) ?? ''].join('|');
}

export function sourceLabel(s: SourceUnit): string {
  if (s.unitModel) return s.unitModel;
  if (s.unitCode) return s.unitCode;
  const bits = [
    s.block ? `بلك ${s.block}` : '',
    s.buildingNumber ? `عمارة ${s.buildingNumber}` : '',
    s.unitNumber != null ? `وحدة ${s.unitNumber}` : '',
    s.floor ? `دور ${s.floor}` : '',
  ].filter(Boolean);
  return bits.length ? bits.join(' ') : s.sourceId ?? '?';
}

function crmKeyInput(d: Record<string, unknown>) {
  return { code: d.developer_unit_code ?? null, model: d.unit_model, block: d.block, building: d.building_number, unit: d.unit_number, floor: d.floor };
}
function srcKeyInput(s: SourceUnit) {
  return { code: s.unitCode ?? null, model: s.unitModel, block: s.block, building: s.buildingNumber, unit: s.unitNumber, floor: s.floor };
}

/** Map a source's free-text unit type to the units.unit_type option value. */
export function mapUnitType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[إأآ]/g, 'ا');
  if (/استوديو|ستوديو|studio/i.test(s)) return 'استوديو';
  if (/مكتب|office/i.test(s)) return 'مكتب';
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
  // Vowel marks out («سَطح» → «سطح»), Arabic digits to ASCII.
  const s = toAsciiDigits(String(raw)).replace(/[ً-ْٰ]/g, '').trim();
  const n = s.match(/^(\d{1,2})\s*F?$/i);            // «3», and Safa's «4F» … «7F»
  if (n) {
    const v = parseInt(n[1]!, 10);
    if (v === 0) return 'ارضي';
    return v >= 1 && v <= 23 ? String(v) : null;
  }
  // Safa broker cards (counted on the real snapshot, 2026-10-05): GF / FF / SF /
  // TF / RF — 205 of 448 cards came out floorless before these were mapped.
  const code: Record<string, string> = { G: 'ارضي', GF: 'ارضي', FF: 'اول', SF: 'ثاني', TF: 'ثالث', RF: 'الروف', ROOF: 'الروف' };
  if (code[s.toUpperCase()]) return code[s.toUpperCase()]!;
  if (/^R\d*$/i.test(s)) return 'الروف';
  const ordinals: Array<[RegExp, string]> = [
    [/الرابع/, '4'], [/الخامس/, '5'], [/السادس/, '6'], [/السابع/, '7'], [/الثامن/, '8'], [/التاسع/, '9'], [/العاشر/, '10'],
  ];
  for (const [re, val] of ordinals) if (re.test(s)) return val;
  for (const [re, val] of FLOOR_WORDS) if (re.test(s)) return val;
  return null;
}

const SIBLING_COPY_KEYS = ['unit_components', 'facade', 'parking_space', 'elevator_status'] as const;

/** The project-level unit type from a `unit_updates` row: a known type AND a
 *  cited source, or nothing. A type without a source is ignored. */
export function statedUnitTypeOf(row: Record<string, unknown>): { type: string; source: string } | null {
  const type = mapUnitType(typeof row.stated_unit_type === 'string' ? row.stated_unit_type : null);
  const source = typeof row.stated_unit_type_source === 'string' ? row.stated_unit_type_source.trim() : '';
  return type && source ? { type, source } : null;
}

export type Essential = 'area' | 'price' | 'bedrooms' | 'unit_type' | 'unit_number';

/** Which of the four essentials a NEW unit lacks. Bedrooms 0 (a studio) is a
 *  real value; area and price must be positive. */
export function missingEssentials(s: SourceUnit, mappedType: string | null): Essential[] {
  const out: Essential[] = [];
  if (!(s.area != null && s.area > 0)) out.push('area');
  if (!(s.price != null && s.price > 0)) out.push('price');
  if (s.bedrooms == null || !Number.isFinite(s.bedrooms) || s.bedrooms < 0) out.push('bedrooms');
  if (!mappedType) out.push('unit_type');
  return out;
}

const ESSENTIAL_AR: Record<Essential, string> = {
  area: 'المساحة', price: 'السعر', bedrooms: 'عدد الغرف', unit_type: 'نوع الوحدة', unit_number: 'رقم الوحدة',
};

/** One WhatsApp message to the operator listing the units a run did NOT add
 *  and what each lacks. Grouped by what is missing, so 130 units missing only
 *  the type read as one line, not 130. */
export function incompleteNotice(projectName: string, sourceLabel: string, items: ReconcileResult['incomplete']): string {
  const groups = new Map<string, string[]>();
  for (const it of items) {
    const k = it.missing.map((m) => ESSENTIAL_AR[m]).join(' + ');
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(it.unit);
  }
  const lines = [
    `⚠️ تحديث المشاريع — ${projectName}`,
    `لم تُضَف ${items.length} وحدة من «${sourceLabel}» لأن معلومة أساسية ناقصة:`,
  ];
  for (const [k, units] of groups) {
    const shown = units.slice(0, 12).join('، ');
    lines.push('', `• ينقصها ${k} (${units.length}): ${shown}${units.length > 12 ? ` … و${units.length - 12} غيرها` : ''}`);
  }
  lines.push('', 'ستُضاف تلقائياً حين يذكر المصدر المعلومة الناقصة، أو أدخلها يدوياً.');
  return lines.join('\n');
}

/** Stable signature of an incomplete list — the same list is reported once. */
export function incompleteSignature(items: ReconcileResult['incomplete']): string {
  return items.map((i) => `${normUnitKey(i.unit)}:${i.missing.join(',')}`).sort().join('|');
}

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
  ctx: {
    projectId: string; developerId: string | null; projectName: string; sourceLabel: string; today: string;
    /** The unit type the DEVELOPER states for the whole project (e.g. Sakani
     *  lists every model of صفا 101 as «شقة»), recorded by a person on the
     *  update-list row with its source. Used only when a unit's own data says
     *  nothing — a stated fact with a citation, never a guess. */
    statedUnitType?: { type: string; source: string } | null;
  },
): ReconcileResult {
  const matchKeys = policy.matchByUnitNumber ? [MATCH_KEYS[0]!, NUMBER_MATCH_KEY] : MATCH_KEYS;
  // A unit code on our side is U-n; a source quoting one matches it too.
  const byCrmCode = new Map<string, CrmUnit>();
  for (const u of crm) {
    const c = part(u.data.unit_code);
    if (c) byCrmCode.set(c, u);
  }
  const crmIndex = new Map<string, CrmUnit[]>();
  for (const u of crm) {
    for (const [, fn] of matchKeys) {
      const k = fn(crmKeyInput(u.data));
      if (k) crmIndex.set(k, [...(crmIndex.get(k) ?? []), u]);
    }
  }
  // Which key kinds the CRM side actually has (bu:, gu:, …).
  const crmKeyKinds = new Set([...crmIndex.keys()].map((k) => k.slice(0, k.indexOf(':'))));
  // Count source keys over DISTINCT source units — the same unit repeated by
  // unstable pagination must not look like two units sharing a key.
  const distinct = new Map<string, SourceUnit>();
  for (const s of source) {
    const dk = sourceUnitKey(s);
    if (!distinct.has(dk)) distinct.set(dk, s);
  }
  const srcCount = new Map<string, number>();
  for (const s of distinct.values()) {
    for (const [, fn] of matchKeys) {
      const k = fn(srcKeyInput(s));
      if (k) srcCount.set(k, (srcCount.get(k) ?? 0) + 1);
    }
  }
  const findMatch = (s: SourceUnit): { unit: CrmUnit | null; ambiguous: boolean; candidates: CrmUnit[] } => {
    const code = part(s.unitCode);
    if (!policy.matchByUnitNumber && code && byCrmCode.has(code)) return { unit: byCrmCode.get(code)!, ambiguous: false, candidates: [] };
    let sawAmbiguity = false;
    const candidates: CrmUnit[] = [];
    // A unit NUMBER is the unit's identity. When the source gives one and the
    // CRM's units carry the same kind of key, a miss means a NEW unit — never
    // fall back to the floor-level keys (they match several units and turned
    // 13 new ستون الملقا units into "ambiguous", 2026-10-05).
    let numberKeyTried = false;
    let numberKeyHit = false;
    for (const [name, fn] of matchKeys) {
      const k = fn(srcKeyInput(s));
      if (!k) continue;
      if ((name === 'block_building_floor' || name === 'building_floor') && numberKeyTried && !numberKeyHit) {
        return { unit: null, ambiguous: false, candidates: [] };
      }
      const hits = crmIndex.get(k) ?? [];
      if ((name === 'block_unit' || name === 'building_unit') && crmKeyKinds.has(k.slice(0, k.indexOf(':')))) {
        numberKeyTried = true;
        if (hits.length) numberKeyHit = true;
      }
      if (hits.length === 1 && (srcCount.get(k) ?? 0) <= 1) return { unit: hits[0]!, ambiguous: false, candidates: [] };
      // Ambiguous only when a CRM unit is actually in play: ten source units all
      // titled «شقة» in a project the CRM has no units for are ten NEW units,
      // not ten unresolvable matches (found on أكنان 24, 2026-10-04).
      if (hits.length > 1 || (hits.length === 1 && (srcCount.get(k) ?? 0) > 1)) {
        sawAmbiguity = true;
        candidates.push(...hits);
      }
    }
    return { unit: null, ambiguous: sawAmbiguity, candidates };
  };

  const updates: UnitPatch[] = [];
  const creates: UnitCreate[] = [];
  const ambiguous: string[] = [];
  const matchedIds = new Set<string>();
  const ambiguousIds = new Set<string>();
  const seenSrc = new Set<string>();
  let statusChanges = 0, toSoldOrReserved = 0, priceChanges = 0, matched = 0;
  const priceDiffsNotApplied: ReconcileResult['priceDiffsNotApplied'] = [];
  const incomplete: ReconcileResult['incomplete'] = [];

  for (const s of source) {
    const label = sourceLabel(s);
    // The same unit listed twice by the source (unstable pagination) → once.
    const dedupeKey = sourceUnitKey(s);
    if (seenSrc.has(dedupeKey)) continue;
    seenSrc.add(dedupeKey);

    const m = findMatch(s);
    if (!m.unit && m.ambiguous) {
      ambiguous.push(label);
      if (policy.matchByUnitNumber) for (const candidate of m.candidates) ambiguousIds.add(candidate.id);
      continue;
    }
    if (m.unit && matchedIds.has(m.unit.id)) { ambiguous.push(label); continue; }

    if (m.unit) {
      const u = m.unit;
      matched++;
      matchedIds.add(u.id);
      const patch: Record<string, unknown> = {};
      const reasons: string[] = [];
      const cur = crmStatus(u.data);
      const forwardOk = (!policy.forwardOnly || (STATUS_RANK[s.status ?? ''] ?? -1) > (STATUS_RANK[cur] ?? -1))
        && !(policy.keepReserved && cur === 'reserved');
      if (s.status && s.status !== cur && forwardOk) {
        patch.unit_status = s.status;
        reasons.push(`status ${cur || '∅'} → ${s.status}`);
        statusChanges++;
        if ((s.status === 'sold' || s.status === 'reserved') && cur === 'available') toSoldOrReserved++;
      }
      if (s.price != null && s.price > 0) {
        const curPrice = num(u.data.total_price);
        const provenance = sourcePriceFields(s);
        // Foreign prices are an exact conversion tuple (including rounding).
        // SAR-only sources retain the lane's existing one-riyal tolerance.
        const priceChanged = provenance ? curPrice !== s.price : curPrice == null || Math.abs(curPrice - s.price) >= 1;
        const provenanceChanged = provenance != null && Object.entries(provenance)
          .some(([key, value]) => u.data[key] !== value);
        if (priceChanged || provenanceChanged) {
          if (policy.updatePrices) {
            patch.total_price = s.price;
            if (provenance) Object.assign(patch, provenance);
            reasons.push(priceChanged ? `price ${curPrice ?? '∅'} → ${s.price}` : 'source price / FX provenance updated');
            if (priceChanged) priceChanges++;
          } else if (priceChanged) {
            priceDiffsNotApplied.push({ unit: String(u.data.unit_model ?? u.data.unit_code ?? u.id), crm: curPrice, source: s.price });
          }
        }
      }
      // Record the source's own unit id the first time we match by something
      // weaker, so later runs match on it directly.
      if (policy.recordSourceId !== false && s.unitCode && !/^U-\d+$/i.test(s.unitCode) && !isLayoutLetter(s.unitCode) && !part(u.data.developer_unit_code)) {
        patch.developer_unit_code = s.unitCode;
        reasons.push('source unit id recorded');
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
    if (s.unitCode && !/^U-\d+$/i.test(s.unitCode)) data.developer_unit_code = s.unitCode;
    if (s.block) data.block = s.block;
    if (s.buildingNumber) data.building_number = s.buildingNumber;
    if (s.unitNumber != null) data.unit_number = s.unitNumber;
    // The type comes from the SOURCE only. A sibling is picked by closest area,
    // so borrowing its type would be a guess dressed up as data.
    const ownType = mapUnitType(s.unitType ?? null);
    const t = ownType ?? ctx.statedUnitType?.type ?? null;
    // The four essentials (operator rule, 2026-10-05): a unit is NEVER created
    // without area, price, bedrooms and unit type. Missing any → skipped and
    // reported, so the operator is told what to ask the developer for.
    const missing = missingEssentials(s, t);
    // Identity: in a project whose CRM units are known by building/block +
    // unit NUMBER, a source row without a number (or a code) cannot be told
    // apart from the others — creating it would make a unit nobody can match
    // again (ستون الملقا replay 2026-10-05: rows read as «P», «J» → 18 junk units).
    if (s.unitNumber == null && !part(s.unitCode) && (crmKeyKinds.has('gu') || crmKeyKinds.has('bu'))) missing.push('unit_number');
    if (missing.length) { incomplete.push({ unit: label, missing }); continue; }
    if (t) data.unit_type = t;
    if (s.price != null && s.price > 0) {
      data.total_price = s.price;
      Object.assign(data, sourcePriceFields(s));
    }
    if (s.area != null && s.area > 0) data.unit_area = s.area;
    if (s.sourceNetArea != null && s.sourceNetArea > 0) data.source_net_area = s.sourceNetArea;
    if (s.sourceTotalArea != null && s.sourceTotalArea > 0) data.source_total_area = s.sourceTotalArea;
    if (s.sourceAreaUnit) data.source_area_unit = s.sourceAreaUnit;
    if (s.sourceUnitType) data.source_unit_type = s.sourceUnitType;
    if (s.sourceFloor != null) data.source_floor = s.sourceFloor;
    if (s.bedrooms != null) data.bedrooms = s.bedrooms;
    if (s.bathrooms != null) data.bathrooms = s.bathrooms;
    const fl = mapFloor(s.floor);
    if (fl) data.floor = fl;
    const noteLines = [`${label} — ${ctx.projectName} (${ctx.sourceLabel}، ${ctx.today} — وحدة جديدة/مُفرجة، أُضيفت تلقائياً)`];
    if (s.description) noteLines.push(`مواصفات المصدر: ${s.description}`);
    if (!ownType && ctx.statedUnitType) noteLines.push(`نوع الوحدة «${ctx.statedUnitType.type}» حسب تصريح المطوّر للمشروع: ${ctx.statedUnitType.source}`);
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
    if (policy.absentAvailable === 'sold' && crmStatus(u.data) === 'available' && !ambiguousIds.has(u.id)) {
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
    priceDiffsNotApplied,
    incomplete,
    ambiguous,
    stats: {
      sourceUnits: seenSrc.size,
      crmUnits: crm.length,
      crmUnsold: crm.filter((u) => crmStatus(u.data) !== 'sold').length,
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
  // The source and the CRM share NO unit although both have several: the
  // project link most likely points at a different project / phase (دروازة,
  // 2026-10-04: the API lists Block 1, our 22 units are Blocks 3-4). Creating
  // the source's units would stack a second inventory next to ours.
  if (r.stats.matched === 0 && r.stats.crmUnits >= 5 && r.stats.sourceUnits >= 5) {
    return `the source shares no unit with the ${r.stats.crmUnits} units in the CRM — wrong project link or a different numbering`;
  }
  // Empty source + units still on sale in the CRM = a failed page. Empty
  // source + every CRM unit already sold = a sold-out project (صفا 83/52 after
  // 2026-10-05) — nothing would change, so it is not a hold.
  if (r.stats.sourceUnits === 0 && r.stats.crmUnsold > 0) {
    return 'the source returned no units for a project that has units — a failed page, not an empty project';
  }
  return null;
}

export type { UnitStatus };
