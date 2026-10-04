/**
 * Shared answers for the three REQUIRED map ports every fake `ResolverDb` must
 * implement (roadAxis, cityLabel, namesInText — design 2026-10-04 §2.4).
 *
 * The road axis comes ONLY from numbers measured live (read-only) on
 * 2026-10-03/04 — never "always valid". A road that was not measured is not in
 * the table, so a fake answers `found:false` for it (the checks ask), exactly
 * like a road the live database does not have.
 *
 * Not a test file (no `.test.ts`): imported by the fakes.
 */

import type { CityCandidate, ElementCandidate, NameInText, ResolverDb, RoadAxis } from '../resolver.js';
import { placeKey } from '../resolver.js';
import { foldWord } from '../anchorPrep.js';

export interface AxisTravel { ew_m: number; ns_m: number }
export interface LocalAxis extends AxisTravel { scope: 'district' | 'window' }

/** East–west share ew/(ew+ns) as metres over a nominal 10 km (only the share was recorded). */
function share(s: number): AxisTravel {
  const ew = Math.round(s * 10_000);
  return { ew_m: ew, ns_m: 10_000 - ew };
}
function local(scope: LocalAxis['scope'], s: number): LocalAxis {
  return { scope, ...share(s) };
}

/**
 * Whole-road travel (design §0, measured 2026-10-03; the share ew/(ew+ns) over
 * segment steps). External-id suffixes as measured; the King Fahd Road numbers
 * are the exact metres wassell_geo_road_axis returned live on 2026-10-04.
 */
export const MEASURED_ROAD_AXIS = {
  kingFahd: { ew_m: 72_933, ns_m: 141_178 },   // RUH-ROAD-0694  share 0.341
  kingSalman: share(0.507),                     // RUH-ROAD-0681
  northernRing: share(0.660),                   // RUH-RING-0853
  dammam0727: share(0.628),                     // Dammam Rd …0727
  dammam0731: share(0.572),                     // Dammam Rd …0731
  kingAbdullah: share(0.650),                   // Riyadh King Abdullah Rd …0690
  khurais: share(0.489),
  makkah0695: share(0.702),                     // Makkah Rd …0695
  makkah0743: share(0.635),                     // Makkah Rd …0743
  olayaStreet: share(0.323),                    // Olaya St …0684
  takhassusi: share(0.315),                     // …0783
  uthmanBinAffan: share(0.316),
  kingAbdulaziz: share(0.364),                  // …0692
  princeTurkiI: share(0.366),                   // …0711
} as const satisfies Record<string, AxisTravel>;

/**
 * The road INSIDE a district polygon ('district'), or in a 0.03° window around
 * a district it does not cross ('window') — design §0; KSR∩Narjis and the two
 * Narjis windows re-measured live on 2026-10-04 through the RPC itself.
 */
export const MEASURED_LOCAL_AXIS = {
  kingSalmanInNarjis: { scope: 'district', ew_m: 5_347, ns_m: 2_466 } as LocalAxis, // 0.684
  kingSalmanInMalqa: local('district', 0.605),
  kingSalmanInYasmin: local('district', 0.685),
  kingSalmanInArid: local('district', 0.684),
  kingFahdInMalqa: local('district', 0.316),
  kingFahdInOlaya: local('district', 0.326),
  kingFahdInSahafa: local('district', 0.315),
  kingFahdInWurud: local('district', 0.314),
  kingFahdAroundMather: local('window', 0.303),
  kingFahdAroundNarjis: local('window', 0.316),
  northernRingAroundNarjis: local('window', 0.647),
} as const satisfies Record<string, LocalAxis>;

export interface FakeRoad {
  road: AxisTravel;
  /** Local answers keyed by the SORTED, comma-joined district ids passed. */
  byDistricts?: Record<string, LocalAxis>;
}

/**
 * A `roadAxis` port over a table keyed by the fixture's external ids. An id not
 * in the table → `found:false`. Districts with no override fall back to the
 * whole road (what the SQL does when the road crosses neither the districts
 * nor the window around them).
 */
export function fakeRoadAxis(table: Readonly<Record<string, FakeRoad>>): ResolverDb['roadAxis'] {
  return async (externalId: string, districtIds?: string[]): Promise<RoadAxis> => {
    const entry = table[externalId];
    if (!entry) return { found: false };
    if (districtIds && districtIds.length > 0) {
      const hit = entry.byDistricts?.[[...districtIds].sort().join(',')];
      if (hit) return { found: true, scope: hit.scope, ew_m: hit.ew_m, ns_m: hit.ns_m };
    }
    return { found: true, scope: 'road', ew_m: entry.road.ew_m, ns_m: entry.road.ns_m };
  };
}

/**
 * A `cityLabel` port over fixture cities: an Arabic name (article- and
 * spelling-insensitive, like the adapter's lexical variants) → its name_en; a
 * Latin input equal (case-insensitive) to a name_en → that name_en; else null.
 */
export function fakeCityLabel(cities: readonly CityCandidate[]): ResolverDb['cityLabel'] {
  return async (city: string): Promise<string | null> => {
    const c = (city ?? '').trim();
    if (!c) return null;
    const hit = /[\u0600-\u06FF]/.test(c)
      ? cities.find((x) => placeKey(x.name_ar) === placeKey(c))
      : cities.find((x) => x.name_en.trim().toLowerCase() === c.toLowerCase());
    return hit?.name_en || null;
  };
}

const norm = (s: string): string => foldWord(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * A `namesInText` port over fixture elements, mirroring wassell_geo_names_in_text:
 * every name / alias of 2+ words whose normalised form occurs in the normalised
 * text followed by a word end (a clitic in front is allowed, as in the SQL).
 */
export function fakeNamesInText(elements: readonly ElementCandidate[]): ResolverDb['namesInText'] {
  return async (text: string): Promise<NameInText[]> => {
    const t = ` ${norm(text)} `;
    const out: NameInText[] = [];
    for (const e of elements) {
      for (const name of [e.name_ar, e.name_en, ...e.aliases]) {
        const n = norm(name ?? '');
        if (!n.includes(' ')) continue;
        if (t.includes(`${n} `)) out.push({ external_id: e.external_id, name, category: e.category });
      }
    }
    return out;
  };
}
