import { describe, it, expect } from 'vitest';
import { runReviewFirst, type RunContext, type OrchestratorPorts, type ProposalRecord } from '../orchestrator.js';
import {
  roadKey, placeKey, type ResolverDb, type DistrictCandidate, type CityCandidate, type ElementCandidate, type RegionCandidate,
} from '../resolver.js';
import type { SatUniverse } from '../satisfiability.js';
import type { GateConfig } from '../gate.js';
import type { AnchorToken, Evidence, GeometryRecipe, GeoPreference } from '../ontology.js';
import { placementsByEvidence, placementSentence } from '../placementText.js';
import { geoPreferenceToLocationItems } from '../../../geo-preference/review.js';
import { pruneGeoExpression } from '../../../../src/lib/geo/pruneGeoExpression.js';
import { describeLocationItem, type LocationItem } from '../../../../src/lib/geo/locationItems.js';
import {
  fakeCityLabel, fakeNamesInText, fakeRoadAxis, MEASURED_LOCAL_AXIS, MEASURED_ROAD_AXIS, type FakeRoad,
} from './fakeGeoMap.js';

/**
 * Road sides, «near a landmark» and «near a road» THROUGH runReviewFirst
 * (2026-10-03). The resolver's own unit tests always passed because they inject
 * the operation companions into the context by hand; in production nothing did.
 * These tests drive the whole review path — anchor preparation → resolution with
 * per-mention context → compile → merge → location items — against a fake map.
 *
 * The second half replays every confirmed failure scenario of the 2026-10-03
 * review (finding numbers in the test names): each must now give the right
 * place, or stay safely unresolved (the rep is asked) — never a confident
 * wrong place.
 */

// ── The fake map ─────────────────────────────────────────────────────────────
const NARJIS = district('d-narjis', 'حي النرجس');
// The DISTRICT «حي الملك سلمان». Its alias «سلمان» is what made «شمال سلمان»
// resolve to this district in production (2026-10-01) — it must never win.
const KING_SALMAN_DISTRICT: DistrictCandidate = { ...district('d-king-salman', 'حي الملك سلمان'), aliases: ['سلمان'] };
const MALQA = district('d-malqa', 'حي الملقا');
const OLAYA = district('d-olaya', 'حي العليا');
const AQRABIYAH: DistrictCandidate = { ...district('d-aqrabiyah', 'حي العقربية'), city_id: 'city-khobar', city_name_ar: 'الخبر', city_name_en: 'Khobar' };
// «حي الفهد» is a real district in Najran (and Bisha, Sharurah…), not King Fahd Road.
const FAHD_NAJRAN: DistrictCandidate = { ...district('d-fahd-najran', 'حي الفهد'), city_id: 'city-najran', city_name_ar: 'نجران', city_name_en: 'Najran' };
// «الروضة» in BOTH Riyadh and Jeddah — a district beside a Jeddah road must be Jeddah's.
const RAWDAH_RUH = district('d-rawdah-ruh', 'حي الروضة');
const RAWDAH_JED: DistrictCandidate = { ...district('d-rawdah-jed', 'حي الروضة'), city_id: 'city-jeddah', city_name_ar: 'جدة', city_name_en: 'Jeddah', centroid_lat: 21.5, centroid_lng: 39.2 };
const DISTRICTS = [NARJIS, KING_SALMAN_DISTRICT, MALQA, OLAYA, AQRABIYAH, FAHD_NAJRAN, RAWDAH_RUH, RAWDAH_JED];

const RIYADH = city('city-riyadh', 'الرياض', 'Riyadh');
const CITIES = [RIYADH, city('city-khobar', 'الخبر', 'Khobar'), city('city-jeddah', 'جدة', 'Jeddah'), city('city-najran', 'نجران', 'Najran'), city('city-dammam', 'الدمام', 'Dammam')];

const KING_SALMAN_ROAD = element('RUH-ROAD-KSR', 'طريق الملك سلمان', 'linestring');
const KING_FAHD_ROAD = element('RUH-ROAD-KFR', 'طريق الملك فهد', 'linestring');
const RIYADH_PARK = { ...element('RUH-MALL-PARK', 'الرياض بارك', 'polygon'), lat: null, lng: null };
const MORE_ELEMENTS: ElementCandidate[] = [
  // The same road names in other cities — the lookup must search the city the customer NAMED.
  { ...element('KHB-ROAD-KFR', 'طريق الملك فهد', 'linestring'), city: 'Khobar' },
  element('RUH-ROAD-KAR', 'طريق الملك عبدالله', 'linestring'),
  { ...element('JED-ROAD-KAR', 'طريق الملك عبدالله', 'linestring'), city: 'Jeddah' },
  element('RUH-ROAD-DMM', 'طريق الدمام', 'linestring'),
  element('RUH-ROAD-JED', 'طريق جدة', 'linestring'),
  element('RUH-RING-N', 'الدائري الشمالي', 'linestring'),
  // Venues: one shape; two namesakes FAR apart (two places); a point + shape 145 m apart (one place).
  { ...element('RUH-MALL-NAKHEEL', 'النخيل مول', 'polygon'), lat: 24.77, lng: 46.71 },
  { ...element('RUH-METR-KSU', 'جامعة الملك سعود', 'point'), lat: 24.7105, lng: 46.6189 },
  { ...element('RUH-UNIV-KSU', 'جامعة الملك سعود', 'polygon'), lat: 24.7240, lng: 46.7340 },
  { ...element('RUH-HOSP-0131', 'مستشفى الدكتور سليمان الحبيب', 'point'), lat: 24.770, lng: 46.605 },
  { ...element('RUH-HOSP-0185', 'مستشفى الدكتور سليمان الحبيب', 'polygon'), lat: 24.720, lng: 46.657 },
  { ...element('RUH-MALL-OTH-P', 'العثيم مول', 'point'), lat: 24.7000, lng: 46.7000 },
  { ...element('RUH-MALL-OTH', 'العثيم مول', 'polygon'), lat: 24.7013, lng: 46.7000 },
];
const ALL_ELEMENTS = [KING_SALMAN_ROAD, KING_FAHD_ROAD, RIYADH_PARK, ...MORE_ELEMENTS];

const ZONES: Record<string, Record<string, string[]>> = {
  [placeKey('الرياض')]: {
    north: ['d-narjis', 'd-yasmin', 'd-arid'],
    south: ['d-shifa', 'd-aziziyah'],
    east: ['d-east-1', 'd-east-2'],
    west: Array.from({ length: 36 }, (_, i) => `d-west-${i}`),
  },
  // Dammam / Jeddah CITY have zones — «شرق طريق الدمام» / «غرب طريق جدة» must never become one of them.
  [placeKey('الدمام')]: { east: ['dmm-e1', 'dmm-e2'] },
  [placeKey('جدة')]: { west: ['jed-w1', 'jed-w2'], north: ['jed-n1', 'jed-n2'] },
  [placeKey('نجران')]: { north: ['njr-n1', 'njr-n2'] },
};

// A REGION record (the live adapter has findRegions). Its id is not a district.
const RIYADH_REGION: RegionCandidate = { id: 'region-riyadh', name_ar: 'منطقة الرياض', name_en: 'Riyadh Region', aliases: [], country_code: 'SA' };

function district(id: string, name_ar: string): DistrictCandidate {
  return {
    id, name_ar, name_en: '', aliases: [], city_id: 'city-riyadh', city_name_ar: 'الرياض', city_name_en: 'Riyadh',
    region_name_ar: 'منطقة الرياض', region_name_en: '', country_code: 'SA', centroid_lat: 24.8, centroid_lng: 46.6,
  };
}
function city(id: string, name_ar: string, name_en: string): CityCandidate {
  return { id, name_ar, name_en, aliases: [], region_name_ar: '', region_name_en: '', country_code: 'SA', centroid_lat: 24.7, centroid_lng: 46.7 };
}
function element(external_id: string, name_ar: string, geom_kind: ElementCandidate['geom_kind']): ElementCandidate {
  return {
    external_id, name_ar, name_en: '', aliases: [], geom_kind, category: null, type: null, city: 'Riyadh',
    country_code: 'SA', lat: 24.75, lng: 46.65, confidence_score: 0.9, review_status: 'approved', is_active: true,
  };
}

/** Like the live adapter: the element search is a hard filter on the (English) city name. */
function cityEn(ar: string | undefined): string | null {
  if (!ar) return null;
  return CITIES.find((c) => placeKey(c.name_ar) === placeKey(ar))?.name_en ?? ar;
}

