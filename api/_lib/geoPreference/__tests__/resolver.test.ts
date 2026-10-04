import { describe, it, expect } from 'vitest';
import {
  resolveAnchor, parseDirection, placeKey, roadKey, cityArabicName, sameCity, stripDirectionClitic, spanReferent, RESOLVER_VERSION,
  type ResolverDb, type ResolutionContext, type DistrictCandidate, type ElementCandidate, type CityCandidate,
} from '../resolver.js';
import type { AnchorToken } from '../ontology.js';
import { latinVariants } from '../latinNames.js';
import { fakeCityLabel, fakeRoadAxis, MEASURED_ROAD_AXIS } from './fakeGeoMap.js';

/**
 * Unit tests for the anchor→geometry resolver. Everything runs against a
 * FakeResolverDb (no live Postgres) so the LOGIC — the exact-match selection gate,
 * the ambiguity gate, spatial disambiguation, and the underspecified-op gates — is
 * verified deterministically. The Supabase-backed port (resolverDb.ts) is a thin
 * adapter over the SAME RPCs the Project Finder already uses; it is exercised
 * against the live DB, not here (see the DB-vs-fake note in the task report).
 */

// ── Fixture districts. `matchIlike` mimics the loose ILIKE candidate generation
//    (bidirectional substring, like fuzzyContains): names containing OR contained
//    by the token surface as candidates. Selection is the resolver's job. ────────
const DISTRICTS: DistrictCandidate[] = [
  mkDistrict('d-mahdiyah', 'المهدية', 'Al Mahdiyah', 'الرياض', 'الرياض', 'منطقة الرياض', 'SA', 24.63, 46.55),
  mkDistrict('d-irqah', 'عرقة', 'Irqah', 'الرياض', 'الرياض', 'منطقة الرياض', 'SA', 24.68, 46.55),
  // Two exact namesakes → the ambiguity/disambiguation case.
  mkDistrict('d-khalidiyah-ryd', 'الخالدية', 'Al Khalidiyah', 'الرياض', 'الرياض', 'منطقة الرياض', 'SA', 24.72, 46.72),
  mkDistrict('d-khalidiyah-jed', 'الخالدية', 'Al Khalidiyah', 'جدة', 'جدة', 'منطقة مكة', 'SA', 21.55, 39.19),
  // The Eastern-Province الجبيل — a NEAR-STRING to الجبيلة that must NEVER be picked.
  mkDistrict('d-jubail', 'الجبيل', 'Al Jubail', 'الجبيل', 'الجبيل', 'المنطقة الشرقية', 'SA', 27.0, 49.66),
  // Official spellings a customer mangles: «النرجس» said as «نرجس», «المحمدية» typed «المحمديه».
  mkDistrict('d-narjis-ryd', 'حي النرجس', 'An Narjis', 'الرياض', 'الرياض', 'منطقة الرياض', 'SA', 24.85, 46.65),
  mkDistrict('d-mohammadiyah', 'حي المحمدية', 'Al Mohammadiyah', 'الرياض', 'الرياض', 'منطقة الرياض', 'SA', 24.73, 46.65),
  // English-letter spellings (calib-003, 2026-09-27): the customer types «Malga».
  mkDistrict('d-malqa', 'حي الملقا', 'Al Malqa Dist.', 'الرياض', 'الرياض', 'منطقة الرياض', 'SA', 24.80, 46.60),
  mkDistrict('d-yasmin', 'حي الياسمين', 'Al Yasmeen Dist.', 'الرياض', 'الرياض', 'منطقة الرياض', 'SA', 24.83, 46.63),
];

const KING_FAHD_ROAD: ElementCandidate = {
  external_id: 'RUH-ROAD-0694', name_ar: 'طريق الملك فهد', name_en: 'King Fahd Road', aliases: [],
  geom_kind: 'linestring', category: 'roads_major', type: null, city: 'Riyadh', country_code: 'SA',
  lat: 24.7, lng: 46.68, confidence_score: 0.8, review_status: 'approved', is_active: true,
};
const KING_FAHD_BRANCH: ElementCandidate = { ...KING_FAHD_ROAD, external_id: 'RUH-ROAD-0696', name_ar: 'طريق الملك فهد الفرعي', name_en: 'King Fahad Branch Road' };
const KING_FAHD_LIBRARY: ElementCandidate = { ...KING_FAHD_ROAD, external_id: 'RUH-METR-0363', name_ar: 'مكتبة الملك فهد', name_en: 'King Fahad Library', geom_kind: 'point', category: 'metro_stations' };

function mkCity(id: string, name_ar: string, name_en: string, aliases: string[] = []): CityCandidate {
  return { id, name_ar, name_en, aliases, region_name_ar: '', region_name_en: '', country_code: 'SA', centroid_lat: null, centroid_lng: null };
}
const CITY_FIXTURES: CityCandidate[] = [
  mkCity('c-riyadh', 'الرياض', 'Riyadh'),
  mkCity('c-jeddah', 'جدة', 'Jeddah'),
  // No alias «مكة»: the short name is a leading-words namesake, never exact.
  mkCity('c-makkah', 'مكة المكرمة', 'Makkah'),
  mkCity('c-dammam', 'الدمام', 'Dammam'),
];
/** Like the live ILIKE generator: a city whose name CONTAINS the token (folded / case-insensitive). */
function citiesIlike(token: string): CityCandidate[] {
  const t = fold(token);
  return CITY_FIXTURES.filter((c) => !!t && (fold(c.name_ar).includes(t) || c.name_en.toLowerCase().includes(t)));
}

function mkDistrict(
  id: string, name_ar: string, name_en: string, city_name_ar: string, city_id: string,
  region_name_ar: string, country_code: string, lat: number, lng: number,
): DistrictCandidate {
  return {
    id, name_ar, name_en, aliases: [], city_id, city_name_ar, city_name_en: '',
    region_name_ar, region_name_en: '', country_code, centroid_lat: lat, centroid_lng: lng,
  };
}

