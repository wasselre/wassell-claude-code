import { describe, it, expect } from 'vitest';
import { runReviewFirst, type RunContext, type OrchestratorPorts, type ProposalRecord, type ReviewFirstResult, type MergeTrace } from '../orchestrator.js';
import {
  roadKey, placeKey, type ResolverDb, type DistrictCandidate, type CityCandidate, type ElementCandidate, type RegionCandidate,
  type ResolutionContext,
} from '../resolver.js';
import {
  ALL_CHECKS, AXIS_EW_SIDE_MAX_EW_SHARE, AXIS_NS_SIDE_MIN_EW_SHARE, axisVerdict, checkMerged, conversationCityCheck,
  type CheckName,
} from '../invariants.js';
import { prepareEvidence } from '../anchorPrep.js';
import { createGeoObserver, type GeoEvent } from '../observability.js';
import type { SatUniverse } from '../satisfiability.js';
import type { GateConfig } from '../gate.js';
import type { AnchorToken, CardinalSide, Evidence, GeometryRecipe, GeoPreference, ResolutionResult } from '../ontology.js';
import {
  fakeCityLabel, fakeNamesInText, fakeRoadAxis, MEASURED_LOCAL_AXIS, MEASURED_ROAD_AXIS, type FakeRoad, type AxisTravel,
} from './fakeGeoMap.js';

/**
 * The demote-only checks (design 2026-10-04 §2.5, tests §6.4): I4 / M2 (a side
 * must run along its road — the MEASURED road runs), I5 (an element in its
 * scope city), I8 (a place word that is part of a longer name), I9 (another
 * city named elsewhere), M1 (a clip's districts in the road's city), the merge
 * holds C1 / V8, the merge-check fixpoint, the map ports throwing, and the
 * MONOTONICITY property: switching any set of checks off can only grow the set
 * of resolved mentions — a check never picks another place.
 */

// ── The fake map ─────────────────────────────────────────────────────────────

function district(id: string, name_ar: string, city: [string, string] = ['الرياض', 'Riyadh'], aliases: string[] = []): DistrictCandidate {
  return {
    id, name_ar, name_en: '', aliases, city_id: `city-${city[1].toLowerCase()}`, city_name_ar: city[0], city_name_en: city[1],
    region_name_ar: '', region_name_en: '', country_code: 'SA', centroid_lat: 24.8, centroid_lng: 46.6,
  };
}
const JEDDAH: [string, string] = ['جدة', 'Jeddah'];
const DISTRICTS: DistrictCandidate[] = [
  district('d-narjis', 'حي النرجس'),
  district('d-malqa', 'حي الملقا'),
  district('d-olaya', 'حي العليا'),
  district('d-rawdah-ruh', 'حي الروضة'),
  district('d-rawdah-jed', 'حي الروضة', JEDDAH),
  // A district that exists ONLY in Jeddah: a Riyadh client naming it gets Jeddah's (M1's case).
  district('d-hamra-jed', 'حي الحمراء', JEDDAH),
  district('d-king-salman', 'حي الملك سلمان', ['الرياض', 'Riyadh'], ['سلمان']),
];

function city(id: string, name_ar: string, name_en: string, region_name_ar: string): CityCandidate {
  return { id, name_ar, name_en, aliases: [], region_name_ar, region_name_en: '', country_code: 'SA', centroid_lat: 24.7, centroid_lng: 46.7 };
}
const CITIES: CityCandidate[] = [
  city('city-riyadh', 'الرياض', 'Riyadh', 'منطقة الرياض'),
  city('city-jeddah', 'جدة', 'Jeddah', 'منطقة مكة المكرمة'),
  city('city-dammam', 'الدمام', 'Dammam', 'المنطقة الشرقية'),
  city('city-khobar', 'الخبر', 'Khobar', 'المنطقة الشرقية'),
  city('city-makkah', 'مكة المكرمة', 'Makkah', 'منطقة مكة المكرمة'),
];
const REGIONS: RegionCandidate[] = [
  { id: 'region-riyadh', name_ar: 'منطقة الرياض', name_en: 'Riyadh Region', aliases: [], country_code: 'SA' },
  { id: 'region-east', name_ar: 'المنطقة الشرقية', name_en: 'Eastern Province', aliases: [], country_code: 'SA' },
  { id: 'region-qassim', name_ar: 'منطقة القصيم', name_en: 'Qassim Region', aliases: ['القصيم'], country_code: 'SA' },
];

function element(external_id: string, name_ar: string, geom_kind: ElementCandidate['geom_kind'], extra: Partial<ElementCandidate> = {}): ElementCandidate {
  return {
    external_id, name_ar, name_en: '', aliases: [], geom_kind, category: null, type: null, city: 'Riyadh',
    country_code: 'SA', lat: 24.75, lng: 46.65, confidence_score: 0.9, review_status: 'approved', is_active: true, ...extra,
  };
}
const ELEMENTS: ElementCandidate[] = [
  element('RUH-ROAD-0694', 'طريق الملك فهد', 'linestring'),
  element('RUH-ROAD-0681', 'طريق الملك سلمان', 'linestring'),
  element('RUH-RING-0853', 'الدائري الشمالي', 'linestring'),
  element('RUH-ROAD-0727', 'طريق الدمام', 'linestring'),
  element('RUH-ROAD-0690', 'طريق الملك عبدالله', 'linestring'),
  element('RUH-ROAD-0695', 'طريق مكة', 'linestring'),
  element('RUH-ROAD-0684', 'شارع العليا', 'linestring'),
  element('KHB-ROAD-KFR', 'طريق الملك فهد', 'linestring', { city: 'Khobar' }),
  element('JED-ROAD-KAR', 'طريق الملك عبدالله', 'linestring', { city: 'Jeddah' }),
  element('RUH-MALL-0038', 'الرياض بارك', 'polygon', { lat: 24.756, lng: 46.629 }),
  element('RUH-MALL-NAKHEEL', 'النخيل مول', 'polygon', { lat: 24.77, lng: 46.71 }),
  element('RUH-PARK-KAP', 'حديقة الملك عبدالله', 'polygon', { lat: 24.66, lng: 46.74 }),
  // One Othaim mall drawn twice 145 m apart, and a far branch whose name only STARTS with «العثيم مول».
  element('RUH-MALL-OTH-P', 'العثيم مول', 'point', { lat: 24.7, lng: 46.7 }),
  element('RUH-MALL-OTH', 'العثيم مول', 'polygon', { lat: 24.7013, lng: 46.7 }),
  element('RUH-MALL-OTH-RAB', 'العثيم مول الربوة', 'polygon', { lat: 24.68, lng: 46.78 }),
  // A catalogued name that is a district word plus a filler («حي») — never "another place" (I8).
  element('RUH-MARK-NARJIS', 'حي النرجس', 'point'),
];

const ROAD_AXIS: Record<string, FakeRoad> = {
  'RUH-ROAD-0694': {
    road: MEASURED_ROAD_AXIS.kingFahd,
    byDistricts: { 'd-malqa': MEASURED_LOCAL_AXIS.kingFahdInMalqa, 'd-olaya': MEASURED_LOCAL_AXIS.kingFahdInOlaya, 'd-narjis': MEASURED_LOCAL_AXIS.kingFahdAroundNarjis },
  },
  'RUH-ROAD-0681': {
    road: MEASURED_ROAD_AXIS.kingSalman,
    byDistricts: { 'd-narjis': MEASURED_LOCAL_AXIS.kingSalmanInNarjis, 'd-malqa': MEASURED_LOCAL_AXIS.kingSalmanInMalqa },
  },
  'RUH-RING-0853': { road: MEASURED_ROAD_AXIS.northernRing, byDistricts: { 'd-narjis': MEASURED_LOCAL_AXIS.northernRingAroundNarjis } },
  'RUH-ROAD-0727': { road: MEASURED_ROAD_AXIS.dammam0727 },
  'RUH-ROAD-0690': { road: MEASURED_ROAD_AXIS.kingAbdullah },
  'RUH-ROAD-0695': { road: MEASURED_ROAD_AXIS.makkah0695 },
  'RUH-ROAD-0684': { road: MEASURED_ROAD_AXIS.olayaStreet },
  // KHB-ROAD-KFR and JED-ROAD-KAR were never measured: found:false.
};

