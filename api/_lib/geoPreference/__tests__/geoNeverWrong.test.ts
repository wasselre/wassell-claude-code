import { describe, it, expect, afterAll } from 'vitest';
import { runReviewFirst, type RunContext, type OrchestratorPorts, type ProposalRecord, type ReviewFirstResult } from '../orchestrator.js';
import type { ResolverDb, DistrictCandidate, CityCandidate, RegionCandidate, ElementCandidate } from '../resolver.js';
import { lexicalVariants } from '../resolverDb.js';
import { isLatinToken, latinVariants } from '../latinNames.js';
import { ALL_CHECKS, type CheckName } from '../invariants.js';
import type { SatUniverse } from '../satisfiability.js';
import type { GateConfig } from '../gate.js';
import type { Conversation } from '../extractor.js';
import type { AnchorToken, CardinalSide, Evidence, GeoOperation, GeoPreference, Polarity } from '../ontology.js';
import { geoPreferenceToLocationItems } from '../../../geo-preference/review.js';
import { fakeNamesInText, fakeRoadAxis, MEASURED_LOCAL_AXIS, MEASURED_ROAD_AXIS, type FakeRoad } from './fakeGeoMap.js';

/**
 * THE NEVER-WRONG CORPUS (design 2026-10-04 §6.5) — every sentence shape the
 * geo fix was built around, run through the WHOLE review path
 * (runReviewFirst: preparation → resolution → checks → merge) against a STRICT
 * fake map.
 *
 * STRICT means the fake generates candidates exactly like the live adapter
 * (resolverDb.ts) over the live SQL, with no folding the live path does not do:
 *  - elements: byte-wise ILIKE substring on name_ar / name_en / alias
 *    (case-insensitive for Latin), plus the adapter's «طريق …» query for a
 *    road, filtered by the element city the adapter would pass (an Arabic city
 *    → its cities.name_en through the adapter's lexical variants, else the
 *    input unchanged) — so a folded token («حديقه …», «طريق مكه») finds
 *    NOTHING on its own, exactly as in production;
 *  - districts / cities / regions: the adapter's ILIKE over name_ar / name_en
 *    with ITS lexical variants (ة/ه, ى/ي, أإآ/ا, ±«ال», Latin spellings);
 *  - zones: the EXACT Arabic city name (wassell_city_zone_districts);
 *  - the road axis: only the numbers measured live (fakeGeoMap.ts); a road that
 *    was never measured answers found:false, so a side of it asks.
 *
 * THE ASSERTION (binding): a resolved recipe that differs from the expected
 * one — operation, sorted ids, side, radius, polarity — FAILS the row. A row
 * that ASKS where the design expected a place does not fail: it is REPORTED,
 * and the ask rate is printed at the end. Asking is always allowed; a wrong
 * place never is.
 *
 * The rows: the 68 cases of the patch probe (scratchpad
 * geo-minimal-patch-probe.ts — the design counts 59; the file holds 68, all
 * kept) with the §5.4 expectation changes, every row of design §5, and the
 * §6.5 adversarial rows. The second half re-runs the corpus with checks
 * switched off (design §6.4 MONOTONICITY over this corpus).
 */

// ─────────────────────────────────────────────────────────────────────────────
// The fixtures
// ─────────────────────────────────────────────────────────────────────────────

const RIYADH: [string, string] = ['الرياض', 'Riyadh'];
const JEDDAH: [string, string] = ['جدة', 'Jeddah'];
const DAMMAM: [string, string] = ['الدمام', 'Dammam'];
const NAJRAN: [string, string] = ['نجران', 'Najran'];
const MAKKAH: [string, string] = ['مكة المكرمة', 'Makkah'];

function district(id: string, name_ar: string, city: [string, string] = RIYADH, aliases: string[] = []): DistrictCandidate {
  return {
    id, name_ar, name_en: '', aliases, city_id: `city-${city[1].toLowerCase()}`, city_name_ar: city[0], city_name_en: city[1],
    region_name_ar: '', region_name_en: '', country_code: 'SA', centroid_lat: 24.8, centroid_lng: 46.6,
  };
}
/** Live district names carry «حي» (measured 2026-10-04). */
const DISTRICTS: DistrictCandidate[] = [
  district('d-rawabi-ruh', 'حي الروابي'),
  district('d-rawabi-dmm', 'حي الروابي', DAMMAM),
  district('d-rawdah-ruh', 'حي الروضة'),
  district('d-rawdah-jed', 'حي الروضة', JEDDAH),
  district('d-narjis', 'حي النرجس'),
  district('d-malqa', 'حي الملقا'),
  district('d-olaya', 'حي العليا'),
  // The DISTRICT «حي الملك سلمان»: its alias «سلمان» is what made «شمال سلمان» a district on 2026-10-01.
  district('d-king-salman', 'حي الملك سلمان', RIYADH, ['سلمان']),
  // «حي الفهد» is a real district in Najran — never King Fahd Road.
  district('d-fahd-najran', 'حي الفهد', NAJRAN),
  district('d-khazam', 'حي خزام'),
  district('d-mather', 'حي المعذر'),
  // Not in the design's fixture list — added so the adversarial «النخيل مول»
  // typed as a district, and «بحي الصفاء بالشرق», are asked by the RULE under
  // test and not merely because the district is unknown.
  district('d-nakheel', 'حي النخيل'),
  district('d-safa', 'حي الصفاء'),
  // A district that exists ONLY in Jeddah (U1's case: never drawn beside north Riyadh).
  district('d-hamra-jed', 'حي الحمراء', JEDDAH),
  // Repair round 1: «العزيزية» in Riyadh AND in Makkah (Makkah's is the famous one).
  district('d-aziziyah-ruh', 'حي العزيزية'),
  district('d-aziziyah-mak', 'حي العزيزية', MAKKAH),
];

function city(id: string, name_ar: string, name_en: string, region_name_ar: string): CityCandidate {
  return { id, name_ar, name_en, aliases: [], region_name_ar, region_name_en: '', country_code: 'SA', centroid_lat: 24.7, centroid_lng: 46.7 };
}
/** Cities carry NO aliases (measured): «مكة» is not an exact name of «مكة المكرمة». */
const CITIES: CityCandidate[] = [
  city('city-riyadh', 'الرياض', 'Riyadh', 'منطقة الرياض'),
  city('city-jeddah', 'جدة', 'Jeddah', 'منطقة مكة المكرمة'),
  city('city-dammam', 'الدمام', 'Dammam', 'المنطقة الشرقية'),
  city('city-khobar', 'الخبر', 'Khobar', 'المنطقة الشرقية'),
  city('city-najran', 'نجران', 'Najran', 'منطقة نجران'),
  city('city-makkah', 'مكة المكرمة', 'Makkah', 'منطقة مكة المكرمة'),
  city('city-madinah', 'المدينة المنورة', 'Madinah', 'منطقة المدينة المنورة'),
];
const REGIONS: RegionCandidate[] = [
  { id: 'region-east', name_ar: 'المنطقة الشرقية', name_en: 'Eastern Province', aliases: [], country_code: 'SA' },
  { id: 'region-qassim', name_ar: 'منطقة القصيم', name_en: 'Qassim Region', aliases: ['القصيم'], country_code: 'SA' },
  { id: 'region-riyadh', name_ar: 'منطقة الرياض', name_en: 'Riyadh Region', aliases: [], country_code: 'SA' },
];

function element(external_id: string, name_ar: string, name_en: string, geom_kind: ElementCandidate['geom_kind'], extra: Partial<ElementCandidate> = {}): ElementCandidate {
  return {
    external_id, name_ar, name_en, aliases: [], geom_kind, category: null, type: null, city: 'Riyadh',
    country_code: 'SA', lat: 24.75, lng: 46.65, confidence_score: 0.9, review_status: 'approved', is_active: true, ...extra,
  };
}

const KFR = 'RUH-ROAD-0694';
const KSR = 'RUH-ROAD-0681';
const RING = 'RUH-RING-0853';
const DMM = 'RUH-ROAD-0727';
const MKH = 'RUH-ROAD-0695';
const KAR = 'RUH-ROAD-0690';
const OLAYA_ST = 'RUH-ROAD-0684';
const PARK = 'RUH-MALL-0038';
const KAP = 'RUH-PARK-KAP';

const PNU_ALIASES = ['جامعة الأميرة نورة', 'جامعة الاميرة نورة'];

