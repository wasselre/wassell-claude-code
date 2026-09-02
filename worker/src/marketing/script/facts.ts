/**
 * Facts package — the ONLY source of factual claims for a script.
 *
 * Reads one `all_projects` record (unified_records, model
 * 220c49b9-de57-492d-9eca-c0d9f54fd40f — see docs/prd/models/all-projects.md)
 * and produces typed, id'd facts (F1..) with a `claimable` flag. Approved rules:
 *
 *  - readiness ONLY from enums (project_status / construction_status), never
 *    from free text; a contradiction is surfaced as 'conflict', not guessed.
 *  - price ONLY from available_price_range.min when available_units > 0 —
 *    a sold-out tier must never set the headline price (CLAUDE.md rollups).
 *  - guarantees are QUALITATIVE (their table columns are unlabeled) → text
 *    facts that are not claimable as numbers ('needs_labeling').
 *  - marketing_document / project_analysis are context, never a number source.
 *  - financing / returns / yield: NEVER produced.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Fact, FactClass, FactsPackage, Readiness } from './types.js';

export const ALL_PROJECTS_MODEL_ID = '220c49b9-de57-492d-9eca-c0d9f54fd40f';
export const FRESHNESS_DAYS = 90;
const QUALITATIVE_MAX_CHARS = 6000;

export const UNIT_TYPE_AR: Record<string, string> = {
  apartment: 'شقة', apartments: 'شقق', townhouse: 'تاون هاوس', townhouses: 'تاون هاوس', villa: 'فيلا', villas: 'فلل',
  floor: 'دور', floors: 'أدوار', duplex: 'دوبلكس', studio: 'استوديو', penthouse: 'بنتهاوس', 'برج': 'برج',
};

/** all_projects.preferred_amenities option → Arabic label (from the live schema). */
export const AMENITY_AR: Record<string, string> = {
  prayer_room: 'مصلى', mosque: 'مسجد', swimming_pool: 'مسبح', sports_club: 'نادي رياضي', lounge: 'لاونج',
  mini_market: 'ميني ماركت', garden: 'حديقة', green_spaces: 'مساحات خضراء', basement_parking: 'مواقف قبو',
  football_pitch: 'ملعب كرة قدم', basketball_court: 'ملعب كرة سلة', volleyball_court: 'ملعب كرة طائرة',
  tennis_court: 'ملعب تنس', 'مواقف-خارجية': 'مواقف خارجية', 'اسطح-خاصة': 'أسطح خاصة', 'بلكونات': 'بلكونات',
  'نظام-مراقبة-امنية': 'نظام مراقبة أمنية', 'مواقف-خارجية-مظللة': 'مواقف خارجية مظللة',
  'شواحن-سيارات-كهربايية': 'شواحن سيارات كهربائية', 'نظام-دخول-ذكي': 'نظام دخول ذكي', 'مصاعد': 'مصاعد',
  'خزان-مياه-ارضي': 'خزان مياه أرضي', 'مضخات-مياه': 'مضخات مياه', 'سينما': 'سينما', 'جلسات-خارجية': 'جلسات خارجية',
  'فراغات-مرنة': 'فراغات مرنة', jacuzzi: 'جاكوزي', sauna: 'ساونا', steam_room: 'غرفة بخار', 'سبا': 'سبا',
  'منطقة-دراجات': 'منطقة دراجات', 'منطقة-خدمة-ذاتية': 'منطقة خدمة ذاتية', golf: 'ملاعب غولف',
  commercial_showrooms: 'معارض تجارية', 'كونسرج': 'كونسرج', 'غرفة-بريد': 'غرفة بريد', 'بزنس-سنتر': 'بزنس سنتر',
  'ممرات-رياضية': 'ممرات رياضية', padel_court: 'ملعب بادل', children_play_area: 'منطقة ألعاب أطفال',
  'ملعب-اسكواش': 'ملعب اسكواش',
};

const OFF_PLAN_PROJECT_STATUS = new Set(['available_on_map', 'under_construction', 'upcoming']);
const IN_PROGRESS_CONSTRUCTION = new Set(['excavation', 'foundations', 'structure', 'finishing', 'facade_installation', 'تحت-التطوير']);

interface Range { min?: number | null; max?: number | null }

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,٬\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim();
}
function range(v: unknown): Range | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const min = num(r.min);
  const max = num(r.max);
  if (min === null && max === null) return null;
  return { min, max };
}
function rows(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
}