const ZONES: Record<string, Record<string, string[]>> = {
  [placeKey('الرياض')]: { north: ['d-narjis', 'd-yasmin', 'd-arid'], south: ['d-shifa'], east: ['d-east-1'], west: ['d-west-1'] },
  [placeKey('جدة')]: { north: ['jed-n1', 'jed-n2'], east: ['jed-e1'] },
};

const k = (s: string) => placeKey(s);
const cityEn = (ar: string | undefined): string | null =>
  ar ? (CITIES.find((c) => k(c.name_ar) === k(ar))?.name_en ?? CITIES.find((c) => c.name_en.toLowerCase() === ar.toLowerCase())?.name_en ?? ar) : null;
const loose = (a: string, b: string): boolean => !!a && !!b && (a.includes(b) || b.includes(a));

function fakeDb(over: Partial<ResolverDb> = {}): ResolverDb {
  return {
    async findDistricts(token) { return DISTRICTS.filter((d) => [d.name_ar, ...d.aliases].some((n) => loose(k(n), k(token)))); },
    async findCities(token) {
      return CITIES.filter((c) => loose(k(c.name_ar), k(token)) || loose(c.name_en.toLowerCase(), token.trim().toLowerCase()));
    },
    async findRegions(token) { return REGIONS.filter((r) => [r.name_ar, ...r.aliases].some((n) => loose(k(n), k(token)))); },
    async findElements(token, opts) {
      const inCity = cityEn(opts.city);
      return ELEMENTS
        .filter((e) => !inCity || e.city === inCity)
        .filter((e) => [e.name_ar, ...e.aliases].some((n) => loose(roadKey(n), roadKey(token))));
    },
    async zoneDistricts(c, zone) { return (ZONES[k(c)]?.[zone] ?? []).map((district_id) => ({ district_id, district_name: district_id })); },
    async districtForPoint() { return null; },
    roadAxis: fakeRoadAxis(ROAD_AXIS),
    cityLabel: fakeCityLabel(CITIES),
    namesInText: fakeNamesInText(ELEMENTS),
    ...over,
  };
}

const universe: SatUniverse = { universe: ['c1'], cellsOf: () => ['c1'], inventoryIn: () => 5 };
const config: GateConfig = {
  auto_write_enabled: false, t_lexical_margin: 0.9, t_geo_margin: 0.9, t_source_quality: 0.9,
  min_action_assurance: { write_soft: 0.9, write_hard: 0.98, supersede: 0.99 },
};
function ctx(db: ResolverDb = fakeDb(), over: Partial<RunContext> = {}): RunContext {
  return {
    client_id: 'client-1', checkpoint_id: 'cp-1', maximum_safe_action: 'propose',
    resolution: { db, preferCountry: 'SA', established_city: 'الرياض', universe_hint: 'organizational_default' },
    universe, config, ...over,
  };
}
const ports: OrchestratorPorts = {
  proposals: { async createProposal(input) { return { ...input, id: 'prop-1', status: 'pending' } as ProposalRecord; } },
};

const a = (anchor_type: AnchorToken['anchor_type'], span: string, extra: Partial<AnchorToken> = {}): AnchorToken =>
  ({ anchor_type, span, normalized_token: span, ...extra });

function ev(id: string, mention_span: string, anchors: AnchorToken[], role: Evidence['preference_role'] = 'positive'): Evidence {
  return {
    id, mention_span, anchors,
    speaker: 'client', preference_holder: 'client', holder_role: 'buyer', quoted_speaker: 'none',
    dialogue_act: 'statement', conditionality: 'asserted', temporal_reference: 'present',
    preference_applicability: 'active', preference_role: role, commitment: 'preferred',
    hardness_evidence: 'none', modality: 'explicit',
    source: { channel: 'chat', ref: 'm1', timestamp: '2026-10-01T00:00:00Z' },
  };
}

const refs = (pref: GeoPreference) => pref.groups.flatMap((g) => g.clauses.flatMap((c) => c.anyOf.map((r) => ({ op: c.op, ...r }))));
const resolvedRecipes = (pref: GeoPreference): GeometryRecipe[] => refs(pref).map((r) => r.recipe).filter((r) => r.geo_data_version !== 'stub');
const shape = (pref: GeoPreference) => resolvedRecipes(pref).map((r) => [r.operation, r.side ?? null, r.resolved_element_ids]);

async function run(evidence: Evidence[], db?: ResolverDb, over: Partial<RunContext> = {}): Promise<ReviewFirstResult> {
  return runReviewFirst(evidence, [], ctx(db, over), ports);
}
async function one(span: string, anchors: AnchorToken[], db?: ResolverDb, over: Partial<RunContext> = {}): Promise<ReviewFirstResult> {
  return run([ev('e1', span, anchors)], db, over);
}

// ─────────────────────────────────────────────────────────────────────────────
// I4 / M2 — the road axis, on the MEASURED fixtures (design §6.4 table).
// ─────────────────────────────────────────────────────────────────────────────

describe('axisVerdict — a side must run along its road (measured shares)', () => {
  const rows: Array<[string, AxisTravel, CardinalSide, ReturnType<typeof axisVerdict>]> = [
    ['KFR north (0.341)', MEASURED_ROAD_AXIS.kingFahd, 'north', 'side_not_along_road'],
    ['KFR west (0.341)', MEASURED_ROAD_AXIS.kingFahd, 'west', 'ok'],
    ['KSR north, whole road (0.507)', MEASURED_ROAD_AXIS.kingSalman, 'north', 'ok'],
    ['Narjis on KSR, local north (0.684)', MEASURED_LOCAL_AXIS.kingSalmanInNarjis, 'north', 'ok'],
    ['Narjis on KSR, local west (0.684)', MEASURED_LOCAL_AXIS.kingSalmanInNarjis, 'west', 'side_not_along_road'],
    ['Malqa on KFR, local north (0.316)', MEASURED_LOCAL_AXIS.kingFahdInMalqa, 'north', 'side_not_along_road'],
    ['Northern Ring south (0.660)', MEASURED_ROAD_AXIS.northernRing, 'south', 'ok'],
    ['Northern Ring east (0.660)', MEASURED_ROAD_AXIS.northernRing, 'east', 'side_not_along_road'],
    ['Dammam Rd east (0.628)', MEASURED_ROAD_AXIS.dammam0727, 'east', 'side_not_along_road'],
  ];
  for (const [name, ax, side, want] of rows) {
    it(`${name} → ${want}`, () => {
      expect(axisVerdict({ found: true, scope: 'road', ...ax }, side)).toBe(want);
    });
  }
  it('found:false → road_geometry_missing (asks, never passes); a road with no travel too', () => {
    expect(axisVerdict({ found: false }, 'north')).toBe('road_geometry_missing');
    expect(axisVerdict({ found: true, scope: 'road', ew_m: 0, ns_m: 0 }, 'west')).toBe('road_geometry_missing');
    expect(axisVerdict({ found: true, scope: 'road' }, 'west')).toBe('road_geometry_missing');
  });
  it('the thresholds are the design numbers', () => {
    expect(AXIS_NS_SIDE_MIN_EW_SHARE).toBe(0.40);
    expect(AXIS_EW_SIDE_MAX_EW_SHARE).toBe(0.60);
  });
});