function elements(pnuAliases: boolean): ElementCandidate[] {
  return [
    element(KFR, 'طريق الملك فهد', 'King Fahd Road', 'linestring'),
    element(KSR, 'طريق الملك سلمان', 'King Salman Road', 'linestring'),
    element(RING, 'الدائري الشمالي', 'Northern Ring Road', 'linestring'),
    element(DMM, 'طريق الدمام', 'Dammam Road', 'linestring'),
    element(MKH, 'طريق مكة', 'Makkah Road', 'linestring'),
    element(KAR, 'طريق الملك عبدالله', 'King Abdullah Road', 'linestring'),
    element('JED-ROAD-KAR', 'طريق الملك عبدالله', 'King Abdullah Road', 'linestring', { city: 'Jeddah' }),
    element('RUH-ROAD-ANAS', 'طريق انس بن مالك', 'Anas Bin Malik Road', 'linestring'),
    element(OLAYA_ST, 'شارع العليا', 'Olaya Street', 'linestring'),
    element('KHB-ROAD-KFR', 'طريق الملك فهد', 'King Fahd Road', 'linestring', { city: 'Khobar' }),
    element(PARK, 'الرياض بارك', 'Riyadh Park', 'polygon', { lat: 24.756, lng: 46.629 }),
    element('RUH-MALL-NAKHEEL', 'النخيل مول', 'Al Nakheel Mall', 'polygon', { lat: 24.77, lng: 46.71 }),
    // King Saud University: a metro station point 11.7 km from the campus — two places.
    element('RUH-METR-KSU', 'جامعة الملك سعود', 'King Saud University', 'point', { lat: 24.7105, lng: 46.6189 }),
    element('RUH-UNIV-KSU', 'جامعة الملك سعود', 'King Saud University', 'polygon', { lat: 24.724, lng: 46.734 }),
    // One Othaim mall drawn twice 145 m apart, and two far branches whose names only START with «العثيم مول».
    element('RUH-MALL-OTH-P', 'العثيم مول', 'Othaim Mall', 'point', { lat: 24.7, lng: 46.7 }),
    element('RUH-MALL-OTH', 'العثيم مول', 'Othaim Mall', 'polygon', { lat: 24.7013, lng: 46.7 }),
    element('RUH-MALL-OTH-RAB', 'العثيم مول الربوة', 'Othaim Mall Rabwa', 'polygon', { lat: 24.68, lng: 46.78 }),
    element('RUH-MALL-OTH-KHU', 'العثيم مول خريص', 'Othaim Mall Khurais', 'polygon', { lat: 24.76, lng: 46.83 }),
    // Princess Nourah University: two campuses ~9 km apart. The migration of
    // 2026-10-04 gave BOTH the spoken alias — so the resolver must ASK which.
    element('RUH-UNIV-0064', 'جامعة الأميرة نورة بنت عبد الرحمن', 'Princess Nourah University', 'polygon',
      { lat: 24.852, lng: 46.718, aliases: pnuAliases ? PNU_ALIASES : [] }),
    element('RUH-UNIV-0072', 'جامعة الأميرة نورة بنت عبدالرحمن - المدينة الجامعية', 'Princess Nourah University Campus', 'polygon',
      { lat: 24.78, lng: 46.68, aliases: pnuAliases ? PNU_ALIASES : [] }),
    element(KAP, 'حديقة الملك عبدالله', 'King Abdullah Park', 'polygon', { lat: 24.66, lng: 46.74 }),
    // Repair round 1: a venue whose name CONTAINS a road's words (I8 on element picks).
    element('RUH-HOSP-KFH', 'مستشفى الملك فهد', 'King Fahd Hospital', 'point', { lat: 24.69, lng: 46.68 }),
  ];
}

/**
 * How the fixture roads run — ONLY the measured numbers (design §0,
 * fakeGeoMap.ts). JED-ROAD-KAR, KHB-ROAD-KFR and «طريق انس بن مالك» were never
 * measured, so they are absent: the axis port answers found:false and a side
 * of them asks (road_geometry_missing). The design calls Anas bin Malik
 * "north–south"; no number was measured for it, so none is invented here.
 */
const ROAD_AXIS: Record<string, FakeRoad> = {
  [KFR]: {
    road: MEASURED_ROAD_AXIS.kingFahd,
    byDistricts: {
      'd-malqa': MEASURED_LOCAL_AXIS.kingFahdInMalqa,
      'd-olaya': MEASURED_LOCAL_AXIS.kingFahdInOlaya,
      'd-narjis': MEASURED_LOCAL_AXIS.kingFahdAroundNarjis,
      'd-mather': MEASURED_LOCAL_AXIS.kingFahdAroundMather,
    },
  },
  [KSR]: {
    road: MEASURED_ROAD_AXIS.kingSalman,
    byDistricts: { 'd-narjis': MEASURED_LOCAL_AXIS.kingSalmanInNarjis, 'd-malqa': MEASURED_LOCAL_AXIS.kingSalmanInMalqa },
  },
  [RING]: { road: MEASURED_ROAD_AXIS.northernRing, byDistricts: { 'd-narjis': MEASURED_LOCAL_AXIS.northernRingAroundNarjis } },
  [DMM]: { road: MEASURED_ROAD_AXIS.dammam0727 },
  [MKH]: { road: MEASURED_ROAD_AXIS.makkah0695 },
  [KAR]: { road: MEASURED_ROAD_AXIS.kingAbdullah },
  [OLAYA_ST]: { road: MEASURED_ROAD_AXIS.olayaStreet },
};

/** wassell_city_zone_districts: keyed by the EXACT Arabic city name (districts.city_name_ar). */
const ZONES: Record<string, Record<string, string[]>> = {
  'الرياض': { north: ['d-narjis', 'd-yasmin', 'd-arid', 'd-malqa'], south: ['d-shifa', 'd-aziziyah'], east: ['d-east-1'], west: ['d-west-1'] },
  'جدة': { north: ['jed-n1', 'jed-n2'], south: ['jed-s1'], east: ['jed-e1'], west: ['jed-w1'] },
  'الدمام': { north: ['dmm-n1'], east: ['dmm-e1'] },
  'الخبر': { north: ['khb-n1'] },
  'نجران': { north: ['njr-n1'] },
  'مكة المكرمة': { north: ['mak-n1'] },
};

// ─────────────────────────────────────────────────────────────────────────────
// The STRICT fake map — the live adapter's candidate generation, byte for byte.
// ─────────────────────────────────────────────────────────────────────────────

/** Postgres ILIKE '%term%' with no wildcard in the term: a case-insensitive substring. */
const ilike = (hay: string | null | undefined, term: string): boolean =>
  !!hay && hay.toLowerCase().includes(term.toLowerCase());

/** resolverDb.ts ilikeModel: the token's lexical (and Latin) variants, PostgREST pattern characters stripped. */
function modelVariants(token: string): string[] {
  return Array.from(new Set([...lexicalVariants(token), ...(isLatinToken(token) ? latinVariants(token) : [])]))
    .map((v) => v.replace(/[%_,()]/g, ''))
    .filter(Boolean);
}
function ilikeRows<T extends { name_ar: string; name_en: string }>(rows: readonly T[], token: string): T[] {
  const vs = modelVariants(token);
  return rows.filter((r) => vs.some((v) => ilike(r.name_ar, v) || ilike(r.name_en, v)));
}

