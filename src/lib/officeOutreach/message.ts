/**
 * The WhatsApp message a real-estate office receives for an unanswered request.
 *
 * Pure (no store / no network) so the api, tests and the SPA share it.
 *
 * Shape follows the cold-outreach research behind the office-outreach
 * migration (2026-09-28_office_outreach.sql): ONE short message that ends in a
 * question the office can answer, NO links and NO media (links from a new
 * number are a ban signal), and an explicit way to opt out. Identical text sent
 * to many strangers is itself a spam signal, so the wording rotates between
 * variants chosen by the office id — stable for one office, different across
 * offices.
 *
 * Voice (operator, 2026-10-05 — "the message is shit"): it reads like one of
 * our reps writing to a broker, in Najdi, not a mail-merge in fusha.
 *   - No office name: the stored name is usually the owner's full legal name
 *     («أحمد راشد براك العتيبي»), which reads like a bulk send.
 *   - A time-neutral greeting: messages are paced and land hours after they
 *     are queued, so «مساء الخير» would arrive in the morning.
 *   - The office's OWN district first («في الملز أو اللي حوله») — that is why
 *     this office was picked — then the specs a broker needs to answer: buying,
 *     type, rooms, size as a real range, budget, ready / off-plan.
 *   - One clear ask: send the details and the price.
 *   - The rep's request note is never included (internal; see requestData).
 */

export interface RequestFacts {
  /** Unit types the client wants, already localised (e.g. «فيلا», «شقة»). */
  unitTypes: string[];
  /** Requested district / area labels, de-duplicated. */
  places: string[];
  /** More places exist than `places` names (a drawing's «+20») → «وغيرها». */
  morePlaces?: boolean;
  /** City label, when known. */
  city?: string | null;
  budgetMin?: number | null;
  budgetMax?: number | null;
  bedroomsMin?: number | null;
  bedroomsMax?: number | null;
  areaMin?: number | null;
  areaMax?: number | null;
  /** Set only when the client wants exactly one: ready now, or off-plan. */
  readiness?: 'ready' | 'off_plan' | null;
  /** Kept for callers/tests; never put into the office message. */
  notes?: string | null;
}

/** The office being written to. */
export interface OfficeTarget {
  /** The office's own district, when it was matched on it («حي الملز» or «الملز»). */
  district?: string | null;
}

/** How many place names the message lists before «وغيرها». */
export const MAX_PLACES = 4;
/** WhatsApp messages over this start to read like a brochure, not a question. */
export const MAX_MESSAGE_CHARS = 600;