describe('I4 — a standalone road side (through runReviewFirst)', () => {
  it('pass: «غرب الملك فهد» → the band (KFR runs north–south)', async () => {
    const r = await one('ابي فيلا غرب الملك فهد', [a('direction', 'غرب الملك فهد')]);
    expect(shape(r.compiled)).toEqual([['directional_band', 'west', ['RUH-ROAD-0694']]]);
    expect(r.trace).toEqual([expect.objectContaining({ kind: 'band', road: 'RUH-ROAD-0694', side: 'west', band_index: 0 })]);
  });
  it('demote: «شمال الملك فهد» → side_not_along_road, nothing drawn', async () => {
    const r = await one('ابي فيلا شمال الملك فهد', [a('direction', 'شمال الملك فهد')]);
    expect(r.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'side_not_along_road' });
    expect(resolvedRecipes(r.compiled)).toEqual([]);
    expect(r.ambiguity).toContain('unresolved_reference');
  });
  it('pass: «جنوب الدائري الشمالي»; demote: «شرق الدائري الشمالي»', async () => {
    const s = await one('ابي جنوب الدائري الشمالي', [a('direction', 'جنوب الدائري الشمالي')]);
    expect(shape(s.compiled)).toEqual([['directional_band', 'south', ['RUH-RING-0853']]]);
    const e = await one('ابي شرق الدائري الشمالي', [a('direction', 'شرق الدائري الشمالي')]);
    expect(e.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'side_not_along_road' });
  });
  it('an unmeasured road (found:false) asks road_geometry_missing — never passes', async () => {
    const r = await one('بالخبر غرب طريق الملك فهد', [a('city', 'الخبر'), a('direction', 'غرب طريق الملك فهد')]);
    expect(r.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'road_geometry_missing', facts: { element_city: 'Khobar' } });
    expect(resolvedRecipes(r.compiled)).toEqual([]);
  });
  it('an EXCLUDE band is checked too («مو شمال طريق الملك فهد»)', async () => {
    const r = await run([ev('e1', 'مو شمال طريق الملك فهد', [a('direction', 'شمال طريق الملك فهد')], 'negative')]);
    expect(r.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'side_not_along_road' });
  });
});

describe('M2 — a clip: the road must run the right way INSIDE the districts', () => {
  it('pass: «النرجس شمال طريق الملك سلمان» (local 0.684)', async () => {
    const r = await one('ابي بالنرجس شمال طريق الملك سلمان', [a('district', 'النرجس'), a('direction', 'شمال طريق الملك سلمان')]);
    expect(shape(r.compiled)).toEqual([['district_side_clip', 'north', ['d-narjis', 'RUH-ROAD-0681']]]);
    expect(r.trace).toEqual([expect.objectContaining({ kind: 'clip', band_index: 1, admin_indices: [0], district_ids: ['d-narjis'] })]);
  });
  it('demote: «النرجس غرب طريق الملك سلمان» — KSR runs east–west inside Narjis (0.684)', async () => {
    const r = await one('ابي بالنرجس غرب طريق الملك سلمان', [a('district', 'النرجس'), a('direction', 'غرب طريق الملك سلمان')]);
    expect(r.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'side_not_along_road' });
    expect(r.resolutions[0]!.status).toBe('resolved'); // the district itself is never demoted
    expect(resolvedRecipes(r.compiled)).toEqual([]);
  });
  it('demote: «الملقا شمال طريق الملك فهد» — KFR runs north–south inside Malqa (0.316)', async () => {
    const r = await one('الملقا شمال طريق الملك فهد', [a('district', 'الملقا'), a('direction', 'شمال طريق الملك فهد')]);
    expect(r.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'side_not_along_road' });
  });
});

describe('M1 — a clip: the districts are in the road\'s city', () => {
  it('pass: Riyadh\'s Narjis on Riyadh\'s road (above); demote: Jeddah-only «الحمراء» on Riyadh\'s King Abdullah Road', async () => {
    const r = await one('الحمراء شمال طريق الملك عبدالله', [a('district', 'الحمراء'), a('direction', 'شمال طريق الملك عبدالله')]);
    expect(r.resolutions[0]).toMatchObject({ status: 'resolved', facts: { district_city_en: { 'd-hamra-jed': 'Jeddah' } } });
    expect(r.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'clip_mixed_cities' });
    expect(resolvedRecipes(r.compiled)).toEqual([]);
  });

  it('checkMerged: unknown cities ask (clip_city_unverified); same city passes', async () => {
    const band = (facts: ResolutionResult['facts']): ResolutionResult => ({ status: 'resolved', facts, recipe: { operation: 'directional_band', source_anchors: [], resolved_element_ids: ['RUH-ROAD-0681'], side: 'north', geo_data_version: 'x', resolver_version: 'x', compiled_at: '' } });
    const dist = (id: string, cityEn?: string): ResolutionResult => ({ status: 'resolved', facts: cityEn ? { district_city_en: { [id]: cityEn } } : {}, recipe: { operation: 'district_polygon', source_anchors: [], resolved_element_ids: [id], geo_data_version: 'x', resolver_version: 'x', compiled_at: '' } });
    const zone = (zone_city?: string): ResolutionResult => ({ status: 'resolved', facts: zone_city ? { zone_city } : {}, recipe: { operation: 'zone_union', source_anchors: [], resolved_element_ids: ['d-narjis'], geo_data_version: 'x', resolver_version: 'x', compiled_at: '' } });
    const t = (kind: MergeTrace['kind'], admin: number[], ids: string[]): MergeTrace => ({
      evidence_id: 'e1', kind, band_index: 1, admin_indices: admin, road: 'RUH-ROAD-0681', side: 'north', district_ids: ids,
      ...(kind === 'distributed_clip' ? { distribute_key: 'RUH-ROAD-0681|north' } : {}),
    });
    const db = fakeDb();
    // Same city → passes M1 and M2 (local 0.684).
    expect(await checkMerged([t('clip', [0], ['d-narjis'])], [dist('d-narjis', 'Riyadh'), band({ element_city: 'Riyadh' })], db))
      .toEqual({ demote: [], noDistribute: [] });
    // A zone of the road's city passes; a zone whose city is unknown asks.
    expect((await checkMerged([t('clip', [0], ['d-narjis'])], [zone('الرياض'), band({ element_city: 'Riyadh' })], db)).demote).toEqual([]);
    expect((await checkMerged([t('clip', [0], ['d-narjis'])], [zone(), band({ element_city: 'Riyadh' })], db)).demote)
      .toEqual([{ index: 1, rule: 'clip_city', reason: 'clip_city_unverified' }]);
    // A district with no city fact, or a road with no city: unverified.
    expect((await checkMerged([t('clip', [0], ['d-narjis'])], [dist('d-narjis'), band({ element_city: 'Riyadh' })], db)).demote[0]?.reason).toBe('clip_city_unverified');
    expect((await checkMerged([t('clip', [0], ['d-narjis'])], [dist('d-narjis', 'Riyadh'), band({ element_city: null })], db)).demote[0]?.reason).toBe('clip_city_unverified');
    // A DISTRIBUTED clip is never demoted: its key is returned instead.
    expect(await checkMerged([t('distributed_clip', [0], ['d-hamra-jed'])], [dist('d-hamra-jed', 'Jeddah'), band({ element_city: 'Riyadh' })], db))
      .toEqual({ demote: [], noDistribute: [{ key: 'RUH-ROAD-0681|north', rule: 'clip_city', reason: 'clip_mixed_cities', band_index: 1 }] });
  });
});

