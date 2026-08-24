// Pure project-WhatsApp-message composer + its fact shape. Extracted from
// projectMessageFacts.ts so it can be imported by a SERVERLESS FUNCTION
// (api/templates/project-message.ts) without dragging in the browser-shaped
// resolveProjectFacts and its transitive chain (locationUtils → mirrorResolver
// → …), which use extensionless relative imports that Vercel's Node-ESM runtime
// rejects (ERR_MODULE_NOT_FOUND). This module imports NOTHING — keep it that way.
//
// projectMessageFacts.ts re-exports these so existing browser importers of
// `composeProjectMessage` / the types from '@/lib/projectMessageFacts' keep
// working unchanged.

export interface Bilingual {
  ar: string;
  en: string;
}

export interface NumericRange {
  min: number;
  max: number;
}

/**
 * Bilingual, pre-resolved facts handed to the generation endpoint. Every
 * dropdown value is already resolved to its ar/en label. Prices are
 * pre-formatted per language. `null` / empty = genuinely missing → the line is
 * omitted from the composed message.
 */
export interface ProjectMessageFacts {
  /** The our_projects record this was generated from. */
  ourProjectId: string;
  /** The linked all_projects master id — what the template links to. */
  allProjectId: string | null;
  name: string | null;
  city: Bilingual | null;
  district: Bilingual | null;
  unitTypes: Bilingual[];
  bedrooms: NumericRange | null;
  bathrooms: NumericRange | null;
  /**
   * Unit area range in m² — the AVAILABLE-units-only rollup
   * (`available_area_range`), NOT the all-unit `area_range`. Customer messages
   * must never quote the area of a sold/reserved unit (QA-003). Null when the
   * project has no available units → the line is omitted.
   */
  areaRange: NumericRange | null;
  /**
   * Pre-formatted starting price per language (e.g. "1,200,000 ر.س" /
   * "SAR 1,200,000"). Derived from the AVAILABLE-units-only price rollup
   * (`available_price_range`). Null when no units are available → line omitted.
   */
  minPrice: Bilingual | null;
  brochureLink: string | null;
  locationLink: string | null;
  /** Public-website link to the project's unit details, labeled "الرابط / Link". */
  websiteUnitsLink: string | null;
  /** CRM `files` ids of every image saved on the project. */
  imageFileIds: string[];
  /** Human-readable keys of the required fields that came back empty. */
  missing: string[];
}

function rangeText(r: NumericRange): string {
  return r.min === r.max ? String(r.min) : `${r.min} - ${r.max}`;
}

/** Area range, rounded to whole m² (unit areas come as decimals like 114.28). */
function areaRangeText(r: NumericRange): string {
  const lo = Math.round(r.min);
  const hi = Math.round(r.max);
  return lo === hi ? String(lo) : `${lo} - ${hi}`;
}

/**
 * Compose the WhatsApp message DETERMINISTICALLY from resolved facts — no AI,
 * no greeting line, no closing line, exact labels. A field that's missing is
 * OMITTED entirely. Structure: the project name on its own line, a blank line,
 * then one labeled line per PRESENT field.
 *
 * Per the user's exact spec (2026-06-08): price label is "الأسعار تبدأ من" /
 * "Prices start from"; nothing extra is ever added to the body.
 */
export function composeProjectMessage(
  facts: ProjectMessageFacts,
  opts?: { nameEn?: string | null },
): { body_ar: string; body_en: string } {
  const ar: string[] = [];
  const en: string[] = [];
  if (facts.city) { ar.push(`المدينة: ${facts.city.ar}`); en.push(`City: ${facts.city.en}`); }
  if (facts.district) { ar.push(`الحي: ${facts.district.ar}`); en.push(`District: ${facts.district.en}`); }
  if (facts.unitTypes.length > 0) {
    ar.push(`أنواع الوحدات: ${facts.unitTypes.map((u) => u.ar).join('، ')}`);
    en.push(`Unit Types: ${facts.unitTypes.map((u) => u.en).join(', ')}`);
  }
  if (facts.bedrooms) { ar.push(`غرف النوم: ${rangeText(facts.bedrooms)}`); en.push(`Bedrooms: ${rangeText(facts.bedrooms)}`); }
  if (facts.areaRange) { ar.push(`المساحة: ${areaRangeText(facts.areaRange)} م²`); en.push(`Area: ${areaRangeText(facts.areaRange)} m²`); }
  if (facts.bathrooms) { ar.push(`دورات المياه: ${rangeText(facts.bathrooms)}`); en.push(`Bathrooms: ${rangeText(facts.bathrooms)}`); }
  if (facts.minPrice) { ar.push(`الأسعار تبدأ من: ${facts.minPrice.ar}`); en.push(`Prices start from: ${facts.minPrice.en}`); }
  if (facts.websiteUnitsLink) { ar.push(`الرابط: ${facts.websiteUnitsLink}`); en.push(`Link: ${facts.websiteUnitsLink}`); }
  const titleAr = facts.name ?? '';
  const titleEn = (opts?.nameEn || facts.name) ?? '';
  return {
    body_ar: [titleAr, '', ...ar].join('\n').trim(),
    body_en: [titleEn, '', ...en].join('\n').trim(),
  };
}
