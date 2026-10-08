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

const AMENITY_GROUPS: Array<{ key: string; unit: boolean; scope: AmenityScope; variants: string[] }> = [
  { key: 'pool', unit: false, scope: 'project', variants: ['مسبح', 'مسابح', 'حمام سباحه', 'swimming pool', 'pool'] },
  { key: 'elevator', unit: true, scope: 'both', variants: ['مصعد', 'مصاعد', 'اسانسير', 'elevator', 'lift'] },
  { key: 'rooftop', unit: true, scope: 'both', variants: ['سطح', 'اسطح', 'روف', 'rooftop', 'roof'] },
  { key: 'yard', unit: true, scope: 'unit', variants: ['حوش', 'فناء', 'yard'] },
  { key: 'majlis', unit: true, scope: 'unit', variants: ['مجلس', 'majlis'] },
  { key: 'maid_room', unit: true, scope: 'unit', variants: ['غرفه خادمه', 'غرفه الخادمه', 'غرفه شغاله', 'maid'] },
  { key: 'driver_room', unit: true, scope: 'unit', variants: ['غرفه سائق', 'غرفه السائق', 'غرفه سواق', 'driver'] },
  { key: 'balcony', unit: true, scope: 'both', variants: ['بلكونه', 'بلكونات', 'شرفه', 'balcony', 'balconies'] },
  { key: 'laundry', unit: true, scope: 'unit', variants: ['غرفه غسيل', 'غسيل', 'laundry'] },
  { key: 'closet', unit: true, scope: 'unit', variants: ['غرفه ملابس', 'ملابس', 'walk in closet', 'closet', 'dressing'] },
  { key: 'storage', unit: true, scope: 'unit', variants: ['مستودع', 'مخزن', 'storage'] },
  { key: 'terrace', unit: true, scope: 'unit', variants: ['تراس', 'terrace'] },
  // Project gardens BEFORE the private garden: a unit records «حديقة», a project
  // «garden» / «green_spaces». Order decides which group a value belongs to.
  { key: 'green', unit: false, scope: 'project', variants: ['حدائق', 'مساحات خضراء', 'مسطحات خضراء', 'green spaces', 'green', 'garden'] },
  { key: 'private_garden', unit: true, scope: 'unit', variants: ['حديقه'] },
  { key: 'gym', unit: false, scope: 'project', variants: ['نادي رياضي', 'جيم', 'صاله رياضيه', 'sports club', 'gym', 'fitness'] },
  { key: 'outdoor_seating', unit: false, scope: 'project', variants: ['جلسات خارجيه', 'جلسات', 'outdoor seating'] },
  { key: 'kids_play', unit: false, scope: 'project', variants: ['العاب اطفال', 'ملعب اطفال', 'children', 'kids', 'play area'] },
  { key: 'security', unit: false, scope: 'project', variants: ['حراسه', 'كاميرات', 'مراقبه', 'security', 'cctv'] },
  { key: 'walking_track', unit: false, scope: 'project', variants: ['ممشي', 'ممرات رياضيه', 'مسار جري', 'running track', 'jogging', 'walking track'] },
  { key: 'ev_chargers', unit: false, scope: 'project', variants: ['شواحن', 'شاحن', 'ev charg', 'electric vehicle'] },
  // After «green»: «green spaces» contains «spa».
  { key: 'spa', unit: false, scope: 'project', variants: ['جاكوزي', 'ساونا', 'سبا', 'jacuzzi', 'sauna', 'spa', 'steam'] },
  { key: 'padel', unit: false, scope: 'project', variants: ['بادل', 'padel'] },
  { key: 'prayer', unit: false, scope: 'project', variants: ['مصلي', 'مسجد', 'جامع', 'prayer', 'mosque'] },
  { key: 'basement_parking', unit: false, scope: 'project', variants: ['قبو', 'مواقف سفليه', 'basement'] },
];

function amenityNorm(s: string): string {
  return normalizeForSearch(String(s ?? '').replace(/[-_]+/g, ' ').replace(/ـ/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي'));
}

function amenityGroupKey(s: string): string | null {
  const n = amenityNorm(s);
  if (!n) return null;
  return AMENITY_GROUPS.find((g) => g.variants.some((v) => n.includes(v) || (n.length >= 5 && v.includes(n))))?.key ?? null;
}

/** Where an amenity is looked for when nobody chose — MUST equal the engine's
 *  `defaultAmenityScope` (same groups), or the picker shows one place and the
 *  finder searches another. */
export function defaultAmenityScope(want: string): AmenityScope {
  const key = amenityGroupKey(want);
  return AMENITY_GROUPS.find((g) => g.key === key)?.scope ?? 'both';
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