/** resolverDb.ts arabicCityEnglishName: the exact spelling first, then any lexical variant; '' when none. */
function arabicCityEn(c: string): string {
  const variants = lexicalVariants(c).map((v) => v.replace(/[,()"]/g, '')).filter(Boolean);
  const rows = CITIES.filter((x) => variants.includes(x.name_ar));
  return (rows.find((x) => x.name_ar === c) ?? rows[0])?.name_en ?? '';
}
const isArabic = (s: string): boolean => /[؀-ۿ]/.test(s);

function strictDb(pnuAliases = true): ResolverDb {
  const ELEMENTS = elements(pnuAliases);
  return {
    async findDistricts(token) { return ilikeRows(DISTRICTS, token.replace(/^\s*حي\s+/, '').trim()); },
    async findCities(token) { return ilikeRows(CITIES, token.trim()); },
    async findRegions(token) { return ilikeRows(REGIONS, token.trim()); },
    async findElements(token, opts) {
      const t = token.trim();
      const queries = opts.kind === 'linestring' && !/^\s*(طريق|شارع|محور|الدائري)\s/.test(t) ? [`طريق ${t}`, t] : [t];
      // cityNameForElements: an Arabic city → its English label (else the input unchanged), a Latin one as is.
      const c = (opts.city ?? '').trim();
      const pCity = !c ? null : isArabic(c) ? (arabicCityEn(c) || c) : c;
      const seen = new Map<string, ElementCandidate>();
      for (const q of queries) {
        const term = q.trim();
        for (const e of ELEMENTS) {
          if (pCity !== null && (e.city ?? '').toLowerCase() !== pCity.toLowerCase()) continue;
          const match = term === '' || ilike(e.name_ar, term) || ilike(e.name_en, term)
            || e.aliases.some((al) => ilike(al.trim(), term));
          if (match && !seen.has(e.external_id)) seen.set(e.external_id, e);
        }
      }
      // The adapter stamps the requested country (the RPC does not project one).
      return [...seen.values()].map((e) => ({ ...e, country_code: opts.preferCountry }));
    },
    async zoneDistricts(cityAr, zone) {
      return (ZONES[cityAr]?.[zone] ?? []).map((district_id) => ({ district_id, district_name: district_id }));
    },
    async districtForPoint() { return null; },
    roadAxis: fakeRoadAxis(ROAD_AXIS),
    async cityLabel(cityName) {
      const c = (cityName ?? '').trim();
      if (!c) return null;
      if (isArabic(c)) return arabicCityEn(c) || null;
      if (!/[a-z]/i.test(c)) return null;
      return CITIES.find((x) => x.name_en.trim().toLowerCase() === c.toLowerCase())?.name_en ?? null;
    },
    namesInText: fakeNamesInText(ELEMENTS),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

const universe: SatUniverse = { universe: ['c1'], cellsOf: () => ['c1'], inventoryIn: () => 5 };
const config: GateConfig = {
  auto_write_enabled: false, t_lexical_margin: 0.9, t_geo_margin: 0.9, t_source_quality: 0.9,
  min_action_assurance: { write_soft: 0.9, write_hard: 0.98, supersede: 0.99 },
};
const ports: OrchestratorPorts = {
  proposals: { async createProposal(input) { return { ...input, id: 'prop-1', status: 'pending' } as ProposalRecord; } },
};

const a = (anchor_type: AnchorToken['anchor_type'], span: string, extra: Partial<AnchorToken> = {}): AnchorToken =>
  ({ anchor_type, span, normalized_token: span, ...extra });

function ev(id: string, mention_span: string, anchors: AnchorToken[], role: Evidence['preference_role'] = 'positive', ref = 'm1'): Evidence {
  return {
    id, mention_span, anchors,
    speaker: 'client', preference_holder: 'client', holder_role: 'buyer', quoted_speaker: 'none',
    dialogue_act: 'statement', conditionality: 'asserted', temporal_reference: 'present',
    preference_applicability: 'active', preference_role: role, commitment: 'preferred',
    hardness_evidence: 'none', modality: 'explicit',
    source: { channel: 'chat', ref, timestamp: '2026-10-01T00:00:00Z' },
  };
}

/** A resolved recipe as the assertion compares it: op, sorted ids, side, radius, polarity. */
interface Rec { op: GeoOperation; ids: string[]; side: CardinalSide | null; radius: number | null; polarity: Polarity }
type Expectation = Rec[] | { anyOf: Rec[][] };
/** Nothing may be drawn: every mention stays a stub (an ask). */
const ASKS: Rec[] = [];

const rec = (op: GeoOperation, ids: readonly string[], side: CardinalSide | null = null, radius: number | null = null): Rec =>
  ({ op, ids: Array.from(new Set(ids)).sort(), side, radius, polarity: 'include' });
const exc = (r: Rec): Rec => ({ ...r, polarity: 'exclude' });
const band = (side: CardinalSide, road: string, m = 5000): Rec => rec('directional_band', [road], side, m);
const clip = (side: CardinalSide, districts: readonly string[], road: string): Rec => rec('district_side_clip', [...districts, road], side);
const zoneIds = (cityAr: string, z: string): string[] => ZONES[cityAr]![z]!;
const zone = (cityAr: string, z: string): Rec => rec('zone_union', zoneIds(cityAr, z));
const poly = (id: string): Rec => rec('district_polygon', [id]);
const union = (ids: readonly string[]): Rec => rec('district_union', ids);
const near = (id: string, m: number): Rec => rec('within_distance', [id], null, m);

interface Row {
  name: string;
  evidence: Evidence[];
  expect: Expectation;
  /** The client's established city (default «الرياض», the organisational default). */
  established?: string;
  conversation?: Conversation;
  /** The PNU campuses without the 2026-10-04 aliases. */
  noPnuAliases?: boolean;
}
const row = (name: string, span: string, anchors: AnchorToken[], expectation: Expectation, extra: Partial<Row> = {}): Row =>
  ({ name, evidence: [ev('e1', span, anchors)], expect: expectation, ...extra });

const NORTH_RUH = zoneIds('الرياض', 'north');

const ROWS: Row[] = [
  // ── The patch probe's cases (expectations per design §5 and §5.4) ──────────
  row('probe report1', 'ابي فيلا غرب الملك فهد', [a('direction', 'غرب الملك فهد')], [band('west', KFR)]),
  row('probe report1-split', 'ابي فيلا غرب الملك فهد', [a('direction', 'غرب'), a('road', 'الملك فهد')], [band('west', KFR)]),
  row('probe report2', 'ابي فيلا غرب طريق الملك فهد', [a('direction', 'غرب طريق الملك فهد')], [band('west', KFR)]),
  row('probe report3', 'ابي بالنرجس شمال طريق الملك سلمان', [a('district', 'النرجس'), a('direction', 'شمال طريق الملك سلمان')], [clip('north', ['d-narjis'], KSR)]),
  row('probe report3-v8', 'ابي بالنرجس شمال طريق الملك سلمان', [a('district', 'النرجس'), a('direction', 'شمال'), a('road', 'طريق الملك سلمان')], [clip('north', ['d-narjis'], KSR)]),
  row('probe report4', 'النرجس شمال سلمان', [a('district', 'النرجس'), a('direction', 'شمال سلمان', { normalized_token: 'شمال الملك سلمان' })], [clip('north', ['d-narjis'], KSR)]),
  row('probe report4-v8', 'النرجس شمال سلمان', [a('district', 'النرجس'), a('direction', 'شمال'), a('district', 'سلمان')], [clip('north', ['d-narjis'], KSR)]),
  row('probe report5', 'ابي قريب من الرياض بارك', [a('landmark', 'الرياض بارك', { role_in_relation: 'proximity' })], ASKS),
  row('probe report5-v8', 'ابي قريب من الرياض بارك', [a('city', 'الرياض')], ASKS),
  row('probe report6', 'ابي في شمال الرياض', [a('direction', 'شمال الرياض')], [zone('الرياض', 'north')]),
  row('probe report6-dupcity', 'ابي في شمال الرياض', [a('direction', 'شمال الرياض'), a('city', 'الرياض')], [zone('الرياض', 'north')]),
  row('probe R1 شمال او شرق جدة (est RUH)', 'ابي شمال او شرق جدة', [a('direction', 'شمال'), a('direction', 'شرق'), a('city', 'جدة')], ASKS),
  row('probe R1 شمال مدينة جدة', 'ابي شمال مدينة جدة', [a('direction', 'شمال'), a('city', 'جدة')], [zone('جدة', 'north')]),
  row('probe R2 الروابي جنوب طريق الدمام + city', 'الروابي جنوب طريق الدمام',
    [a('district', 'الروابي'), a('direction', 'جنوب'), a('road', 'طريق الدمام'), a('city', 'الدمام')], [clip('south', ['d-rawabi-ruh'], DMM)]),
  // §5.4: the twin bare word is dropped, and a band north of King Fahd Road (0.341) asks (I4).
  row('probe R2 bare inside road side', 'شمال طريق الملك فهد', [a('direction', 'شمال'), a('direction', 'شمال طريق الملك فهد')], ASKS),
  row('probe R3 شمال او جنوب انس بن مالك', 'ابي شمال او جنوب انس بن مالك', [a('direction', 'شمال'), a('direction', 'جنوب انس بن مالك')], ASKS),
  row('probe R4 quotes', 'ابي بيت قريب من "الرياض بارك"', [a('city', 'الرياض')], ASKS),
  row('probe R4 parens', 'ابي بيت قريب من (الرياض بارك)', [a('city', 'الرياض')], ASKS),
  row('probe R4 the', 'near the Riyadh Park', [a('city', 'Riyadh')], ASKS),
  row('probe R5 clitic royal', 'ابي النرجس وجنوب سلمان',
    [a('district', 'النرجس'), a('direction', 'وجنوب سلمان', { normalized_token: 'جنوب الملك سلمان' })], [clip('south', ['d-narjis'], KSR)]),
  row('probe R6 شمال القصيم', 'ابي شمال القصيم', [a('direction', 'شمال'), a('region', 'القصيم')], ASKS),
  row('probe R7 band + region', 'شمال طريق الملك فهد بالمنطقة الشرقية', [a('direction', 'شمال طريق الملك فهد'), a('region', 'المنطقة الشرقية')], ASKS),
  row('probe R7 near road + region', 'قريب من طريق الملك فهد بالمنطقة الشرقية خلال 2 كيلو',
    [a('road', 'طريق الملك فهد', { distance_m: 2000, role_in_relation: 'proximity' }), a('region', 'المنطقة الشرقية')], ASKS),
  row('probe R8a في جدة بالشمال (est RUH)', 'في جدة بالشمال', [a('city', 'جدة'), a('direction', 'الشمال')], ASKS),
  row('probe R8c الروضة شمال جدة', 'الروضة شمال جدة', [a('district', 'الروضة'), a('direction', 'شمال'), a('city', 'جدة')],
    [union(['d-rawdah-jed', ...zoneIds('جدة', 'north')])]),
  row('probe R8d الروضة بجدة', 'الروضة بجدة', [a('district', 'الروضة'), a('city', 'جدة')], [union(['d-rawdah-jed'])]),
  // §5.3 #8 (HIGH): «east of» an east–west road is meaningless (I4) — never Dammam city.
  row('probe R9 one anchor road word dropped', 'ابي شرق طريق الدمام', [a('direction', 'شرق طريق الدمام', { normalized_token: 'شرق الدمام' })], ASKS),
  row('probe R9 jeddah folded', 'ابي فيلا شمال جدة', [a('direction', 'شمال جدة', { normalized_token: 'شمال جده' })], [zone('جدة', 'north')]),
  row('probe R10 folded venue', 'خلال 2 كيلو من حديقة الملك عبدالله',
    [a('landmark', 'حديقة الملك عبدالله', { normalized_token: 'حديقه الملك عبدالله', distance_m: 2000 })], [near(KAP, 2000)]),
  row('probe R11 بالشمال في جدة (est RUH)', 'ابي بالشمال في جدة', [a('direction', 'الشمال'), a('city', 'جدة')], ASKS),
  row('probe R11 شمال منطقة القصيم', 'ابي شمال منطقة القصيم', [a('direction', 'شمال'), a('region', 'منطقة القصيم')], ASKS),
  row('probe R13 north Riyadh', 'I want a villa in north Riyadh', [a('direction', 'north'), a('city', 'Riyadh')], [zone('الرياض', 'north')]),
  row('probe R14 الشمال وغرب الملك فهد (accepted ask)', 'ابي بالشمال وغرب الملك فهد', [a('direction', 'الشمال'), a('direction', 'غرب الملك فهد')], ASKS),
  row('probe L1 assembled', 'شمال الرياض على طريق الملك فهد', [a('direction', 'شمال طريق الملك فهد'), a('city', 'الرياض')], ASKS),
  row('probe L2 road typed as direction', 'ابي قريب من طريق الملك فهد تقريبا 2 كيلو',
    [a('direction', 'طريق الملك فهد', { distance_m: 2000, role_in_relation: 'proximity' })], [near(KFR, 2000)]),
  row('probe L3 PNU short name (aliases)', 'قريب من جامعة الأميرة نورة بحدود 3 كيلو',
    [a('landmark', 'جامعة الأميرة نورة', { normalized_token: 'جامعه الاميره نوره', distance_m: 3000, role_in_relation: 'proximity' })], ASKS),
  row('probe L3 PNU short name (no aliases)', 'قريب من جامعة الأميرة نورة بحدود 3 كيلو',
    [a('landmark', 'جامعة الأميرة نورة', { normalized_token: 'جامعه الاميره نوره', distance_m: 3000, role_in_relation: 'proximity' })], ASKS,
    { noPnuAliases: true }),
  // §5.4: BD2.
  row('probe G الشمال غرب طريق الملك فهد', 'الشمال غرب طريق الملك فهد', [a('direction', 'الشمال'), a('direction', 'غرب طريق الملك فهد')], ASKS),
  row('probe G شرق او غرب الملك فهد', 'شرق او غرب الملك فهد', [a('direction', 'شرق'), a('direction', 'غرب الملك فهد')], ASKS),
  row('probe G شمال الرياض على طريق split', 'شمال الرياض على طريق الملك فهد',
    [a('direction', 'شمال'), a('city', 'الرياض'), a('road', 'طريق الملك فهد')], ASKS),
  row('probe G شمال جدة split', 'ابي شمال جدة', [a('direction', 'شمال'), a('city', 'جدة')], [zone('جدة', 'north')]),
  row('probe G الشمال او جدة', 'الشمال او جدة', [a('direction', 'الشمال'), a('city', 'جدة')], ASKS),
  row('probe G بالشمال في الرياض (est RUH)', 'ابي بالشمال في الرياض', [a('direction', 'الشمال'), a('city', 'الرياض')], [zone('الرياض', 'north')]),
  row('probe G «شرق الدمام» model added road', 'ابي شرق الدمام', [a('direction', 'شرق الدمام', { normalized_token: 'شرق طريق الدمام' })], ASKS),
  row('probe G v8 no-occurrence split', 'some other text', [a('direction', 'شمال'), a('city', 'الرياض')], [zone('الرياض', 'north')]),
  // §5.4: M2 — King Fahd Road runs north–south.
  row('probe G district + named city + road side', 'الروضة شمال طريق الملك فهد بالرياض',
    [a('district', 'الروضة'), a('direction', 'شمال طريق الملك فهد'), a('city', 'الرياض')], ASKS),
  row('probe G region alone', 'ابي في القصيم', [a('region', 'القصيم')], [union(['region-qassim'])]),
  // §5.4: I4 — Makkah Road runs east–west.
  row('probe G «طريق مكة» + city مكة', 'غرب طريق مكة', [a('direction', 'غرب'), a('road', 'طريق مكة'), a('city', 'مكة')], ASKS),
  row('probe A one-anchor «شمال الرياض» + nested city + road side, est JED', 'شمال الرياض غرب طريق الملك فهد',
    [a('direction', 'شمال الرياض'), a('city', 'الرياض'), a('direction', 'غرب طريق الملك فهد')], [clip('west', NORTH_RUH, KFR)], { established: 'جدة' }),
  row('probe A «الرياض شمال» est JED', 'الرياض شمال', [a('city', 'الرياض'), a('direction', 'شمال')], ASKS, { established: 'جدة' }),
  row('probe A «الرياض شمال» est RUH', 'الرياض شمال', [a('city', 'الرياض'), a('direction', 'شمال')], [zone('الرياض', 'north')]),
  row('probe A dup bare + road', 'شمال طريق الملك فهد', [a('direction', 'شمال'), a('direction', 'شمال'), a('road', 'طريق الملك فهد')], ASKS),
  row('probe A two cities two directions', 'شمال الرياض او شمال جدة',
    [a('direction', 'شمال'), a('city', 'الرياض'), a('direction', 'شمال'), a('city', 'جدة')], ASKS),
  row('probe A district + 2 cities', 'الروضة في جدة او الدمام', [a('district', 'الروضة'), a('city', 'جدة'), a('city', 'الدمام')], ASKS),
  row('probe A «شمال جدة» est JED split', 'شمال جدة', [a('direction', 'شمال'), a('city', 'جدة')], [zone('جدة', 'north')], { established: 'جدة' }),
  row('probe A «في جدة بالشمال» est JED', 'في جدة بالشمال', [a('city', 'جدة'), a('direction', 'الشمال')], [zone('جدة', 'north')], { established: 'جدة' }),
  row('probe A one-anchor «شمال مكة»', 'شمال مكة', [a('direction', 'شمال مكة')], ASKS),
  // The cities carry no aliases here (measured): «مكة» names no city record exactly — ask.
  row('probe A split «شمال مكة» owner', 'شمال مكة', [a('direction', 'شمال'), a('city', 'مكة')], ASKS),
  row('probe A «غرب العليا» model added شارع', 'غرب العليا', [a('direction', 'غرب العليا', { normalized_token: 'غرب شارع العليا' })], ASKS),
  row('probe A «غرب الملك فهد» model added طريق', 'غرب الملك فهد',
    [a('direction', 'غرب الملك فهد', { normalized_token: 'غرب طريق الملك فهد' })], [band('west', KFR)]),
  // A1 (grounding): the anchor's words «غرب طريق الملك فهد» are not in the customer's text.
  row('probe A span has طريق text lacks it', 'ابي فيلا غرب الملك فهد', [a('direction', 'غرب طريق الملك فهد')], ASKS),
  row('probe A near road no distance', 'قريب من طريق الملك فهد', [a('direction', 'طريق الملك فهد', { role_in_relation: 'proximity' })], ASKS),
  row('probe A «قريب من الرياض» alone', 'ابي قريب من الرياض', [a('city', 'الرياض')], ASKS),
  row('probe A «النرجس او الشمال بالرياض»', 'النرجس او الشمال بالرياض',
    [a('district', 'النرجس'), a('direction', 'الشمال'), a('city', 'الرياض')], [union(['d-narjis', ...NORTH_RUH])]),
  row('probe A Riyadh Park + city + dist', 'خلال 3 كيلو من الرياض بارك',
    [a('city', 'الرياض', { distance_m: 3000 }), a('landmark', 'الرياض بارك')], [near(PARK, 3000)]),
  row('probe A R9 + nested city', 'ابي شرق طريق الدمام',
    [a('direction', 'شرق طريق الدمام', { normalized_token: 'شرق الدمام' }), a('city', 'الدمام')], ASKS),
  row('probe A R9 split + city', 'ابي شرق طريق الدمام',
    [a('direction', 'شرق'), a('road', 'طريق الدمام', { normalized_token: 'الدمام' }), a('city', 'الدمام')], ASKS),
  row('probe A quote breaks nothing else', 'ابي "شمال الرياض"', [a('direction', 'شمال'), a('city', 'الرياض')], [zone('الرياض', 'north')]),
  // The Khobar road was never measured: its side cannot be checked — ask.
  row('probe A road side in named other city', 'شمال طريق الملك فهد بالخبر', [a('direction', 'شمال طريق الملك فهد'), a('city', 'الخبر')], ASKS),

  // ── Design §5.1 / §5.2 rows the probe does not carry ───────────────────────
  {
    name: '§5.1 #6 «ابي في شمال الرياض بس مو النرجس»',
    evidence: [ev('e1', 'ابي في شمال الرياض', [a('direction', 'شمال الرياض')]), ev('e2', 'بس مو النرجس', [a('district', 'النرجس')], 'negative')],
    expect: [zone('الرياض', 'north'), exc(poly('d-narjis'))],
  },
  row('§5.2 «شمال الرياض على طريق الملك فهد» v9d shape', 'شمال الرياض على طريق الملك فهد',
    [a('direction', 'شمال الرياض'), a('road', 'طريق الملك فهد', { role_in_relation: 'along' })], ASKS),
  row('§5.2 «بين طريق الملك فهد وطريق العليا»', 'بين طريق الملك فهد وطريق العليا',
    [a('road', 'طريق الملك فهد', { role_in_relation: 'boundary_start' }), a('road', 'طريق العليا', { role_in_relation: 'boundary_end' })], ASKS),
  row('§5.2 «جنوب الدائري الشمالي»', 'جنوب الدائري الشمالي', [a('direction', 'جنوب الدائري الشمالي')], [band('south', RING)]),
  row('§5.2 «شمال الرياض تقريبا»', 'شمال الرياض تقريبا', [a('direction', 'شمال'), a('city', 'الرياض')], [zone('الرياض', 'north')]),

  // ── Design §5.3 rows the probe does not carry ──────────────────────────────
  // §5.3 #3: the third quoting form (the probe has "…", (…) and «the»).
  row('§5.3 #3 guillemets «الرياض بارك»', 'ابي بيت قريب من «الرياض بارك»', [a('city', 'الرياض')], ASKS),
  row('§5.3 #1 twin bare word + King Abdullah Road side', 'ابي شمال طريق الملك عبدالله',
    [a('direction', 'شمال'), a('direction', 'شمال طريق الملك عبدالله')], [band('north', KAR)]),
  row('§5.3 #6 venue + region', 'قريب من النخيل مول في المنطقة الشرقية خلال 2 كيلو',
    [a('landmark', 'النخيل مول', { distance_m: 2000, role_in_relation: 'proximity' }), a('region', 'المنطقة الشرقية')], ASKS),
  {
    name: '§5.3 #6 a held region band is never distributed onto «العليا»',
    evidence: [
      ev('e1', 'ابي العليا', [a('district', 'العليا')]),
      ev('e2', 'او شمال طريق الملك فهد بالمنطقة الشرقية', [a('direction', 'شمال طريق الملك فهد'), a('region', 'المنطقة الشرقية')]),
    ],
    expect: [poly('d-olaya')],
  },
  // §5.3 #7c in the glued shape (no separate city anchor): the district must still be Jeddah's, or ask.
  row('§5.3 #7c «الروضة شمال جدة» one-anchor direction', 'الروضة شمال جدة', [a('district', 'الروضة'), a('direction', 'شمال جدة')],
    [union(['d-rawdah-jed', ...zoneIds('جدة', 'north')])]),
  row('§5.3 #7c «الروضة شمال جدة» one-anchor direction, Jeddah client', 'الروضة شمال جدة', [a('district', 'الروضة'), a('direction', 'شمال جدة')],
    [union(['d-rawdah-jed', ...zoneIds('جدة', 'north')])], { established: 'جدة' }),
  row('§5.3 #7c «الروابي شمال الدمام» one-anchor direction', 'الروابي شمال الدمام', [a('district', 'الروابي'), a('direction', 'شمال الدمام')],
    [union(['d-rawabi-dmm', ...zoneIds('الدمام', 'north')])]),
  // U1: Jeddah's only الحمراء is not «الحمراء شمال الرياض».
  row('U1 «الحمراء شمال الرياض» (the only الحمراء is Jeddah\'s)', 'الحمراء شمال الرياض', [a('district', 'الحمراء'), a('direction', 'شمال الرياض')], ASKS),
  row('§5.3 #7b «شمال المنطقة الشرقية» one anchor', 'ابي شمال المنطقة الشرقية', [a('direction', 'شمال المنطقة الشرقية')], ASKS),
  row('§5.3 #7b «شمال المنطقة الشرقية» split', 'ابي شمال المنطقة الشرقية', [a('direction', 'شمال'), a('region', 'المنطقة الشرقية')], ASKS),
  row('§5.3 #9 «غرب طريق مكة» (folded road token)', 'ابي غرب طريق مكة', [a('direction', 'غرب طريق مكة', { normalized_token: 'غرب طريق مكه' })], ASKS),
  row('§5.3 #10 «ابي في جدة بالشمال» Riyadh client', 'ابي في جدة بالشمال', [a('city', 'جدة'), a('direction', 'الشمال')], ASKS),
  row('§5.3 #10 «ابي في جدة بالشمال» Jeddah client', 'ابي في جدة بالشمال', [a('city', 'جدة'), a('direction', 'الشمال')],
    [zone('جدة', 'north')], { established: 'جدة' }),
  row('§5.3 #10 «ابي بالشمال في جدة» Jeddah client', 'ابي بالشمال في جدة', [a('direction', 'الشمال'), a('city', 'جدة')],
    [zone('جدة', 'north')], { established: 'جدة' }),
  {
    name: '§5.3 #12 «not south Riyadh» excludes south Riyadh',
    evidence: [ev('e1', 'not south Riyadh', [a('direction', 'south'), a('city', 'Riyadh')], 'negative')],
    expect: [exc(zone('الرياض', 'south'))],
  },

  // ── Design §5.4 rows the probe does not carry ──────────────────────────────
  row('§5.4 round 3 #23 «ابي في الشمال غرب طريق الملك فهد»', 'ابي في الشمال غرب طريق الملك فهد',
    [a('direction', 'الشمال'), a('direction', 'غرب طريق الملك فهد')], ASKS),
  row('§5.4 round 3 #8 «شمال الرياض، تحديدا شمال طريق الملك فهد»', 'شمال الرياض، تحديدا شمال طريق الملك فهد',
    [a('direction', 'شمال الرياض'), a('direction', 'شمال طريق الملك فهد')], ASKS),
  row('§5.4 round 3 #5 a distance not in the words', 'ابي قريب من طريق الملك فهد',
    [a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 3000 })], ASKS),
  row('§5.4 round 3 #5 sibling: «٣ كيلو» is in the words', 'ابي قريب من طريق الملك فهد ٣ كيلو',
    [a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 3000 })], [near(KFR, 3000)]),
  row('§5.4 #13 «ابي غرب طريق جدة» — never a Jeddah zone', 'ابي غرب طريق جدة', [a('direction', 'غرب طريق جدة')], ASKS),
  row('§5.4 «شمال الفهد» → «الملك فهد»', 'ابي شمال الفهد', [a('direction', 'شمال الفهد', { normalized_token: 'شمال الملك فهد' })], ASKS),
  row('§5.4 «جنوب حي سلمان»', 'ابي جنوب حي سلمان', [a('direction', 'جنوب حي سلمان')], ASKS),
  row('§5.4 «ابي فيلا شمال الملقا»', 'ابي فيلا شمال الملقا', [a('direction', 'شمال الملقا')], ASKS),

  // ── Design §5.5 stored shapes ──────────────────────────────────────────────
  row('§5.5 [direction شمال, city الرياض]', 'ابي في شمال الرياض', [a('direction', 'شمال'), a('city', 'الرياض')], [zone('الرياض', 'north')]),
  row('§5.5 [direction شمال] alone (BD5)', 'ابي بالشمال', [a('direction', 'الشمال')], [zone('الرياض', 'north')]),
  row('§5.5 «النرجس جنوب سلمان»', 'النرجس جنوب سلمان', [a('district', 'النرجس'), a('direction', 'جنوب سلمان')], [clip('south', ['d-narjis'], KSR)]),
  row('§5.5 «شمال طريق الملك سلمان» (whole road 0.507)', 'ابي شمال طريق الملك سلمان', [a('direction', 'شمال طريق الملك سلمان')], [band('north', KSR)]),
  row('§5.5 «جنوب سلمان»', 'جنوب سلمان', [a('direction', 'جنوب سلمان')], [band('south', KSR)]),
  row('§5.5 «شمال حي النرجس» split (BD4)', 'شمال حي النرجس', [a('direction', 'شمال'), a('district', 'النرجس')], ASKS),
  row('§5.5 «شمال حي النرجس» one anchor (P5a)', 'ابي شمال حي النرجس', [a('direction', 'شمال حي النرجس')], ASKS),
  row('§5.5 «المعذر الشمالي»', 'المعذر الشمالي', [a('district', 'المعذر'), a('direction', 'الشمالي')], ASKS),
  row('§5.5 «بحي الصفاء بالشرق» (BD4)', 'ابي بحي الصفاء بالشرق', [a('district', 'الصفاء'), a('direction', 'الشرق')], ASKS),
  row('§5.5 «في ضاحية خزام أو، … في الشمال» (BD4 not adjacent)', 'في ضاحية خزام أو، في الشمال',
    [a('district', 'خزام'), a('direction', 'الشمال')], [union(['d-khazam', ...NORTH_RUH])]),
  row('§5.5 «إذا فيه شي في الشمال … غير خزام» (BD4 not adjacent)', 'إذا فيه شي في الشمال … غير خزام',
    [a('direction', 'الشمال'), a('district', 'خزام')], [union([...NORTH_RUH, 'd-khazam'])]),
  row('§5.5 «الملجى جنب الملك فهد»', 'الملجى جنب الملك فهد', [a('road', 'الملك فهد')], ASKS),
  {
    name: '§5.5 «شمال الرياض أو شرق» (role none)',
    evidence: [ev('e1', 'شمال الرياض أو شرق', [a('direction', 'شمال الرياض'), a('direction', 'شرق')], 'none')],
    expect: ASKS,
  },

  // ── Design §6.5 adversarial rows ───────────────────────────────────────────
  row('adv «حول الرياض بارك» [city]', 'ابي حول الرياض بارك', [a('city', 'الرياض')], ASKS),
  row('adv «قريب من \'الرياض بارك\'» typed as a district (whole name)', "ابي قريب من 'الرياض بارك'", [a('district', 'الرياض بارك')], ASKS),
  row('adv «قريب من \'الرياض بارك\'» typed as a district (city word)', "ابي قريب من 'الرياض بارك'", [a('district', 'الرياض')], ASKS),
  row('adv «النخيل مول» typed as a district النخيل (near)', 'ابي قريب من النخيل مول', [a('district', 'النخيل')], ASKS),
  row('adv «النخيل مول» typed as a district النخيل', 'ابي شقة في النخيل مول', [a('district', 'النخيل')], ASKS),
  row('adv «شمال الرياض بارك» one anchor', 'ابي شمال الرياض بارك', [a('direction', 'شمال الرياض')], ASKS),
  {
    name: 'adv two cities in two mentions plus a bare direction',
    evidence: [
      ev('e1', 'ابي في جدة', [a('city', 'جدة')]),
      ev('e2', 'او الدمام', [a('city', 'الدمام')]),
      ev('e3', 'بالشمال', [a('direction', 'الشمال')]),
    ],
    expect: [union(['city-jeddah']), union(['city-dammam'])],
  },
  {
    // Found by this corpus (2026-10-04): Riyadh's الروضة was drawn — the established city settled the namesakes.
    name: 'adv another city named in one mention, a namesake district in the next',
    evidence: [ev('e1', 'ابي في جدة', [a('city', 'جدة')]), ev('e2', 'الروضة', [a('district', 'الروضة')])],
    expect: { anyOf: [[union(['city-jeddah']), poly('d-rawdah-jed')], [union(['city-jeddah'])]] },
  },
  row('adv Latin «Jeddah north», Riyadh client', 'Jeddah north', [a('city', 'Jeddah'), a('direction', 'north')], ASKS),
  row('adv Latin «Jeddah north», Jeddah client', 'Jeddah north', [a('city', 'Jeddah'), a('direction', 'north')], [zone('جدة', 'north')], { established: 'جدة' }),
  row('adv a hallucinated distance beside «10 دقايق»', 'ابي قريب من طريق الملك فهد 10 دقايق',
    [a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 1000 })], ASKS),
  {
    name: 'adv a distance said in ANOTHER turn only',
    evidence: [ev('e1', 'ابي قريب من طريق الملك فهد', [a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 })])],
    conversation: {
      channel: 'chat', id: 'conv-1',
      turns: [{ speaker: 'client', text: 'ابي قريب من طريق الملك فهد', ref: 'm1' }, { speaker: 'client', text: 'تقريبا 2 كيلو', ref: 'm2' }],
    },
    expect: ASKS,
  },
  {
    name: 'adv the distance in the mention\'s OWN turn (mention_span trimmed)',
    evidence: [ev('e1', 'قريب من طريق الملك فهد', [a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 })])],
    conversation: { channel: 'chat', id: 'conv-1', turns: [{ speaker: 'client', text: 'ابي قريب من طريق الملك فهد تقريبا 2 كيلو', ref: 'm1' }] },
    expect: [near(KFR, 2000)],
  },
  row('adv «النرجس او شمال طريق الملك سلمان» (V8)', 'النرجس او شمال طريق الملك سلمان',
    [a('district', 'النرجس'), a('direction', 'شمال طريق الملك سلمان')], ASKS),
  row('adv «النرجس، الشمال منه» (BD4)', 'النرجس، الشمال منه', [a('district', 'النرجس'), a('direction', 'الشمال')], ASKS),
  // A named city scopes the element lookup (P9) — Khobar's road, never Riyadh's.
  row('adv «في الخبر قريب من طريق الملك فهد خلال 2 كيلو»', 'ابي في الخبر قريب من طريق الملك فهد خلال 2 كيلو',
    [a('city', 'الخبر'), a('road', 'طريق الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 })], [near('KHB-ROAD-KFR', 2000)]),
  row('adv «النرجس شمال طريق الملك فهد بالخبر» — Narjis is not in Khobar', 'النرجس شمال طريق الملك فهد بالخبر',
    [a('district', 'النرجس'), a('direction', 'شمال طريق الملك فهد'), a('city', 'الخبر')], ASKS),
  row('adv one-anchor «شمال الدمام» from a Riyadh client', 'ابي شمال الدمام', [a('direction', 'شمال الدمام')], [zone('الدمام', 'north')]),
  row('adv «شرق الرياض او غرب الملك فهد» (V8)', 'شرق الرياض او غرب الملك فهد', [a('direction', 'شرق الرياض'), a('direction', 'غرب الملك فهد')], ASKS),
  // Venues: one place drawn twice is ONE place; two places, or only a longer name, ask.
  row('adv «العثيم مول» exact + far prefix branches', 'خلال 2 كيلو من العثيم مول', [a('landmark', 'العثيم مول', { distance_m: 2000 })], ASKS),
  row('adv «جامعة الملك سعود» station + campus', 'خلال 2 كيلو من جامعة الملك سعود', [a('landmark', 'جامعة الملك سعود', { distance_m: 2000 })], ASKS),

  // ── Repair round 1 (2026-10-04): the confirmed review findings ─────────────
  // #1 / #8 — P5 rule e: a bare SPAN whose TOKEN names the referent. The token's
  // referent was dropped and the ESTABLISHED city's zone drawn.
  row('R1#1 «ابي في جدة بالشمال» [«بالشمال» / «شمال جدة»]', 'ابي في جدة بالشمال',
    [a('direction', 'بالشمال', { normalized_token: 'شمال جدة' })], ASKS),
  row('R1#1 «ابي فيلا شمال جدة» [«شمال» / «شمال جدة»]', 'ابي فيلا شمال جدة',
    [a('direction', 'شمال', { normalized_token: 'شمال جدة' })], [zone('جدة', 'north')]),
  row('R1#1 «ابي غرب الملك فهد» [«غرب» / «غرب الملك فهد»]', 'ابي غرب الملك فهد',
    [a('direction', 'غرب', { normalized_token: 'غرب الملك فهد' })], [band('west', KFR)]),
  row('R1#1 «ابي غرب طريق الملك فهد» [«غرب» / «غرب طريق الملك فهد»]', 'ابي غرب طريق الملك فهد',
    [a('direction', 'غرب', { normalized_token: 'غرب طريق الملك فهد' })], [band('west', KFR)]),
  row('R1#1 Latin «west» / «west of King Fahd Road»', 'I want west of King Fahd Road',
    [a('direction', 'west', { normalized_token: 'west of King Fahd Road' })], [band('west', KFR)]),
  row('R1#1 «ابي جنوب سلمان» [«جنوب» / «جنوب الملك سلمان»]', 'ابي جنوب سلمان',
    [a('direction', 'جنوب', { normalized_token: 'جنوب الملك سلمان' })], [band('south', KSR)]),
  row('R1#1 «ابي شمال الرياض» [«شمال» / «شمال الرياض»], Jeddah client', 'ابي شمال الرياض',
    [a('direction', 'شمال', { normalized_token: 'شمال الرياض' })], [zone('الرياض', 'north')], { established: 'جدة' }),
  {
    name: 'R1#1 «ابي النرجس» + «او غرب الملك فهد» [«غرب» / «غرب الملك فهد»]',
    evidence: [ev('e1', 'ابي النرجس', [a('district', 'النرجس')]),
      ev('e2', 'او غرب الملك فهد', [a('direction', 'غرب', { normalized_token: 'غرب الملك فهد' })])],
    expect: [poly('d-narjis')],
  },
  row('R1#8 «جدة الشمال» [«الشمال» / «شمال جدة»]', 'جدة الشمال',
    [a('direction', 'الشمال', { normalized_token: 'شمال جدة' })], [zone('جدة', 'north')]),
  row('R1#8 «الدمام بالشمال» [«بالشمال» / «شمال الدمام»]', 'الدمام بالشمال',
    [a('direction', 'بالشمال', { normalized_token: 'شمال الدمام' })], [zone('الدمام', 'north')]),
  row('R1#8 «ابي في الرياض الشمال» [«الشمال» / «شمال الرياض»], Jeddah client', 'ابي في الرياض الشمال',
    [a('direction', 'الشمال', { normalized_token: 'شمال الرياض' })], [zone('الرياض', 'north')], { established: 'جدة' }),
  row('R1#8 «ابي على طريق الملك فهد من الغرب» [«الغرب» / «غرب طريق الملك فهد»]', 'ابي على طريق الملك فهد من الغرب',
    [a('direction', 'الغرب', { normalized_token: 'غرب طريق الملك فهد' })], [band('west', KFR)]),
  row('R1#8 «ابي في جدة بالشمال» [«بالشمال» / «شمال جده»]', 'ابي في جدة بالشمال',
    [a('direction', 'بالشمال', { normalized_token: 'شمال جده' })], ASKS),
  row('R1#8 a Riyadh token on a bare span still confirms Riyadh', 'ابي بالشمال',
    [a('direction', 'بالشمال', { normalized_token: 'شمال الرياض' })], [zone('الرياض', 'north')]),

  // #2 — I8 on element picks: a road's words inside a longer venue name, or after «حي».
  row('R1#2 «قريب من مستشفى الملك فهد خلال 2 كيلو» [road «الملك فهد»]', 'ابي قريب من مستشفى الملك فهد خلال 2 كيلو',
    [a('road', 'الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 })], ASKS),
  row('R1#2 «جنب مستشفى الملك فهد 2 كيلو» [road «الملك فهد» / «طريق الملك فهد»]', 'ابي جنب مستشفى الملك فهد 2 كيلو',
    [a('road', 'الملك فهد', { normalized_token: 'طريق الملك فهد', role_in_relation: 'proximity', distance_m: 2000 })], ASKS),
  row('R1#2 «قريب من حي الملك فهد خلال 2 كيلو» [road «الملك فهد»]', 'ابي قريب من حي الملك فهد خلال 2 كيلو',
    [a('road', 'الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 })], ASKS),
  row('R1#2 control: «قريب من طريق الملك فهد خلال 2 كيلو» [road «الملك فهد»]', 'ابي قريب من طريق الملك فهد خلال 2 كيلو',
    [a('road', 'الملك فهد', { role_in_relation: 'proximity', distance_m: 2000 })], [near(KFR, 2000)]),

  // #3 — I9: the SHORT city name («مكة», «المدينة») names no record exactly.
  {
    name: 'R1#3 «ابي في مكة» + «العزيزية» — never Riyadh\'s',
    evidence: [ev('e1', 'ابي في مكة', [a('city', 'مكة')]), ev('e2', 'العزيزية', [a('district', 'العزيزية')])],
    expect: [union(['city-makkah']), poly('d-aziziyah-mak')],
  },
  {
    name: 'R1#3 «ابي في مكة» + «بالشمال» — never north Riyadh',
    evidence: [ev('e1', 'ابي في مكة', [a('city', 'مكة')]), ev('e2', 'بالشمال', [a('direction', 'الشمال')])],
    expect: [union(['city-makkah']), zone('مكة المكرمة', 'north')],
  },
  {
    name: 'R1#3 «ابي شقة في المدينة» + «العزيزية» — never Riyadh\'s',
    evidence: [ev('e1', 'ابي شقة في المدينة', [a('city', 'المدينة')]), ev('e2', 'العزيزية', [a('district', 'العزيزية')])],
    expect: [union(['city-madinah'])],
  },

  // #4 — V8: «والا / وإلا / يا … يا» are «or».
  row('R1#4 «النرجس والا شمال طريق الملك سلمان»', 'النرجس والا شمال طريق الملك سلمان',
    [a('district', 'النرجس'), a('direction', 'شمال طريق الملك سلمان')], ASKS),
  row('R1#4 «النرجس وإلا شمال طريق الملك سلمان»', 'النرجس وإلا شمال طريق الملك سلمان',
    [a('district', 'النرجس'), a('direction', 'شمال طريق الملك سلمان')], ASKS),
  row('R1#4 «يا النرجس يا شمال طريق الملك سلمان»', 'يا النرجس يا شمال طريق الملك سلمان',
    [a('district', 'النرجس'), a('direction', 'شمال طريق الملك سلمان')], ASKS),
  {
    name: 'R1#4 «ابي النرجس» + «والا شمال طريق الملك سلمان» — never distributed into a clip',
    evidence: [ev('e1', 'ابي النرجس', [a('district', 'النرجس')]),
      ev('e2', 'والا شمال طريق الملك سلمان', [a('direction', 'شمال طريق الملك سلمان')])],
    expect: [poly('d-narjis'), band('north', KSR)],
  },

  // #5 / #9 — a named city offered as an ALTERNATIVE is not the scope.
  row('R1#5 «ابي شمال الرياض او جدة»', 'ابي شمال الرياض او جدة', [a('direction', 'شمال الرياض'), a('city', 'جدة')], ASKS),
  row('R1#9 «ابي الروضة او جدة»', 'ابي الروضة او جدة', [a('district', 'الروضة'), a('city', 'جدة')],
    [union(['d-rawdah-ruh', 'city-jeddah'])]),
  row('R1#9 «جدة او الروضة»', 'جدة او الروضة', [a('city', 'جدة'), a('district', 'الروضة')],
    [union(['d-rawdah-ruh', 'city-jeddah'])]),
  row('R1#9 «الروضة، جدة»', 'الروضة، جدة', [a('district', 'الروضة'), a('city', 'جدة')], ASKS),
  row('R1#9 «الروابي ولا الدمام»', 'الروابي ولا الدمام', [a('district', 'الروابي'), a('city', 'الدمام')],
    [union(['d-rawabi-ruh', 'city-dammam'])]),
  row('R1#9 «شمال طريق الملك عبدالله او جدة»', 'شمال طريق الملك عبدالله او جدة',
    [a('direction', 'شمال طريق الملك عبدالله'), a('city', 'جدة')], ASKS),

  // #6 — BD4 asks before BD3: a city word never turns a district's side into the city's whole zone.
  row('R1#6 «ابي شمال حي النرجس بالرياض»', 'ابي شمال حي النرجس بالرياض',
    [a('direction', 'شمال'), a('district', 'حي النرجس'), a('city', 'الرياض')], ASKS),
  row('R1#6 «ابي شمال النرجس بالرياض»', 'ابي شمال النرجس بالرياض',
    [a('direction', 'شمال'), a('district', 'النرجس'), a('city', 'الرياض')], ASKS),
  row('R1#6 «ابي بحي الصفاء بالشرق في الرياض»', 'ابي بحي الصفاء بالشرق في الرياض',
    [a('district', 'حي الصفاء'), a('direction', 'بالشرق'), a('city', 'الرياض')], ASKS),

  // #7 — P5 rule f: a side only the TOKEN gave must be said by the customer.
  row('R1#7 «ابي قريب من الملك فهد» [«الملك فهد» / «غرب الملك فهد»]', 'ابي قريب من الملك فهد',
    [a('direction', 'الملك فهد', { normalized_token: 'غرب الملك فهد' })], ASKS),
  row('R1#7 «ابي فيلا على طريق الملك فهد» [«طريق الملك فهد» / «غرب طريق الملك فهد»]', 'ابي فيلا على طريق الملك فهد',
    [a('direction', 'طريق الملك فهد', { normalized_token: 'غرب طريق الملك فهد' })], ASKS),
];

// ─────────────────────────────────────────────────────────────────────────────
// The judge
// ─────────────────────────────────────────────────────────────────────────────

function ctxFor(r: Row, disabledChecks?: ReadonlySet<CheckName>): RunContext {
  return {
    client_id: 'client-1', checkpoint_id: 'cp-1', maximum_safe_action: 'propose',
    resolution: { db: strictDb(!r.noPnuAliases), preferCountry: 'SA', established_city: r.established ?? 'الرياض', universe_hint: 'organizational_default' },
    universe, config,
    ...(r.conversation ? { conversation: r.conversation } : {}),
    ...(disabledChecks ? { disabledChecks } : {}),
  };
}
async function runRow(r: Row, disabledChecks?: ReadonlySet<CheckName>): Promise<ReviewFirstResult> {
  return runReviewFirst(r.evidence, [], ctxFor(r, disabledChecks), ports);
}

/** Every NON-stub recipe the review would show, as the assertion compares it. */
function resolvedRecs(pref: GeoPreference): Rec[] {
  const out: Rec[] = [];
  for (const g of pref.groups) {
    for (const c of g.clauses) {
      for (const ref of c.anyOf) {
        const x = ref.recipe;
        if (!x || x.geo_data_version === 'stub') continue;
        out.push({
          op: x.operation, ids: [...x.resolved_element_ids].sort(), side: x.side ?? null,
          radius: typeof x.radius_or_band_m === 'number' ? x.radius_or_band_m : null, polarity: c.op,
        });
      }
    }
  }
  return out;
}
const recKey = (r: Rec): string => JSON.stringify([r.op, r.ids, r.side, r.radius, r.polarity]);
const recText = (r: Rec): string =>
  `${r.polarity === 'exclude' ? 'NOT ' : ''}${r.op}${r.side ? `/${r.side}` : ''}[${r.ids.join(',')}]${r.radius !== null ? `@${r.radius}` : ''}`;

/** `small` is a sub-multiset of `big`. */
function within(small: readonly Rec[], big: readonly Rec[]): boolean {
  const left = new Map<string, number>();
  for (const r of big) left.set(recKey(r), (left.get(recKey(r)) ?? 0) + 1);
  for (const r of small) {
    const n = left.get(recKey(r)) ?? 0;
    if (n === 0) return false;
    left.set(recKey(r), n - 1);
  }
  return true;
}

type Verdict = 'right' | 'asked' | 'partly_asked' | 'wrong';
/** right = exactly an expected outcome; asked / partly_asked = less than expected, nothing else; wrong = anything not expected. */
function judge(actual: readonly Rec[], expectation: Expectation): Verdict {
  const alternatives = Array.isArray(expectation) ? [expectation] : expectation.anyOf;
  let best: Verdict = 'wrong';
  const rank: Record<Verdict, number> = { wrong: 0, asked: 1, partly_asked: 2, right: 3 };
  for (const alt of alternatives) {
    if (!within(actual, alt)) continue;
    const v: Verdict = actual.length === alt.length ? 'right' : actual.length === 0 ? 'asked' : 'partly_asked';
    if (rank[v] > rank[best]) best = v;
  }
  return best;
}
const expectsPlace = (e: Expectation): boolean => (Array.isArray(e) ? e.length > 0 : e.anyOf.every((x) => x.length > 0));

interface Report { name: string; verdict: Verdict; expected: string; got: string; reasons: string }
const reports: Report[] = [];

describe('the never-wrong corpus (strict fake map): a resolved place is always the expected one', () => {
  it('holds a fixture for every design section', () => {
    expect(ROWS.filter((r) => r.name.startsWith('probe ')).length).toBe(69); // 68 probe cases, PNU run on both maps
    expect(ROWS.length).toBeGreaterThan(110);
    expect(new Set(ROWS.map((r) => r.name)).size).toBe(ROWS.length);
  });

  for (const r of ROWS) {
    it(r.name, async () => {
      const res = await runRow(r);
      const actual = resolvedRecs(res.compiled);
      const verdict = judge(actual, r.expect);
      const alternatives = Array.isArray(r.expect) ? [r.expect] : r.expect.anyOf;
      const expected = alternatives.map((alt) => (alt.length ? alt.map(recText).join(' + ') : 'asks')).join('  OR  ');
      const got = actual.length ? actual.map(recText).join(' + ') : 'asks';
      const reasons = res.resolutions.map((x) => (x.status === 'resolved' ? 'ok' : `${x.status}:${x.reason}`)).join(', ');
      reports.push({ name: r.name, verdict, expected, got, reasons });
      expect(verdict, `WRONG PLACE — expected ${expected}; got ${got} (resolutions: ${reasons})`).not.toBe('wrong');
      if (actual.length === 0) {
        // An ask saves nothing and tells the rep why.
        expect(geoPreferenceToLocationItems(res.compiled)).toEqual([]);
        if (r.evidence.some((e) => e.preference_role === 'positive' || e.preference_role === 'negative')) {
          expect(res.ambiguity.length, 'an ask with no ambiguity entry').toBeGreaterThan(0);
        }
      }
    });
  }
});

afterAll(() => {
  if (reports.length === 0) return;
  const placeRows = reports.filter((p) => expectsPlace(ROWS.find((r) => r.name === p.name)!.expect));
  const asked = placeRows.filter((p) => p.verdict === 'asked' || p.verdict === 'partly_asked');
  const lines = [
    `[NEVER-WRONG] rows: ${reports.length}; right: ${reports.filter((p) => p.verdict === 'right').length}; wrong: ${reports.filter((p) => p.verdict === 'wrong').length}`,
    `[NEVER-WRONG] ask rate where a place was expected: ${asked.length}/${placeRows.length} (${placeRows.length ? Math.round((100 * asked.length) / placeRows.length) : 0}%)`,
    ...asked.map((p) => `[NEVER-WRONG]   ASKED  ${p.name} — expected ${p.expected}; got ${p.got} (${p.reasons})`),
    ...reports.filter((p) => p.verdict === 'wrong').map((p) => `[NEVER-WRONG]   WRONG  ${p.name} — expected ${p.expected}; got ${p.got} (${p.reasons})`),
    // NEVER_WRONG_VERBOSE=1: every row with its reason codes (run with --silent=false).
    ...(process.env.NEVER_WRONG_VERBOSE === '1'
      ? reports.map((p) => `[NEVER-WRONG]   ${p.verdict.padEnd(12)} ${p.name} — got ${p.got} (${p.reasons})`)
      : []),
  ];
  console.log(lines.join('\n'));
});

// ─────────────────────────────────────────────────────────────────────────────
// MONOTONICITY over this corpus (design §6.4): switching any set of checks off
// can only GROW the resolved set, and never changes what ALL-checks resolved —
// except where a road side was distributed onto other mentions in either run.
// ─────────────────────────────────────────────────────────────────────────────

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

function recipeByEvidence(r: ReviewFirstResult): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of r.compiled.groups) {
    for (const c of g.clauses) {
      for (const ref of c.anyOf) {
        if (ref.recipe.geo_data_version === 'stub') continue;
        const eid = ref.geometry_id.startsWith('geo:') ? ref.geometry_id.slice(4) : ref.geometry_id;
        out.set(eid, JSON.stringify([ref.recipe.operation, [...ref.recipe.resolved_element_ids].sort(), ref.recipe.side ?? null, ref.recipe.radius_or_band_m ?? null, c.op]));
      }
    }
  }
  return out;
}

describe('MONOTONICITY over the never-wrong corpus', () => {
  it('R(ALL) ⊆ R(S) for every single check (alone, all-but-one) and 50 random subsets; recipes unchanged', async () => {
    const random = rng(20261004);
    const enabledSets: CheckName[][] = [
      ...ALL_CHECKS.map((c) => [c]),
      ...ALL_CHECKS.map((c) => ALL_CHECKS.filter((x) => x !== c)),
      ...Array.from({ length: 50 }, () => ALL_CHECKS.filter(() => random() < 0.5)),
    ];
    const failures: string[] = [];
    let compared = 0;
    for (const r of ROWS) {
      const all = await runRow(r);
      const rAll = new Set(all.resolved_evidence_ids);
      const recAll = recipeByEvidence(all);
      for (const on of enabledSets) {
        const disabled = new Set<CheckName>(ALL_CHECKS.filter((x) => !on.includes(x)));
        const s = await runRow(r, disabled);
        const rS = new Set(s.resolved_evidence_ids);
        const off = `[${[...disabled].join(',')}] off`;
        for (const id of rAll) if (!rS.has(id)) failures.push(`${r.name}: ${id} resolved with every check on but not with ${off}`);
        const distributed = (x: ReviewFirstResult, id: string) => x.trace.some((t) => t.kind === 'distributed_clip' && t.evidence_id === id);
        const anyDistribution = all.trace.some((t) => t.kind === 'distributed_clip') || s.trace.some((t) => t.kind === 'distributed_clip');
        const recS = recipeByEvidence(s);
        for (const id of rAll) {
          if (distributed(all, id) || distributed(s, id)) continue;
          if (!recAll.has(id) || !recS.has(id)) {
            if (!anyDistribution) failures.push(`${r.name}: ${id} lost its ref with ${off}`);
            continue;
          }
          if (recS.get(id) !== recAll.get(id)) failures.push(`${r.name}: ${id} changed shape with ${off}: ${recAll.get(id)} → ${recS.get(id)}`);
          compared += 1;
        }
      }
    }
    expect(failures.slice(0, 20)).toEqual([]);
    expect(compared).toBeGreaterThan(1000);
  }, 600_000);
});
