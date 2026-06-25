import { describe, it, expect } from 'vitest';
import {
  pointInPolygon,
  pointInDistrict,
  distanceBetweenCentroids,
  haversineKm,
  normalizeArabicDistrictName,
  normalizeEnglishDistrictName,
} from '../locationUtils';

// A 0.1°×0.1° square around Riyadh (~46.6–46.7 E, 24.6–24.7 N). GeoJSON [lng,lat].
const square = {
  type: 'Polygon' as const,
  coordinates: [[[46.6, 24.6], [46.7, 24.6], [46.7, 24.7], [46.6, 24.7], [46.6, 24.6]]],
};
// Same outer square with a central hole.
const withHole = {
  type: 'Polygon' as const,
  coordinates: [
    [[46.6, 24.6], [46.7, 24.6], [46.7, 24.7], [46.6, 24.7], [46.6, 24.6]],
    [[46.64, 24.64], [46.66, 24.64], [46.66, 24.66], [46.64, 24.66], [46.64, 24.64]],
  ],
};
const multi = {
  type: 'MultiPolygon' as const,
  coordinates: [square.coordinates, [[[47.0, 25.0], [47.1, 25.0], [47.1, 25.1], [47.0, 25.1], [47.0, 25.0]]]],
};

describe('pointInPolygon', () => {
  it('detects a point inside the polygon (lng,lat order)', () => {
    expect(pointInPolygon(46.65, 24.65, square)).toBe(true);
  });
  it('rejects a point outside the polygon', () => {
    expect(pointInPolygon(46.9, 24.65, square)).toBe(false);
  });
  it('rejects a point inside a hole', () => {
    expect(pointInPolygon(46.65, 24.65, withHole)).toBe(false);
    expect(pointInPolygon(46.61, 24.61, withHole)).toBe(true); // inside outer, outside hole
  });
  it('handles MultiPolygon (in either polygon)', () => {
    expect(pointInPolygon(46.65, 24.65, multi)).toBe(true);
    expect(pointInPolygon(47.05, 25.05, multi)).toBe(true);
    expect(pointInPolygon(50.0, 25.0, multi)).toBe(false);
  });
});

describe('pointInDistrict', () => {
  it('accepts a parsed GeoJSON string and uses (lat,lng) arg order', () => {
    expect(pointInDistrict(24.65, 46.65, JSON.stringify(square))).toBe(true);
    expect(pointInDistrict(24.65, 46.9, JSON.stringify(square))).toBe(false);
  });
  it('returns false for malformed GeoJSON instead of throwing', () => {
    expect(pointInDistrict(24.65, 46.65, '{not json')).toBe(false);
    expect(pointInDistrict(24.65, 46.65, null)).toBe(false);
  });
});

describe('distance helpers', () => {
  it('haversine ~0 for identical points', () => {
    expect(haversineKm(24.7, 46.7, 24.7, 46.7)).toBeCloseTo(0, 5);
  });
  it('distanceBetweenCentroids is positive and sane (<200km within Riyadh metro)', () => {
    const d = distanceBetweenCentroids({ lat: 24.6, lng: 46.6 }, { lat: 24.8, lng: 46.8 });
    expect(d).toBeGreaterThan(20);
    expect(d).toBeLessThan(40);
  });
});

describe('name normalization', () => {
  it('strips the حي prefix and unifies variants', () => {
    expect(normalizeArabicDistrictName('حي الملز')).toBe('الملز');
    expect(normalizeArabicDistrictName('الملز')).toBe('الملز');
    expect(normalizeArabicDistrictName('حي النرجس')).toBe(normalizeArabicDistrictName('النرجس'));
    // alef + teh-marbuta unification
    expect(normalizeArabicDistrictName('حي قرطبة')).toBe(normalizeArabicDistrictName('قرطبه'));
  });
  it('strips the Dist. suffix and lowercases', () => {
    expect(normalizeEnglishDistrictName('Al Amal Dist.')).toBe('al amal');
    expect(normalizeEnglishDistrictName('Al Amal')).toBe('al amal');
  });
});
