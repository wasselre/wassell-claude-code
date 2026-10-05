/**
 * The WhatsApp message a real-estate office receives for an unanswered request.
 *
 * Pure (no store / no network) so the api, tests and the SPA share it.
 *
 * Shape follows the cold-outreach research behind the office-outreach
 * migration (2026-09-28_office_outreach.sql): ONE short message, personal (the
 * office's name when we have it), ends in a question the office can answer,
 * NO links and NO media (links from a new number are a ban signal), and an
 * explicit way to opt out. Identical text sent to many strangers is itself a
 * spam signal, so the wording rotates between variants chosen by the office id
 * — stable for one office, different across offices.
 */

export interface RequestFacts {
  /** Unit types the client wants, already localised (e.g. «فيلا», «شقة»). */
  unitTypes: string[];
  /** Requested district / area labels, de-duplicated. */
  places: string[];
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
  /** An extra line for the office. The SPA no longer passes the rep's request
   *  notes here (they are internal — 2026-10-05); kept for callers/tests. */
  notes?: string | null;
}

/** How many place names the message lists before «وغيرها». */
export const MAX_PLACES = 4;
/** Longest rep note carried into the message. */
export const MAX_NOTE_CHARS = 160;
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

function rangeText(min: number | null | undefined, max: number | null | undefined, fmt: (n: number) => string): string | null {
  const lo = typeof min === 'number' && Number.isFinite(min) && min > 0 ? min : null;
  const hi = typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : null;
  if (lo && hi) return lo === hi ? fmt(lo) : `من ${fmt(lo)} إلى ${fmt(hi)}`;
  if (hi) return `حتى ${fmt(hi)}`;
  if (lo) return `من ${fmt(lo)}`;
  return null;
}

/** Element i of a non-empty list (wrapping), typed as present. */
const at = <T,>(list: readonly T[], i: number): T => list[i % list.length] as T;

/** Stable small hash so one office always gets the same wording. */
export function variantFor(key: string, count: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return count > 0 ? h % count : 0;
}

const OPENINGS = [
  (name: string | null) => `السلام عليكم${name ? ` ${name}` : ''}،`,
  (name: string | null) => `مساء الخير${name ? ` ${name}` : ''}،`,
  (name: string | null) => `حياكم الله${name ? ` ${name}` : ''}،`,
  (name: string | null) => `السلام عليكم ورحمة الله${name ? ` ${name}` : ''}،`,
];
const INTROS = [
  'معكم وصل العقارية، عندنا عميل يبحث عن',
  'من وصل العقارية، لدينا عميل جاد يطلب',
  'معك فريق وصل العقارية، عميلنا يدور على',
  'وصل العقارية معكم، عندنا طلب لعميل يبحث عن',
];
const QUESTIONS = [
  'هل يتوفر لديكم شيء مناسب؟',
  'هل عندكم شيء يناسبه؟',
  'هل يتوفر عندكم خيار مناسب؟',
  'عندكم شيء بهالمواصفات؟',
];
const OPT_OUT = 'إذا ما تبون تستقبلون طلبات منا ردّوا بـ «إيقاف».';

/** The ask as one line: «فيلا في المعذر والرفيعة (الرياض)، الميزانية حتى 2٫5 مليون، 4 غرف». */
export function describeAsk(f: RequestFacts): string {
  const parts: string[] = [];
  const types = [...new Set(f.unitTypes.map((t) => t.trim()).filter(Boolean))];
  const what = types.length > 0 ? types.join(' أو ') : 'عقار';
  const places = [...new Set(f.places.map((p) => p.trim()).filter(Boolean))];
  let where = '';
  if (places.length > 0) {
    const shown = places.slice(0, MAX_PLACES);
    where = ` في ${shown.join('، ')}${places.length > MAX_PLACES ? ' وغيرها' : ''}`;
  }
  if (f.city && f.city.trim()) where += where ? ` (${f.city.trim()})` : ` في ${f.city.trim()}`;
  parts.push(`${what}${where}`);
  if (f.readiness === 'ready') parts.push('جاهز للسكن');
  else if (f.readiness === 'off_plan') parts.push('على الخارطة');
  const budget = rangeText(f.budgetMin, f.budgetMax, formatAmountAr);
  if (budget) parts.push(`الميزانية ${budget}`);
  const beds = rangeText(f.bedroomsMin, f.bedroomsMax, (n) => String(n));
  if (beds) parts.push(`غرف النوم ${beds}`);
  const area = rangeText(f.areaMin, f.areaMax, (n) => `${Math.round(n)} م²`);
  if (area) parts.push(`المساحة ${area}`);
  return parts.join('، ');
}

/**
 * Build the office's message. `variantKey` is normally the office id, so the
 * same office always reads the same wording but neighbours read different ones.
 */
export function buildOfficeMessage(f: RequestFacts, officeName: string | null, variantKey: string): string {
  const v = variantFor(variantKey, OPENINGS.length);
  const name = officeName && officeName.trim() ? officeName.trim() : null;
  const lines = [at(OPENINGS, v)(name), `${at(INTROS, v)} ${describeAsk(f)}.`];
  const note = (f.notes ?? '').replace(/\s+/g, ' ').trim();
  if (note) lines.push(note.length > MAX_NOTE_CHARS ? `${note.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…` : note);
  lines.push(at(QUESTIONS, v));
  lines.push(OPT_OUT);
  const text = lines.join('\n');
  return text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS - 1) + '…' : text;
}

/** True when a message would carry a link — never sent from a cold line. */
export function containsLink(text: string): boolean {
  return /(https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,6}\b)/i.test(text);
}
