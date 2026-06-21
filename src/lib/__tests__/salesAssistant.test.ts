import { describe, it, expect } from 'vitest';
// Deterministic Sales-Assistant logic (geo distance + nearby tier, lead
// temperature) lives in the API agent — no DB / SDK runtime deps.
import { __test } from '../../../api/_lib/matchAgent';

const { scoreProject, haversineKm, computeLeadTemperature, resolveClientFromCandidates } = __test;

describe('haversineKm', () => {
  it('measures a realistic Riyadh inter-district distance', () => {
    // النرجس ≈ (24.83, 46.64) → الملقا ≈ (24.80, 46.61): a few km apart.
    const d = haversineKm(24.83, 46.64, 24.8, 46.61);
    expect(d).toBeGreaterThan(2);
    expect(d).toBeLessThan(6);
  });
  it('is zero for the same point', () => {
    expect(haversineKm(24.7, 46.7, 24.7, 46.7)).toBeCloseTo(0, 5);
  });
});

describe('scoreProject — location intelligence', () => {
  const PROJECT = {
    project_name: 'X',
    preferred_city: 'الرياض',
    preferred_neighborhoods: 'العارض', // NOT the requested district…
    unit_types: ['villa'],
    available_units: 5,
    latitude: 24.83,
    longitude: 46.64,
  };

  it('flags a different-district project as "nearby" with a real distance when within radius', () => {
    const r = scoreProject(PROJECT, { district: 'النرجس', property_type: 'فيلا' }, {
      projLat: 24.83, projLng: 46.64, // العارض project
      reqLat: 24.8, reqLng: 46.61, // النرجس centroid ≈ 3 km away
    });
    expect(r.match_type).toBe('nearby');
    expect(r.location_tier).toBe('nearby');
    expect(r.distance_km).not.toBeNull();
    expect(r.distance_km!).toBeGreaterThan(0);
    expect(r.distance_km!).toBeLessThan(12);
    expect(r.facts.distance_km).toBe(r.distance_km);
  });

  it('falls back to same_city (not nearby) when the project is beyond the radius', () => {
    const r = scoreProject(PROJECT, { city: 'الرياض', district: 'النرجس' }, {
      projLat: 24.83, projLng: 46.64,
      reqLat: 25.6, reqLng: 47.5, // far away (>12 km)
    });
    expect(r.match_type).toBe('same_city'); // beyond radius → city match takes over
    expect(r.location_tier).toBe('same_city');
  });

  it('stays pure-text (no nearby) when no coordinates are supplied', () => {
    const r = scoreProject(PROJECT, { city: 'الرياض', district: 'النرجس' });
    expect(r.match_type).toBe('same_city');
    expect(r.distance_km).toBeNull();
  });
});

describe('computeLeadTemperature (deterministic)', () => {
  const day = 86_400_000;
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();

  it('is HOT for a high-intent stage with recent activity', () => {
    const r = computeLeadTemperature({ client_stage: 'عرض سعر', last_activity_at: iso(1) });
    expect(r.temperature).toBe('hot');
  });
  it('is COLD when quiet for over two weeks', () => {
    const r = computeLeadTemperature({ client_stage: 'موعد زيارة', last_activity_at: iso(20) });
    expect(r.temperature).toBe('cold');
  });
  it('is COLD when the status says cold/not-interested', () => {
    const r = computeLeadTemperature({ client_stage: 'جديد', client_status: 'بارد', last_activity_at: iso(1) });
    expect(r.temperature).toBe('cold');
  });
  it('reports won / lost from terminal stages', () => {
    expect(computeLeadTemperature({ client_stage: 'مغلق ناجح' }).temperature).toBe('won');
    expect(computeLeadTemperature({ client_stage: 'خاسر' }).temperature).toBe('lost');
  });
  it('is WARM for an active stage that has gone a little quiet', () => {
    const r = computeLeadTemperature({ client_stage: 'زيارة', last_activity_at: iso(6) });
    expect(r.temperature).toBe('warm');
  });
});

describe('resolveClientFromCandidates — never guess on ambiguity (task write safety)', () => {
  const c = (id: string, name: string, phone = '') => ({ id, name, phone });

  it('resolves a unique exact name match', () => {
    const r = resolveClientFromCandidates([c('1', 'الهنوف'), c('2', 'محمد')], 'الهنوف');
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') expect(r.client.id).toBe('1');
  });

  it('BLOCKS (ambiguous) when two clients share the same name — never picks the first', () => {
    const r = resolveClientFromCandidates([c('1', 'الهنوف', '0551'), c('2', 'الهنوف', '0552')], 'الهنوف');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.candidates.length).toBe(2);
  });

  it('returns not_found when nothing matches', () => {
    expect(resolveClientFromCandidates([c('1', 'محمد')], 'سارة').status).toBe('not_found');
  });

  it('prefers a UNIQUE exact match over multiple substring matches', () => {
    // "الهنوف" is an exact match for #1 and a substring of #2 — exact wins uniquely.
    const r = resolveClientFromCandidates([c('1', 'الهنوف'), c('2', 'الهنوف العتيبي')], 'الهنوف');
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') expect(r.client.id).toBe('1');
  });

  it('is ambiguous when only substring matches exist and there are several', () => {
    const r = resolveClientFromCandidates([c('1', 'أبو الهنوف'), c('2', 'الهنوف العتيبي')], 'الهنوف');
    expect(r.status).toBe('ambiguous');
  });

  it('returns not_found for an empty requested name', () => {
    expect(resolveClientFromCandidates([c('1', 'الهنوف')], '').status).toBe('not_found');
  });
});