function fakeDb(elements: ElementCandidate[] = ALL_ELEMENTS): ResolverDb {
  const k = (s: string) => placeKey(s);
  return {
    // Loose candidate generation (substring both ways, + aliases) like the live ILIKE.
    async findDistricts(token) {
      const t = k(token);
      return DISTRICTS.filter((d) => [d.name_ar, ...d.aliases].some((n) => k(n).includes(t) || t.includes(k(n))));
    },
    async findCities(token) { return CITIES.filter((c) => k(c.name_ar) === k(token)); },
    async findRegions(token) { return [RIYADH_REGION].filter((r) => [r.name_ar, ...r.aliases].some((n) => k(n) === k(token))); },
    async findElements(token, opts) {
      const t = roadKey(token);
      const inCity = cityEn(opts.city);
      return elements
        .filter((e) => !inCity || e.city === inCity)
        .filter((e) => roadKey(e.name_ar).includes(t) || t.includes(roadKey(e.name_ar)));
    },
    async zoneDistricts(c, zone) {
      return (ZONES[k(c)]?.[zone] ?? []).map((district_id) => ({ district_id, district_name: district_id }));
    },
    async districtForPoint() { return null; },
    roadAxis: fakeRoadAxis(ROAD_AXIS),
    cityLabel: fakeCityLabel(CITIES),
    namesInText: fakeNamesInText(elements),
  };
}

/**
 * How the fixture roads run — the MEASURED numbers of the real road each one
 * stands for (fakeGeoMap.ts). JED-ROAD-KAR and KHB-ROAD-KFR were never measured,
 * so they are absent: the axis port answers found:false for them.
 */
const ROAD_AXIS: Record<string, FakeRoad> = {
  'RUH-ROAD-KFR': {
    road: MEASURED_ROAD_AXIS.kingFahd,
    byDistricts: {
      'd-malqa': MEASURED_LOCAL_AXIS.kingFahdInMalqa,
      'd-olaya': MEASURED_LOCAL_AXIS.kingFahdInOlaya,
      'd-narjis': MEASURED_LOCAL_AXIS.kingFahdAroundNarjis,
    },
  },
  'RUH-ROAD-KSR': {
    road: MEASURED_ROAD_AXIS.kingSalman,
    byDistricts: {
      'd-narjis': MEASURED_LOCAL_AXIS.kingSalmanInNarjis,
      'd-malqa': MEASURED_LOCAL_AXIS.kingSalmanInMalqa,
    },
  },
  'RUH-RING-N': { road: MEASURED_ROAD_AXIS.northernRing, byDistricts: { 'd-narjis': MEASURED_LOCAL_AXIS.northernRingAroundNarjis } },
  'RUH-ROAD-KAR': { road: MEASURED_ROAD_AXIS.kingAbdullah },
  'RUH-ROAD-DMM': { road: MEASURED_ROAD_AXIS.dammam0727 },
  // «طريق جدة» in Riyadh is the Makkah Road leaving the city westward.
  'RUH-ROAD-JED': { road: MEASURED_ROAD_AXIS.makkah0695 },
};

const universe: SatUniverse = { universe: ['c1'], cellsOf: () => ['c1'], inventoryIn: () => 5 };
const config: GateConfig = {
  auto_write_enabled: false, t_lexical_margin: 0.9, t_geo_margin: 0.9, t_source_quality: 0.9,
  min_action_assurance: { write_soft: 0.9, write_hard: 0.98, supersede: 0.99 },
};
function ctx(db: ResolverDb = fakeDb()): RunContext {
  return {
    client_id: 'client-1', checkpoint_id: 'cp-1', maximum_safe_action: 'propose',
    // A client with no city on record: the established city is the organisational default.
    resolution: { db, preferCountry: 'SA', established_city: 'الرياض', universe_hint: 'organizational_default' },
    universe, config,
  };
}
const ports: OrchestratorPorts = {
  proposals: { async createProposal(input) { return { ...input, id: 'prop-1', status: 'pending' } as ProposalRecord; } },
};

const a = (anchor_type: AnchorToken['anchor_type'], span: string, extra: Partial<AnchorToken> = {}): AnchorToken =>
  ({ anchor_type, span, normalized_token: span, ...extra });

function ev(id: string, mention_span: string, anchors: AnchorToken[]): Evidence {
  return {
    id, mention_span, anchors,
    speaker: 'client', preference_holder: 'client', holder_role: 'buyer', quoted_speaker: 'none',
    dialogue_act: 'statement', conditionality: 'asserted', temporal_reference: 'present',
    preference_applicability: 'active', preference_role: 'positive', commitment: 'preferred',
    hardness_evidence: 'none', modality: 'explicit',
    source: { channel: 'chat', ref: 'm1', timestamp: '2026-10-01T00:00:00Z' },
  };
}

function recipes(pref: GeoPreference): GeometryRecipe[] {
  return pref.groups.flatMap((g) => g.clauses.flatMap((c) => c.anyOf.map((r) => r.recipe)));
}
const allIds = (pref: GeoPreference) => recipes(pref).flatMap((r) => r.resolved_element_ids);
const resolvedRecipes = (pref: GeoPreference) => recipes(pref).filter((r) => r.geo_data_version !== 'stub');
const ops = (pref: GeoPreference) => resolvedRecipes(pref).map((r) => r.operation);
const conds = (items: LocationItem[]) => items.flatMap((i) => (i.kind === 'element_rule' ? i.conditions : []));

async function run(evidence: Evidence[], db?: ResolverDb) {
  return runReviewFirst(evidence, [], ctx(db), ports);
}
/** One mention, run through the whole pipeline. */
async function one(span: string, anchors: AnchorToken[], db?: ResolverDb) {
  const res = await run([ev('e1', span, anchors)], db);
  return { res, items: geoPreferenceToLocationItems(res.compiled) };
}
/** Safely unresolved: nothing resolved for the mention, nothing would be saved. */
function expectUnresolved(r: Awaited<ReturnType<typeof one>>): void {
  expect(resolvedRecipes(r.res.compiled)).toEqual([]);
  expect(r.items).toEqual([]);
}

describe('a district + a side of a road → ONE district_side_clip', () => {
  it('[district النرجس, direction جنوب, road سلمان] → Narjis clipped SOUTH of King Salman Road', async () => {
    const res = await run([ev('e1', 'ابي بالنرجس جنوب سلمان', [a('district', 'النرجس'), a('direction', 'جنوب'), a('road', 'سلمان')])]);
    expect(res.resolutions.every((r) => r.status === 'resolved')).toBe(true);
    const rs = recipes(res.compiled);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.operation).toBe('district_side_clip');
    expect(rs[0]!.resolved_element_ids).toEqual(['d-narjis', 'RUH-ROAD-KSR']);
    expect(rs[0]!.side).toBe('south');
    expect(rs[0]!.geo_data_version).not.toBe('stub');
    // NOT the south city zone, NOT the district «حي الملك سلمان».
    expect(allIds(res.compiled)).not.toContain('d-shifa');
    expect(allIds(res.compiled)).not.toContain('d-king-salman');
    expect(res.proposal?.source_evidence_ids).toEqual(['e1']);
  });

  it('[district النرجس, direction شمال, district سلمان] (rule b) → clipped NORTH of King Salman Road, never a union with a district', async () => {
    const res = await run([ev('e1', 'النرجس شمال سلمان', [a('district', 'النرجس'), a('direction', 'شمال'), a('district', 'سلمان')])]);
    const rs = recipes(res.compiled);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.operation).toBe('district_side_clip');
    expect(rs[0]!.resolved_element_ids).toEqual(['d-narjis', 'RUH-ROAD-KSR']);
    expect(rs[0]!.side).toBe('north');
    expect(allIds(res.compiled)).not.toContain('d-king-salman');
    expect(rs.some((r) => r.operation === 'district_union')).toBe(false);
  });

  it('«بالنرجس شمال طريق الملك سلمان» (road with its road word) → the same clip', async () => {
    const res = await run([ev('e1', 'ابي بالنرجس شمال طريق الملك سلمان', [a('district', 'النرجس'), a('direction', 'شمال'), a('road', 'طريق الملك سلمان')])]);
    const rs = recipes(res.compiled);
    expect(rs.map((r) => [r.operation, r.side])).toEqual([['district_side_clip', 'north']]);
  });
});

