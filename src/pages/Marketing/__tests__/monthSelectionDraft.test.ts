/**
 * The month's project choice survives a reload.
 *
 * Reported live on 2026-09-20: "if I select projects and then I refresh before
 * saving, what I select goes away". It was held in React state only and written
 * nowhere until the confirm.
 *
 * There is no DOM in this suite, so `window.localStorage` is a small in-memory
 * stand-in — which also makes the blocked-storage case (private mode, policy)
 * something we can actually exercise rather than assert about.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSelectionDraft, writeSelectionDraft, clearSelectionDraft } from '../MonthPage';

function installStorage(opts: { throws?: boolean } = {}): Map<string, string> {
  const store = new Map<string, string>();
  const boom = (): never => { throw new Error('storage blocked'); };
  const storage = opts.throws
    ? { getItem: boom, setItem: boom, removeItem: boom }
    : {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return store;
}

describe('the month selection draft', () => {
  beforeEach(() => { installStorage(); });

  it('gives back exactly what was picked, in slot order', () => {
    writeSelectionDraft('2026-09', ['a', 'b', 'c']);
    expect(readSelectionDraft('2026-09')).toEqual(['a', 'b', 'c']);
  });

  it('keeps each month apart', () => {
    writeSelectionDraft('2026-09', ['a']);
    expect(readSelectionDraft('2026-10')).toBeNull();
  });

  it('treats an empty choice as no draft rather than an empty one', () => {
    writeSelectionDraft('2026-09', ['a']);
    writeSelectionDraft('2026-09', []);
    expect(readSelectionDraft('2026-09')).toBeNull();
  });

  it('is dropped once the month is confirmed', () => {
    writeSelectionDraft('2026-09', ['a', 'b']);
    clearSelectionDraft('2026-09');
    expect(readSelectionDraft('2026-09')).toBeNull();
  });

  it('discards an unreadable draft loudly instead of crashing the page', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = installStorage();
    store.set('wassel.mos.month-selection.v1:2026-09', '{not json');
    expect(readSelectionDraft('2026-09')).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('survives storage being blocked — no draft, no throw, but it is logged', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    installStorage({ throws: true });
    expect(() => writeSelectionDraft('2026-09', ['a'])).not.toThrow();
    expect(() => clearSelectionDraft('2026-09')).not.toThrow();
    expect(readSelectionDraft('2026-09')).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
