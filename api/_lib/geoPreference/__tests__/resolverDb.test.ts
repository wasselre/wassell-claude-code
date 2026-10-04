import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseResolverDb, parseRoadAxis } from '../resolverDb.js';

/**
 * The Supabase adapter's NEW ports (design 2026-10-04 §2.4): roadAxis,
 * cityLabel, namesInText are wired, call the right RPCs with the right
 * argument names, and every port THROWS on a database error — none quietly
 * returns "nothing found". Runs against a scripted stand-in client; the RPCs
 * themselves were verified live when the migration was applied.
 */

type Result = { data: unknown; error: { message: string } | null };
interface Call { kind: 'rpc' | 'from'; name: string; args?: unknown; ops: Array<[string, unknown[]]> }

/** A scripted client: `rpc(fn)` and `from(table)…` resolve to the scripted result; every call is recorded. */
function scripted(rpc: Record<string, Result>, tables: Record<string, Result | ((ops: Array<[string, unknown[]]>) => Result)>) {
  const calls: Call[] = [];
  const builder = (call: Call, result: () => Result): unknown => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'or', 'limit', 'ilike']) {
      b[m] = (...args: unknown[]) => { call.ops.push([m, args]); return b; };
    }
    b.maybeSingle = async () => result();
    b.then = (ok: (r: Result) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad);
    return b;
  };
  const client = {
    rpc: async (name: string, args: unknown): Promise<Result> => {
      calls.push({ kind: 'rpc', name, args, ops: [] });
      const r = rpc[name];
      if (!r) throw new Error(`unscripted rpc ${name}`);
      return r;
    },
    from: (name: string): unknown => {
      const call: Call = { kind: 'from', name, ops: [] };
      calls.push(call);
      const t = tables[name];
      if (!t) throw new Error(`unscripted table ${name}`);
      return builder(call, () => (typeof t === 'function' ? t(call.ops) : t));
    },
  };
  return { db: createSupabaseResolverDb(client as unknown as SupabaseClient), calls };
}

const ok = (data: unknown): Result => ({ data, error: null });
const fail = (message: string): Result => ({ data: null, error: { message } });

describe('createSupabaseResolverDb — the three required ports', () => {
  it('exposes roadAxis, cityLabel and namesInText', () => {
    const { db } = scripted({}, {});
    expect(typeof db.roadAxis).toBe('function');
    expect(typeof db.cityLabel).toBe('function');
    expect(typeof db.namesInText).toBe('function');
  });

  it('roadAxis calls wassell_geo_road_axis with the road id and the district ids (null when none)', async () => {
    const { db, calls } = scripted({ wassell_geo_road_axis: ok({ found: true, scope: 'district', ew_m: 5347, ns_m: 2466 }) }, {});
    expect(await db.roadAxis('RUH-ROAD-0681', ['5d788587-4219-7ad2-a6b6-e0bbfebde16d']))
      .toEqual({ found: true, scope: 'district', ew_m: 5347, ns_m: 2466 });
    await db.roadAxis('RUH-ROAD-0694');
    await db.roadAxis('RUH-ROAD-0694', []);
    expect(calls.map((c) => c.args)).toEqual([
      { p_road_external_id: 'RUH-ROAD-0681', p_district_ids: ['5d788587-4219-7ad2-a6b6-e0bbfebde16d'] },
      { p_road_external_id: 'RUH-ROAD-0694', p_district_ids: null },
      { p_road_external_id: 'RUH-ROAD-0694', p_district_ids: null },
    ]);
  });

  it('roadAxis passes found:false through and throws on an error or an unknown shape', async () => {
    expect(await scripted({ wassell_geo_road_axis: ok({ found: false }) }, {}).db.roadAxis('NOPE')).toEqual({ found: false });
    await expect(scripted({ wassell_geo_road_axis: fail('boom') }, {}).db.roadAxis('X')).rejects.toThrow(/road axis lookup failed/);
    await expect(scripted({ wassell_geo_road_axis: ok(null) }, {}).db.roadAxis('X')).rejects.toThrow(/road axis/);
    expect(() => parseRoadAxis({ found: true, scope: 'city', ew_m: 1, ns_m: 1 })).toThrow(/unknown scope/);
    expect(() => parseRoadAxis({ found: true, scope: 'road' })).toThrow(/ew_m/);
    expect(parseRoadAxis({ found: true, scope: 'road', ew_m: '72933', ns_m: 141178 })).toEqual({ found: true, scope: 'road', ew_m: 72933, ns_m: 141178 });
  });

  it('namesInText calls wassell_geo_names_in_text and throws on an error', async () => {
    const rows = [{ external_id: 'RUH-MALL-0038', name: 'الرياض بارك', category: 'malls' }, { external_id: '', name: 'x', category: null }];
    const { db, calls } = scripted({ wassell_geo_names_in_text: ok(rows) }, {});
    expect(await db.namesInText('ابي حول الرياض بارك')).toEqual([{ external_id: 'RUH-MALL-0038', name: 'الرياض بارك', category: 'malls' }]);
    expect(calls[0]).toMatchObject({ name: 'wassell_geo_names_in_text', args: { p_text: 'ابي حول الرياض بارك' } });
    await expect(scripted({ wassell_geo_names_in_text: fail('boom') }, {}).db.namesInText('x')).rejects.toThrow(/names-in-text/);
    await expect(scripted({ wassell_geo_names_in_text: ok({ not: 'rows' }) }, {}).db.namesInText('x')).rejects.toThrow(/names-in-text/);
  });

  it('cityLabel: an Arabic spelling → name_en; a Latin name_en → itself; unknown → NULL (never the input)', async () => {
    const cities = [{ data: { name_ar: 'الرياض', name_en: 'Riyadh' } }];
    const { db } = scripted({}, {
      models: ok({ id: 'm-cities' }),
      unified_records: (ops) => (ops.some(([m, a]) => m === 'in' && (a[1] as string[]).includes('الرياض'))
        || ops.some(([m, a]) => m === 'ilike' && String(a[1]).toLowerCase() === 'riyadh') ? ok(cities) : ok([])),
    });
    expect(await db.cityLabel('رياض')).toBe('Riyadh');
    expect(await db.cityLabel('riyadh')).toBe('Riyadh');
    expect(await db.cityLabel('المزرعة')).toBeNull();
    expect(await db.cityLabel('Atlantis')).toBeNull();
    expect(await db.cityLabel('')).toBeNull();
  });

  it('cityLabel throws when the cities lookup errors', async () => {
    const { db } = scripted({}, { models: ok({ id: 'm-cities' }), unified_records: fail('boom') });
    await expect(db.cityLabel('الرياض')).rejects.toThrow(/city/);
  });
});