describe('a side of a road on its own → directional_band', () => {
  it('[direction غرب, road الملك فهد] → directional_band on King Fahd Road, not the west of the city', async () => {
    const res = await run([ev('e1', 'ابي فيلا غرب الملك فهد', [a('direction', 'غرب'), a('road', 'الملك فهد')])]);
    const rs = recipes(res.compiled);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.operation).toBe('directional_band');
    expect(rs[0]!.resolved_element_ids).toEqual(['RUH-ROAD-KFR']);
    expect(rs[0]!.side).toBe('west');
    expect(allIds(res.compiled).some((id) => id.startsWith('d-west-'))).toBe(false);
    const items = geoPreferenceToLocationItems(res.compiled);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'element_rule', conditions: [{ rule: 'west_of', element_id: 'RUH-ROAD-KFR' }] });
    // The chip names the road once — never «غرب غرب الملك فهد» (finding 24a).
    expect(describeLocationItem(items[0]!, true)).toBe('غرب الملك فهد (حتى 5 كم)');
  });
});

describe('near a named venue (polygon landmark)', () => {
  it('[landmark الرياض بارك, distance_m 3000] → within_distance 3000 of the mall shape', async () => {
    const res = await run([ev('e1', 'خلال 3 كيلو من الرياض بارك', [a('landmark', 'الرياض بارك', { distance_m: 3000 })])]);
    const rs = recipes(res.compiled);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.operation).toBe('within_distance');
    expect(rs[0]!.resolved_element_ids).toEqual(['RUH-MALL-PARK']);
    expect(rs[0]!.radius_or_band_m).toBe(3000);
    const items = geoPreferenceToLocationItems(res.compiled);
    expect(items[0]).toMatchObject({ kind: 'element_rule', conditions: [{ rule: 'within_distance', element_id: 'RUH-MALL-PARK', distance_m: 3000 }] });
  });

  it('[landmark الرياض بارك] with no distance → needs_confirm(missing_radius) — HARD RULE 4, no silent default', async () => {
    const res = await run([ev('e1', 'قريب من الرياض بارك', [a('landmark', 'الرياض بارك')])]);
    expect(res.resolutions).toHaveLength(1);
    expect(res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'missing_radius' });
    expect(recipes(res.compiled)[0]!.geo_data_version).toBe('stub');
    expect(geoPreferenceToLocationItems(res.compiled)).toEqual([]);
    expect(res.ambiguity).toContain('missing_radius');
  });

  it('«قريب من الرياض بارك» extracted as [city الرياض] → never the Riyadh city record (landmark path)', async () => {
    const res = await run([ev('e1', 'قريب من الرياض بارك', [a('city', 'الرياض')])]);
    expect(allIds(res.compiled)).not.toContain('city-riyadh');
    expect(res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'missing_radius' });
    expect(geoPreferenceToLocationItems(res.compiled)).toEqual([]);
  });

  it('the same, with the mall absent from the map → needs_confirm, still never the city', async () => {
    const res = await run([ev('e1', 'قريب من الرياض بارك', [a('city', 'الرياض')])], fakeDb([KING_FAHD_ROAD]));
    expect(res.resolutions[0]!.status).toBe('needs_confirm');
    expect(allIds(res.compiled)).not.toContain('city-riyadh');
  });

  it('«قريب من الرياض» (nothing after the city) → needs_confirm(proximity_to_city)', async () => {
    const res = await run([ev('e1', 'ابي قريب من الرياض', [a('city', 'الرياض')])]);
    expect(res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'proximity_to_city' });
    expect(allIds(res.compiled)).not.toContain('city-riyadh');
  });

  it('«خلال 3 كيلو من الرياض بارك» extracted as [city الرياض, 3000] → the mall, 3000 — never the city', async () => {
    const { res, items } = await one('خلال 3 كيلو من الرياض بارك', [a('city', 'الرياض', { distance_m: 3000 })]);
    expect(ops(res.compiled)).toEqual(['within_distance']);
    expect(allIds(res.compiled)).toEqual(['RUH-MALL-PARK']);
    expect(conds(items)).toEqual([{ rule: 'within_distance', element_id: 'RUH-MALL-PARK', distance_m: 3000 }]);
  });
});

describe('near a road', () => {
  it('«خلال كيلو من طريق الملك فهد» → within_distance 1000 of the road', async () => {
    // The text states the distance: a radius is used only when the customer said it (P10, HARD RULE 4).
    const res = await run([ev('e1', 'قريب من طريق الملك فهد خلال كيلو', [a('road', 'طريق الملك فهد', { distance_m: 1000, role_in_relation: 'proximity' })])]);
    const rs = recipes(res.compiled);
    expect(rs.map((r) => [r.operation, r.radius_or_band_m])).toEqual([['within_distance', 1000]]);
  });

  it('a road with proximity but no number → missing_radius (not corridor_underspecified)', async () => {
    const res = await run([ev('e1', 'قريب من طريق الملك فهد', [a('road', 'طريق الملك فهد')])]);
    expect(res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'missing_radius' });
  });
});

describe('«بين طريقين» stays needs_confirm(corridor_underspecified) — no silent 3 km bands (decision D; findings 7, 12, 22)', () => {
  it('[road boundary_start, road boundary_end] → both roads ask; nothing resolves, nothing is saved', async () => {
    const r = await one('بين طريق الملك فهد وطريق الملك سلمان', [
      a('road', 'طريق الملك فهد', { role_in_relation: 'boundary_start' }),
      a('road', 'طريق الملك سلمان', { role_in_relation: 'boundary_end' }),
    ]);
    expect(r.res.resolutions.map((x) => [x.status, x.reason])).toEqual([
      ['needs_confirm', 'corridor_underspecified'], ['needs_confirm', 'corridor_underspecified'],
    ]);
    expect(r.res.resolutions.some((x) => x.recipe?.operation === 'corridor')).toBe(false);
    expectUnresolved(r);
  });

  it('even with a stated width on one road, the corridor never resolves', async () => {
    const r = await one('بين طريق الملك فهد وطريق العليا بعرض 2 كيلو', [
      a('road', 'طريق الملك فهد', { role_in_relation: 'boundary_start', distance_m: 2000 }),
      a('road', 'طريق العليا', { role_in_relation: 'boundary_end' }),
    ]);
    expect(r.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'corridor_underspecified' });
    expectUnresolved(r);
  });
});