describe('I5 — an element in the city its lookup was scoped to', () => {
  // A leaky search (ignores the city filter) can hand back another city's road.
  const leaky = fakeDb({
    async findElements(token) {
      return ELEMENTS.filter((e) => e.external_id === 'KHB-ROAD-KFR' && loose(roadKey(e.name_ar), roadKey(token)));
    },
  });
  it('pass: Riyadh\'s road for a Riyadh lookup', async () => {
    const r = await one('ابي غرب طريق الملك فهد', [a('direction', 'غرب طريق الملك فهد')]);
    expect(r.resolutions[0]).toMatchObject({ status: 'resolved', facts: { scope_city: 'الرياض', scope_source: 'established', element_city: 'Riyadh' } });
  });
  it('demote: a Khobar road picked for a Riyadh lookup → element_outside_scope_city', async () => {
    const r = await one('قريب من طريق الملك فهد خلال 2 كيلو', [a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 })], leaky);
    expect(r.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'element_outside_scope_city' });
    expect(resolvedRecipes(r.compiled)).toEqual([]);
  });
  it('a scope city the map does not know → scope_city_unknown; no scope at all → scope_city_missing', async () => {
    const unknownLabel = fakeDb({ async cityLabel() { return null; } });
    const r = await one('قريب من طريق الملك فهد خلال 2 كيلو', [a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 })], unknownLabel);
    expect(r.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'scope_city_unknown' });
    // No established city: the (unscoped) search finds ONE King Fahd Road, but
    // nothing says which city it was meant to be in.
    const oneRoad = fakeDb({ async findElements() { return ELEMENTS.filter((e) => e.external_id === 'RUH-ROAD-0694'); } });
    const noCity = await runReviewFirst(
      [ev('e1', 'قريب من طريق الملك فهد خلال 2 كيلو', [a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 })])],
      [], { ...ctx(), resolution: { db: oneRoad, preferCountry: 'SA' } }, ports,
    );
    expect(noCity.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'scope_city_missing' });
  });
});

describe('I8 — a place word that is only part of a longer catalogued name', () => {
  it('demote: «ابي حول الرياض بارك» read as [city الرياض] → place_is_part_of_name (also with «بالرياض بارك»)', async () => {
    for (const span of ['ابي حول الرياض بارك', 'ابي شقة بالرياض بارك']) {
      const r = await one(span, [a('city', 'الرياض')]);
      expect(r.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'place_is_part_of_name' });
      expect(resolvedRecipes(r.compiled)).toEqual([]);
    }
  });
  it('pass: one occurrence stands alone («في الرياض او حول الرياض بارك»)', async () => {
    const r = await one('ابي شقة في الرياض او حول الرياض بارك', [a('city', 'الرياض')]);
    expect(r.resolutions[0]!.status).toBe('resolved');
  });
  it('pass: a filler word around the place is not another place («حي النرجس» is catalogued)', async () => {
    const r = await one('ابي حي النرجس', [a('district', 'النرجس')]);
    expect(shape(r.compiled)).toEqual([['district_polygon', null, ['d-narjis']]]);
  });
  it('demote: the referent of a one-anchor direction («شمال الرياض» inside «شمال الرياض بارك»)', async () => {
    const r = await one('ابي شمال الرياض بارك', [a('direction', 'شمال الرياض')]);
    expect(r.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'place_is_part_of_name' });
  });
  it('the names lookup runs ONCE per run, and not at all when nothing could be part of a name', async () => {
    let calls = 0;
    const counting = fakeDb({ async namesInText(text) { calls += 1; return fakeNamesInText(ELEMENTS)(text); } });
    await run([ev('e1', 'ابي حول الرياض بارك', [a('city', 'الرياض')]), ev('e2', 'او الملقا', [a('district', 'الملقا')])], counting);
    expect(calls).toBe(1);
    calls = 0;
    // A bare direction's zone has no words that could be part of a name.
    await one('ابي في الشمال', [a('direction', 'الشمال')], counting);
    expect(calls).toBe(0);
  });

  it('an ELEMENT pick inside a longer catalogued name, or after «حي», is demoted (repair round 1)', async () => {
    const hosp = fakeDb({ namesInText: fakeNamesInText([...ELEMENTS, element('RUH-HOSP-KFH', 'مستشفى الملك فهد', 'point')]) });
    const near = (span: string): AnchorToken => a('road', span, { role_in_relation: 'proximity', distance_m: 2000 });
    const r1 = await one('ابي قريب من مستشفى الملك فهد خلال 2 كيلو', [near('الملك فهد')], hosp);
    expect(r1.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'place_is_part_of_name' });
    const r2 = await one('ابي قريب من حي الملك فهد خلال 2 كيلو', [near('الملك فهد')], hosp);
    expect(r2.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'place_is_district_name' });
    // The road's own name (and a same-named road elsewhere) around its words is not another place.
    const ok = await one('ابي قريب من طريق الملك فهد خلال 2 كيلو', [near('الملك فهد')], hosp);
    expect(ok.resolutions[0]).toMatchObject({ status: 'resolved', recipe: { operation: 'within_distance' } });
  });
});

describe('I9 — another city named elsewhere in the conversation', () => {
  const rctx = (): ResolutionContext => ({ db: fakeDb(), preferCountry: 'SA', established_city: 'الرياض' });
  const check = async (evidence: Evidence[]) => {
    const { evidence: prepped, prepared } = prepareEvidence(evidence);
    return conversationCityCheck(prepped, prepared, rctx());
  };
  it('a city other than the established one sets the flag; the bare direction then asks', async () => {
    expect(await check([ev('e1', 'ابي في جدة', [a('city', 'جدة')])])).toBe(true);
    const r = await run([ev('e1', 'ابي في جدة', [a('city', 'جدة')]), ev('e2', 'او بالشمال', [a('direction', 'الشمال')])]);
    expect(r.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'established_city_contradicted' });
    expect(shape(r.compiled)).toEqual([['district_union', null, ['city-jeddah']]]);
  });
  it('a SHORT city name that starts another city\'s record («مكة») sets the flag; a non-city word does not (repair round 1)', async () => {
    expect(await check([ev('e1', 'ابي في مكة', [a('city', 'مكة')])])).toBe(true);
    const r = await run([ev('e1', 'ابي في مكة', [a('city', 'مكة')]), ev('e2', 'او بالشمال', [a('direction', 'الشمال')])]);
    expect(r.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'established_city_contradicted' });
    expect(await check([ev('e1', 'ابي شمال الملقا', [a('direction', 'شمال الملقا')])])).toBe(false);
  });
  it('the established city named elsewhere does not', async () => {
    expect(await check([ev('e1', 'ابي في الرياض', [a('city', 'الرياض')])])).toBe(false);
    const r = await run([ev('e1', 'ابي في الرياض', [a('city', 'الرياض')]), ev('e2', 'او بالشمال', [a('direction', 'الشمال')])]);
    expect(r.resolutions[1]).toMatchObject({ status: 'resolved', recipe: { operation: 'zone_union' } });
  });
  it('a region containing the established city does not; another region does', async () => {
    expect(await check([ev('e1', 'في منطقة الرياض', [a('region', 'منطقة الرياض')])])).toBe(false);
    expect(await check([ev('e1', 'في المنطقة الشرقية', [a('region', 'المنطقة الشرقية')])])).toBe(true);
  });
  it('only active roles count (an exploratory mention of Jeddah does not); a name that is no city is ignored', async () => {
    expect(await check([ev('e1', 'كيف جدة؟', [a('city', 'جدة')], 'exploratory')])).toBe(false);
    expect(await check([ev('e1', 'ابي في الواحة', [a('city', 'الواحة')])])).toBe(false);
  });
  it('the established city no longer settles two namesake districts; one exact match stands', async () => {
    const r = await run([ev('e1', 'ابي في جدة', [a('city', 'جدة')]), ev('e2', 'او الروضة', [a('district', 'الروضة')])]);
    expect(r.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'established_city_contradicted' });
    const one_ = await run([ev('e1', 'ابي في جدة', [a('city', 'جدة')]), ev('e2', 'او النرجس', [a('district', 'النرجس')])]);
    expect(one_.resolutions[1]).toMatchObject({ status: 'resolved', recipe: { resolved_element_ids: ['d-narjis'] } });
    // Without another city named, the established city still decides («الروضة» alone → Riyadh's).
    const plain = await one('ابي الروضة', [a('district', 'الروضة')]);
    expect(plain.resolutions[0]).toMatchObject({ status: 'resolved', recipe: { resolved_element_ids: ['d-rawdah-ruh'] } });
  });
  it('an element lookup with no named scope asks too (never the established city\'s road)', async () => {
    const r = await run([ev('e1', 'ابي في جدة', [a('city', 'جدة')]), ev('e2', 'او غرب طريق الملك فهد', [a('direction', 'غرب طريق الملك فهد')])]);
    expect(r.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'established_city_contradicted' });
  });
});