describe('createSupabaseResolverDb — no silent failures in the existing ports', () => {
  it('zoneDistricts throws on an error; a non-list without an error is an empty zone', async () => {
    await expect(scripted({ wassell_city_zone_districts: fail('boom') }, {}).db.zoneDistricts('الرياض', 'north')).rejects.toThrow(/zone lookup failed/);
    expect(await scripted({ wassell_city_zone_districts: ok(null) }, {}).db.zoneDistricts('الرياض', 'north')).toEqual([]);
  });

  it('districtForPoint throws on an error; no row is null', async () => {
    await expect(scripted({ districts_for_points: fail('boom') }, {}).db.districtForPoint(24.7, 46.6)).rejects.toThrow(/point-in-district/);
    expect(await scripted({ districts_for_points: ok([]) }, {}).db.districtForPoint(24.7, 46.6)).toBeNull();
  });

  it('a failed model lookup throws instead of reading as "no such model"', async () => {
    await expect(scripted({}, { models: fail('boom') }).db.findDistricts('النرجس', 'SA')).rejects.toThrow(/model lookup/);
  });

  it('findElements loads each element\'s aliases (the search matches them but does not return them), and throws on an alias error', async () => {
    const element = { external_id: 'RUH-UNIV-0064', name_ar: 'جامعة الأميرة نورة بنت عبدالرحمن', name_en: '', geom_kind: 'polygon', city: 'Riyadh', latitude: 24.84, longitude: 46.72, review_status: 'approved' };
    const { db, calls } = scripted({ wassell_search_geo_elements: ok([element]) }, {
      geo_element_aliases: ok([
        { external_id: 'RUH-UNIV-0064', alias: 'جامعة الأميرة نورة' },
        { external_id: 'RUH-UNIV-0064', alias: 'جامعة الاميرة نورة' },
      ]),
    });
    const rows = await db.findElements('جامعة الأميرة نورة', { preferCountry: 'SA' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aliases).toEqual(['جامعة الأميرة نورة', 'جامعة الاميرة نورة']);
    const aliasCall = calls.find((c) => c.name === 'geo_element_aliases')!;
    expect(aliasCall.ops).toContainEqual(['in', ['external_id', ['RUH-UNIV-0064']]]);

    const broken = scripted({ wassell_search_geo_elements: ok([element]) }, { geo_element_aliases: fail('boom') });
    await expect(broken.db.findElements('x', { preferCountry: 'SA' })).rejects.toThrow(/alias lookup failed/);
  });
});
