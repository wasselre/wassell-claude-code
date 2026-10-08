/**
 * TWIN of the amenity synonym rule in `api/_lib/matchAgent.ts` (AMENITY_GROUPS /
 * amenityMatches). The API package cannot be imported from the SPA build, so the
 * groups are MIRRORED here — CHANGE BOTH TOGETHER, or a unit the card offers
 * stops agreeing with the ✓ the engine put on its project.
 *
 * Used by the finder card to keep only the units that have the amenities the
 * search asked to find IN THE UNIT (operator, 2026-10-08).
 */
import type { UnitView } from '@/lib/projects/unitView';
import { normalizeForSearch } from '@/lib/recordSearch';

export type AmenityScope = 'unit' | 'project' | 'both';

const AMENITY_GROUPS: Array<{ key: string; variants: string[] }> = [
  { key: 'pool', variants: ['مسبح', 'مسابح', 'حمام سباحه', 'swimming pool', 'pool'] },
  { key: 'elevator', variants: ['مصعد', 'مصاعد', 'اسانسير', 'elevator', 'lift'] },
  { key: 'rooftop', variants: ['سطح', 'اسطح', 'روف', 'rooftop', 'roof'] },
  { key: 'yard', variants: ['حوش', 'فناء', 'yard'] },
  { key: 'majlis', variants: ['مجلس', 'majlis'] },
  { key: 'maid_room', variants: ['غرفه خادمه', 'غرفه الخادمه', 'غرفه شغاله', 'maid'] },
  { key: 'driver_room', variants: ['غرفه سائق', 'غرفه السائق', 'غرفه سواق', 'driver'] },
  { key: 'garden', variants: ['حديقه', 'حدائق', 'garden'] },
  { key: 'gym', variants: ['نادي رياضي', 'جيم', 'صاله رياضيه', 'sports club', 'gym', 'fitness'] },
  { key: 'balcony', variants: ['بلكونه', 'بلكونات', 'شرفه', 'balcony', 'balconies'] },
  { key: 'prayer', variants: ['مصلى', 'مسجد', 'جامع', 'prayer', 'mosque'] },
  { key: 'basement_parking', variants: ['قبو', 'مواقف سفليه', 'basement'] },
  { key: 'kids_play', variants: ['ملعب اطفال', 'العاب اطفال', 'children', 'kids'] },
];

function amenityNorm(s: string): string {
  return normalizeForSearch(String(s ?? '').replace(/[-_]+/g, ' ').replace(/ـ/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي'));
}

function amenityGroupKey(s: string): string | null {
  const n = amenityNorm(s);
  if (!n) return null;
  return AMENITY_GROUPS.find((g) => g.variants.some((v) => n.includes(v) || (n.length >= 3 && v.includes(n))))?.key ?? null;
}

/** True when an amenity value satisfies what the client asked for. */
export function amenityMatches(have: string, want: string): boolean {
  const gw = amenityGroupKey(want);
  const gh = amenityGroupKey(have);
  if (gw && gh) return gw === gh;
  const h = amenityNorm(have);
  const w = amenityNorm(want);
  return !!h && !!w && (h.includes(w) || w.includes(h));
}

/** What a unit is known to contain — the same evidence the project rollup
 *  (`unit_features`) is built from: its components, «مصعد» when the elevator is
 *  ready, «فناء خارجي» when it has a yard area. */
export function unitAmenityEvidence(unit: UnitView): string[] {
  const out: string[] = [];
  for (const c of unit.components) out.push(c.value, c.label_ar, c.label_en);
  if (unit.elevator?.value === 'جاهز') out.push('مصعد');
  if (unit.yardArea != null && unit.yardArea > 0) out.push('فناء خارجي');
  return out.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
}

/** Does this unit record anything at all (components / ready elevator / yard)? */
export function unitHasAmenityData(unit: UnitView): boolean {
  return unitAmenityEvidence(unit).length > 0;
}

export function unitHasAmenity(unit: UnitView, want: string): boolean {
  return unitAmenityEvidence(unit).some((h) => amenityMatches(h, want));
}
