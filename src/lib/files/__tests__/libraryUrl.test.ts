/**
 * Phase 3 · B5 — the Library's URL codec and feature flag.
 *
 * These two pieces carry the batch's two riskiest contracts:
 *
 *   1. The URL is the single source of truth for the query, so a codec that
 *      loses or mangles a filter produces a WRONG RESULT THAT LOOKS RIGHT —
 *      the exact failure class this batch was told to avoid. Round-tripping is
 *      therefore tested value-by-value, not just "it encodes something".
 *
 *   2. The flag IS the rollback boundary. If `filesLibraryEnabled()` returns
 *      true when it should not, there is no way back to the folder-first page
 *      without a deploy.
 *
 * One subtlety gets its own test because it has bitten this codebase before:
 * an EMPTY array is not "no filter" to `business_files_search` — the RPC tests
 * key PRESENCE (`f ? 'document_type'`), so `{tags: []}` means "match nothing"
 * and would render as an empty library rather than an unfiltered one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  activeFilterCount, decodeLibraryUrl, encodeLibraryUrl, filesLibraryEnabled,
} from '../libraryUrl';
import { pruneFilters } from '../library';
import { SYSTEM_VIEWS, systemView } from '../views';
import type { LibraryFilters } from '@/types';

const BASE = {
  view: null as string | null,
  q: '',
  filters: {} as LibraryFilters,
  grouping: 'none' as const,
  sort: 'created_desc' as const,
  layout: 'grid' as const,
  page: 1,
};

describe('encode/decode — every filter survives the round trip', () => {
  it('carries a full filter set through the URL unchanged', () => {
    const state = {
      ...BASE,
      view: 'unlinked',
      q: 'برج',
      filters: {
        document_type: ['floor_plan', 'brochure'],
        status: ['active'] as LibraryFilters['status'],
        kind: ['pdf'] as LibraryFilters['kind'],
        origin: ['marketing_intake'] as LibraryFilters['origin'],
        confidentiality: ['internal'] as LibraryFilters['confidentiality'],
        role: ['gallery_image'],
        tags: ['riyadh', 'q3'],
        owner_user_id: ['11111111-1111-1111-1111-111111111111'],
        linked_model: 'all_projects',
        created_from: '2026-01-01T00:00:00.000Z',
        size_min: 1024,
        unlinked: true,
        include_archived: true,
      },
      grouping: 'document_type' as const,
      sort: 'title_asc' as const,
      layout: 'list' as const,
      page: 3,
    };
    const decoded = decodeLibraryUrl(encodeLibraryUrl(state));
    expect(decoded).toEqual(state);
  });

  it('leaves a default state as a bare /files with no query string', () => {
    expect(encodeLibraryUrl(BASE)).toBe('');
  });

  it('preserves Arabic free text through encodeURIComponent and back', () => {
    const s = { ...BASE, q: 'مخطط الدور الأرضي' };
    expect(decodeLibraryUrl(encodeLibraryUrl(s)).q).toBe('مخطط الدور الأرضي');
  });

  it('drops an EMPTY list parameter rather than decoding it to []', () => {
    // `?type=` must mean "no document-type filter". Decoding it to [] would be
    // handed to the RPC as "match nothing" and read as an empty library.
    const decoded = decodeLibraryUrl('?type=&tag=');
    expect(decoded.filters.document_type).toBeUndefined();
    expect(decoded.filters.tags).toBeUndefined();
  });

  it('falls back to the default sort when a stale link names an unknown one', () => {
    // An unknown sort makes business_files_search RAISE, so passing it through
    // would turn an old bookmark into a broken page instead of a stale one.
    expect(decodeLibraryUrl('?sort=relevance').sort).toBe('created_desc');
    expect(decodeLibraryUrl('?group=by_moon').grouping).toBe('none');
    expect(decodeLibraryUrl('?layout=carousel').layout).toBe('grid');
  });

  it('never decodes a page below 1', () => {
    expect(decodeLibraryUrl('?page=0').page).toBe(1);
    expect(decodeLibraryUrl('?page=-4').page).toBe(1);
    expect(decodeLibraryUrl('?page=abc').page).toBe(1);
  });

  it('ignores parameters it does not know', () => {
    const decoded = decodeLibraryUrl('?type=floor_plan&somethingNew=42');
    expect(decoded.filters.document_type).toEqual(['floor_plan']);
  });
});

describe('pruneFilters — an empty value must never reach the RPC', () => {
  it('removes empty arrays, empty strings and false booleans', () => {
    expect(pruneFilters({
      document_type: [],
      tags: ['x'],
      linked_model: '',
      unlinked: false,
      expired: true,
    })).toEqual({ tags: ['x'], expired: true });
  });

  it('keeps a zero, which is a real size bound', () => {
    expect(pruneFilters({ size_min: 0 })).toEqual({ size_min: 0 });
  });
});

describe('activeFilterCount', () => {
  it('counts one per active filter, ignoring falsey flags', () => {
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ document_type: [], unlinked: false })).toBe(0);
    expect(activeFilterCount({ document_type: ['a', 'b'], unlinked: true })).toBe(2);
  });
});

describe('the six system views', () => {
  it('ships exactly six, each with both labels and a stable key', () => {
    expect(SYSTEM_VIEWS).toHaveLength(6);
    for (const v of SYSTEM_VIEWS) {
      expect(v.key).toMatch(/^[a-z_]+$/);
      expect(v.label_ar.trim()).not.toBe('');
      expect(v.label_en.trim()).not.toBe('');
      expect(v.hint_ar.trim()).not.toBe('');
      expect(v.hint_en.trim()).not.toBe('');
    }
    // Keys are in URLs, so a duplicate would make one view unreachable.
    expect(new Set(SYSTEM_VIEWS.map((v) => v.key)).size).toBe(6);
  });

  it('builds filters the RPC actually understands', () => {
    expect(systemView('unlinked')!.build(null).filters).toEqual({ unlinked: true });
    expect(systemView('marketing')!.build(null).filters).toEqual({ origin: ['marketing_intake'] });
    expect(systemView('expiring')!.build(null).filters).toEqual({ expired: true });
    expect(systemView('project_pack')!.build(null).filters).toEqual({ linked_model: 'all_projects' });
    expect(systemView('project_pack')!.build(null).grouping).toBe('document_type');
  });

  it('"My files" filters on OWNER, and on nothing at all without a user', () => {
    // owner_user_id, not uploaded_by_user_id: ownership is transferable and the
    // uploader is immutable history. One person uploaded 80% of this library.
    expect(systemView('mine')!.build('u1').filters).toEqual({ owner_user_id: ['u1'] });
    // An unbound session must NOT silently become "everyone's files".
    expect(systemView('mine')!.build(null).filters).toEqual({});
    expect(systemView('mine')!.requiresUser).toBe(true);
  });

  it('"Recently added" builds a window that moves with the clock', () => {
    const from = systemView('recent')!.build(null).filters.created_from!;
    const age = Date.now() - new Date(from).getTime();
    expect(age).toBeGreaterThan(29 * 864e5);
    expect(age).toBeLessThan(31 * 864e5);
  });

  it('every system view round-trips through the URL', () => {
    for (const v of SYSTEM_VIEWS) {
      const state = { ...v.build('u1'), page: 1, view: v.key };
      expect(decodeLibraryUrl(encodeLibraryUrl(state))).toEqual(state);
    }
  });
});

describe('filesLibraryEnabled — the rollback boundary', () => {
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

  it('is OFF when nothing has opted in', () => {
    vi.stubEnv('VITE_FEATURE_FILES_LIBRARY', '');
    expect(filesLibraryEnabled('')).toBe(false);
  });

  it('is OFF for any env value other than exactly "1"', () => {
    for (const v of ['0', 'true', 'yes', 'on']) {
      vi.stubEnv('VITE_FEATURE_FILES_LIBRARY', v);
      expect(filesLibraryEnabled('')).toBe(false);
    }
  });

  it('is ON for the env value "1"', () => {
    vi.stubEnv('VITE_FEATURE_FILES_LIBRARY', '1');
    expect(filesLibraryEnabled('')).toBe(true);
  });

  it('?library=1 turns it on and is remembered', () => {
    vi.stubEnv('VITE_FEATURE_FILES_LIBRARY', '');
    expect(filesLibraryEnabled('?library=1')).toBe(true);
    expect(store.wassell_files_library).toBe('1');
    expect(filesLibraryEnabled('')).toBe(true);       // now from storage
  });

  it('?library=0 turns it OFF even when the environment has it on', () => {
    // This is the instant, no-deploy rollback. It has to beat the env var.
    vi.stubEnv('VITE_FEATURE_FILES_LIBRARY', '1');
    expect(filesLibraryEnabled('?library=0')).toBe(false);
    expect(filesLibraryEnabled('')).toBe(false);
  });

  it('survives a localStorage that throws', () => {
    vi.stubEnv('VITE_FEATURE_FILES_LIBRARY', '1');
    vi.stubGlobal('window', {
      location: { search: '' },
      localStorage: {
        getItem: () => { throw new Error('private mode'); },
        setItem: () => { throw new Error('private mode'); },
      },
    });
    // A storage failure must degrade to the environment default, never crash
    // the route that decides which page to render.
    expect(filesLibraryEnabled('')).toBe(true);
    expect(filesLibraryEnabled('?library=0')).toBe(false);
  });
});