export function fmtNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/** Deterministic readiness from the two status enums only. */
export function deriveReadiness(projectStatus: string, constructionStatus: string): Readiness {
  const ps = projectStatus.trim();
  const cs = constructionStatus.trim();
  const offPlanMarker = OFF_PLAN_PROJECT_STATUS.has(ps) || IN_PROGRESS_CONSTRUCTION.has(cs);
  const readyMarker = cs === 'ready' || (ps === 'available' && !IN_PROGRESS_CONSTRUCTION.has(cs));
  if (offPlanMarker && cs === 'ready') return 'conflict';
  if (OFF_PLAN_PROJECT_STATUS.has(ps)) return 'off_plan';
  if (readyMarker) return 'ready';
  if (offPlanMarker) return 'off_plan';
  return 'unknown';
}

function daysSince(iso: string, now: Date): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / 86_400_000;
}

/** Parse "٥ دقائق" / "3.2 كم" / "500 م" out of a landmark cell. */
function parseMeasure(s: string): { value: number; unit: 'minute' | 'km' | 'm' } | null {
  const t = s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(دقيقه|دقيقة|دقائق|د\b|min|minutes?|كم|كيلو|km|متر|م\b|m\b)/i);
  if (!m) return null;
  const value = Number(m[1]!.replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  const u = m[2]!.toLowerCase();
  const unit: 'minute' | 'km' | 'm' = /دق|min|د/.test(u) ? 'minute' : /كم|كيلو|km/.test(u) ? 'km' : 'm';
  return { value, unit };
}

export interface FactsOptions { now?: Date; developerName?: string | null; marketerName?: string | null }

