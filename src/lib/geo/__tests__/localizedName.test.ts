import { describe, it, expect } from 'vitest';
import {
  resolveLocalizedName,
  diagnoseLocalizedName,
  resolveArabicName,
  toEnglishDisplay,
  normalizeWhitespace,
  pickLocalized,
  looksLikeUuid,
  containsUuid,
} from '../localizedName';
import { GEO_FIXTURES, UUID_LEAK_SAMPLES } from '../geoLocalizationFixtures';

describe('localizedName — conformance fixtures (the contract)', () => {
  for (const f of GEO_FIXTURES) {
    it(f.name, () => {
      const got = resolveLocalizedName(f.id, f.data);
      if (f.expect === null) {
        expect(got).toBeNull();
        return;
      }
      expect(got).not.toBeNull();
      expect(got!.id).toBe(f.id);
      expect(got!.ar).toBe(f.expect.ar);
      expect(got!.enCanonical).toBe(f.expect.enCanonical);
      expect(got!.enDisplay).toBe(f.expect.enDisplay);
    });
  }
});

describe('never silently substitutes Arabic into English', () => {
  it('returns null rather than an Arabic English-name when name_en is absent', () => {
    const got = resolveLocalizedName('x', { display_name: 'المهدية', name_ar: 'حي المهدية' });
    expect(got).toBeNull();
  });

  it('no resolved English value ever contains Arabic script', () => {
    for (const f of GEO_FIXTURES) {
      const got = resolveLocalizedName(f.id, f.data);
      if (!got) continue;
      expect(got.enCanonical).not.toMatch(/[؀-ۿ]/);
      expect(got.enDisplay).not.toMatch(/[؀-ۿ]/);
    }
  });

  it('diagnose reports the specific reason', () => {
    expect(diagnoseLocalizedName(null, null)).toEqual({ ok: false, reason: 'missing_record' });
    expect(diagnoseLocalizedName('x', { name_en: 'A' })).toEqual({ ok: false, reason: 'missing_arabic' });
    expect(diagnoseLocalizedName('x', { name_ar: 'ب' })).toEqual({ ok: false, reason: 'missing_english' });
    const ok = diagnoseLocalizedName('x', { name_ar: 'ب', name_en: 'B Dist.' });
    expect(ok.ok).toBe(true);
  });
});

describe('regions without display_name', () => {
  it('falls through to name_ar without any English contamination', () => {
    const got = resolveLocalizedName('r1', { name_ar: 'منطقة مكة المكرمة', name_en: 'Makkah Region' });
    expect(got).toEqual({
      id: 'r1',
      ar: 'منطقة مكة المكرمة',
      enCanonical: 'Makkah Region',
      enDisplay: 'Makkah Region',
    });
  });
});

describe('toEnglishDisplay — suffix stripping is trailing-only', () => {
  it.each([
    ['Al Mahdiyah Dist.', 'Al Mahdiyah'],
    ['Al Narjis District', 'Al Narjis'],
    ['Al Olaya, Dist.', 'Al Olaya'],
    ['al yasmin dist.', 'al yasmin'],
    ['District Cooling Plant', 'District Cooling Plant'],
    ['District', 'District'],
    ['Riyadh', 'Riyadh'],
    ['Asharai  Dist.', 'Asharai'],
  ])('%s → %s', (input, expected) => {
    expect(toEnglishDisplay(input)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = toEnglishDisplay('Al Mahdiyah Dist.');
    expect(toEnglishDisplay(once)).toBe(once);
  });
});

describe('canonical value is never mutated', () => {
  it('enCanonical keeps the suffix that enDisplay drops', () => {
    const got = resolveLocalizedName('d', { name_ar: 'حي', name_en: 'Al Mahdiyah Dist.' })!;
    expect(got.enCanonical).toBe('Al Mahdiyah Dist.');
    expect(got.enDisplay).toBe('Al Mahdiyah');
  });

  it('does not mutate the input record', () => {
    const data = { display_name: 'المهدية', name_ar: 'حي المهدية', name_en: 'Al Mahdiyah Dist.' };
    const snapshot = JSON.stringify(data);
    resolveLocalizedName('d', data);
    expect(JSON.stringify(data)).toBe(snapshot);
  });
});

describe('normalizeWhitespace', () => {
  it('collapses runs and trims', () => {
    expect(normalizeWhitespace('  Asharai   Dist.  ')).toBe('Asharai Dist.');
    expect(normalizeWhitespace('\tAl\n\nOlaya ')).toBe('Al Olaya');
  });
});

describe('pickLocalized', () => {
  const name = resolveLocalizedName('d', {
    display_name: 'المهدية',
    name_ar: 'حي المهدية',
    name_en: 'Al Mahdiyah Dist.',
  })!;
  it('Arabic surface gets the Arabic form', () => expect(pickLocalized(name, true)).toBe('المهدية'));
  it('English surface gets the display form, not the canonical suffix', () =>
    expect(pickLocalized(name, false)).toBe('Al Mahdiyah'));
});

describe('resolveArabicName — Arabic-only surfaces', () => {
  it('prefers display_name then name_ar', () => {
    expect(resolveArabicName({ display_name: 'المهدية', name_ar: 'حي المهدية' })).toBe('المهدية');
    expect(resolveArabicName({ name_ar: 'حي المهدية' })).toBe('حي المهدية');
    expect(resolveArabicName({ name_en: 'Only English' })).toBeNull();
  });
});

describe('UUID leak guard', () => {
  it('detects bare UUIDs', () => {
    expect(looksLikeUuid('5405e1c7-91e1-a36c-6135-52a0615a7cf7')).toBe(true);
    expect(looksLikeUuid('Al Mahdiyah')).toBe(false);
    expect(looksLikeUuid('حي المهدية')).toBe(false);
  });

  it('detects UUIDs nested anywhere in a fact sheet', () => {
    for (const sample of UUID_LEAK_SAMPLES) {
      expect(containsUuid(sample)).toBe(true);
    }
  });

  it('a properly localized fact sheet contains no UUIDs', () => {
    const factSheet = {
      project_name: 'أدوار - يمام 9',
      city_ar: 'الرياض',
      city_en: 'Riyadh',
      district_ar: 'القيروان',
      district_en: 'Al Qairawan',
    };
    expect(containsUuid(factSheet)).toBe(false);
  });
});
