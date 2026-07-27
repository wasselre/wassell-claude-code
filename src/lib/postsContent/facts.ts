/**
 * Shared fact types, the FACT CATALOG, and the deterministic spec-block
 * composer for the Posts Content writer. Imported by BOTH the browser page and
 * the server endpoint (`api/templates/posts-content.ts`) so a preview and a
 * stored post are byte-identical.
 *
 * Two independent defences against invented claims
 * ------------------------------------------------
 * 1. STRUCTURAL — the model writes only a headline + prose; every numeric
 *    specification (price, area, warranty durations, unit type, link) is
 *    rendered here from database values via `composeSpecBlock`. A model that
 *    never emits the price cannot get the price wrong.
 * 2. REFERENTIAL — the model must cite a `used_fact_ids[]` for the claims it
 *    makes, drawn from `buildFactCatalog(facts)`. The server rejects any post
 *    citing an id that isn't in the catalog. This catches the failure mode a
 *    digit-scanner cannot: "مع حديقة خاصة ومسبح" contains no numbers at all
 *    but is a fabrication if the project has neither.
 *
 * Neither check alone is sufficient; both are enforced server-side.
 */

import type { PostTone } from './templates';
import type { PostLanguage } from './planning';

export interface Bilingual {
  ar: string;
  en: string;
}

export interface NumericRange {
  min: number;
  max: number;
}

export interface GuaranteeItem {
  /** e.g. «الهيكل الإنشائي» */
  item: string;
  /** Raw duration text as stored, e.g. «10 سنوات» / «سنة واحدة». */
  duration: string;
  /** Parsed duration in years, for ranking + the «ضمان يصل حتى» line. */
  years: number | null;
}

export interface PostsProjectFacts {
  ourProjectId: string;
  allProjectId: string | null;
  name: string | null;
  developer: string | null;
  city: Bilingual | null;
  district: Bilingual | null;
  unitTypes: Bilingual[];
  /** Raw `unit_types` option VALUES — used for angle/type fit scoring. */
  unitTypeValues: string[];
  /** AVAILABLE-units-only rollups (QA-003) — never the all-unit ranges. */
  areaRange: NumericRange | null;
  priceRange: NumericRange | null;
  bedrooms: NumericRange | null;
  bathrooms: NumericRange | null;
  availableUnits: number | null;
  projectStatus: Bilingual | null;
  constructionStatus: Bilingual | null;
  features: string[];
  guarantees: GuaranteeItem[];
  services: string[];
  landmarks: string[];
  amenities: Bilingual[];
  websiteUnitsLink: string | null;
  brochureLink: string | null;
  /** Keys of the facts a post needs that came back empty. */
  missing: string[];
}

/** One citable fact handed to the model. `id` is what comes back in used_fact_ids. */
export interface FactEntry {
  id: string;
  kind: 'unit_type' | 'feature' | 'service' | 'amenity' | 'landmark' | 'guarantee'
      | 'location' | 'project' | 'status' | 'range' | 'count';
  text_ar: string;
  text_en: string;
}

/** One generated post as it travels from the endpoint to the page. */
export interface GeneratedPost {
  /** Client-supplied id so a post survives reordering / retries. */
  key: string;
  ourProjectId: string;
  angle: string;
  variationIndex: number;
  postNumber: number;
  headline_ar: string;
  headline_en: string;
  /** Headline + prose + deterministic spec block — ready to paste. */
  body_ar: string;
  body_en: string;
  /** The model-written prose alone (kept so an edit can be told apart from a rewrite). */
  prose_ar: string;
  prose_en: string;
  /** The deterministic block alone, so the card can render it distinctly. */
  spec_ar: string;
  spec_en: string;
  tone: PostTone;
  language: PostLanguage;
  /** Fact ids the model cited — every one validated against the catalog. */
  used_fact_ids: string[];
  /** Human-readable evidence keywords behind the chosen angle. */
  evidence: string[];
  grounded: boolean;
  generated_by: string;
}

const AR_WORD_YEARS: Array<[RegExp, number]> = [
  [/سنتان|سنتين/, 2],
  [/سنة واحدة|سنه واحده|عام واحد/, 1],
];