describe('regression — city zones are unchanged', () => {
  it('[direction شمال, city الرياض] → the north zone_union, exactly as before', async () => {
    const res = await run([ev('e1', 'ابي في شمال الرياض', [a('direction', 'شمال'), a('city', 'الرياض')])]);
    const rs = recipes(res.compiled);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.operation).toBe('zone_union');
    expect(rs[0]!.resolved_element_ids).toEqual(ZONES[placeKey('الرياض')]!.north);
  });

  it('a bare [direction شمال] with an established city → the same zone_union', async () => {
    const res = await run([ev('e1', 'ابي في الشمال', [a('direction', 'الشمال')])]);
    const rs = recipes(res.compiled);
    expect(rs.map((r) => r.operation)).toEqual(['zone_union']);
    expect(rs[0]!.resolved_element_ids).toEqual(ZONES[placeKey('الرياض')]!.north);
  });

  it('a city beside a road side is scope, never a "district" in the clip', async () => {
    const res = await run([ev('e1', 'شمال طريق الملك سلمان بالرياض', [a('direction', 'شمال'), a('road', 'طريق الملك سلمان'), a('city', 'الرياض')])]);
    const rs = recipes(res.compiled);
    expect(rs.map((r) => r.operation)).toEqual(['directional_band']);
    expect(allIds(res.compiled)).not.toContain('city-riyadh');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The confirmed failure scenarios of the 2026-10-03 review.
// ─────────────────────────────────────────────────────────────────────────────

describe('review findings — a direction owned by a city, or a «near» road, is never folded', () => {
  it('#0/#28 «شمال الرياض على طريق الملك فهد» → not a band on King Fahd Road; the road asks', async () => {
    const r = await one('شمال الرياض على طريق الملك فهد', [a('direction', 'شمال'), a('city', 'الرياض'), a('road', 'طريق الملك فهد')]);
    expect(r.res.resolutions.some((x) => x.recipe?.operation === 'directional_band')).toBe(false);
    expect(r.res.resolutions[2]).toMatchObject({ status: 'needs_confirm', reason: 'corridor_underspecified' });
    expectUnresolved(r);
    const s = await one('ابي شمال الرياض على طريق الملك سلمان', [a('direction', 'شمال'), a('city', 'الرياض'), a('road', 'طريق الملك سلمان')]);
    expectUnresolved(s);
  });

  it('#0/#9 «في الشمال قريب من طريق الملك فهد خلال 2 كيلو» → never «north OF the road»; north AND near the road is asked (round 3, #24)', async () => {
    const r = await one('في الشمال قريب من طريق الملك فهد خلال 2 كيلو', [
      a('direction', 'الشمال'), a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 }),
    ]);
    // The road resolves on its own (within 2 km — never a band); the bare
    // direction beside a road is asked by the preparation (BD2, design
    // 2026-10-04) — "the north zone AND near the road" has no single shape, and
    // the saved location_items are an OR-union: two items would save the WHOLE
    // north. Asked.
    expect(r.res.resolutions.map((x) => x.recipe?.operation ?? x.reason)).toEqual(['direction_referent_unclear', 'within_distance']);
    expect(r.res.resolutions[1]!.recipe!.radius_or_band_m).toBe(2000);
    expectUnresolved(r);
    expect(r.res.compiled.groups.flatMap((g) => g.clauses.flatMap((c) => c.anyOf.map((x) => x.geometry_id)))).toEqual(['geo:e1']);
    expect(r.res.ambiguity).toContain('unresolved_reference');
  });

  it('#28 «ابي الشمال قريب من طريق الملك فهد» (no number) → asks for the distance; no band', async () => {
    const r = await one('ابي الشمال قريب من طريق الملك فهد', [a('direction', 'الشمال'), a('road', 'طريق الملك فهد', { role_in_relation: 'proximity' })]);
    expect(r.res.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'missing_radius' });
    expectUnresolved(r);
  });

  it('#3/#28 «شرق او غرب الملك فهد» / «شمال او جنوب طريق الملك فهد» → asked, never a city zone clipped to the other side', async () => {
    const r = await one('شرق او غرب الملك فهد', [a('direction', 'شرق'), a('direction', 'غرب'), a('road', 'الملك فهد')]);
    // BD2 (design 2026-10-04 §5.4): a bare direction beside a road side asks.
    expect(r.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'direction_referent_unclear' });
    expect(recipes(r.res.compiled).some((x) => x.operation === 'district_side_clip')).toBe(false);
    expect(allIds(r.res.compiled).some((id) => id.startsWith('d-west-') || id.startsWith('d-east-'))).toBe(false);
    expectUnresolved(r);
    const s = await one('شمال او جنوب طريق الملك فهد', [a('direction', 'شمال'), a('direction', 'جنوب'), a('road', 'طريق الملك فهد')]);
    expect(allIds(s.res.compiled)).not.toContain('d-shifa');
    expectUnresolved(s);
  });
});

describe('review findings — royal short names', () => {
  it('#1 «ابي في الفهد شمال نجران» → the district «الفهد» stays a district; no King Fahd Road; «شمال» is NAJRAN\'s north (round 3, #4)', async () => {
    const r = await one('ابي في الفهد شمال نجران', [a('district', 'الفهد'), a('direction', 'شمال'), a('city', 'نجران')]);
    expect(r.res.resolutions[0]).toMatchObject({ status: 'resolved', recipe: { operation: 'district_polygon', resolved_element_ids: ['d-fahd-najran'] } });
    expect(allIds(r.res.compiled)).toContain('d-fahd-najran');
    expect(allIds(r.res.compiled)).toEqual(expect.arrayContaining(['njr-n1', 'njr-n2']));
    // Never Riyadh's north (the established city) for a customer who named Najran.
    expect(allIds(r.res.compiled)).not.toContain('d-narjis');
    expect(allIds(r.res.compiled)).not.toContain('RUH-ROAD-KFR');
    expect(ops(r.res.compiled)).not.toContain('directional_band');
    expect(conds(r.items)).toEqual([]);
  });

  it('#17 ONE direction anchor «شمال سلمان» / «جنوب سلمان» (the v9 prompt shape) → the King Salman Road side clip', async () => {
    const r = await one('النرجس شمال سلمان', [a('district', 'النرجس'), a('direction', 'شمال سلمان')]);
    expect(resolvedRecipes(r.res.compiled).map((x) => [x.operation, x.side, x.resolved_element_ids])).toEqual([
      ['district_side_clip', 'north', ['d-narjis', 'RUH-ROAD-KSR']],
    ]);
    const s = await one('ابي بالنرجس جنوب سلمان', [a('district', 'النرجس'), a('direction', 'جنوب سلمان')]);
    expect(resolvedRecipes(s.res.compiled).map((x) => [x.operation, x.side])).toEqual([['district_side_clip', 'south']]);
    expect(allIds(s.res.compiled)).not.toContain('d-king-salman');
  });
});

describe('review findings — a road referent never becomes a city zone', () => {
  it('#13 «ابي شرق طريق الدمام» (normalized «الدمام») → never east Dammam city; the road runs east–west, so «east of» it asks', async () => {
    const r = await one('ابي شرق طريق الدمام', [a('direction', 'شرق'), a('road', 'طريق الدمام', { normalized_token: 'الدمام' })]);
    // Design 2026-10-04 §5.4: I4 — the Dammam Road's east–west share is 0.628 > 0.60,
    // so "east of" it means nothing. Still never Dammam CITY's east zone.
    expect(r.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'side_not_along_road' });
    expect(allIds(r.res.compiled)).not.toContain('dmm-e1');
    expectUnresolved(r);
  });

  it('#13 «ابي غرب طريق جدة» (normalized «جدة») → never west Jeddah city; the road runs east–west, so «west of» it asks', async () => {
    const r = await one('ابي غرب طريق جدة', [a('direction', 'غرب'), a('road', 'طريق جدة', { normalized_token: 'جدة' })]);
    // Design §5.4: I4 — Riyadh's «طريق جدة» is the Makkah Road (share 0.702 > 0.60).
    expect(r.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'side_not_along_road' });
    expect(allIds(r.res.compiled).some((id) => id.startsWith('jed-w'))).toBe(false);
    expectUnresolved(r);
    // The same referent said as ONE direction anchor with its road word.
    const s = await one('ابي غرب طريق جدة', [a('direction', 'غرب طريق جدة')]);
    expect(s.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'side_not_along_road' });
    expect(allIds(s.res.compiled).some((id) => id.startsWith('jed-w'))).toBe(false);
    expectUnresolved(s);
  });

  it('#21 «ابي جنوب الدائري الشمالي» → SOUTH of the Northern Ring Road (the road\'s own name never flips the side)', async () => {
    const r = await one('ابي جنوب الدائري الشمالي', [a('direction', 'جنوب'), a('road', 'الدائري الشمالي')]);
    const rs = resolvedRecipes(r.res.compiled);
    expect(rs.map((x) => [x.operation, x.side, x.resolved_element_ids])).toEqual([['directional_band', 'south', ['RUH-RING-N']]]);
    expect(conds(r.items)).toEqual([{ rule: 'south_of', element_id: 'RUH-RING-N', distance_m: 5000 }]);
  });
});