/** «2٫5 مليون» / «850 ألف» — Arabic decimal comma, whole millions without a decimal. */
export function formatAmountAr(n: number): string {
  if (n >= 1_000_000) {
    const m = Math.round((n / 1_000_000) * 10) / 10;
    return `${Number.isInteger(m) ? m : String(m).replace('.', '٫')} مليون`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)} ألف`;
  return String(Math.round(n));
}

const pos = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/** «من X إلى Y» / «حتى Y» / «من X»; null when neither is set. */
function rangeText(min: number | null | undefined, max: number | null | undefined, fmt: (n: number) => string): string | null {
  const lo = pos(min), hi = pos(max);
  if (lo && hi) return lo === hi ? fmt(lo) : `من ${fmt(lo)} إلى ${fmt(hi)}`;
  if (hi) return `حتى ${fmt(hi)}`;
  if (lo) return `من ${fmt(lo)}`;
  return null;
}

/** Arabic counted noun for rooms: غرفة / غرفتين / 3 غرف / 11 غرفة. */
function rooms(n: number): string {
  if (n === 1) return 'غرفة';
  if (n === 2) return 'غرفتين';
  return n <= 10 ? `${n} غرف` : `${n} غرفة`;
}

/** «4 غرف» · «3 إلى 4 غرف» · «4 غرف وأكثر» · «حتى 3 غرف». */
export function roomsText(min: number | null | undefined, max: number | null | undefined): string | null {
  const lo = pos(min), hi = pos(max);
  if (lo && hi) return lo === hi ? rooms(lo) : `${lo} إلى ${rooms(hi)}`;
  if (lo) return `${rooms(lo)} وأكثر`;
  if (hi) return `حتى ${rooms(hi)}`;
  return null;
}

/** «مساحة 291 إلى 297 متر» — whole metres, the way reps say it. */
function areaText(min: number | null | undefined, max: number | null | undefined): string | null {
  const lo = pos(min), hi = pos(max);
  if (lo && hi) return lo === hi ? `مساحة ${Math.round(lo)} متر` : `مساحة ${Math.round(lo)} إلى ${Math.round(hi)} متر`;
  if (hi) return `مساحة حتى ${Math.round(hi)} متر`;
  if (lo) return `مساحة ${Math.round(lo)} متر وأكثر`;
  return null;
}

function budgetText(min: number | null | undefined, max: number | null | undefined): string | null {
  const r = rangeText(min, max, formatAmountAr);
  return r ? `الميزانية ${r}` : null;
}

function readinessText(r: RequestFacts['readiness']): string | null {
  return r === 'ready' ? 'جاهز للسكن' : r === 'off_plan' ? 'على الخارطة' : null;
}

/** «حي الملز» → «الملز». */
const bareDistrict = (s: string): string => s.trim().replace(/^حي\s+/, '');

const uniq = (xs: string[]): string[] => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** «بالرياض» / «بجدة». */
const inCity = (city: string): string => `ب${city.trim()}`;

/** Where, in words: the office's district first, else the client's places, else the city. */
function whereText(f: RequestFacts, officeDistrict: string | null): string {
  const city = f.city && f.city.trim() ? f.city.trim() : null;
  const places = uniq(f.places.map(bareDistrict));
  if (officeDistrict) {
    const d = bareDistrict(officeDistrict);
    const others = places.filter((p) => p !== d);
    return `في ${d}${others.length > 0 ? ' أو اللي حوله' : ''}${city ? ` ${inCity(city)}` : ''}`;
  }
  if (places.length > 0) {
    const shown = places.slice(0, MAX_PLACES);
    // «النرجس والياسمين» / «أ، ب، ج، د وغيرها».
    const more = places.length > MAX_PLACES || f.morePlaces === true;
    const list = more || shown.length === 1
      ? shown.join('، ')
      : `${shown.slice(0, -1).join('، ')} و${shown[shown.length - 1]}`;
    return `في ${list}${more ? ' وغيرها' : ''}${city ? ` ${inCity(city)}` : ''}`;
  }
  return city ? `في ${city}` : '';
}

const typesText = (f: RequestFacts): string => {
  const types = uniq(f.unitTypes);
  return types.length > 0 ? types.join(' أو ') : 'عقار';
};

/** The ask as one line, for the app's own screens (list rows, previews). */
export function describeAsk(f: RequestFacts): string {
  const parts = [`${typesText(f)} ${whereText(f, null)}`.trim()];
  for (const s of [readinessText(f.readiness), budgetText(f.budgetMin, f.budgetMax), roomsText(f.bedroomsMin, f.bedroomsMax), areaText(f.areaMin, f.areaMax)]) {
    if (s) parts.push(s);
  }
  return parts.join('، ');
}

/** Element i of a non-empty list (wrapping), typed as present. */
const at = <T,>(list: readonly T[], i: number): T => list[i % list.length] as T;

/** Stable small hash so one office always gets the same wording. */
export function variantFor(key: string, count: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return count > 0 ? h % count : 0;
}

// Time-neutral on purpose: a paced message can land hours after it was queued.
const GREETINGS = ['السلام عليكم', 'حياكم الله', 'السلام عليكم ورحمة الله', 'هلا والله'];
const WHO = ['معكم وصل العقارية', 'معكم فريق وصل العقارية', 'من وصل العقارية', 'معكم وصل العقارية'];
// No «يدور»: with the type «دور» it reads «يدور دور» (caught live, 2026-10-05).
const ASKERS = ['عندنا عميل يبي يشتري', 'عندنا عميل حاب يشتري', 'معنا عميل يبي يشتري', 'عندنا مشتري يبي'];
const CLOSERS = [
  'عندكم شي يناسبه؟ أرسلوا لنا التفاصيل والسعر الله يعافيكم.',
  'فيه شي عندكم بهالمواصفات؟ ابعثوا لنا التفاصيل والسعر.',
  'عندكم شي مناسب؟ عطونا التفاصيل والسعر الله يسلمكم.',
  'لو عندكم شي يناسب ابعثوا لنا التفاصيل والسعر، الله يعافيكم.',
];
const OPT_OUT = 'ولو ما تبون طلبات منا ردوا بكلمة «إيقاف».';

/**
 * Build one office's message. `variantKey` is normally the office id, so the
 * same office always reads the same wording but neighbours read different ones.
 */
export function buildOfficeMessage(f: RequestFacts, office: OfficeTarget, variantKey: string): string {
  const v = variantFor(variantKey, GREETINGS.length);
  const district = office.district && office.district.trim() ? office.district : null;
  const head = `${typesText(f)} ${whereText(f, district)}`.trim();
  const specs = [roomsText(f.bedroomsMin, f.bedroomsMax), areaText(f.areaMin, f.areaMax), budgetText(f.budgetMin, f.budgetMax), readinessText(f.readiness)]
    .filter((s): s is string => !!s);
  const ask = `${at(ASKERS, v)} ${[head, ...specs].join('، ')}.`;
  const text = [`${at(GREETINGS, v)}، ${at(WHO, v)}.`, ask, at(CLOSERS, v), OPT_OUT].join('\n');
  return text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS - 1) + '…' : text;
}

/** True when a message would carry a link — never sent from a cold line. */
export function containsLink(text: string): boolean {
  return /(https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,6}\b)/i.test(text);
}