describe('the merge holds (C1, V8) and C2', () => {
  it('C1: a region beside another place; two named cities beside a non-city place', async () => {
    const r = await one('النرجس بمنطقة الرياض', [a('district', 'النرجس'), a('region', 'منطقة الرياض')]);
    expect(r.resolutions.every((x) => x.status === 'resolved')).toBe(true);
    expect(resolvedRecipes(r.compiled)).toEqual([]);
    expect(r.ambiguity).toContain('unresolved_reference');
    const s = await one('النرجس بالرياض او جدة', [a('district', 'النرجس'), a('city', 'الرياض'), a('city', 'جدة')]);
    expect(resolvedRecipes(s.compiled)).toEqual([]);
    // Two cities alone are not held.
    const t = await one('الرياض او جدة', [a('city', 'الرياض'), a('city', 'جدة')]);
    expect(shape(t.compiled)).toEqual([['district_union', null, ['city-riyadh', 'city-jeddah']]]);
  });
  it('V8: «او» between a district and a road side is two places, never a clip', async () => {
    const r = await one('النرجس او شمال طريق الملك سلمان', [a('district', 'النرجس'), a('direction', 'شمال طريق الملك سلمان')]);
    expect(r.resolutions.every((x) => x.status === 'resolved')).toBe(true);
    expect(resolvedRecipes(r.compiled)).toEqual([]);
    // «و» is not «او».
    const s = await one('ابي النرجس وجنوب سلمان', [a('district', 'النرجس'), a('direction', 'وجنوب سلمان', { normalized_token: 'جنوب الملك سلمان' })]);
    expect(shape(s.compiled)).toEqual([['district_side_clip', 'south', ['d-narjis', 'RUH-ROAD-0681']]]);
  });
  it('C2: a city beside another place is its scope, never a second id', async () => {
    const r = await one('الروضة بجدة', [a('district', 'الروضة'), a('city', 'جدة')]);
    expect(shape(r.compiled)).toEqual([['district_union', null, ['d-rawdah-jed']]]);
  });
});

describe('U1 — a mention\'s districts are in the city its zone names', () => {
  it('demote: «الحمراء شمال الرياض» — the only الحمراء is Jeddah\'s, never drawn beside north Riyadh', async () => {
    const r = await one('الحمراء شمال الرياض', [a('district', 'الحمراء'), a('direction', 'شمال الرياض')]);
    expect(r.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'district_outside_named_city', facts: { district_city_en: { 'd-hamra-jed': 'Jeddah' } } });
    expect(r.resolutions[1]).toMatchObject({ status: 'resolved', facts: { zone_city: 'الرياض', scope_source: 'named' } });
    expect(resolvedRecipes(r.compiled)).toEqual([]);
  });
  it('«الروضة شمال جدة» with no city anchor — a Riyadh client never gets Riyadh\'s الروضة beside north Jeddah', async () => {
    const r = await one('الروضة شمال جدة', [a('district', 'الروضة'), a('direction', 'شمال جدة')]);
    // The mention names Jeddah (I9), so the established city may not settle the namesakes — and U1 would ask anyway.
    expect(r.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'established_city_contradicted' });
    expect(resolvedRecipes(r.compiled)).toEqual([]);
    const noI9 = await one('الروضة شمال جدة', [a('district', 'الروضة'), a('direction', 'شمال جدة')], undefined, {
      disabledChecks: new Set<CheckName>(['conversation_city']),
    });
    expect(noI9.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'district_outside_named_city' });
  });
  it('pass: a Jeddah client gets Jeddah\'s الروضة; a city anchor scopes it too', async () => {
    const jed = await one('الروضة شمال جدة', [a('district', 'الروضة'), a('direction', 'شمال جدة')], undefined, {
      resolution: { db: fakeDb(), preferCountry: 'SA', established_city: 'جدة', universe_hint: 'organizational_default' },
    });
    expect(shape(jed.compiled)).toEqual([['district_union', null, ['d-rawdah-jed', 'jed-n1', 'jed-n2']]]);
    const split = await one('الروضة شمال جدة', [a('district', 'الروضة'), a('direction', 'شمال'), a('city', 'جدة')]);
    expect(shape(split.compiled)).toEqual([['district_union', null, ['d-rawdah-jed', 'jed-n1', 'jed-n2']]]);
  });
  it('an ESTABLISHED zone is not a named city: «خزام … او في الشمال» keeps its union', async () => {
    const r = await one('النرجس او في الشمال', [a('district', 'النرجس'), a('direction', 'الشمال')]);
    expect(shape(r.compiled)).toEqual([['district_union', null, ['d-narjis', 'd-yasmin', 'd-arid']]]);
  });
  it('a zone whose city the map cannot name asks (union_city_unverified)', async () => {
    const db = fakeDb({ async cityLabel() { return null; } });
    const r = await one('الروضة شمال جدة', [a('district', 'الروضة'), a('direction', 'شمال'), a('city', 'جدة')], db);
    expect(r.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'union_city_unverified' });
  });
});

