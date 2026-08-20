/**
 * The per-batch Files feature flags (src/lib/files/flags.ts).
 *
 * recordFilesEnabled was ACTIVATED for everyone on 2026-08-20. These assert the
 * new default-ON contract and that all three rollback levers still work — the
 * same contract filesLibraryEnabled carries, and for the same reason: a flag
 * that cannot be turned back off is not a rollback boundary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { recordFilesEnabled } from '../flags';

describe('recordFilesEnabled — activated, but still fully rollback-able', () => {
  const store: Record<string, string> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.stubGlobal('window', {
      location: { search: '' },
      localStorage: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
      },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('is ON by default when nothing has opted out', () => {
    vi.stubEnv('VITE_FEATURE_RECORD_FILES', '');
    expect(recordFilesEnabled('')).toBe(true);
  });

  it('VITE_FEATURE_RECORD_FILES=0 is the environment kill switch', () => {
    vi.stubEnv('VITE_FEATURE_RECORD_FILES', '0');
    expect(recordFilesEnabled('')).toBe(false);
  });

  it('?recordfiles=0 turns it off for one person and is remembered', () => {
    vi.stubEnv('VITE_FEATURE_RECORD_FILES', '');
    expect(recordFilesEnabled('?recordfiles=0')).toBe(false);
    expect(store.wassell_record_files).toBe('0');
    expect(recordFilesEnabled('')).toBe(false);
  });

  it('?recordfiles=1 opts a person back in even under the env kill switch', () => {
    vi.stubEnv('VITE_FEATURE_RECORD_FILES', '0');
    expect(recordFilesEnabled('?recordfiles=1')).toBe(true);
    expect(recordFilesEnabled('')).toBe(true);
  });
});