/**
 * Parse «10 سنوات» / «سنة واحدة» / «سنتان» / «25 سنة» → a year count.
 * Returns null when the text carries no recognizable duration (so it just
 * doesn't participate in ranking — never guessed).
 */
export function parseGuaranteeYears(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const digits = t.match(/\d+/);
  if (digits) {
    const n = Number(digits[0]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  for (const [re, years] of AR_WORD_YEARS) if (re.test(t)) return years;
  return null;
}

function formatPriceAr(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} ر.س`;
}
function formatPriceEn(n: number): string {
  return `SAR ${Math.round(n).toLocaleString('en-US')}`;
}

function areaText(r: NumericRange): string {
  const lo = Math.round(r.min);
  const hi = Math.round(r.max);
  return lo === hi ? String(lo) : `${lo} - ${hi}`;
}

/** The longest warranty on the project — powers «ضمان يصل حتى [عدد] سنة». */
export function maxGuaranteeYears(facts: PostsProjectFacts): number | null {
  const years = facts.guarantees.map((g) => g.years).filter((y): y is number => y != null);
  return years.length > 0 ? Math.max(...years) : null;
}

/** Top guarantees by duration, longest first — what a post actually quotes. */
export function topGuarantees(facts: PostsProjectFacts, limit = 3): GuaranteeItem[] {
  return [...facts.guarantees]
    .sort((a, b) => (b.years ?? -1) - (a.years ?? -1))
    .slice(0, limit);
}

/**
 * The complete set of claims the model is allowed to make about this project.
 * Ids are index-based (`feature:3`) rather than slugged Arabic text so they are
 * unambiguous to validate; the prompt shows the text next to each id.
 */
export function buildFactCatalog(facts: PostsProjectFacts): FactEntry[] {
  const out: FactEntry[] = [];
  const push = (id: string, kind: FactEntry['kind'], ar: string, en?: string) => {
    if (!ar && !en) return;
    out.push({ id, kind, text_ar: ar, text_en: en ?? ar });
  };

  if (facts.name) push('project:name', 'project', facts.name);
  if (facts.developer) push('project:developer', 'project', facts.developer);
  if (facts.city) push('location:city', 'location', facts.city.ar, facts.city.en);
  if (facts.district) push('location:district', 'location', facts.district.ar, facts.district.en);
  facts.unitTypes.forEach((u, i) => push(`unit_type:${i}`, 'unit_type', u.ar, u.en));
  facts.features.forEach((f, i) => push(`feature:${i}`, 'feature', f));
  facts.services.forEach((s, i) => push(`service:${i}`, 'service', s));
  facts.amenities.forEach((a, i) => push(`amenity:${i}`, 'amenity', a.ar, a.en));
  facts.landmarks.forEach((l, i) => push(`landmark:${i}`, 'landmark', l));
  facts.guarantees.forEach((g, i) =>
    push(`guarantee:${i}`, 'guarantee', `${g.item}${g.duration ? ` — ${g.duration}` : ''}`));
  if (facts.constructionStatus) {
    push('status:construction', 'status', facts.constructionStatus.ar, facts.constructionStatus.en);
  }
  if (facts.projectStatus) push('status:project', 'status', facts.projectStatus.ar, facts.projectStatus.en);
  if (facts.areaRange) push('range:area', 'range', `${areaText(facts.areaRange)} م²`, `${areaText(facts.areaRange)} m²`);
  if (facts.priceRange) {
    push('range:price', 'range', `من ${formatPriceAr(facts.priceRange.min)}`, `from ${formatPriceEn(facts.priceRange.min)}`);
  }
  if (facts.bedrooms) push('range:bedrooms', 'range', `${facts.bedrooms.min}-${facts.bedrooms.max} غرف`, `${facts.bedrooms.min}-${facts.bedrooms.max} bedrooms`);
  if (facts.bathrooms) push('range:bathrooms', 'range', `${facts.bathrooms.min}-${facts.bathrooms.max} دورات مياه`, `${facts.bathrooms.min}-${facts.bathrooms.max} bathrooms`);
  if (facts.availableUnits != null) {
    push('count:available_units', 'count', `${facts.availableUnits} وحدة متاحة`, `${facts.availableUnits} units available`);
  }
  return out;
}

/**
 * Ids the model cited that do NOT exist in the catalog. A non-empty result is a
 * hard rejection — the model asserted something the database does not contain.
 */
export function unknownFactIds(used: string[], catalog: FactEntry[]): string[] {
  const known = new Set(catalog.map((f) => f.id));
  return used.filter((id) => !known.has(id));
}

/**
 * Render the deterministic spec block appended under every post's prose.
 *
 * SHORT mirrors the client's set-1 shape (نوع العقار / المساحة / الضمانات /
 * القيمة); LONG mirrors set 2 (adds الموقع and المزايا, and renames القيمة →
 * القيمة الاستثمارية). Every value comes from the database — a missing fact
 * drops its line entirely rather than printing "غير متوفر".
 */
export function composeSpecBlock(
  facts: PostsProjectFacts,
  tone: PostTone,
  lang: 'ar' | 'en',
): string {
  const lines: string[] = [];
  const L = (ar: string, en: string) => (lang === 'ar' ? ar : en);
  const join = lang === 'ar' ? '، ' : ', ';

  if (facts.unitTypes.length > 0) {
    lines.push(`${L('نوع العقار', 'Property type')}: ${facts.unitTypes.map((u) => (lang === 'ar' ? u.ar : u.en)).join(join)}`);
  }
  if (tone === 'long') {
    const place = [facts.district, facts.city]
      .filter((p): p is Bilingual => !!p)
      .map((p) => (lang === 'ar' ? p.ar : p.en));
    if (place.length > 0) lines.push(`${L('الموقع', 'Location')}: ${place.join(join)}`);
  }
  if (facts.areaRange) {
    lines.push(`${L('المساحة', 'Area')}: ${areaText(facts.areaRange)} ${L('م²', 'm²')}`);
  }
  if (tone === 'long' && facts.features.length > 0) {
    lines.push(`${L('المزايا', 'Highlights')}: ${facts.features.slice(0, 3).join(' | ')}`);
  }
  const gs = topGuarantees(facts);
  if (gs.length > 0) {
    lines.push(`${L('الضمانات', 'Warranties')}: ${gs.map((g) => (g.duration ? `${g.item} ${g.duration}` : g.item)).join(' · ')}`);
  }
  if (facts.priceRange) {
    const price = lang === 'ar' ? formatPriceAr(facts.priceRange.min) : formatPriceEn(facts.priceRange.min);
    const label = tone === 'long' ? L('القيمة الاستثمارية', 'Investment value') : L('القيمة', 'Price');
    lines.push(`${label}: ${L('تبدأ من', 'from')} ${price}`);
  }
  if (facts.websiteUnitsLink) {
    lines.push(`${L('الرابط', 'Link')}: ${facts.websiteUnitsLink}`);
  }
  return lines.join('\n');
}

/** Headline + prose + spec block — the final pasteable post body. */
export function composePostBody(
  headline: string,
  prose: string,
  spec: string,
): string {
  return [headline.trim(), prose.trim(), spec].filter(Boolean).join('\n\n');
}

/**
 * Everything the model is allowed to see as free text, flattened — also the
 * haystack `matchAngleEvidence` / `rankAngles` search for per-angle evidence.
 */
export function evidenceHaystack(facts: PostsProjectFacts): string[] {
  return [
    ...facts.features,
    ...facts.services,
    ...facts.landmarks,
    ...facts.amenities.map((a) => a.ar),
    ...facts.guarantees.map((g) => `${g.item} ${g.duration}`),
    facts.constructionStatus?.ar ?? '',
    facts.projectStatus?.ar ?? '',
    ...facts.unitTypes.map((u) => u.ar),
  ].filter(Boolean);
}

/** Whether a given output language needs Arabic / English text at all. */
export function needsAr(lang: PostLanguage): boolean {
  return lang === 'ar' || lang === 'both';
}
export function needsEn(lang: PostLanguage): boolean {
  return lang === 'en' || lang === 'both';
}
