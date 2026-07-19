import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { saveFinderStash, loadFinderStash, clearFinderStash } from '../finderStash';

/** Minimal in-memory localStorage so the module under test runs in any env. */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  return map;
}

const CLIENT = 'client-1';
const items = [
  { sourceType: 'market_listing' as const, sourceId: 'a', sourceName: 'فيلا ألف', matchScore: 100, facts: { district: 'المهدية' } },
  { sourceType: 'project' as const, sourceId: 'b', sourceName: 'مشروع باء', matchScore: 92, facts: {} },
];

let storage: Map<string, string>;
beforeEach(() => { storage = installStorage(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('finderStash', () => {
  it('round-trips the selection payloads for a client', () => {
    saveFinderStash(CLIENT, items);
    const got = loadFinderStash(CLIENT);
    expect(got?.clientId).toBe(CLIENT);
    expect(got?.items).toHaveLength(2);
    expect(got?.items[0]?.sourceName).toBe('فيلا ألف');
    expect(got?.items[1]?.matchScore).toBe(92);
  });

  it('is scoped per client — another client sees nothing', () => {
    saveFinderStash(CLIENT, items);
    expect(loadFinderStash('other-client')).toBeNull();
  });

  it('saving an EMPTY selection clears the stash (nothing left to restore)', () => {
    saveFinderStash(CLIENT, items);
    saveFinderStash(CLIENT, []);
    expect(loadFinderStash(CLIENT)).toBeNull();
    expect([...storage.keys()]).toHaveLength(0);
  });

  it('clearFinderStash removes it', () => {
    saveFinderStash(CLIENT, items);
    clearFinderStash(CLIENT);
    expect(loadFinderStash(CLIENT)).toBeNull();
  });

  it('ignores and sweeps a stash older than the 24h TTL', () => {
    saveFinderStash(CLIENT, items);
    const key = [...storage.keys()][0]!;
    const stale = JSON.parse(storage.get(key)!);
    stale.savedAt = Date.now() - 25 * 60 * 60 * 1000;
    storage.set(key, JSON.stringify(stale));
    expect(loadFinderStash(CLIENT)).toBeNull();
    expect(storage.has(key)).toBe(false); // swept, not left to resurface
  });

  it('drops a corrupt entry instead of throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    saveFinderStash(CLIENT, items);
    const key = [...storage.keys()][0]!;
    storage.set(key, '{not json');
    expect(() => loadFinderStash(CLIENT)).not.toThrow();
    expect(loadFinderStash(CLIENT)).toBeNull();
    expect(storage.has(key)).toBe(false);
  });

  it('survives a write failure (quota) without throwing — the finder keeps working', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} },
      configurable: true, writable: true,
    });
    expect(() => saveFinderStash(CLIENT, items)).not.toThrow();
    expect(err).toHaveBeenCalled(); // surfaced, never silent
  });
});
