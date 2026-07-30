import { describe, it, expect } from 'vitest';
import { rankGeoCandidates, canonicalPlaceName, DEFAULT_GEO_COUNTRY } from '../matchAgent.js';

/**
 * Guards the country-scoping of free-text district/city resolution.
 *
 * The failure this prevents is silent and expensive: `resolveRequestedDistrict` ILIKEs
 * every district row and used to take `pool[0]` off an unordered PostgREST result. On
 * production «حي الخالدية» exists in 49 different Saudi cities, «حي النهضة» in 46 and
 * «حي النخيل» in 34 — so the pick already depended on Postgres row order. Once UAE rows
 * share the table, the same names exist across the border and a Saudi client's Project
 * Finder request could be scored against a Dubai community with nothing in the output
 * saying so.
 */

const d = (id: string, name_ar: string, city_name_ar: string, country_code: string) =>
  ({ id, data: { name_ar, name_en: '', city_name_ar, city_name_en: '', country_code } });

describe('canonicalPlaceName', () => {
  it('strips the حي prefix so a bare name matches a prefixed one', () => {
    expect(canonicalPlaceName('حي النرجس')).toBe(canonicalPlaceName('النرجس'));
  });

  it('folds the Arabic letter variants that spellings disagree on', () => {
    expect(canonicalPlaceName('الأندلس')).toBe(canonicalPlaceName('الاندلس'));
    expect(canonicalPlaceName('النهضة')).toBe(canonicalPlaceName('النهضه'));
    expect(canonicalPlaceName('الرملى')).toBe(canonicalPlaceName('الرملي'));
  });

  it('drops the English "Dist." suffix', () => {
    expect(canonicalPlaceName('Al Narjis Dist.')).toBe(canonicalPlaceName('Al Narjis'));
  });

  it('does not collapse genuinely different names', () => {
    expect(canonicalPlaceName('النرجس')).not.toBe(canonicalPlaceName('النخيل'));
  });
});

describe('rankGeoCandidates — country scoping', () => {
  const cityFields: [string, string] = ['city_name_ar', 'city_name_en'];

  it('prefers the requested country when the name exists in both', () => {
    // Deliberately ordered UAE-first, which is what an unordered query could hand back.
    const rows = [
      d('u1', 'النخيل', 'دبي', 'AE'),
      d('s1', 'النخيل', 'الرياض', 'SA'),
    ];
    expect(rankGeoCandidates(rows, { name: 'النخيل', country: 'SA', cityFields })[0].id).toBe('s1');
    expect(rankGeoCandidates(rows, { name: 'النخيل', country: 'AE', cityFields })[0].id).toBe('u1');
  });

  it('lets the city win over the country, since a named city is the stronger signal', () => {
    const rows = [
      d('s1', 'النخيل', 'الرياض', 'SA'),
      d('u1', 'النخيل', 'دبي', 'AE'),
    ];
    // Country says SA but the request names Dubai — Dubai must win, which is how
    // "مرسى دبي" resolves inside the UAE without anyone saying "UAE".
    expect(rankGeoCandidates(rows, { name: 'النخيل', city: 'دبي', country: 'SA', cityFields })[0].id).toBe('u1');
  });

  it('prefers an exact name over a mere substring match', () => {
    const rows = [
      d('a', 'النخيل الشرقي', 'الرياض', 'SA'),
      d('b', 'النخيل', 'الرياض', 'SA'),
    ];
    expect(rankGeoCandidates(rows, { name: 'النخيل', country: 'SA', cityFields })[0].id).toBe('b');
  });

  it('is deterministic when nothing distinguishes the candidates', () => {
    // 49 same-named Saudi districts is the real production shape. We cannot know which
    // one the user meant, but we must return the SAME one every time rather than
    // whatever Postgres happened to return first.
    const rows = ['z9', 'a1', 'm5'].map((id) => d(id, 'الخالدية', 'مدينة' + id, 'SA'));
    const first = rankGeoCandidates(rows, { name: 'الخالدية', country: 'SA', cityFields })[0].id;
    const shuffled = [rows[2], rows[0], rows[1]];
    expect(rankGeoCandidates(shuffled, { name: 'الخالدية', country: 'SA', cityFields })[0].id).toBe(first);
    expect(first).toBe('a1'); // lowest id — the documented stable tiebreak
  });

  it('treats a row with no country stamp as the default country rather than unresolvable', () => {
    const rows = [{ id: 'x', data: { name_ar: 'النخيل', name_en: '', city_name_ar: '', city_name_en: '' } }];
    expect(rankGeoCandidates(rows, { name: 'النخيل', country: DEFAULT_GEO_COUNTRY, cityFields })[0].id).toBe('x');
  });

  it('does not mutate the input array', () => {
    const rows = [d('u1', 'النخيل', 'دبي', 'AE'), d('s1', 'النخيل', 'الرياض', 'SA')];
    const order = rows.map((r) => r.id);
    rankGeoCandidates(rows, { name: 'النخيل', country: 'SA', cityFields });
    expect(rows.map((r) => r.id)).toEqual(order);
  });
});