describe('review findings — the city the customer NAMED scopes the road / venue', () => {
  it('#2 «في الخبر قريب من طريق الملك فهد خلال 2 كيلو» → Khobar\'s King Fahd Road, not Riyadh\'s', async () => {
    const r = await one('في الخبر قريب من طريق الملك فهد خلال 2 كيلو', [
      a('city', 'الخبر'), a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 }),
    ]);
    expect(resolvedRecipes(r.res.compiled).map((x) => [x.operation, x.resolved_element_ids, x.radius_or_band_m])).toEqual([
      ['within_distance', ['KHB-ROAD-KFR'], 2000],
    ]);
    expect(allIds(r.res.compiled)).not.toContain('RUH-ROAD-KFR');
    expect(allIds(r.res.compiled)).not.toContain('city-khobar');
    expect(conds(r.items)).toEqual([{ rule: 'within_distance', element_id: 'KHB-ROAD-KFR', distance_m: 2000 }]);
  });

  it('#6 «بجدة شمال طريق الملك عبدالله» → JEDDAH\'s King Abdullah Road is the pick, never Riyadh\'s; with no measured run the side asks', async () => {
    const r = await one('بجدة شمال طريق الملك عبدالله', [a('city', 'جدة'), a('direction', 'شمال'), a('road', 'طريق الملك عبدالله')]);
    // The lookup searched the city the customer NAMED (the pick's facts say so)…
    expect(r.res.resolutions[1]).toMatchObject({ facts: { element_city: 'Jeddah', scope_city: 'جدة', scope_source: 'named' } });
    // …but this fixture road has no MEASURED run (fakeGeoMap.ts — never "always
    // valid"), and a road whose run is unknown ASKS (design 2026-10-04 §1.6, I4).
    expect(r.res.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'road_geometry_missing' });
    expect(allIds(r.res.compiled)).not.toContain('RUH-ROAD-KAR');
    expectUnresolved(r);
  });

  it('#6 the same shape on a road whose run IS measured: «بالرياض شمال طريق الملك عبدالله» → the band, labelled with the road', async () => {
    const r = await one('بالرياض شمال طريق الملك عبدالله', [a('city', 'الرياض'), a('direction', 'شمال'), a('road', 'طريق الملك عبدالله')]);
    const rs = resolvedRecipes(r.res.compiled);
    expect(rs.map((x) => [x.operation, x.side, x.resolved_element_ids])).toEqual([['directional_band', 'north', ['RUH-ROAD-KAR']]]);
    // The road side comes first in the provenance, so the chip is not the city.
    expect(rs[0]!.source_anchors[0]!.anchor_type).toBe('direction');
    expect(conds(r.items)).toEqual([{ rule: 'north_of', element_id: 'RUH-ROAD-KAR', distance_m: 5000 }]);
    const item = r.items[0]!;
    expect(item.kind === 'element_rule' ? item.element_label : '').toBe('طريق الملك عبدالله');
  });

  it('#29 «ابي في جدة شمال طريق الملك فهد» — no such road in Jeddah → asked, NEVER Riyadh\'s road', async () => {
    const r = await one('ابي في جدة شمال طريق الملك فهد', [a('city', 'جدة'), a('direction', 'شمال'), a('road', 'طريق الملك فهد')]);
    expect(allIds(r.res.compiled)).not.toContain('RUH-ROAD-KFR');
    expect(r.res.resolutions.some((x) => x.status === 'needs_confirm')).toBe(true);
    expectUnresolved(r);
    const s = await one('في جدة قريب من طريق الملك عبدالله خلال 2 كيلو', [
      a('city', 'جدة'), a('road', 'طريق الملك عبدالله', { role_in_relation: 'proximity', distance_m: 2000 }),
    ]);
    expect(allIds(s.res.compiled)).toEqual(['JED-ROAD-KAR']);
  });

  it('#6 the city AFTER the venue scopes it too: «قريب من النخيل مول بالخبر خلال 2 كيلو» → no such mall in Khobar → asked, never Riyadh\'s', async () => {
    const r = await one('قريب من النخيل مول بالخبر خلال 2 كيلو', [a('landmark', 'النخيل مول', { distance_m: 2000 }), a('city', 'الخبر')]);
    expect(r.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'outside_admin' });
    expect(allIds(r.res.compiled)).not.toContain('RUH-MALL-NAKHEEL');
    expectUnresolved(r);
  });

  it('a REGION beside a road side is never a "district" in a clip, and never a lookup scope (round 3, #25) — the mention asks (C1)', async () => {
    for (const region of [a('region', 'منطقة الرياض', { normalized_token: 'الرياض' }), a('region', 'منطقة الرياض')]) {
      const r = await one('منطقة الرياض شمال طريق الملك فهد', [region, a('direction', 'شمال'), a('road', 'طريق الملك فهد')]);
      // Design 2026-10-04 §5.4: C1 — a region beside anything else is held as a stub.
      expect(allIds(r.res.compiled)).not.toContain('region-riyadh');
      expect(ops(r.res.compiled)).not.toContain('district_side_clip');
      expect(r.res.ambiguity).toContain('unresolved_reference');
      expectUnresolved(r);
    }
  });

  it('#11/#24b «بالرياض شمال طريق الملك سلمان» → the chip is the road side, not «الرياض»', async () => {
    const r = await one('بالرياض شمال طريق الملك سلمان', [a('city', 'الرياض'), a('direction', 'شمال'), a('road', 'طريق الملك سلمان')]);
    expect(conds(r.items)).toEqual([{ rule: 'north_of', element_id: 'RUH-ROAD-KSR', distance_m: 5000 }]);
    expect(describeLocationItem(r.items[0]!, true)).toBe('شمال طريق الملك سلمان (حتى 5 كم)');
  });

  it('#10 «في الرياض بجوار النخيل مول خلال 2 كيلو» → the mall, 2 km — no fake «الرياض بجوار …» landmark', async () => {
    const r = await one('ابي شقة في الرياض بجوار النخيل مول خلال 2 كيلو', [a('city', 'الرياض'), a('landmark', 'النخيل مول', { distance_m: 2000 })]);
    expect(conds(r.items)).toEqual([{ rule: 'within_distance', element_id: 'RUH-MALL-NAKHEEL', distance_m: 2000 }]);
    expect(r.items[0]!.kind === 'element_rule' ? r.items[0]!.element_label : '').toBe('النخيل مول');
    const s = await one('في الرياض بالقرب من النخيل مول', [a('city', 'الرياض'), a('landmark', 'النخيل مول')]);
    expect(s.res.resolutions.map((x) => [x.status, x.reason ?? null])).toEqual([['resolved', null], ['needs_confirm', 'missing_radius']]);
  });
});

describe('review findings — a distance belongs to its own anchor; two rules in one mention are asked', () => {
  it('#5/#16 «غرب طريق الملك فهد قريب من النخيل مول بحدود 2 كيلو» → the band keeps its own depth; the mention is asked, the venue never silently dropped', async () => {
    const r = await one('غرب طريق الملك فهد قريب من النخيل مول بحدود 2 كيلو', [
      a('direction', 'غرب'), a('road', 'طريق الملك فهد'), a('landmark', 'النخيل مول', { distance_m: 2000 }),
    ]);
    const band = r.res.resolutions.find((x) => x.recipe?.operation === 'directional_band');
    expect(band?.recipe?.radius_or_band_m).toBe(5000);
    expect(band?.recipe?.universe_source).toBe('organizational_default');
    expect(r.res.resolutions.find((x) => x.recipe?.operation === 'within_distance')?.recipe?.radius_or_band_m).toBe(2000);
    expectUnresolved(r);
    expect(r.res.ambiguity).toContain('unresolved_reference');
  });

  it('#16 «شمال طريق الملك سلمان قريب من جامعة الملك سعود خلال 2 كيلو» → the band is not 2 km deep, and nothing is saved', async () => {
    const r = await one('شمال طريق الملك سلمان قريب من جامعة الملك سعود خلال 2 كيلو', [
      a('direction', 'شمال'), a('road', 'طريق الملك سلمان'), a('landmark', 'جامعة الملك سعود', { distance_m: 2000 }),
    ]);
    expect(r.res.resolutions.find((x) => x.recipe?.operation === 'directional_band')?.recipe?.radius_or_band_m).toBe(5000);
    expectUnresolved(r);
  });

  it('#19 one-anchor «غرب الملك فهد» with its own distance_m 2000 → a 2 km band, explicit', async () => {
    const r = await one('ابي غرب الملك فهد خلال 2 كيلو', [a('direction', 'غرب الملك فهد', { distance_m: 2000 })]);
    const rs = resolvedRecipes(r.res.compiled);
    expect(rs.map((x) => [x.operation, x.radius_or_band_m, x.universe_source])).toEqual([['directional_band', 2000, 'explicit']]);
    expect(conds(r.items)).toEqual([{ rule: 'west_of', element_id: 'RUH-ROAD-KFR', distance_m: 2000 }]);
  });
});

describe('review findings — a venue is one place or it is asked (point AND polygon together, #15)', () => {
  it('two branches 7.7 km apart → ambiguous_entity', async () => {
    const r = await one('قريب من مستشفى الدكتور سليمان الحبيب، خلال 2 كيلو', [a('landmark', 'مستشفى الدكتور سليمان الحبيب', { distance_m: 2000 })]);
    expect(r.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'ambiguous_entity' });
    expectUnresolved(r);
  });

  it('a metro-station point and the campus shape 11.7 km apart → ambiguous_entity (never the station)', async () => {
    const r = await one('خلال 3 كيلو من جامعة الملك سعود', [a('landmark', 'جامعة الملك سعود', { distance_m: 3000 })]);
    expect(r.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'ambiguous_entity' });
    expect(allIds(r.res.compiled)).not.toContain('RUH-METR-KSU');
  });

  it('a point and a shape of ONE venue (145 m apart) → its shape, within_distance', async () => {
    const r = await one('خلال 2 كيلو من العثيم مول', [a('landmark', 'العثيم مول', { distance_m: 2000 })]);
    expect(resolvedRecipes(r.res.compiled).map((x) => [x.operation, x.resolved_element_ids])).toEqual([['within_distance', ['RUH-MALL-OTH']]]);
  });
});

