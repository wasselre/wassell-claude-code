import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { clientEstablishedCity, DEFAULT_ESTABLISHED_CITY } from '../backfillPorts';

/** Minimal fake: `from('unified_records').select().eq('id', x).maybeSingle()`. */
function fakeSupabase(rows: Record<string, Record<string, unknown>>, failIds: string[] = []): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () =>
            failIds.includes(id)
              ? { data: null, error: { message: `boom ${id}` } }
              : { data: rows[id] ? { data: rows[id] } : null, error: null },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('clientEstablishedCity — reads the location cascade', () => {
  it('resolves the ONE location.city id to its Arabic city name', async () => {
    const sb = fakeSupabase({
      c1: { location: { city: ['city-jed'] } },
      'city-jed': { name_ar: 'جدة', name_en: 'Jeddah' },
    });
    expect(await clientEstablishedCity(sb, 'c1')).toEqual({ city: 'جدة', universe: 'explicit' });
  });

  it('falls back to the organisational default with no city, several cities, or an unknown city id', async () => {
    const sb = fakeSupabase({
      none: {},
      many: { location: { city: ['a', 'b'] } },
      ghost: { location: { city: ['missing-city'] } },
    });
    for (const id of ['none', 'many', 'ghost']) {
      expect(await clientEstablishedCity(sb, id)).toEqual({ city: DEFAULT_ESTABLISHED_CITY, universe: 'organizational_default' });
    }
  });

  it('fails loudly when the city read errors', async () => {
    const sb = fakeSupabase({ c1: { location: { city: ['city-x'] } } }, ['city-x']);
    await expect(clientEstablishedCity(sb, 'c1')).rejects.toThrow(/city read for established city failed/);
  });
});