describe('the merge checks run to a FIXPOINT', () => {
  it('a distributed clip failing M2 leaves the band standalone; I4 then passes it («النرجس» + «غرب طريق الملك سلمان»)', async () => {
    const r = await run([ev('e1', 'النرجس', [a('district', 'النرجس')]), ev('e2', 'غرب طريق الملك سلمان', [a('direction', 'غرب طريق الملك سلمان')])]);
    expect(shape(r.compiled).sort()).toEqual([
      ['directional_band', 'west', ['RUH-ROAD-0681']],
      ['district_polygon', null, ['d-narjis']],
    ]);
    expect(r.trace.map((t) => t.kind)).toEqual(['band']);
    expect(r.resolved_evidence_ids.sort()).toEqual(['e1', 'e2']);
  });
  it('…and I4 then demotes it when the whole road fails too («الملقا» + «شمال طريق الملك فهد»)', async () => {
    const r = await run([ev('e1', 'الملقا', [a('district', 'الملقا')]), ev('e2', 'شمال طريق الملك فهد', [a('direction', 'شمال طريق الملك فهد')])]);
    expect(shape(r.compiled)).toEqual([['district_polygon', null, ['d-malqa']]]);
    expect(r.resolutions[1]).toMatchObject({ status: 'needs_confirm', reason: 'side_not_along_road' });
    expect(r.resolved_evidence_ids).toEqual(['e1']);
  });
  it('a distributed clip failing M1 keeps the band standalone («الحمراء» + «شمال طريق الملك عبدالله»)', async () => {
    const r = await run([ev('e1', 'الحمراء', [a('district', 'الحمراء')]), ev('e2', 'شمال طريق الملك عبدالله', [a('direction', 'شمال طريق الملك عبدالله')])]);
    expect(shape(r.compiled).sort()).toEqual([
      ['directional_band', 'north', ['RUH-ROAD-0690']],
      ['district_polygon', null, ['d-hamra-jed']],
    ]);
  });
  it('a valid distribution stays («العليا» + «غرب طريق الملك فهد»): the trace names the distributed clip', async () => {
    const r = await run([ev('e1', 'العليا', [a('district', 'العليا')]), ev('e2', 'غرب طريق الملك فهد', [a('direction', 'غرب طريق الملك فهد')])]);
    expect(shape(r.compiled)).toEqual([['district_side_clip', 'west', ['d-olaya', 'RUH-ROAD-0694']]]);
    expect(r.trace).toEqual([expect.objectContaining({
      kind: 'distributed_clip', evidence_id: 'e1', band_index: 1, admin_indices: [0], district_ids: ['d-olaya'], distribute_key: 'RUH-ROAD-0694|west',
    })]);
    expect(r.resolved_evidence_ids.sort()).toEqual(['e1', 'e2']);
  });
  it('a road side said elsewhere is never distributed onto a CITY ZONE (legacy-diff blocker 34eebb5d: «شمال» + «جنوب سلمان»)', async () => {
    const r = await run([ev('e1', 'شمال', [a('direction', 'شمال')]), ev('e2', 'جنوب طريق الملك سلمان', [a('direction', 'جنوب طريق الملك سلمان')])]);
    expect(r.trace.some((t) => t.kind === 'distributed_clip')).toBe(false);
    expect(shape(r.compiled).map((s) => s[0]).sort()).toEqual(['directional_band', 'zone_union']);
  });
  it('no distribution when the customer\'s turn offers alternatives («النرجس او شمال طريق الملك سلمان» as two mentions)', async () => {
    const text = 'ابي النرجس او شمال طريق الملك سلمان';
    const conversation = { channel: 'chat' as const, id: 'c1', turns: [{ speaker: 'client' as const, text, ref: 'm1' }] };
    const r = await run(
      [ev('e1', 'النرجس', [a('district', 'النرجس')]), ev('e2', 'شمال طريق الملك سلمان', [a('direction', 'شمال طريق الملك سلمان')])],
      undefined, { conversation } as Partial<RunContext>,
    );
    expect(r.trace.some((t) => t.kind === 'distributed_clip')).toBe(false);
    expect(shape(r.compiled).sort()).toEqual([
      ['directional_band', 'north', ['RUH-ROAD-0681']],
      ['district_polygon', null, ['d-narjis']],
    ]);
  });
  it('«او» between the DISTRICTS keeps the distribution («… او العليا (غرب الملك فهد)», graded right)', async () => {
    const text = 'فيلا بس بالملقا او العليا (غرب الملك فهد)';
    const conversation = { channel: 'chat' as const, id: 'c1', turns: [{ speaker: 'client' as const, text, ref: 'm1' }] };
    const r = await run(
      [ev('e1', 'الملقا', [a('district', 'الملقا')]), ev('e2', 'العليا', [a('district', 'العليا')]), ev('e3', 'غرب الملك فهد', [a('direction', 'غرب الملك فهد')])],
      undefined, { conversation } as Partial<RunContext>,
    );
    expect(r.trace.filter((t) => t.kind === 'distributed_clip').map((t) => t.evidence_id).sort()).toEqual(['e1', 'e2']);
  });
  it('terminates with a bounded number of map calls', async () => {
    let axisCalls = 0;
    const counting = fakeDb({ async roadAxis(id, ids) { axisCalls += 1; return fakeRoadAxis(ROAD_AXIS)(id, ids); } });
    await run([
      ev('e1', 'الملقا', [a('district', 'الملقا')]),
      ev('e2', 'النرجس', [a('district', 'النرجس')]),
      ev('e3', 'شمال طريق الملك فهد', [a('direction', 'شمال طريق الملك فهد')]),
    ], counting);
    expect(axisCalls).toBeGreaterThan(0);
    expect(axisCalls).toBeLessThanOrEqual(4); // memoised per (road, districts)
  });
});

describe('the map ports THROW — a check that cannot run fails the review loudly', () => {
  it('roadAxis rejecting makes runReviewFirst reject', async () => {
    const db = fakeDb({ async roadAxis() { throw new Error('axis rpc down'); } });
    await expect(one('ابي غرب الملك فهد', [a('direction', 'غرب الملك فهد')], db)).rejects.toThrow('axis rpc down');
  });
  it('namesInText rejecting makes runReviewFirst reject', async () => {
    const db = fakeDb({ async namesInText() { throw new Error('names rpc down'); } });
    await expect(one('ابي في النرجس', [a('district', 'النرجس')], db)).rejects.toThrow('names rpc down');
  });
  it('cityLabel rejecting makes runReviewFirst reject', async () => {
    const db = fakeDb({ async cityLabel() { throw new Error('label rpc down'); } });
    await expect(one('ابي غرب الملك فهد', [a('direction', 'غرب الملك فهد')], db)).rejects.toThrow('label rpc down');
  });
});