describe('review findings — proximity is whole words on the anchor itself', () => {
  it('#4/#8/#18 «ابي في العقربية بالخبر» / «ابي في الخبر العقربية» → still resolved (the «قرب» inside the name is not «near»)', async () => {
    for (const [span, anchors] of [
      ['ابي في العقربية بالخبر', [a('district', 'العقربية'), a('city', 'الخبر')]],
      ['ابي في الخبر العقربية', [a('city', 'الخبر'), a('district', 'العقربية')]],
    ] as Array<[string, AnchorToken[]]>) {
      const r = await one(span, anchors);
      expect(r.res.resolutions.every((x) => x.status === 'resolved')).toBe(true);
      expect(allIds(r.res.compiled)).toContain('d-aqrabiyah');
      expect(resolvedRecipes(r.res.compiled)).toHaveLength(1);
    }
  });

  it('#14/#18/#26/#27 «شمال الرياض» with «تقريبا» / «قريب من شغلي» / «قريبة من المدارس» → the north zone, unchanged', async () => {
    for (const [span, anchors] of [
      ['شمال الرياض تقريبا', [a('direction', 'شمال'), a('city', 'الرياض')]],
      ['شمال الرياض قريب من شغلي', [a('direction', 'شمال'), a('city', 'الرياض')]],
      ['ابي في شمال الرياض قريب من المدارس', [a('direction', 'شمال'), a('city', 'الرياض')]],
      ['ابي فيلا شمال الرياض قريبة من المدارس', [a('direction', 'شمال'), a('city', 'الرياض')]],
      ['ابي شمال الرياض قريب من المدارس', [a('direction', 'شمال الرياض'), a('city', 'الرياض')]],
    ] as Array<[string, AnchorToken[]]>) {
      const r = await one(span, anchors);
      expect(ops(r.res.compiled)).toEqual(['zone_union']);
      expect(r.items.map((i) => (i.kind === 'district' ? i.district_id : '?'))).toEqual(ZONES[placeKey('الرياض')]!.north);
    }
  });

  it('#18/#26/#27 a plain city with «تقريبا» / «قريب من المدارس» / «اقرب» is still the city (as before)', async () => {
    for (const [span, anchors] of [
      ['ابي بيت في الرياض تقريبا بمليون', [a('city', 'الرياض')]],
      ['ابي بيت في الرياض قريب من المدارس', [a('city', 'الرياض')]],
      ['ابي بيت في الرياض قريب من شغلي', [a('city', 'الرياض')]],
    ] as Array<[string, AnchorToken[]]>) {
      const r = await one(span, anchors);
      expect(r.res.resolutions.every((x) => x.status === 'resolved')).toBe(true);
      expect(allIds(r.res.compiled)).toContain('city-riyadh');
    }
    // A city BESIDE a district is that district's scope, never a second place
    // (design 2026-10-04 C2, §5.3 row 7d; the legacy diff allows dropping a
    // city record id): «اقرب» is still no «near», the district stays resolved.
    const r = await one('في الرياض، واقرب شي للعليا', [a('city', 'الرياض'), a('district', 'العليا')]);
    expect(r.res.resolutions.every((x) => x.status === 'resolved')).toBe(true);
    expect(allIds(r.res.compiled)).toEqual(['d-olaya']);
  });

  it('#14 a district next to its city with a «قريب من …» about something else keeps the district', async () => {
    const r = await one('النرجس بالرياض قريب من المدارس', [a('district', 'النرجس'), a('city', 'الرياض')]);
    expect(r.res.resolutions.every((x) => x.status === 'resolved')).toBe(true);
    expect(allIds(r.res.compiled)).toContain('d-narjis');
    expect(r.items.some((i) => i.kind === 'district' && i.district_id === 'd-narjis')).toBe(true);
  });
});

