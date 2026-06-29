/**
 * Canonical property-type bucketing for Market Intelligence.
 *
 * market_listings.property_type is free Arabic text (326 distinct values, mostly
 * suffix noise). We collapse it to a small stable set so benchmark segments and
 * deal-quality badges line up between the SQL precompute and the TS readers.
 *
 * CRITICAL: this is a MIRROR of the SQL function public.wassell_canon_property_type
 * (supabase/migrations/2026-06-29_market_intel_benchmarks.sql). Same posture as
 * worker/src/imageGen.ts being a copy of api/_lib/imageGen.ts — change BOTH together.
 * Order matters (first match wins).
 */

export type CanonPropertyType =
  | 'فيلا' | 'دور' | 'شقة' | 'عمارة' | 'تاون هاوس' | 'أرض' | 'تجاري' | 'استراحة' | 'سكني' | 'أخرى';

const has = (s: string, ...needles: string[]) => needles.some((n) => s.includes(n));

/** Collapse a raw Arabic property-type string into a canonical bucket. */
export function canonPropertyType(raw: string | null | undefined): CanonPropertyType {
  const s = (raw ?? '').trim();
  if (!s) return 'أخرى';
  if (has(s, 'فيلا', 'دوبلكس', 'دبلكس', 'فلل')) return 'فيلا';
  if (has(s, 'تاون')) return 'تاون هاوس';
  if (has(s, 'شقة', 'شقه', 'شقق')) return 'شقة';
  if (has(s, 'عمارة', 'عماره', 'عمائر')) return 'عمارة';
  if (has(s, 'استراح')) return 'استراحة';
  if (has(s, 'دور')) return 'دور';
  if (has(s, 'أرض', 'ارض', 'اراض', 'أراض')) return 'أرض';
  if (has(s, 'تجاري', 'تجاره', 'مكتب', 'محل', 'معرض')) return 'تجاري';
  if (has(s, 'سكني', 'سكنيه')) return 'سكني';
  return 'أخرى';
}

/** All canonical types, in display order. */
export const CANON_PROPERTY_TYPES: CanonPropertyType[] = [
  'فيلا', 'دور', 'شقة', 'تاون هاوس', 'عمارة', 'أرض', 'تجاري', 'استراحة', 'سكني', 'أخرى',
];

/** Bilingual labels for a canonical type (the AR value IS the canonical key). */
export const PROPERTY_TYPE_LABELS: Record<CanonPropertyType, { ar: string; en: string }> = {
  'فيلا': { ar: 'فيلا', en: 'Villa' },
  'دور': { ar: 'دور', en: 'Floor' },
  'شقة': { ar: 'شقة', en: 'Apartment' },
  'تاون هاوس': { ar: 'تاون هاوس', en: 'Townhouse' },
  'عمارة': { ar: 'عمارة', en: 'Building' },
  'أرض': { ar: 'أرض', en: 'Land' },
  'تجاري': { ar: 'تجاري', en: 'Commercial' },
  'استراحة': { ar: 'استراحة', en: 'Rest house' },
  'سكني': { ar: 'سكني', en: 'Residential' },
  'أخرى': { ar: 'أخرى', en: 'Other' },
};

export function propertyTypeLabel(canon: string, isAr: boolean): string {
  const m = PROPERTY_TYPE_LABELS[canon as CanonPropertyType];
  if (!m) return canon;
  return isAr ? m.ar : m.en;
}
