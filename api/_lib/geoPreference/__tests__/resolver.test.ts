import { describe, it, expect } from 'vitest';
import { resolveAnchor, type ResolverDb, type ResolutionContext, type DistrictCandidate } from '../resolver.js';
import type { AnchorToken } from '../ontology.js';

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
];

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
  const t = fold(token.replace(/^\s*حي\s+/, ''));
  return rows.filter((r) => {
    const na = fold(r.name_ar), ne = fold(r.name_en);
    return na.includes(t) || t.includes(na) || ne.includes(t) || t.includes(ne);
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