describe('review findings — a side clip that keeps nothing saves nothing (#23)', () => {
  it('«ابي الملقا شمال سلمان» → a clip; once computed as "nothing on that side" → no items, an untickable warning line', async () => {
    const r = await one('ابي الملقا شمال سلمان', [a('district', 'الملقا'), a('direction', 'شمال'), a('district', 'سلمان')]);
    const pref = r.res.compiled;
    const clip = resolvedRecipes(pref)[0]!;
    expect([clip.operation, clip.side, clip.resolved_element_ids]).toEqual(['district_side_clip', 'north', ['d-malqa', 'RUH-ROAD-KSR']]);
    // What hydrateClipGeometry stores when every district lies on the other side.
    clip.clip_geojson = { type: 'MultiPolygon', coordinates: [] };
    clip.clip_parts = [{ district_id: 'd-malqa', name: 'حي الملقا', crossed: false, kept: false, kept_km2: 0, total_km2: 21.85 }];
    expect(geoPreferenceToLocationItems(pref)).toEqual([]);
    const placement = placementsByEvidence(pref).e1!;
    expect(placement.clip_state).toBe('empty');
    expect(placementSentence(placement, { 'RUH-ROAD-KSR': { name_ar: 'طريق الملك سلمان' } }))
      .toBe('لا يقع جزء من الحي على هذا الجانب: حي الملقا — الجزء الشمالي من طريق الملك سلمان');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round 3 of the 2026-10-03 review — one test per confirmed defect.
// ─────────────────────────────────────────────────────────────────────────────

describe('round 3 — royal short names', () => {
  it('#1 a district «سلمان» normalized to «الملك سلمان» (what the v9 prompt asks) still folds: «النرجس شمال سلمان» is the King Salman Road clip', async () => {
    const r = await one('النرجس شمال سلمان', [
      a('district', 'النرجس'), a('direction', 'شمال'), a('district', 'سلمان', { normalized_token: 'الملك سلمان' }),
    ]);
    expect(resolvedRecipes(r.res.compiled).map((x) => [x.operation, x.side, x.resolved_element_ids])).toEqual([
      ['district_side_clip', 'north', ['d-narjis', 'RUH-ROAD-KSR']],
    ]);
    expect(allIds(r.res.compiled)).not.toContain('d-king-salman');
    expect(allIds(r.res.compiled).some((id) => ZONES[placeKey('الرياض')]!.north!.includes(id) && id !== 'd-narjis')).toBe(false);
  });

  it('#3 «ابي جنوب حي سلمان» (normalized «جنوب سلمان») is the DISTRICT — never a band on King Salman Road', async () => {
    for (const [mention, span, norm] of [
      ['ابي جنوب حي سلمان', 'جنوب حي سلمان', 'جنوب سلمان'],
      ['شمال حي عبدالله', 'شمال حي عبدالله', 'شمال عبدالله'],
    ] as const) {
      const r = await one(mention, [a('direction', span, { normalized_token: norm })]);
      expect(ops(r.res.compiled)).not.toContain('directional_band');
      expect(allIds(r.res.compiled)).not.toContain('RUH-ROAD-KSR');
      expect(allIds(r.res.compiled)).not.toContain('RUH-ROAD-KAR');
      expectUnresolved(r);
    }
  });

  it('#18 a model rewrite of «شمال الفهد» to «شمال الملك فهد» is undone — never King Fahd Road', async () => {
    const r = await one('ابي شقة شمال الفهد', [a('direction', 'شمال الفهد', { normalized_token: 'شمال الملك فهد' })]);
    expect(allIds(r.res.compiled)).not.toContain('RUH-ROAD-KFR');
    expectUnresolved(r);
    // The legitimate rewrite («جنوب سلمان» → «جنوب الملك سلمان») still resolves.
    const s = await one('ابي جنوب سلمان', [a('direction', 'جنوب سلمان', { normalized_token: 'جنوب الملك سلمان' })]);
    expect(resolvedRecipes(s.res.compiled).map((x) => [x.operation, x.side, x.resolved_element_ids])).toEqual([['directional_band', 'south', ['RUH-ROAD-KSR']]]);
  });
});

describe('round 3 — a bare direction beside a road side', () => {
  it('#2 a bare direction AFTER a folded road side, joined by «او», asks — never the city\'s east clipped to the road', async () => {
    const r = await one('ابي غرب الملك فهد او شرق', [a('direction', 'غرب'), a('road', 'الملك فهد'), a('direction', 'شرق')]);
    expect(r.res.resolutions.map((x) => [x.status, x.reason ?? null])).toEqual([['resolved', null], ['needs_confirm', 'direction_referent_unclear']]);
    expect(allIds(r.res.compiled).some((id) => id.startsWith('d-east-'))).toBe(false);
    expectUnresolved(r);
  });

  it('#2 a road said twice with ONE road anchor: each direction folds with its own copy → two sides of one road, asked', async () => {
    const r = await one('شمال طريق الملك فهد او جنوب طريق الملك فهد', [a('direction', 'شمال'), a('road', 'طريق الملك فهد'), a('direction', 'جنوب')]);
    expect(r.res.resolutions.map((x) => [x.recipe?.operation, x.recipe?.side])).toEqual([['directional_band', 'north'], ['directional_band', 'south']]);
    expect(allIds(r.res.compiled)).not.toContain('d-shifa');
    expectUnresolved(r);
  });

  it('#23 «ابي في الشمال غرب طريق الملك فهد» (no word between) → ASKS (BD2 — design 2026-10-04 §5.4, an accepted ask)', async () => {
    const r = await one('ابي في الشمال غرب طريق الملك فهد', [a('direction', 'الشمال', { normalized_token: 'شمال' }), a('direction', 'غرب طريق الملك فهد')]);
    expect(r.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'direction_referent_unclear' });
    expectUnresolved(r);
    // A bare direction whose span is not in the text asks too.
    const s = await one('ابي شمالي غرب الملك فهد', [a('direction', 'شمال'), a('direction', 'غرب الملك فهد')]);
    expect(s.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'direction_referent_unclear' });
    expectUnresolved(s);
  });

  it('#6/#14 a comma between the direction and the road («بالشمال، على طريق الملك فهد») → no fold; the road asks', async () => {
    for (const mention of ['ابي بالشمال، على طريق الملك فهد', 'شمال، على طريق الملك فهد']) {
      const r = await one(mention, [a('direction', mention.includes('بالشمال') ? 'الشمال' : 'شمال'), a('road', 'طريق الملك فهد')]);
      expect(ops(r.res.compiled)).not.toContain('directional_band');
      expect(r.res.resolutions.some((x) => x.recipe?.operation === 'directional_band')).toBe(false);
      expectUnresolved(r);
    }
  });

  it('#8 two «شمال» anchors are two places: the city owns the first, the second folds with its road — and «north of» King Fahd Road asks', async () => {
    const r = await one('شمال الرياض، تحديدا شمال طريق الملك فهد', [
      a('direction', 'شمال'), a('city', 'الرياض'), a('direction', 'شمال'), a('road', 'طريق الملك فهد'),
    ]);
    // The preparation still builds the right shape: the zone of the owner city
    // and ONE folded road side (never a city record in a clip)…
    expect(r.res.resolutions.map((x) => x.status)).toEqual(['resolved', 'resolved', 'needs_confirm']);
    expect(r.res.resolutions[0]!.recipe?.operation).toBe('zone_union');
    // …but design 2026-10-04 §5.4: M2 — King Fahd Road runs north–south, so the
    // north-of-it clip means nothing. Asked, never drawn.
    expect(r.res.resolutions[2]).toMatchObject({ status: 'needs_confirm', reason: 'side_not_along_road' });
    expect(allIds(r.res.compiled)).not.toContain('city-riyadh');
    expectUnresolved(r);
  });
});

describe('round 3 — the city a bare direction belongs to', () => {
  it('#4/#15 «ابي فيلا شمال جدة» → JEDDAH\'s north, never Riyadh\'s (the established city)', async () => {
    const r = await one('ابي فيلا شمال جدة', [a('direction', 'شمال'), a('city', 'جدة')]);
    expect(resolvedRecipes(r.res.compiled).map((x) => [x.operation, x.resolved_element_ids])).toEqual([['zone_union', ['jed-n1', 'jed-n2']]]);
    expect(allIds(r.res.compiled)).not.toContain('d-narjis');
  });

  it('#4 the folded «جده» finds the zone recorded as «جدة» (the zone lookup matches the Arabic name exactly)', async () => {
    const strict: ResolverDb = {
      ...fakeDb(),
      async zoneDistricts(c, zone) { return c === 'جدة' && zone === 'north' ? [{ district_id: 'jed-n1', district_name: 'x' }] : []; },
    };
    const r = await one('ابي فيلا شمال جدة', [a('direction', 'شمال'), a('city', 'جدة', { normalized_token: 'جده' })], strict);
    expect(resolvedRecipes(r.res.compiled).map((x) => x.resolved_element_ids)).toEqual([['jed-n1']]);
  });

  it('#4 a city with no zone data → asked, never the established city\'s zone', async () => {
    const r = await one('ابي شمال الدمام', [a('direction', 'شمال'), a('city', 'الدمام')]);
    expect(r.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'outside_admin' });
    expectUnresolved(r);
  });
});

describe('round 3 — WhatsApp text, venue names and distances', () => {
  it('#5 an emoji or WhatsApp markup glued to the city word never makes «قريب من الرياض» the whole city', async () => {
    for (const mention of ['ابي بيت قريب من الرياض🙏', 'ابي بيت قريب من *الرياض*', 'ابي بيت قريب من الرياض 🙏']) {
      const r = await one(mention, [a('city', 'الرياض')]);
      expect(r.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'proximity_to_city' });
      expect(allIds(r.res.compiled)).not.toContain('city-riyadh');
    }
    // The 3000 m is not in the customer's words: asked, never a radius (P10 —
    // design 2026-10-04 §5.4). The sibling below says «٣ كيلو» and resolves.
    const s = await one('ابي بيت قريب من *الرياض* بارك 🙏', [a('city', 'الرياض', { distance_m: 3000 })]);
    expect(s.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'distance_unverified' });
    expect(allIds(s.res.compiled)).not.toContain('city-riyadh');
    expectUnresolved(s);
    const t = await one('ابي بيت قريب من *الرياض* بارك ٣ كيلو 🙏', [a('city', 'الرياض', { distance_m: 3000 })]);
    expect(conds(t.items)).toEqual([{ rule: 'within_distance', element_id: 'RUH-MALL-PARK', distance_m: 3000 }]);
  });

  it('#9 the venue name stops before the stated distance: «قريب من الرياض بارك ٣ كيلو» → Riyadh Park, 3 km', async () => {
    const r = await one('ابي قريب من الرياض بارك ٣ كيلو', [a('city', 'الرياض', { distance_m: 3000 })]);
    expect(conds(r.items)).toEqual([{ rule: 'within_distance', element_id: 'RUH-MALL-PARK', distance_m: 3000 }]);
  });

  it('#8 «في الرياض فيلا خلال 3 كيلو من الرياض بارك» → measured FROM the second «الرياض»: Riyadh Park, 3 km', async () => {
    const r = await one('ابي في الرياض فيلا خلال 3 كيلو من الرياض بارك', [a('city', 'الرياض', { distance_m: 3000 })]);
    expect(conds(r.items)).toEqual([{ rule: 'within_distance', element_id: 'RUH-MALL-PARK', distance_m: 3000 }]);
  });

  it('#10 the city\'s distance moves onto the venue it duplicates: «خلال 3 كيلو من الرياض بارك» → 3 km, not missing_radius', async () => {
    const r = await one('خلال 3 كيلو من الرياض بارك', [a('city', 'الرياض', { distance_m: 3000 }), a('landmark', 'الرياض بارك')]);
    expect(r.res.resolutions.map((x) => x.status)).toEqual(['resolved']);
    expect(conds(r.items)).toEqual([{ rule: 'within_distance', element_id: 'RUH-MALL-PARK', distance_m: 3000 }]);
  });
});