export function buildFactsPackage(record: Record<string, unknown>, opts: FactsOptions = {}): FactsPackage {
  const now = opts.now ?? new Date();
  const g = (k: string): unknown => record[k];
  const facts: Fact[] = [];
  const warnings: string[] = [];
  const missing: string[] = [];
  let n = 0;
  const verifiedAt = str(g('last_verified_at')) || str(g('status_checked_at')) || null;
  const add = (key: string, cls: FactClass, value: unknown, rendered: string, source: string, claimable: boolean, note?: string): Fact => {
    n += 1;
    const f: Fact = { id: `F${n}`, key, class: cls, value, rendered_ar: rendered, source_field: source, verified_at: verifiedAt, claimable };
    if (note) f.note = note;
    facts.push(f);
    return f;
  };

  // ── name
  const projectName = str(g('project_name')) || str(g('name'));
  if (projectName) add('project_name', 'name', projectName, projectName, 'project_name', true);
  else missing.push('project_name');

  // ── readiness (enums only)
  const ps = str(g('project_status'));
  const cs = str(g('construction_status'));
  const readiness = deriveReadiness(ps, cs);
  if (readiness === 'off_plan') add('readiness', 'status', 'off_plan', 'بيع على الخارطة (تحت الإنشاء)', 'project_status/construction_status', true);
  else if (readiness === 'ready') add('readiness', 'status', 'ready', 'جاهز للسكن / استلام فوري', 'project_status/construction_status', true);
  else if (readiness === 'conflict') {
    warnings.push(`readiness conflict: project_status='${ps}' vs construction_status='${cs}' — fix the record before scripting`);
    missing.push('readiness');
  } else {
    warnings.push(`readiness unknown: project_status='${ps || '∅'}', construction_status='${cs || '∅'}'`);
    missing.push('readiness');
  }

  // ── availability / sold out
  const availableUnits = num(g('available_units'));
  const unitCount = num(g('unit_count'));
  const soldOut = ps === 'sold_out' || availableUnits === 0;
  if (soldOut) warnings.push('project is sold out — no price fact; the script must not quote a price or availability');
  if (unitCount !== null && unitCount > 0) add('unit_count', 'unit_count', unitCount, `${fmtNum(unitCount)} وحدة`, 'unit_count', true);
  if (availableUnits !== null && availableUnits > 0) add('available_units', 'availability', availableUnits, `${fmtNum(availableUnits)} وحدة متاحة`, 'available_units', true);
  if (availableUnits === null && !soldOut) warnings.push('no unit inventory (available_units is empty) — price and availability omitted');

  // ── price (available range only, min when available_units > 0)
  const avail = range(g('available_price_range'));
  let hasPrice = false;
  if (!soldOut && availableUnits !== null && availableUnits > 0 && avail && avail.min !== null && avail.min! > 0) {
    add('price_from', 'price', avail.min, `تبدأ من ${fmtNum(avail.min!)} ر.س`, 'available_price_range.min', true);
    hasPrice = true;
    if (avail.max !== null && avail.max! > avail.min!) add('price_to', 'price', avail.max, `حتى ${fmtNum(avail.max!)} ر.س`, 'available_price_range.max', true);
  } else {
    missing.push('price');
    if (!soldOut && avail === null && availableUnits !== null && availableUnits > 0) warnings.push('available_price_range is empty although units are available — rollup missing?');
  }

  // ── areas (available range)
  const area = range(g('available_area_range'));
  if (!soldOut && area && (area.min !== null || area.max !== null)) {
    const lo = area.min ?? area.max!;
    const hi = area.max ?? area.min!;
    add('area_range', 'area', { min: lo, max: hi }, lo === hi ? `مساحة ${fmtNum(lo)} م²` : `مساحات من ${fmtNum(lo)} إلى ${fmtNum(hi)} م²`, 'available_area_range', true);
  }

  // ── unit types
  const types = Array.isArray(g('unit_types')) ? (g('unit_types') as unknown[]).map(str).filter(Boolean) : [];
  const typeLabels = Array.from(new Set(types.map((t) => UNIT_TYPE_AR[t] ?? t)));
  for (const t of typeLabels) add(`unit_type:${t}`, 'unit_type', t, t, 'unit_types', true);
  if (typeLabels.length === 0) missing.push('unit_types');

  // ── bedrooms (all-unit range — descriptive, claimable as a count)
  const bed = range(g('bedroom_range'));
  if (bed && bed.max !== null && bed.max! > 0) {
    const lo = bed.min ?? bed.max!;
    add('bedrooms', 'other', { min: lo, max: bed.max }, lo === bed.max ? `${fmtNum(lo)} غرف نوم` : `من ${fmtNum(lo)} إلى ${fmtNum(bed.max!)} غرف نوم`, 'bedroom_range', true, 'all-unit range (not only available units)');
  }

  // ── location
  const loc = (g('location') && typeof g('location') === 'object' ? g('location') : {}) as Record<string, unknown>;
  const district = str(loc.district_ar) || str(loc.district) || str(g('preferred_neighborhoods')) || str(loc.district_name);
  const city = str(loc.city_ar) || str(loc.city) || str(g('city_name')) || str(loc.city_name);
  if (district || city) add('location', 'location', { district, city }, [district, city].filter(Boolean).join('، '), 'location', true);
  else missing.push('location');

  // ── handover (off-plan only)
  const handover = str(g('handover_date'));
  if (readiness === 'off_plan') {
    if (handover) add('handover_date', 'date', handover.slice(0, 10), `التسليم المتوقع ${handover.slice(0, 7)}`, 'handover_date', true);
    else missing.push('handover_date');
  }

  // ── payment plan
  const dp = num(g('down_payment_percent'));
  if (dp !== null && dp > 0) add('down_payment_percent', 'payment', dp, `دفعة أولى ${fmtNum(dp)}٪`, 'down_payment_percent', true);
  const dc = num(g('during_construction_percent'));
  if (dc !== null && dc > 0) add('during_construction_percent', 'payment', dc, `${fmtNum(dc)}٪ أثناء الإنشاء`, 'during_construction_percent', true);
  const oh = num(g('on_handover_percent'));
  if (oh !== null && oh > 0) add('on_handover_percent', 'payment', oh, `${fmtNum(oh)}٪ عند التسليم`, 'on_handover_percent', true);
  const ph = num(g('post_handover_months'));
  if (ph !== null && ph > 0) add('post_handover_months', 'payment', ph, `تقسيط ${fmtNum(ph)} شهر بعد التسليم`, 'post_handover_months', true);
  const pps = str(g('payment_plan_summary'));
  if (pps) add('payment_plan_summary', 'payment', pps, pps, 'payment_plan_summary', false, 'qualitative — numbers inside are not verified fields');

  // ── features / amenities / services
  const featureRows = rows(g('features')).map((r) => str(r.feature)).filter(Boolean);
  const amenities = Array.isArray(g('preferred_amenities')) ? (g('preferred_amenities') as unknown[]).map(str).filter(Boolean).map((a) => AMENITY_AR[a] ?? a) : [];
  const services = rows(g('services')).map((r) => str(r.service)).filter(Boolean);
  const featureSet = Array.from(new Set([...featureRows, ...amenities, ...services]));
  for (const f of featureSet) add(`feature:${f}`, 'feature', f, f, featureRows.includes(f) ? 'features' : amenities.includes(f) ? 'preferred_amenities' : 'services', true);
  if (featureSet.length < 3) missing.push('features');

  // ── landmarks (distance / duration only when the cell has a number)
  for (const l of rows(g('nearby_landmarks'))) {
    const name = str(l.landmark);
    if (!name) continue;
    add(`landmark:${name}`, 'landmark', name, `قريب من ${name}`, 'nearby_landmarks', true);
    const dist = str(l.distance);
    const dur = str(l.duration);
    const dm = dist ? parseMeasure(dist) : null;
    if (dm) add(`distance:${name}`, 'distance', dm.value, `${fmtNum(dm.value)} ${dm.unit === 'km' ? 'كم' : 'م'} من ${name}`, 'nearby_landmarks.distance', true);
    else if (dist) add(`distance:${name}`, 'distance', dist, `${dist} من ${name}`, 'nearby_landmarks.distance', false, 'non-numeric distance text');
    const um = dur ? parseMeasure(dur) : null;
    if (um) add(`duration:${name}`, 'duration', um.value, `${fmtNum(um.value)} دقيقة إلى ${name}`, 'nearby_landmarks.duration', true);
    else if (dur) add(`duration:${name}`, 'duration', dur, `${dur} إلى ${name}`, 'nearby_landmarks.duration', false, 'non-numeric duration text');
  }

  // ── guarantees: qualitative, never claimable numbers
  const guarantees = rows(g('guarantees')).map((r) => [r.col_1, r.col_2, r.col_3, r.col_4].map(str).filter(Boolean).join(' — ')).filter(Boolean);
  for (const gtxt of guarantees) add(`guarantee:${gtxt.slice(0, 40)}`, 'guarantee', gtxt, `ضمان: ${gtxt}`, 'guarantees', false, 'needs_labeling — guarantee columns are unlabeled; mention guarantees qualitatively, never as a number');

  // ── qualitative context (never a number source)
  for (const key of ['marketing_document', 'project_analysis'] as const) {
    const v = str(g(key));
    if (!v) continue;
    const truncated = v.length > QUALITATIVE_MAX_CHARS;
    add(key, 'other', truncated ? v.slice(0, QUALITATIVE_MAX_CHARS) : v, truncated ? `${v.slice(0, QUALITATIVE_MAX_CHARS)} …` : v, key, false, 'qualitative context only — NEVER a source for numbers; any number here is unverified');
  }

  // ── freshness
  const freshSrc = str(g('status_checked_at')) || str(g('last_verified_at'));
  if (!freshSrc) warnings.push('record never verified (status_checked_at / last_verified_at empty)');
  else {
    const d = daysSince(freshSrc, now);
    if (d !== null && d > FRESHNESS_DAYS) warnings.push(`record last verified ${Math.round(d)} days ago (> ${FRESHNESS_DAYS}) — confirm status and price before publishing`);
  }

  const readinessKnown = readiness === 'off_plan' || readiness === 'ready';
  const viable = Boolean(projectName) && readinessKnown && (hasPrice || typeLabels.length > 0 || featureSet.length >= 3);

  const pkg: FactsPackage = { project_name: projectName || '(unnamed)', readiness, sold_out: soldOut, facts, warnings, viable, missing };
  if (opts.developerName !== undefined) pkg.developer_name = opts.developerName;
  if (opts.marketerName !== undefined) pkg.marketer_name = opts.marketerName;
  return pkg;
}

/** Load the raw all_projects jsonb (service client). Throws on DB error; null when absent. */
export async function loadProjectRecord(sb: SupabaseClient, projectId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await sb
    .from('unified_records')
    .select('data')
    .eq('id', projectId)
    .eq('model_id', ALL_PROJECTS_MODEL_ID)
    .maybeSingle();
  if (error) throw new Error(`project read failed: ${error.message}`);
  if (!data) return null;
  return ((data as { data: unknown }).data ?? null) as Record<string, unknown> | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a lookup value (record id or inline text) to a display name via
 * unified_records.data.name. Returns the raw text when it is not a uuid.
 */
export async function resolveLookupName(sb: SupabaseClient, value: unknown): Promise<string | null> {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== 'string' || !v.trim()) return null;
  if (!UUID_RE.test(v)) return v.trim();
  const { data, error } = await sb.from('unified_records').select('data').eq('id', v).maybeSingle();
  if (error) throw new Error(`lookup read failed: ${error.message}`);
  const d = (data as { data?: Record<string, unknown> } | null)?.data;
  if (!d) return null;
  const name = d.name ?? d.name_ar ?? d.developer_name ?? d.marketer_name ?? d.company_name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}
