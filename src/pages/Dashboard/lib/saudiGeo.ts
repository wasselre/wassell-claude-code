/**
 * Self-contained geography for the Map widget — no map-tile library, no API
 * keys, no external tiles or geo-data fetches (keeps the private-CRM posture).
 * A simplified Saudi Arabia outline + major-city centroids, both pre-projected
 * into a 0..100 × 0..100 SVG viewBox (x: west→east, y: north→south). Group
 * labels (city names, AR or EN) are matched to a centroid; anything unmatched is
 * surfaced as a footnote count, never silently dropped.
 */

// Simplified national outline (Red Sea coast up the west, the eastern Gulf
// bulge, the southern Yemen/Oman border). A recognizable backdrop, not a survey.
export const SAUDI_OUTLINE =
  'M 8 21 L 21 13 L 26 5 L 38 11 L 46 21 L 56 21 L 60 25 L 64 28 L 71 36 L 71 41 L 77 47 L 91 58 L 91 72 L 79 78 L 58 89 L 42 92 L 38 90 L 36 84 L 26 67 L 23 56 L 17 45 L 13 36 L 9 28 Z';

export interface CityCentroid {
  x: number;
  y: number;
  names: string[]; // normalized match keys (AR + EN + variants)
}

// ~20 major Saudi cities at their projected positions. `names` are lowercased,
// space-stripped match keys.
export const CITY_CENTROIDS: CityCentroid[] = [
  { x: 57, y: 46, names: ['الرياض', 'riyadh', 'arriyadh'] },
  { x: 26, y: 64, names: ['جدة', 'جده', 'jeddah', 'jedda', 'jiddah'] },
  { x: 29, y: 65, names: ['مكة', 'مكةالمكرمة', 'makkah', 'mecca'] },
  { x: 28, y: 47, names: ['المدينة', 'المدينةالمنورة', 'medina', 'madinah', 'almadinah'] },
  { x: 71, y: 36, names: ['الدمام', 'dammam', 'addammam'] },
  { x: 71, y: 37, names: ['الخبر', 'khobar', 'alkhobar'] },
  { x: 70, y: 36, names: ['القطيف', 'qatif', 'alqatif'] },
  { x: 69, y: 33, names: ['الجبيل', 'jubail', 'aljubail'] },
  { x: 69, y: 42, names: ['الأحساء', 'الاحساء', 'الهفوف', 'ahsa', 'alahsa', 'hofuf', 'hufuf'] },
  { x: 31, y: 65, names: ['الطائف', 'taif', 'attaif'] },
  { x: 22, y: 50, names: ['ينبع', 'yanbu'] },
  { x: 16, y: 25, names: ['تبوك', 'tabuk'] },
  { x: 46, y: 37, names: ['بريدة', 'buraidah', 'buraydah'] },
  { x: 49, y: 39, names: ['عنيزة', 'unaizah', 'onaizah'] },
  { x: 37, y: 30, names: ['حائل', 'hail', 'hail'] },
  { x: 40, y: 83, names: ['أبها', 'ابها', 'abha'] },
  { x: 41, y: 82, names: ['خميسمشيط', 'khamismushait'] },
  { x: 40, y: 90, names: ['جازان', 'جيزان', 'jazan', 'jizan'] },
  { x: 46, y: 87, names: ['نجران', 'najran'] },
  { x: 54, y: 25, names: ['حفرالباطن', 'hafaralbatin'] },
  { x: 34, y: 11, names: ['عرعر', 'arar'] },
  { x: 30, y: 16, names: ['سكاكا', 'sakaka'] },
];

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[ً-ْ]/g, '') // Arabic diacritics
    .replace(/[\s\-_،,]/g, '');
}

const INDEX = new Map<string, CityCentroid>();
for (const c of CITY_CENTROIDS) for (const n of c.names) INDEX.set(normalize(n), c);

/** Match a group label to a city centroid (exact, then contains either way). */
export function matchCity(label: string): CityCentroid | null {
  const key = normalize(label);
  if (!key) return null;
  const exact = INDEX.get(key);
  if (exact) return exact;
  for (const [n, c] of INDEX) {
    if (key.includes(n) || n.includes(key)) return c;
  }
  return null;
}