describe('round 3 — the named scope city', () => {
  it('#7 two named cities: the road could be in either → asked, never the first city\'s road', async () => {
    const r = await one('في الدمام او الخبر قريب من طريق الملك فهد بحدود 2 كيلو', [
      a('city', 'الدمام'), a('city', 'الخبر'), a('road', 'طريق الملك فهد', { distance_m: 2000 }),
    ]);
    expect(r.res.resolutions[2]).toMatchObject({ status: 'needs_confirm', reason: 'ambiguous_entity' });
    expect(allIds(r.res.compiled)).not.toContain('KHB-ROAD-KFR');
    expect(allIds(r.res.compiled)).not.toContain('RUH-ROAD-KFR');
    expectUnresolved(r);
  });

  it('#12 «الروضة شمال طريق الملك عبدالله بجدة» → JEDDAH\'s الروضة and Jeddah\'s road; never Riyadh\'s (the unmeasured road asks)', async () => {
    const r = await one('الروضة شمال طريق الملك عبدالله بجدة', [a('district', 'الروضة'), a('direction', 'شمال طريق الملك عبدالله'), a('city', 'جدة')]);
    // Both picks are in the city the customer NAMED…
    expect(r.res.resolutions[0]).toMatchObject({ status: 'resolved', recipe: { operation: 'district_polygon', resolved_element_ids: ['d-rawdah-jed'] } });
    expect(r.res.resolutions[1]).toMatchObject({ facts: { element_city: 'Jeddah' } });
    // …but the fixture has no MEASURED run for Jeddah's King Abdullah Road
    // (fakeGeoMap.ts), and the clip's local axis check (M2) asks on an unknown road.
    expect(r.res.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'road_geometry_missing' });
    expect(allIds(r.res.compiled)).not.toContain('d-rawdah-ruh');
    expectUnresolved(r);
    // The same shape on a MEASURED road: the named city's district, clipped.
    const m = await one('الروضة شمال طريق الملك عبدالله بالرياض', [a('district', 'الروضة'), a('direction', 'شمال طريق الملك عبدالله'), a('city', 'الرياض')]);
    expect(resolvedRecipes(m.res.compiled).map((x) => [x.operation, x.side, x.resolved_element_ids])).toEqual([
      ['district_side_clip', 'north', ['d-rawdah-ruh', 'RUH-ROAD-KAR']],
    ]);
    expect(allIds(m.res.compiled)).not.toContain('d-rawdah-jed');
    // A district the named city does not have → asked, never the established city's namesake.
    const s = await one('الملقا شمال طريق الملك عبدالله بجدة', [a('district', 'الملقا'), a('direction', 'شمال طريق الملك عبدالله'), a('city', 'جدة')]);
    expect(s.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'outside_admin' });
    expect(allIds(s.res.compiled)).not.toContain('d-malqa');
    expectUnresolved(s);
  });

  it('#11 a road side scoped to ANOTHER city is never spread onto a district mention of the established city', async () => {
    const res = await run([
      ev('e1', 'العليا', [a('district', 'العليا')]),
      ev('e2', 'او شمال طريق الملك فهد بالخبر', [a('direction', 'شمال طريق الملك فهد'), a('city', 'الخبر')]),
    ]);
    // Riyadh's العليا stays itself — never clipped by Khobar's road.
    expect(resolvedRecipes(res.compiled).map((x) => [x.operation, x.resolved_element_ids])).toEqual([
      ['district_polygon', ['d-olaya']],
    ]);
    expect(ops(res.compiled)).not.toContain('district_side_clip');
    // The band's lookup picked KHOBAR's road; its run was never measured
    // (fakeGeoMap.ts), so the standalone side asks (I4) instead of drawing.
    expect(res.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'road_geometry_missing', facts: { element_city: 'Khobar' } });
    // «او شمال طريق الملك فهد بالرياض»: an «او» mention is never spread onto the
    // other mentions (V8), and north of King Fahd Road means nothing (I4).
    const same = await run([
      ev('e1', 'العليا', [a('district', 'العليا')]),
      ev('e2', 'او شمال طريق الملك فهد بالرياض', [a('direction', 'شمال طريق الملك فهد'), a('city', 'الرياض')]),
    ]);
    expect(resolvedRecipes(same.compiled).map((x) => [x.operation, x.resolved_element_ids])).toEqual([
      ['district_polygon', ['d-olaya']],
    ]);
    expect(same.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'side_not_along_road' });
    // A road side of the ESTABLISHED city that runs along its road is still
    // distributed (the operator rule, 2026-09-15): west of King Fahd Road inside العليا.
    const west = await run([
      ev('e1', 'العليا', [a('district', 'العليا')]),
      ev('e2', 'غرب طريق الملك فهد بالرياض', [a('direction', 'غرب طريق الملك فهد'), a('city', 'الرياض')]),
    ]);
    expect(resolvedRecipes(west.compiled).map((x) => [x.operation, x.side, x.resolved_element_ids])).toEqual([
      ['district_side_clip', 'west', ['d-olaya', 'RUH-ROAD-KFR']],
    ]);
  });

  it('#25 «النرجس بمنطقة الرياض غرب الملك فهد» → the region is neither a scope nor a district — and a region beside another place asks (C1)', async () => {
    const r = await one('النرجس بمنطقة الرياض غرب الملك فهد', [a('district', 'النرجس'), a('region', 'منطقة الرياض'), a('direction', 'غرب الملك فهد')]);
    // Design 2026-10-04 §5.3 row 6 / §8 accepted asks: any region beside another
    // place is held as a stub (C1) — the same finding #25 as the test above.
    expect(allIds(r.res.compiled)).not.toContain('region-riyadh');
    expect(r.res.ambiguity).toContain('unresolved_reference');
    expectUnresolved(r);
  });
});

describe('round 3 — a diagonal or «وسط» road side asks; nothing saves a both-sides strip (#13, #16, #20)', () => {
  it('«شمال شرق طريق الملك فهد», «شمال شرق سلمان», «وسط الملك فهد» → needs_confirm, no items', async () => {
    for (const span of ['شمال شرق طريق الملك فهد', 'شمال شرق سلمان', 'وسط الملك فهد']) {
      const r = await one(`ابي ${span}`, [a('direction', span)]);
      expect(r.res.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'side_of_road_not_cardinal' });
      expectUnresolved(r);
    }
    const s = await one('النرجس شمال شرق طريق الملك فهد', [a('district', 'النرجس'), a('direction', 'شمال شرق طريق الملك فهد')]);
    expectUnresolved(s);
  });
});

describe('round 3 #24 — a district AND a distance rule in one mention is asked, never a hidden clause', () => {
  it('«النرجس قريب من الرياض بارك خلال 2 كيلو» → unresolved (no `geo:<id>:admin` clause); the other mention saves alone', async () => {
    const res = await run([
      ev('e1', 'النرجس قريب من الرياض بارك خلال 2 كيلو', [a('district', 'النرجس'), a('landmark', 'الرياض بارك', { distance_m: 2000 })]),
      ev('e2', 'او الملقا', [a('district', 'الملقا')]),
    ]);
    const ids = res.compiled.groups.flatMap((g) => g.clauses.flatMap((c) => c.anyOf.map((x) => x.geometry_id)));
    expect(ids.some((id) => id.includes(':admin'))).toBe(false);
    expect(res.ambiguity).toContain('unresolved_reference');
    const items = geoPreferenceToLocationItems(res.compiled);
    expect(items.map((i) => (i.kind === 'district' ? i.district_id : i.kind))).toEqual(['d-malqa']);
  });

  it('a LEGACY proposal with a `geo:<id>:admin` clause: unticking the mention removes it too', () => {
    const recipe = (id: string): GeometryRecipe => ({
      operation: 'district_polygon', source_anchors: [], resolved_element_ids: [id],
      geo_data_version: 'v', resolver_version: 'r', compiled_at: '',
    });
    const legacy: GeoPreference = {
      schema_version: 'geo-pref/v7',
      groups: [
        { id: 'g1', role: 'primary', strength: 'soft', priority: 1, clauses: [
          { op: 'include', anyOf: [{ geometry_id: 'geo:e1', recipe: { ...recipe('RUH-MALL-PARK'), operation: 'within_distance', radius_or_band_m: 2000 } }] },
          { op: 'include', anyOf: [{ geometry_id: 'geo:e1:admin', recipe: recipe('d-narjis') }] },
        ] },
        { id: 'g2', role: 'alternative', strength: 'soft', priority: 2, clauses: [{ op: 'include', anyOf: [{ geometry_id: 'geo:e2', recipe: recipe('d-malqa') }] }] },
      ],
    };
    const items = geoPreferenceToLocationItems(pruneGeoExpression(legacy, ['e1']));
    expect(items.map((i) => (i.kind === 'district' ? i.district_id : i.kind))).toEqual(['d-malqa']);
  });
});