// Very small canonical fold (ة→ه, ى→ي, strip حي, tatweel) matching canonicalPlaceName.
function fold(s: string): string {
  return s.replace(/^\s*حي\s+/, '').replace(/ـ/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim().toLowerCase();
}
function matchIlike(rows: DistrictCandidate[], token: string): DistrictCandidate[] {
  // The real port also tries the Latin spelling variants (resolverDb.ilikeModel).
  const ts = [token, ...latinVariants(token)].map((v) => fold(v.replace(/^\s*حي\s+/, '')));
  return rows.filter((r) => {
    const na = fold(r.name_ar), ne = fold(r.name_en);
    return ts.some((t) => na.includes(t) || t.includes(na) || ne.includes(t) || t.includes(ne));
  });
}

function fakeDb(overrides: Partial<ResolverDb> = {}): ResolverDb {
  return {
    async findDistricts(token) { return matchIlike(DISTRICTS, token); },
    async findCities() { return []; },
    async findElements() { return []; },
    async zoneDistricts(city, zone) {
      if (fold(city) === fold('الرياض') && zone === 'north') {
        return [
          { district_id: 'd-narjis', district_name: 'النرجس' },
          { district_id: 'd-yasmin', district_name: 'الياسمين' },
          { district_id: 'd-arid', district_name: 'العارض' },
        ];
      }
      return [];
    },
    async districtForPoint() { return null; },
    // The measured axis of the one real road here; every other id → found:false.
    roadAxis: fakeRoadAxis({ 'RUH-ROAD-0694': { road: MEASURED_ROAD_AXIS.kingFahd } }),
    cityLabel: fakeCityLabel(CITY_FIXTURES),
    namesInText: async () => [],
    ...overrides,
  };
}

const ctx = (over: Partial<ResolutionContext> & { db?: ResolverDb } = {}): ResolutionContext =>
  ({ db: over.db ?? fakeDb(), preferCountry: 'SA', ...over });

const anchor = (t: AnchorToken['anchor_type'], span: string, normalized = span): AnchorToken =>
  ({ anchor_type: t, span, normalized_token: normalized });

describe('resolveAnchor — admin place (district)', () => {
  it('resolves «حي المهدية» (canonicalization strips حي)', async () => {
    const r = await resolveAnchor(anchor('district', 'حي المهدية', 'المهدية'), ctx());
    expect(r.status).toBe('resolved');
    expect(r.recipe?.operation).toBe('district_polygon');
    expect(r.recipe?.resolved_element_ids).toEqual(['d-mahdiyah']);
  });

  it('resolves a unique «عرقة»', async () => {
    const r = await resolveAnchor(anchor('district', 'عرقة'), ctx());
    expect(r.status).toBe('resolved');
    expect(r.recipe?.resolved_element_ids).toEqual(['d-irqah']);
  });

  it('«الجبيلة» (absent from catalog) → needs_confirm(outside_admin), never the wrong الجبيل', async () => {
    const r = await resolveAnchor(anchor('district', 'الجبيلة'), ctx({ established_city: 'الرياض' }));
    expect(r.status).toBe('needs_confirm');
    expect(r.reason).toBe('outside_admin');
    // Prove the near-string الجبيل was a generated candidate yet was NOT selected.
    expect(matchIlike(DISTRICTS, 'الجبيلة').some((c) => c.id === 'd-jubail')).toBe(true);
    expect(r.recipe).toBeUndefined();
  });

  it('«الخالدية» with Riyadh context → the RIYADH one (spatial/context, not string)', async () => {
    const r = await resolveAnchor(anchor('district', 'الخالدية'), ctx({ established_city: 'الرياض' }));
    expect(r.status).toBe('resolved');
    expect(r.recipe?.resolved_element_ids).toEqual(['d-khalidiyah-ryd']);
    expect(r.recipe?.universe_source).toBe('established_context');
  });

  it('«الخالدية» with NO context → needs_confirm(ambiguous_entity) (no lowest-id tiebreak)', async () => {
    const r = await resolveAnchor(anchor('district', 'الخالدية'), ctx());
    expect(r.status).toBe('needs_confirm');
    expect(r.reason).toBe('ambiguous_entity');
  });

  it('«الخالدية» disambiguated by a prior-anchor pin near Jeddah → the JEDDAH one', async () => {
    const r = await resolveAnchor(
      anchor('district', 'الخالدية'),
      ctx({ prior_anchors: [{ lat: 21.5, lng: 39.2, city_id: 'جدة' }] }),
    );
    expect(r.status).toBe('resolved');
    expect(r.recipe?.resolved_element_ids).toEqual(['d-khalidiyah-jed']);
  });
});

describe('resolveAnchor — direction + city', () => {
  it('«شمال الرياض» → zone_union via wassell_city_zone_districts', async () => {
    const r = await resolveAnchor(anchor('direction', 'شمال الرياض'), ctx());
    expect(r.status).toBe('resolved');
    expect(r.recipe?.operation).toBe('zone_union');
    expect(r.recipe?.resolved_element_ids).toEqual(['d-narjis', 'd-yasmin', 'd-arid']);
  });

  it('a direction with no city → needs_confirm(missing_city_for_zone)', async () => {
    const r = await resolveAnchor(anchor('direction', 'شمال'), ctx());
    expect(r.status).toBe('needs_confirm');
    expect(r.reason).toBe('missing_city_for_zone');
  });
});

describe('resolveAnchor — underspecified operations (no silent default)', () => {
  it('a bare «قريب من الطريق» (proximity, no radius) → needs_confirm(missing_radius)', async () => {
    const db = fakeDb({
      async findElements() {
        return [{
          external_id: 'rd-king-fahd', name_ar: 'طريق الملك فهد', name_en: 'King Fahd Rd', aliases: [],
          geom_kind: 'linestring', category: 'road', type: 'highway', city: 'الرياض', country_code: 'SA',
          lat: 24.7, lng: 46.67, confidence_score: 1, review_status: 'approved', is_active: true,
        }];
      },
    });
    const r = await resolveAnchor(anchor('road', 'طريق الملك فهد'), ctx({ db, proximity: true }));
    expect(r.status).toBe('needs_confirm');
    expect(r.reason).toBe('missing_radius');
  });

  it('a landmark with no radius → needs_confirm(missing_radius)', async () => {
    const db = fakeDb({
      async findElements() {
        return [{
          external_id: 'kafd', name_ar: 'كافد', name_en: 'KAFD', aliases: [], geom_kind: 'point',
          category: 'business_zone', type: 'financial_district', city: 'الرياض', country_code: 'SA',
          lat: 24.76, lng: 46.64, confidence_score: 1, review_status: 'approved', is_active: true,
        }];
      },
    });
    const r = await resolveAnchor(anchor('landmark', 'كافد'), ctx({ db }));
    expect(r.status).toBe('needs_confirm');
    expect(r.reason).toBe('missing_radius');
  });

  it('sales agent path: no distance → 3 km landmark / 1 km metro, marked default; a stated one still wins', async () => {
    const el = (category: string) => fakeDb({
      async findElements() {
        return [{
          external_id: 'x', name_ar: 'كافد', name_en: 'KAFD', aliases: [], geom_kind: 'point',
          category, type: 't', city: 'الرياض', country_code: 'SA',
          lat: 24.76, lng: 46.64, confidence_score: 1, review_status: 'approved', is_active: true,
        }];
      },
    });
    const near = { landmark: 3000, metro: 1000 };
    const land = await resolveAnchor(anchor('landmark', 'كافد'), ctx({ db: el('business_zone'), default_near_radius_m: near }));
    expect(land.recipe?.radius_or_band_m).toBe(3000);
    expect(land.facts?.radius_source).toBe('default');
    const metro = await resolveAnchor(anchor('landmark', 'كافد'), ctx({ db: el('metro_stations'), default_near_radius_m: near }));
    expect(metro.recipe?.radius_or_band_m).toBe(1000);
    const stated = await resolveAnchor(anchor('landmark', 'كافد'), ctx({ db: el('metro_stations'), default_near_radius_m: near, radius_m: 500 }));
    expect(stated.recipe?.radius_or_band_m).toBe(500);
    expect(stated.facts?.radius_source).toBe('stated');
  });

  it('a landmark WITH an explicit radius → within_radius resolved', async () => {
    const db = fakeDb({
      async findElements() {
        return [{
          external_id: 'kafd', name_ar: 'كافد', name_en: 'KAFD', aliases: [], geom_kind: 'point',
          category: 'business_zone', type: 'financial_district', city: 'الرياض', country_code: 'SA',
          lat: 24.76, lng: 46.64, confidence_score: 1, review_status: 'approved', is_active: true,
        }];
      },
    });
    const r = await resolveAnchor(anchor('landmark', 'كافد'), ctx({ db, radius_m: 3000 }));
    expect(r.status).toBe('resolved');
    expect(r.recipe?.operation).toBe('within_radius');
    expect(r.recipe?.radius_or_band_m).toBe(3000);
    expect(r.recipe?.resolved_element_ids).toEqual(['kafd']);
  });

  it('«بين طريقين» with only one road → needs_confirm(corridor_underspecified)', async () => {
    const r = await resolveAnchor(
      anchor('relative_ref', 'بين طريقين'),
      ctx({ corridor: true, corridor_roads: [anchor('road', 'طريق الملك فهد')] }),
    );
    expect(r.status).toBe('needs_confirm');
    expect(r.reason).toBe('corridor_underspecified');
  });
});

describe('resolveAnchor — road + direction', () => {
  it('road + direction → directional_band (bounded, organizational_default depth)', async () => {
    const db = fakeDb({
      async findElements() {
        return [{
          external_id: 'rd-king-fahd', name_ar: 'طريق الملك فهد', name_en: 'King Fahd Rd', aliases: [],
          geom_kind: 'linestring', category: 'road', type: 'highway', city: 'الرياض', country_code: 'SA',
          lat: 24.7, lng: 46.67, confidence_score: 1, review_status: 'approved', is_active: true,
        }];
      },
    });
    const r = await resolveAnchor(anchor('road', 'طريق الملك فهد'), ctx({ db, direction: 'شرق' }));
    expect(r.status).toBe('resolved');
    expect(r.recipe?.operation).toBe('directional_band');
    expect(r.recipe?.universe_source).toBe('organizational_default');
    expect(r.recipe?.radius_or_band_m).toBe(5000);
  });
});

describe('resolveAnchor — pin', () => {
  it('pin inside a district → pin_containing_district + keeps the point', async () => {
    const db = fakeDb({
      async districtForPoint() {
        return { district_record_id: 'd-mahdiyah', city_id: 'الرياض', region_id: 'منطقة الرياض' };
      },
    });
    const r = await resolveAnchor(anchor('pin', 'دبوس'), ctx({ db, pin: { lat: 24.63, lng: 46.55 } }));
    expect(r.status).toBe('resolved');
    expect(r.recipe?.operation).toBe('pin_containing_district');
    expect(r.recipe?.resolved_element_ids).toEqual(['d-mahdiyah']);
    expect(r.recipe?.source_anchors[0]?.normalized_token).toBe('24.63,46.55');
  });

  it('pin with unclear scope → needs_confirm(pin_scope_unclear)', async () => {
    const r = await resolveAnchor(anchor('pin', 'دبوس'), ctx({ pin: { lat: 24.6, lng: 46.5 }, pin_scope_ambiguous: true }));
    expect(r.status).toBe('needs_confirm');
    expect(r.reason).toBe('pin_scope_unclear');
  });
});

describe('resolveAnchor — a side of a ROAD («غرب الملك فهد»), not a city zone (2026-09-15)', () => {
  const roadsDb = () => fakeDb({
    async findElements(token) {
      // The live RPC returns roads AND points for «الملك فهد»; the resolver must pick the line.
      return roadKey(token) === roadKey('طريق الملك فهد') || token.includes('الملك فهد') ? [KING_FAHD_LIBRARY, KING_FAHD_BRANCH, KING_FAHD_ROAD] : [];
    },
  });

  it('city lookup is empty for «الملك فهد» → the King Fahd ROAD wins → directional_band (default depth)', async () => {
    const r = await resolveAnchor(anchor('direction', 'غرب الملك فهد'), ctx({ db: roadsDb(), established_city: 'الرياض' }));
    expect(r.status).toBe('resolved');
    expect(r.recipe?.operation).toBe('directional_band');
    expect(r.recipe?.resolved_element_ids).toEqual(['RUH-ROAD-0694']); // not the branch road, not the library
    expect(r.recipe?.radius_or_band_m).toBeGreaterThan(0);
    expect(r.recipe?.universe_source).toBe('organizational_default');
  });

  it('«شمال الرياض» still resolves as the CITY zone (city before road)', async () => {
    const r = await resolveAnchor(anchor('direction', 'شمال الرياض'), ctx({ db: roadsDb() }));
    expect(r.status).toBe('resolved');
    expect(r.recipe?.operation).toBe('zone_union');
  });

  it('«الشمال» (article on the direction word) and «شمال_الرياض» (underscore) both parse', async () => {
    expect(parseDirection('الشمال')).toEqual({ zone: 'north', rest: '' });
    expect(parseDirection('شمال_الرياض')).toEqual({ zone: 'north', rest: 'الرياض' });
    const r = await resolveAnchor(anchor('direction', 'الشمال'), ctx({ established_city: 'الرياض' }));
    expect(r.status).toBe('resolved');
    expect(r.recipe?.operation).toBe('zone_union');
  });

  it('a side of something that is neither a city nor a road → needs_confirm(side_of_unknown_referent), never a guess', async () => {
    const r = await resolveAnchor(anchor('direction', 'غرب المزرعة'), ctx({ established_city: 'الرياض' }));
    expect(r.status).toBe('needs_confirm');
    expect(r.reason).toBe('side_of_unknown_referent');
  });
});

describe('resolveAnchor — article-insensitive and spelling-tolerant district match', () => {
  it('«نرجس» (no article) resolves «حي النرجس»', async () => {
    const r = await resolveAnchor(anchor('district', 'نرجس'), ctx({ established_city: 'الرياض' }));
    expect(r.status).toBe('resolved');
    expect(r.recipe?.resolved_element_ids).toEqual(['d-narjis-ryd']);
  });
  it('«المحمديه» (ه for ة) resolves «حي المحمدية»', async () => {
    const r = await resolveAnchor(anchor('district', 'المحمديه'), ctx({ established_city: 'الرياض' }));
    expect(r.status).toBe('resolved');
    expect(r.recipe?.resolved_element_ids).toEqual(['d-mohammadiyah']);
  });
  it('a Riyadh client naming a district that exists only ABROAD is asked about, never placed abroad («الحمرة»)', async () => {
    const hamra = mkDistrict('d-hamra-uaq', 'الحمرة', 'Al Hamra', 'أم القيوين', 'أم القيوين', 'أم القيوين', 'AE', 25.5, 55.6);
    const db = fakeDb({ async findDistricts(token) { return matchIlike([...DISTRICTS, hamra], token); } });
    const r = await resolveAnchor(anchor('district', 'الحمرة'), ctx({ established_city: 'الرياض', db }));
    expect(r.status).toBe('needs_confirm');
    expect(r.recipe?.resolved_element_ids ?? []).not.toContain('d-hamra-uaq');
  });
  it('«Malga» (English letters, g for ق) resolves «حي الملقا» through its English name', async () => {
    const r = await resolveAnchor(anchor('district', 'Malga'), ctx({ established_city: 'الرياض' }));
    expect(r.status).toBe('resolved');
    expect(r.recipe?.resolved_element_ids).toEqual(['d-malqa']);
  });
  it('«Yasmin» resolves «حي الياسمين» («Al Yasmeen Dist.»)', async () => {
    const r = await resolveAnchor(anchor('district', 'Yasmin'), ctx({ established_city: 'الرياض' }));
    expect(r.status).toBe('resolved');
    expect(r.recipe?.resolved_element_ids).toEqual(['d-yasmin']);
  });
  it('an English spelling that matches nothing exactly is NOT guessed («Malqah» ≠ «Al Mahdiyah»)', async () => {
    const r = await resolveAnchor(anchor('district', 'Mahdi'), ctx({ established_city: 'الرياض' }));
    expect(r.status).not.toBe('resolved');
  });
  it('a mangled normalized_token falls back to the verbatim span', async () => {
    const r = await resolveAnchor(anchor('district', 'المهدية', 'المهديه_'), ctx());
    expect(r.status).toBe('resolved');
    expect(r.recipe?.resolved_element_ids).toEqual(['d-mahdiyah']);
  });
  it('keys: placeKey drops «حي» + «ال» and folds; roadKey also drops the road word', () => {
    expect(placeKey('حي النرجس')).toBe(placeKey('نرجس'));
    expect(placeKey('المحمديه')).toBe(placeKey('حي المحمدية'));
    expect(placeKey('الجبيلة')).not.toBe(placeKey('الجبيل'));
    expect(roadKey('الملك فهد')).toBe(roadKey('طريق الملك فهد'));
    expect(roadKey('طريق الملك فهد الفرعي')).not.toBe(roadKey('طريق الملك فهد'));
  });
});

describe('resolveAnchor — road-side context companions (2026-10-03)', () => {
  const zoneEverywhere = (seen: string[]) => fakeDb({
    async zoneDistricts(c, zone) { seen.push(`${c}/${zone}`); return [{ district_id: `zone-${zone}`, district_name: 'z' }]; },
    async findElements(token, opts) {
      return roadKey(token) === roadKey('طريق الملك فهد') ? [{ ...KING_FAHD_ROAD, city: opts.city ?? null }] : [];
    },
  });

  it('a road referent (referent_is_road) never tries a city zone, and the band records its SIDE', async () => {
    const seen: string[] = [];
    const r = await resolveAnchor(anchor('direction', 'جنوب الملك فهد'), ctx({ db: zoneEverywhere(seen), referent_is_road: true }));
    expect(seen).toEqual([]);
    expect(r.recipe).toMatchObject({ operation: 'directional_band', side: 'south', resolved_element_ids: ['RUH-ROAD-0694'] });
  });

  it('a referent that starts with «طريق» is a road without the flag', async () => {
    const seen: string[] = [];
    const r = await resolveAnchor(anchor('direction', 'شرق طريق الملك فهد'), ctx({ db: zoneEverywhere(seen) }));
    expect(seen).toEqual([]);
    expect(r.recipe).toMatchObject({ operation: 'directional_band', side: 'east' });
  });

  it('the anchor\'s OWN referent wins over a companion city, which only scopes the road lookup', async () => {
    const seen: string[] = [];
    const base = zoneEverywhere([]);
    let askedCity: string | undefined;
    // Only a real city has zones here: «الملك فهد» has none, «جدة» does.
    const db: ResolverDb = {
      ...base,
      async zoneDistricts(c, zone) { seen.push(`${c}/${zone}`); return c === 'جدة' ? [{ district_id: 'jed-west', district_name: 'z' }] : []; },
      async findElements(token, opts) { askedCity = opts.city; return base.findElements(token, opts); },
    };
    const r = await resolveAnchor(anchor('direction', 'غرب الملك فهد'), ctx({ db, city: 'جدة', established_city: 'الرياض' }));
    expect(seen).toEqual(['الملك فهد/west']); // never «جدة/west»
    expect(r.recipe?.operation).toBe('directional_band');
    expect(askedCity).toBe('جدة');
  });

  it('an ask_reason from the preparation short-circuits every anchor type — no lookup can overrule it', async () => {
    let lookups = 0;
    const db = fakeDb({
      async zoneDistricts() { lookups += 1; return [{ district_id: 'z', district_name: 'z' }]; },
      async findDistricts() { lookups += 1; return DISTRICTS; },
      async findElements() { lookups += 1; return [KING_FAHD_ROAD]; },
    });
    const r = await resolveAnchor(anchor('direction', 'شرق'), ctx({ db, established_city: 'الرياض', ask_reason: 'side_of_unknown_referent' }));
    expect(r).toMatchObject({ status: 'needs_confirm', reason: 'side_of_unknown_referent' });
    const d = await resolveAnchor(anchor('district', 'المهدية'), ctx({ db, ask_reason: 'anchor_not_in_text' }));
    expect(d).toMatchObject({ status: 'needs_confirm', reason: 'anchor_not_in_text' });
    const road = await resolveAnchor(anchor('road', 'طريق الملك فهد'), ctx({ db, radius_m: 2000, ask_reason: 'distance_unverified' }));
    expect(road).toMatchObject({ status: 'needs_confirm', reason: 'distance_unverified' });
    expect(lookups).toBe(0);
  });

  it('round 3 #13/#16: a diagonal or «وسط» side of a road asks — never a sideless band (both resolver paths)', async () => {
    const db = zoneEverywhere([]);
    for (const span of ['شمال شرق طريق الملك فهد', 'وسط طريق الملك فهد']) {
      const r = await resolveAnchor(anchor('direction', span), ctx({ db }));
      expect(r).toMatchObject({ status: 'needs_confirm', reason: 'side_of_road_not_cardinal' });
    }
    const viaRoad = await resolveAnchor(anchor('road', 'طريق الملك فهد'), ctx({ db, direction: 'شمال شرق' }));
    expect(viaRoad).toMatchObject({ status: 'needs_confirm', reason: 'side_of_road_not_cardinal' });
    const cardinal = await resolveAnchor(anchor('road', 'طريق الملك فهد'), ctx({ db, direction: 'شمال' }));
    expect(cardinal.recipe).toMatchObject({ operation: 'directional_band', side: 'north' });
  });

  it('round 3 #4/#15: a bare direction with a companion city is THAT city\'s zone — never looked up as a road', async () => {
    const seen: string[] = [];
    let roadLookups = 0;
    const db = fakeDb({
      async zoneDistricts(c, zone) { seen.push(`${c}/${zone}`); return c === 'جدة' ? [{ district_id: 'jed-n', district_name: 'z' }] : []; },
      async findElements() { roadLookups += 1; return []; },
    });
    const r = await resolveAnchor(anchor('direction', 'شمال'), ctx({ db, city: 'جده', established_city: 'الرياض' }));
    expect(seen).toEqual(['جده/north', 'جدة/north']);
    expect(r.recipe).toMatchObject({ operation: 'zone_union', resolved_element_ids: ['jed-n'], universe_source: 'explicit' });
    const none = await resolveAnchor(anchor('direction', 'شمال'), ctx({ db, city: 'الدمام', established_city: 'الرياض' }));
    expect(none).toMatchObject({ status: 'needs_confirm', reason: 'outside_admin' });
    expect(roadLookups).toBe(0);
    // Naming the client's OWN city in another spelling («رياض») never asks where leaving it out resolved.
    const strict = fakeDb({ async zoneDistricts(c, zone) { return c === 'الرياض' && zone === 'north' ? [{ district_id: 'd-narjis', district_name: 'z' }] : []; } });
    const own = await resolveAnchor(anchor('direction', 'شمال'), ctx({ db: strict, city: 'رياض', established_city: 'الرياض' }));
    expect(own.recipe?.resolved_element_ids).toEqual(['d-narjis']);
  });

  it('round 3 #7: city_unclear makes every element lookup ask', async () => {
    const db = zoneEverywhere([]);
    const r = await resolveAnchor(anchor('road', 'طريق الملك فهد'), ctx({ db, city_unclear: true, proximity: true, radius_m: 2000 }));
    expect(r).toMatchObject({ status: 'needs_confirm', reason: 'ambiguous_entity' });
    const band = await resolveAnchor(anchor('direction', 'غرب طريق الملك فهد'), ctx({ db, city_unclear: true }));
    expect(band).toMatchObject({ status: 'needs_confirm', reason: 'ambiguous_entity' });
  });

  it('round 3 #12: admin_city keeps a district in the named city, or asks', async () => {
    // الخالدية exists in Riyadh AND Jeddah; the established city alone would pick Riyadh's.
    const r = await resolveAnchor(anchor('district', 'الخالدية'), ctx({ established_city: 'الرياض', admin_city: 'جده' }));
    expect(r.recipe?.resolved_element_ids).toEqual(['d-khalidiyah-jed']);
    const ryd = await resolveAnchor(anchor('district', 'الخالدية'), ctx({ established_city: 'الرياض' }));
    expect(ryd.recipe?.resolved_element_ids).toEqual(['d-khalidiyah-ryd']);
    const none = await resolveAnchor(anchor('district', 'الخالدية'), ctx({ established_city: 'الرياض', admin_city: 'الدمام' }));
    expect(none).toMatchObject({ status: 'needs_confirm', reason: 'outside_admin' });
  });

  it('the side changes the geometry id: north and south of one road are different shapes', async () => {
    const db = zoneEverywhere([]);
    const n = await resolveAnchor(anchor('direction', 'شمال طريق الملك فهد'), ctx({ db }));
    const s = await resolveAnchor(anchor('direction', 'جنوب طريق الملك فهد'), ctx({ db }));
    expect(n.geometry_id).not.toBe(s.geometry_id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Design 2026-10-04 §6.3 — the resolver's enabling rules and vetoes.
// ─────────────────────────────────────────────────────────────────────────────

/** An element fixture (Riyadh, approved, usable). */
function el(external_id: string, name_ar: string, geom_kind: ElementCandidate['geom_kind'], extra: Partial<ElementCandidate> = {}): ElementCandidate {
  return {
    external_id, name_ar, name_en: '', aliases: [], geom_kind, category: null, type: null, city: 'Riyadh',
    country_code: 'SA', lat: 24.75, lng: 46.65, confidence_score: 0.9, review_status: 'approved', is_active: true, ...extra,
  };
}
/** A byte-wise element search like the live ILIKE: a name / alias CONTAINING the token, no folding. */
function elementsIlike(elements: readonly ElementCandidate[]): ResolverDb['findElements'] {
  return async (token) => {
    const t = token.trim();
    return elements.filter((e) => [e.name_ar, e.name_en, ...e.aliases].some((n) => !!t && !!n && n.includes(t)));
  };
}

describe('city helpers — exact and unique only (§6.3)', () => {
  const cctx = { db: fakeDb({ findCities: async (t) => citiesIlike(t) }), preferCountry: 'SA' };

  it('cityArabicName: an exact official / Latin / article-less name of ONE record; «مكة» is null', async () => {
    expect(await cityArabicName(cctx, 'Riyadh')).toBe('الرياض');
    expect(await cityArabicName(cctx, 'رياض')).toBe('الرياض');
    expect(await cityArabicName(cctx, 'جده')).toBe('جدة');
    expect(await cityArabicName(cctx, 'مكة')).toBeNull(); // «مكة المكرمة» is a leading-words namesake, not exact
    expect(await cityArabicName(cctx, 'المزرعة')).toBeNull();
    expect(await cityArabicName(cctx, '')).toBeNull();
    const twins = { db: fakeDb({ findCities: async () => [mkCity('a', 'الحمراء', 'Al Hamra'), mkCity('b', 'الحمراء', 'Al Hamra')] }), preferCountry: 'SA' };
    expect(await cityArabicName(twins, 'الحمراء')).toBeNull(); // two records → not unique
    const abroad = { db: fakeDb({ findCities: async () => [{ ...mkCity('ae', 'العين', 'Al Ain'), country_code: 'AE' }] }), preferCountry: 'SA' };
    expect(await cityArabicName(abroad, 'العين')).toBeNull(); // another country → not the preferred one
  });

  it('sameCity: the same spelling, or a name of the ONE record whose Arabic name is the other', async () => {
    expect(await sameCity(cctx, 'رياض', 'الرياض')).toBe(true);
    expect(await sameCity(cctx, 'Riyadh', 'الرياض')).toBe(true);
    expect(await sameCity(cctx, 'جدة', 'الرياض')).toBe(false);
    expect(await sameCity(cctx, 'مكة', 'مكة المكرمة')).toBe(false);
    expect(await sameCity(cctx, '', 'الرياض')).toBe(false);
  });
});

describe('a direction with a referent — city first, then the namesake vetoes, then a road (§6.3)', () => {
  const DAMMAM_ROAD = el('RUH-ROAD-DMM', 'طريق الدمام', 'linestring');
  const MAKKAH_ROAD = el('RUH-ROAD-MKH', 'طريق مكة', 'linestring');
  const OLAYA_STREET = el('RUH-ROAD-0684', 'شارع العليا', 'linestring');
  const ANAS_ROAD = el('RUH-ROAD-ANAS', 'طريق انس بن مالك', 'linestring');
  const OLAYA = mkDistrict('d-olaya', 'حي العليا', 'Al Olaya', 'الرياض', 'الرياض', 'منطقة الرياض', 'SA', 24.69, 46.68);

  it('«north Riyadh» (Latin) → the city record\'s Arabic name reaches the zone RPC', async () => {
    const r = await resolveAnchor(anchor('direction', 'north Riyadh'), ctx({ db: fakeDb({ findCities: async (t) => citiesIlike(t) }) }));
    expect(r.recipe).toMatchObject({ operation: 'zone_union', resolved_element_ids: ['d-narjis', 'd-yasmin', 'd-arid'] });
    expect(r.facts).toMatchObject({ zone_city: 'الرياض', scope_city: 'الرياض', scope_source: 'named' });
  });

  it('a city record with no such zone → outside_admin, and the road of its name is never tried', async () => {
    let roadLookups = 0;
    const db = fakeDb({
      findCities: async (t) => citiesIlike(t),
      async findElements() { roadLookups += 1; return [DAMMAM_ROAD]; },
    });
    const r = await resolveAnchor(anchor('direction', 'شمال الدمام'), ctx({ db, established_city: 'الرياض' }));
    expect(r).toMatchObject({ status: 'needs_confirm', reason: 'outside_admin' });
    expect(roadLookups).toBe(0);
  });

  it('«شرق العليا» (a district of the scope city, and a street) → referent_road_or_district, never the street', async () => {
    const db = fakeDb({
      async findDistricts(t) { return matchIlike([...DISTRICTS, OLAYA], t); },
      findElements: elementsIlike([OLAYA_STREET]),
    });
    const r = await resolveAnchor(anchor('direction', 'شرق العليا'), ctx({ db, established_city: 'الرياض' }));
    expect(r).toMatchObject({ status: 'needs_confirm', reason: 'referent_road_or_district' });
    // The same district in ANOTHER city is no namesake of the scope city's street.
    const jed = await resolveAnchor(anchor('direction', 'شرق العليا'), ctx({ db, established_city: 'جدة' }));
    expect(jed.reason).not.toBe('referent_road_or_district');
  });

  it('«شمال مكة» with a road «طريق مكة» in the map → road_or_city_unclear (never north of the road)', async () => {
    const db = fakeDb({ findCities: async (t) => citiesIlike(t), findElements: elementsIlike([MAKKAH_ROAD]) });
    const r = await resolveAnchor(anchor('direction', 'شمال مكة'), ctx({ db, established_city: 'الرياض' }));
    expect(r).toMatchObject({ status: 'needs_confirm', reason: 'road_or_city_unclear' });
    expect(r.recipe).toBeUndefined();
  });

  it('«جنوب انس بن مالك» (no city, no district of that name) → a band south of the road', async () => {
    const db = fakeDb({ findCities: async (t) => citiesIlike(t), findElements: elementsIlike([ANAS_ROAD]) });
    const r = await resolveAnchor(anchor('direction', 'جنوب انس بن مالك'), ctx({ db, established_city: 'الرياض' }));
    expect(r.recipe).toMatchObject({ operation: 'directional_band', side: 'south', resolved_element_ids: ['RUH-ROAD-ANAS'] });
  });

  it('the namesake vetoes are skipped for a referent known to be a road, and can be switched off (test-only)', async () => {
    const db = fakeDb({
      async findDistricts(t) { return matchIlike([...DISTRICTS, OLAYA], t); },
      findElements: elementsIlike([OLAYA_STREET]),
    });
    const flagged = await resolveAnchor(anchor('direction', 'شرق العليا'), ctx({ db, established_city: 'الرياض', referent_is_road: true }));
    expect(flagged.recipe).toMatchObject({ operation: 'directional_band', side: 'east', resolved_element_ids: ['RUH-ROAD-0684'] });
    const off = await resolveAnchor(anchor('direction', 'شرق العليا'), ctx({ db, established_city: 'الرياض', disabled: new Set(['namesake_veto']) }));
    expect(off.recipe?.operation).toBe('directional_band');
  });

  it('the customer\'s span decides a road: token «شرق الدمام», span «شرق طريق الدمام» → Dammam ROAD, never the city zone', async () => {
    const seen: string[] = [];
    const db = fakeDb({
      findCities: async (t) => citiesIlike(t),
      async zoneDistricts(c, zone) { seen.push(`${c}/${zone}`); return [{ district_id: 'dmm-e1', district_name: 'x' }]; },
      findElements: elementsIlike([DAMMAM_ROAD]),
    });
    const r = await resolveAnchor(anchor('direction', 'شرق طريق الدمام', 'شرق الدمام'), ctx({ db, established_city: 'الرياض' }));
    expect(seen).toEqual([]);
    expect(r.recipe).toMatchObject({ operation: 'directional_band', side: 'east', resolved_element_ids: ['RUH-ROAD-DMM'] });
  });
});

describe('a bare direction — owner, Rule Z, I9 (§6.3)', () => {
  it('confirm_city equal to the established city → its zone; another city → zone_city_unclear', async () => {
    const db = fakeDb({ findCities: async (t) => citiesIlike(t) });
    const same = await resolveAnchor(anchor('direction', 'الشمال'), ctx({ db, established_city: 'الرياض', confirm_city: 'رياض' }));
    expect(same.recipe).toMatchObject({ operation: 'zone_union', resolved_element_ids: ['d-narjis', 'd-yasmin', 'd-arid'], universe_source: 'explicit' });
    const latin = await resolveAnchor(anchor('direction', 'الشمال'), ctx({ db, established_city: 'الرياض', confirm_city: 'Riyadh' }));
    expect(latin.status).toBe('resolved');
    const other = await resolveAnchor(anchor('direction', 'الشمال'), ctx({ db, established_city: 'الرياض', confirm_city: 'جدة' }));
    expect(other).toMatchObject({ status: 'needs_confirm', reason: 'zone_city_unclear' });
    const none = await resolveAnchor(anchor('direction', 'الشمال'), ctx({ db, confirm_city: 'جدة' }));
    expect(none).toMatchObject({ status: 'needs_confirm', reason: 'zone_city_unclear' });
  });

  it('forbid_established → established_city_contradicted for the established zone; an owner city still resolves', async () => {
    const r = await resolveAnchor(anchor('direction', 'الشمال'), ctx({ established_city: 'الرياض', forbid_established: true }));
    expect(r).toMatchObject({ status: 'needs_confirm', reason: 'established_city_contradicted' });
    const owned = await resolveAnchor(anchor('direction', 'شمال'), ctx({ established_city: 'الرياض', city: 'الرياض', forbid_established: true }));
    expect(owned.status).toBe('resolved');
  });

  it('I9 in lookups: no named scope + forbid_established → asks before searching; a named scope searches', async () => {
    let lookups = 0;
    const db = fakeDb({ async findElements() { lookups += 1; return [KING_FAHD_ROAD]; } });
    const r = await resolveAnchor(anchor('road', 'طريق الملك فهد'), ctx({ db, established_city: 'الرياض', forbid_established: true, proximity: true, radius_m: 2000 }));
    expect(r).toMatchObject({ status: 'needs_confirm', reason: 'established_city_contradicted' });
    const band = await resolveAnchor(anchor('direction', 'غرب طريق الملك فهد'), ctx({ db, established_city: 'الرياض', forbid_established: true }));
    expect(band).toMatchObject({ status: 'needs_confirm', reason: 'established_city_contradicted' });
    expect(lookups).toBe(0);
    const named = await resolveAnchor(anchor('road', 'طريق الملك فهد'), ctx({ db, city: 'الرياض', established_city: 'الرياض', forbid_established: true, proximity: true, radius_m: 2000 }));
    expect(named.recipe?.operation).toBe('within_distance');
  });
});

describe('element lookups — the token union (§6.3)', () => {
  const PARK = el('RUH-PARK-KA', 'حديقة الملك عبدالله', 'polygon', { lat: 24.66, lng: 46.74 });

  it('a folded token («حديقه …») finds nothing byte-wise; the customer\'s span finds the park', async () => {
    const db = fakeDb({ findElements: elementsIlike([PARK]) });
    const r = await resolveAnchor(anchor('landmark', 'حديقة الملك عبدالله', 'حديقه الملك عبدالله'), ctx({ db, established_city: 'الرياض', radius_m: 2000 }));
    expect(r.recipe).toMatchObject({ operation: 'within_distance', resolved_element_ids: ['RUH-PARK-KA'], radius_or_band_m: 2000 });
  });

  it('two spellings that name two different roads → ambiguous_entity, never the first one tried', async () => {
    const KSR = el('RUH-ROAD-0681', 'طريق الملك سلمان', 'linestring');
    const SALMAN_ST = el('RUH-ROAD-SLM', 'شارع سلمان', 'linestring');
    const db = fakeDb({ findElements: elementsIlike([KSR, SALMAN_ST]) });
    const r = await resolveAnchor(anchor('road', 'شارع سلمان', 'الملك سلمان'), ctx({ db, established_city: 'الرياض', proximity: true, radius_m: 1000 }));
    expect(r).toMatchObject({ status: 'needs_confirm', reason: 'ambiguous_entity' });
  });

  it('admin_city compares article-insensitively («رياض» keeps Riyadh\'s الخالدية)', async () => {
    const r = await resolveAnchor(anchor('district', 'الخالدية'), ctx({ admin_city: 'رياض' }));
    expect(r.recipe?.resolved_element_ids).toEqual(['d-khalidiyah-ryd']);
  });
});

describe('venues — one place or ask (I7, §6.3)', () => {
  const OTH = el('RUH-MALL-OTH', 'العثيم مول', 'polygon', { lat: 24.7013, lng: 46.7 });
  const OTH_P = el('RUH-MALL-OTH-P', 'العثيم مول', 'point', { lat: 24.7, lng: 46.7 });
  const OTH_RABWA = el('RUH-MALL-OTH-R', 'العثيم مول الربوة', 'point', { lat: 24.69, lng: 46.78 }); // ~8 km away
  const OTH_ANNEX = el('RUH-MALL-OTH-A', 'العثيم مول التوسعة', 'point', { lat: 24.702, lng: 46.701 }); // same site
  const KSU_STATION = el('RUH-METR-KSU', 'جامعة الملك سعود', 'point', { lat: 24.7105, lng: 46.6189 });
  const KSU_CAMPUS = el('RUH-UNIV-KSU', 'جامعة الملك سعود', 'polygon', { lat: 24.724, lng: 46.734 });
  const PNU_A = el('RUH-UNIV-0064', 'جامعة الأميرة نورة بنت عبدالرحمن', 'polygon', { lat: 24.846, lng: 46.725 });
  const PNU_B = el('RUH-UNIV-0072', 'جامعة الأميرة نورة بنت عبدالرحمن', 'polygon', { lat: 24.77, lng: 46.69 });
  const venue = (elements: ElementCandidate[], token: string, over: Partial<ResolutionContext> = {}) =>
    resolveAnchor(anchor('landmark', token), ctx({ db: fakeDb({ findElements: elementsIlike(elements) }), established_city: 'الرياض', radius_m: 2000, ...over }));

  it('the exact point and polygon of ONE place → the polygon', async () => {
    const r = await venue([OTH_P, OTH], 'العثيم مول');
    expect(r.recipe).toMatchObject({ operation: 'within_distance', resolved_element_ids: ['RUH-MALL-OTH'] });
  });

  it('a station and a campus 11.7 km apart → ambiguous_entity', async () => {
    const r = await venue([KSU_STATION, KSU_CAMPUS], 'جامعة الملك سعود');
    expect(r).toMatchObject({ status: 'needs_confirm', reason: 'ambiguous_entity' });
  });

  it('an exact «العثيم مول» plus a prefix branch in another cluster → ambiguous_entity; a branch on the same site does not split it', async () => {
    expect(await venue([OTH_P, OTH, OTH_RABWA], 'العثيم مول')).toMatchObject({ status: 'needs_confirm', reason: 'ambiguous_entity' });
    const one = await venue([OTH_P, OTH, OTH_ANNEX], 'العثيم مول');
    expect(one.recipe?.resolved_element_ids).toEqual(['RUH-MALL-OTH']);
  });

  it('PNU with prefix matches only → venue_name_partial; with the spoken alias on both campuses → ambiguous_entity', async () => {
    expect(await venue([PNU_A, PNU_B], 'جامعة الأميرة نورة')).toMatchObject({ status: 'needs_confirm', reason: 'venue_name_partial' });
    const aliased = [PNU_A, PNU_B].map((e) => ({ ...e, aliases: ['جامعة الأميرة نورة', 'جامعة الاميرة نورة'] }));
    expect(await venue(aliased, 'جامعة الأميرة نورة')).toMatchObject({ status: 'needs_confirm', reason: 'ambiguous_entity' });
  });

  it('a generic-only spoken name never makes prefix namesakes; switching the check off only removes asks', async () => {
    const MALL = el('RUH-MALL-X', 'مول', 'polygon', { lat: 24.7, lng: 46.7 });
    const MALL_FAR = el('RUH-MALL-Y', 'مول الرياض', 'polygon', { lat: 24.9, lng: 46.9 });
    expect((await venue([MALL, MALL_FAR], 'مول')).recipe?.resolved_element_ids).toEqual(['RUH-MALL-X']);
    const off = await venue([PNU_A, PNU_B], 'جامعة الأميرة نورة', { disabled: new Set(['venue_prefix']) });
    expect(off).toMatchObject({ status: 'needs_confirm', reason: 'outside_admin' });
  });
});

describe('facts — filled on every resolved branch, never stored in the recipe (§2.3.2)', () => {
  it('district / zone / band / road distance / venue', async () => {
    const district = await resolveAnchor(anchor('district', 'الملقا'), ctx({ established_city: 'الرياض' }));
    expect(district.facts).toEqual({ district_city_en: { 'd-malqa': '' } });

    const zone = await resolveAnchor(anchor('direction', 'الشمال'), ctx({ established_city: 'الرياض' }));
    expect(zone.facts).toEqual({ zone_city: 'الرياض', scope_city: 'الرياض', scope_source: 'established' });

    const db = fakeDb({ findElements: elementsIlike([KING_FAHD_ROAD, el('RUH-MALL-NKH', 'النخيل مول', 'polygon')]) });
    const band = await resolveAnchor(anchor('direction', 'غرب طريق الملك فهد'), ctx({ db, established_city: 'الرياض' }));
    expect(band.facts).toEqual({ scope_city: 'الرياض', scope_source: 'established', element_city: 'Riyadh', radius_source: 'default' });
    const stated = await resolveAnchor(anchor('direction', 'غرب طريق الملك فهد'), ctx({ db, city: 'الرياض', established_city: 'الرياض', radius_m: 2000 }));
    expect(stated.facts).toMatchObject({ scope_source: 'named', radius_source: 'stated' });

    const near = await resolveAnchor(anchor('road', 'طريق الملك فهد'), ctx({ db, established_city: 'الرياض', proximity: true, radius_m: 1500 }));
    expect(near.facts).toEqual({ scope_city: 'الرياض', scope_source: 'established', element_city: 'Riyadh', radius_source: 'stated' });

    const mall = await resolveAnchor(anchor('landmark', 'النخيل مول'), ctx({ db, established_city: 'الرياض', radius_m: 2000 }));
    expect(mall.facts).toMatchObject({ element_city: 'Riyadh', radius_source: 'stated' });

    for (const r of [district, zone, band, stated, near, mall]) {
      expect(r.status).toBe('resolved');
      expect(JSON.stringify(r.recipe)).not.toMatch(/scope_city|element_city|zone_city|district_city_en|radius_source/);
    }
  });

  it('the resolver version is bumped (provenance only)', () => {
    expect(RESOLVER_VERSION).toBe('geo-anchor-resolver@v5-checks');
  });
});

describe('stripDirectionClitic / spanReferent', () => {
  it('takes a preposition or clitic off a direction word only', () => {
    expect(stripDirectionClitic('وجنوب سلمان')).toBe('جنوب سلمان');
    expect(stripDirectionClitic('بالشمال')).toBe('الشمال');
    expect(stripDirectionClitic('في جنوب سلمان')).toBe('جنوب سلمان');
    expect(stripDirectionClitic('من شمال الرياض')).toBe('شمال الرياض');
    expect(stripDirectionClitic('وسط')).toBe('وسط');
    expect(stripDirectionClitic('وسط الرياض')).toBe('وسط الرياض');
    expect(stripDirectionClitic('بالرياض')).toBe('بالرياض');
  });

  it('spanReferent: the words after the direction in the customer\'s span', () => {
    expect(spanReferent({ span: 'وجنوب سلمان' })).toBe('سلمان');
    expect(spanReferent({ span: 'شرق طريق الدمام' })).toBe('طريق الدمام');
    expect(spanReferent({ span: 'بالشمال' })).toBe('');
    expect(spanReferent({ span: 'سلمان' })).toBe('');
  });
});