describe('observability and the test-only switch', () => {
  it('one event per demotion and per preparation ask — rule, reason, evidence id, anchor type; never customer text', async () => {
    const events: GeoEvent[] = [];
    const observer = createGeoObserver((e) => events.push(e));
    await run([
      ev('e1', 'ابي حول الرياض بارك', [a('city', 'الرياض')]),
      ev('e2', 'ابي فيلا شمال الملك فهد', [a('direction', 'شمال الملك فهد')]),
      ev('e3', 'ابي بالشمال وغرب الملك فهد', [a('direction', 'الشمال'), a('direction', 'غرب الملك فهد')]),
    ], undefined, { observer });
    const demotions = events.filter((e) => e.result === 'demoted').map((e) => e.detail);
    expect(demotions).toEqual(expect.arrayContaining([
      { rule: 'names_in_text', reason: 'place_is_part_of_name', evidence_id: 'e1', anchor_type: 'city' },
      { rule: 'road_axis', reason: 'side_not_along_road', evidence_id: 'e2', anchor_type: 'direction' },
      { rule: 'prep_ask', reason: 'direction_referent_unclear', evidence_id: 'e3', anchor_type: 'direction' },
    ]));
    expect(demotions).toHaveLength(3);
    const dump = JSON.stringify(events);
    for (const word of ['الرياض', 'بارك', 'الملك', 'فهد', 'الشمال']) expect(dump).not.toContain(word);
  });
  it('distance_unverified is a missing radius in the ambiguity list', async () => {
    const r = await one('ابي غرب الملك فهد', [a('direction', 'غرب الملك فهد', { distance_m: 2000 })]);
    expect(r.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'distance_unverified' });
    expect(r.ambiguity).toContain('missing_radius');
  });
  it('disabledChecks outside the test runner throws', async () => {
    const saved = process.env.VITEST;
    try {
      delete process.env.VITEST;
      await expect(one('ابي غرب الملك فهد', [a('direction', 'غرب الملك فهد')], undefined, { disabledChecks: new Set<CheckName>(['road_axis']) }))
        .rejects.toThrow('disabledChecks is test-only');
      // An empty set is not a switch.
      await expect(one('ابي غرب الملك فهد', [a('direction', 'غرب الملك فهد')], undefined, { disabledChecks: new Set<CheckName>() })).resolves.toBeTruthy();
    } finally {
      process.env.VITEST = saved;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Every check is load-bearing: with it off, its named case resolves (the
// automated half of the §6.4 mutation check).
// ─────────────────────────────────────────────────────────────────────────────

interface Case { name: string; evidence: Evidence[]; db?: ResolverDb }
const c1 = (name: string, span: string, anchors: AnchorToken[], db?: ResolverDb): Case => ({ name, evidence: [ev('e1', span, anchors)], db });

const leakyDb = fakeDb({
  async findElements(token) { return ELEMENTS.filter((e) => e.external_id === 'KHB-ROAD-KFR' && loose(roadKey(e.name_ar), roadKey(token))); },
});

const LOAD_BEARING: Array<[CheckName, Case, string]> = [
  ['grounding', c1('A1 «جنوب الرياض على طريق الملك سلمان» as one road side', 'جنوب الرياض على طريق الملك سلمان', [a('direction', 'جنوب طريق الملك سلمان')]), 'e1'],
  ['distance', c1('P10 a distance not in the words', 'ابي غرب الملك فهد', [a('direction', 'غرب الملك فهد', { distance_m: 2000 })]), 'e1'],
  ['bare_direction', c1('BD2 «في الشمال غرب طريق الملك فهد»', 'ابي في الشمال غرب طريق الملك فهد', [a('direction', 'الشمال'), a('direction', 'غرب طريق الملك فهد')]), 'e1'],
  ['referent_disagree', c1('P5c «جنوب الدمام» → «جنوب طريق الدمام»', 'ابي جنوب الدمام', [a('direction', 'جنوب الدمام', { normalized_token: 'جنوب طريق الدمام' })]), 'e1'],
  ['merge_region_hold', c1('C1 region', 'النرجس بمنطقة الرياض', [a('district', 'النرجس'), a('region', 'منطقة الرياض')]), 'e1'],
  ['merge_two_cities', c1('C1 two cities', 'النرجس بالرياض او جدة', [a('district', 'النرجس'), a('city', 'الرياض'), a('city', 'جدة')]), 'e1'],
  ['or_not_and', c1('V8', 'النرجس او شمال طريق الملك سلمان', [a('district', 'النرجس'), a('direction', 'شمال طريق الملك سلمان')]), 'e1'],
  ['road_axis', c1('I4', 'ابي فيلا شمال الملك فهد', [a('direction', 'شمال الملك فهد')]), 'e1'],
  ['element_city', c1('I5', 'قريب من طريق الملك فهد خلال 2 كيلو', [a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 })], leakyDb), 'e1'],
  ['clip_city', c1('M1', 'الحمراء شمال طريق الملك عبدالله', [a('district', 'الحمراء'), a('direction', 'شمال طريق الملك عبدالله')]), 'e1'],
  ['venue_prefix', c1('I7', 'خلال 2 كيلو من العثيم مول', [a('landmark', 'العثيم مول', { distance_m: 2000 })]), 'e1'],
  ['names_in_text', c1('I8', 'ابي حول الرياض بارك', [a('city', 'الرياض')]), 'e1'],
  ['conversation_city', { name: 'I9', evidence: [ev('e1', 'ابي في جدة', [a('city', 'جدة')]), ev('e2', 'او بالشمال', [a('direction', 'الشمال')])] }, 'e2'],
  // Repair round 1: «شمال مكة» is now ALSO caught by I9 (a short city name
  // forbids the established city), so the namesake veto's own case is its
  // DISTRICT branch: «شرق العليا» — Olaya district, or Olaya Street?
  ['namesake_veto', c1('namesake «شرق العليا»', 'ابي شرق العليا', [a('direction', 'شرق العليا')]), 'e1'],
  // U1 (added 2026-10-04 by the never-wrong corpus): Jeddah's only الحمراء was drawn beside north Riyadh.
  ['union_city', c1('U1 «الحمراء شمال الرياض»', 'الحمراء شمال الرياض', [a('district', 'الحمراء'), a('direction', 'شمال الرياض')]), 'e1'],
];

describe('every check is load-bearing (its case resolves only with the check switched off)', () => {
  for (const [check, c, eid] of LOAD_BEARING) {
    it(`${check}: ${c.name}`, async () => {
      const all = await run(c.evidence, c.db);
      expect(all.resolved_evidence_ids).not.toContain(eid);
      const off = await run(c.evidence, c.db, { disabledChecks: new Set<CheckName>([check]) });
      expect(off.resolved_evidence_ids).toContain(eid);
    });
  }
  it('region_owner: «شمال القصيم» — the direction is asked as a region\'s zone; off, it is not', async () => {
    const e = [ev('e1', 'ابي شمال القصيم', [a('direction', 'شمال'), a('region', 'القصيم')])];
    const all = await run(e);
    expect(all.resolutions[0]).toMatchObject({ status: 'needs_confirm', reason: 'zone_of_region' });
    const off = await run(e, undefined, { disabledChecks: new Set<CheckName>(['region_owner']) });
    expect(off.resolutions[0]!.reason).not.toBe('zone_of_region');
    // The mention is still held by C1 (a region beside anything else): never a place.
    expect(off.resolved_evidence_ids).not.toContain('e1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MONOTONICITY (property): R(ALL) ⊆ R(S) for every S, and the recipes of
// R(ALL) are unchanged except where a distribution was involved.
// ─────────────────────────────────────────────────────────────────────────────

const CORPUS: Case[] = [
  c1('#1', 'ابي فيلا غرب الملك فهد', [a('direction', 'غرب'), a('road', 'الملك فهد')]),
  c1('#2', 'ابي فيلا غرب طريق الملك فهد', [a('direction', 'غرب طريق الملك فهد')]),
  c1('#3', 'ابي بالنرجس شمال طريق الملك سلمان', [a('district', 'النرجس'), a('direction', 'شمال'), a('road', 'طريق الملك سلمان')]),
  c1('#4', 'النرجس شمال سلمان', [a('district', 'النرجس'), a('direction', 'شمال'), a('district', 'سلمان')]),
  c1('#5', 'ابي قريب من الرياض بارك', [a('city', 'الرياض')]),
  {
    name: '#6', evidence: [
      ev('e1', 'ابي في شمال الرياض', [a('direction', 'شمال'), a('city', 'الرياض')]),
      ev('e2', 'بس مو النرجس', [a('district', 'النرجس')], 'negative'),
    ],
  },
  c1('L1 v9c', 'شمال الرياض على طريق الملك فهد', [a('direction', 'شمال طريق الملك فهد')]),
  c1('L1 v9d', 'شمال الرياض على طريق الملك فهد', [a('direction', 'شمال الرياض'), a('road', 'طريق الملك فهد', { role_in_relation: 'along' })]),
  c1('L2', 'ابي قريب من طريق الملك فهد تقريبا 2 كيلو', [a('direction', 'طريق الملك فهد', { distance_m: 2000 })]),
  c1('ring', 'جنوب الدائري الشمالي', [a('direction', 'جنوب الدائري الشمالي')]),
  c1('zone', 'شمال الرياض تقريبا', [a('direction', 'شمال'), a('city', 'الرياض')]),
  c1('f0a', 'ابي شمال او شرق جدة', [a('direction', 'شمال'), a('direction', 'شرق'), a('city', 'جدة')]),
  c1('f0b', 'ابي شمال مدينة جدة', [a('direction', 'شمال'), a('city', 'جدة')]),
  c1('f4', 'ابي النرجس وجنوب سلمان', [a('district', 'النرجس'), a('direction', 'وجنوب سلمان', { normalized_token: 'جنوب الملك سلمان' })]),
  c1('f5', 'ابي شمال القصيم', [a('direction', 'شمال'), a('region', 'القصيم')]),
  c1('f8a', 'ابي شرق طريق الدمام', [a('direction', 'شرق طريق الدمام', { normalized_token: 'شرق الدمام' })]),
  c1('f8b', 'ابي فيلا شمال جدة', [a('direction', 'شمال جدة', { normalized_token: 'شمال جده' })]),
  c1('f9', 'خلال 2 كيلو من حديقة الملك عبدالله', [a('landmark', 'حديقة الملك عبدالله', { normalized_token: 'حديقه الملك عبدالله', distance_m: 2000 })]),
  c1('f11', 'I want a villa in north Riyadh', [a('direction', 'north'), a('city', 'Riyadh')]),
  c1('f13', 'ابي بالشمال وغرب الملك فهد', [a('direction', 'الشمال'), a('direction', 'غرب الملك فهد')]),
  c1('7c', 'الروضة شمال جدة', [a('district', 'الروضة'), a('direction', 'شمال'), a('city', 'جدة')]),
  c1('7d', 'الروضة بجدة', [a('district', 'الروضة'), a('city', 'جدة')]),
  c1('olaya', 'ابي شرق العليا', [a('direction', 'شرق العليا')]),
  c1('bd5', 'ابي في الشمال', [a('direction', 'الشمال')]),
  {
    name: 'I9', evidence: [ev('e1', 'ابي في جدة', [a('city', 'جدة')]), ev('e2', 'او بالشمال', [a('direction', 'الشمال')])],
  },
  {
    name: 'dist-ok', evidence: [ev('e1', 'العليا', [a('district', 'العليا')]), ev('e2', 'غرب طريق الملك فهد', [a('direction', 'غرب طريق الملك فهد')])],
  },
  {
    name: 'dist-M2', evidence: [ev('e1', 'النرجس', [a('district', 'النرجس')]), ev('e2', 'غرب طريق الملك سلمان', [a('direction', 'غرب طريق الملك سلمان')])],
  },
  {
    name: 'dist-I4', evidence: [ev('e1', 'الملقا', [a('district', 'الملقا')]), ev('e2', 'شمال طريق الملك فهد', [a('direction', 'شمال طريق الملك فهد')])],
  },
  {
    name: 'dist-M1', evidence: [ev('e1', 'الحمراء', [a('district', 'الحمراء')]), ev('e2', 'شمال طريق الملك عبدالله', [a('direction', 'شمال طريق الملك عبدالله')])],
  },
  {
    name: 'dist-or', evidence: [ev('e1', 'العليا', [a('district', 'العليا')]), ev('e2', 'او غرب طريق الملك فهد', [a('direction', 'غرب طريق الملك فهد')])],
  },
  c1('M1', 'الحمراء شمال طريق الملك عبدالله', [a('district', 'الحمراء'), a('direction', 'شمال طريق الملك عبدالله')]),
  c1('I8a', 'ابي حول الرياض بارك', [a('city', 'الرياض')]),
  c1('I8b', 'ابي شمال الرياض بارك', [a('direction', 'شمال الرياض')]),
  c1('I8c', 'ابي حي النرجس', [a('district', 'النرجس')]),
  c1('V8', 'النرجس او شمال طريق الملك سلمان', [a('district', 'النرجس'), a('direction', 'شمال طريق الملك سلمان')]),
  c1('C1a', 'النرجس بالرياض او جدة', [a('district', 'النرجس'), a('city', 'الرياض'), a('city', 'جدة')]),
  c1('C1b', 'النرجس بمنطقة الرياض', [a('district', 'النرجس'), a('region', 'منطقة الرياض')]),
  c1('I7', 'خلال 2 كيلو من العثيم مول', [a('landmark', 'العثيم مول', { distance_m: 2000 })]),
  c1('veto', 'ابي شمال مكة', [a('direction', 'شمال مكة')]),
  c1('P5c', 'ابي جنوب الدمام', [a('direction', 'جنوب الدمام', { normalized_token: 'جنوب طريق الدمام' })]),
  c1('A1', 'جنوب الرياض على طريق الملك سلمان', [a('direction', 'جنوب طريق الملك سلمان')]),
  c1('P10', 'ابي غرب الملك فهد', [a('direction', 'غرب الملك فهد', { distance_m: 2000 })]),
  c1('BD2', 'ابي في الشمال غرب طريق الملك فهد', [a('direction', 'الشمال'), a('direction', 'غرب طريق الملك فهد')]),
  c1('M2', 'ابي بالنرجس غرب طريق الملك سلمان', [a('district', 'النرجس'), a('direction', 'غرب طريق الملك سلمان')]),
  c1('bd4', 'شمال حي النرجس', [a('direction', 'شمال'), a('district', 'النرجس')]),
];

/** A deterministic PRNG (mulberry32) — the property must be reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The comparable shape of each mention's ref: op, sorted ids, side, radius, polarity. */
function recipeByEvidence(r: ReviewFirstResult): Map<string, string> {
  const out = new Map<string, string>();
  for (const ref of refs(r.compiled)) {
    if (ref.recipe.geo_data_version === 'stub') continue;
    const eid = ref.geometry_id.startsWith('geo:') ? ref.geometry_id.slice(4) : ref.geometry_id;
    out.set(eid, JSON.stringify([ref.recipe.operation, [...ref.recipe.resolved_element_ids].sort(), ref.recipe.side ?? null, ref.recipe.radius_or_band_m ?? null, ref.op]));
  }
  return out;
}

describe('MONOTONICITY — switching checks off can only grow the resolved set', () => {
  it('R(ALL) ⊆ R(S) over the corpus, for every single check (alone, and all-but-one) and 50 random subsets', async () => {
    const random = rng(20261004);
    const subsets: CheckName[][] = [
      [],
      ...ALL_CHECKS.map((c) => [c]),
      ...ALL_CHECKS.map((c) => ALL_CHECKS.filter((x) => x !== c)),
      ...Array.from({ length: 50 }, () => ALL_CHECKS.filter(() => random() < 0.5)),
    ];
    let compared = 0;
    for (const c of CORPUS) {
      const all = await run(c.evidence, c.db);
      const rAll = new Set(all.resolved_evidence_ids);
      const recAll = recipeByEvidence(all);
      for (const enabledSet of subsets) {
        const disabled = new Set<CheckName>(ALL_CHECKS.filter((x) => !enabledSet.includes(x)));
        const s = await run(c.evidence, c.db, { disabledChecks: disabled });
        const rS = new Set(s.resolved_evidence_ids);
        for (const id of rAll) {
          expect(rS.has(id), `${c.name}: ${id} resolved with every check on but not with [${[...disabled].join(',')}] off`).toBe(true);
        }
        // Same recipe for what ALL resolved — unless a distribution was involved in either run.
        const distributed = (r: ReviewFirstResult, id: string) => r.trace.some((t) => t.kind === 'distributed_clip' && t.evidence_id === id);
        const anyDistribution = all.trace.some((t) => t.kind === 'distributed_clip') || s.trace.some((t) => t.kind === 'distributed_clip');
        const recS = recipeByEvidence(s);
        for (const id of rAll) {
          if (distributed(all, id) || distributed(s, id)) continue;
          if (!recAll.has(id) || !recS.has(id)) {
            // A ref can only vanish when its band was distributed onto the other mentions.
            expect(anyDistribution, `${c.name}: ${id} lost its ref with [${[...disabled].join(',')}] off`).toBe(true);
            continue;
          }
          expect(recS.get(id), `${c.name}: ${id} changed shape with [${[...disabled].join(',')}] off`).toBe(recAll.get(id));
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
  }, 120_000);
});
