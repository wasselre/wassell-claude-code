/**
 * Phase 3 · B5 — the Library's URL codec and its feature flag.
 *
 * Spec §6: "Chips are removable and the active set is URL-encoded, so any
 * filtered state is a shareable link." That is the whole job of this file:
 * turn the view state into query parameters and back, losslessly, so a
 * colleague pasted a link sees the same slice — under THEIR permissions, since
 * the search is SECURITY INVOKER.
 *
 * Design constraint that shapes everything below: the encoding is READ by a
 * future version of the app, and by a human scanning a URL. So it uses one
 * parameter per filter with comma-separated values (`?type=floor_plan,brochure`)
 * rather than a base64 blob. An unknown parameter is ignored on read and a
 * known one that has gone away decodes to nothing — the same forward/backward
 * tolerance the jsonb filters column has.
 */
import type {
  BusinessFileSort,
  FileClass,
  FileConfidentiality,
  FileOrigin,
  FilePreviewKind,
  FileStatus,
  LibraryFilters,
  LibraryGrouping,
  LibraryLayout,
} from '@/types';
import type { LibraryViewState } from './views';
import { readFileFlag } from './flags';

// ─── Feature flag ─────────────────────────────────────────────────────────

const FLAG_STORAGE_KEY = 'wassell_files_library';

/**
 * B5's rollback boundary, verbatim from the spec: "Feature flag returns the
 * folder-first page."
 *
 * Three sources, most specific first:
 *   1. `?library=1` / `?library=0` in the URL — takes effect immediately AND
 *      is remembered, so one person can turn it on (or off) without a deploy.
 *      This is what makes the rollback instant rather than a build away.
 *   2. localStorage, from a previous use of (1).
 *   3. `VITE_FEATURE_FILES_LIBRARY=1` — the global default, set per
 *      environment. Same mechanism as VITE_FEATURE_FILE_LINKS before it.
 *
 * Default OFF. A user who has never opted in and whose environment has not
 * enabled it keeps the folder-first page exactly as it is today.
 */
export function filesLibraryEnabled(search?: string): boolean {
  // ACTIVATED FOR EVERYONE — 2026-08-20. Phase 3 (B1–B9) is complete and the
  // Library is now the default `/files`.
  //
  // The rollback boundary the whole batch was built around is preserved intact,
  // at three levels of granularity:
  //   - `?library=0` in the URL turns it off for one person, instantly, and is
  //     remembered — the per-user escape hatch.
  //   - `VITE_FEATURE_FILES_LIBRARY=0` set in the environment turns it off for
  //     everyone at the next build, without a code change — the kill switch.
  //   - reverting this one commit restores the folder-first default.
  //
  // So the env var flips meaning: it is now an explicit OFF switch, not the ON
  // switch. Absent (the production state — the compiled bundle defaulted to
  // false because it was never set), it defaults ON. Only the literal '0' turns
  // it off.
  const env = import.meta.env.VITE_FEATURE_FILES_LIBRARY as string | undefined;
  if (env === '0') {
    // Environment kill switch: honour it, but a per-user ?library=1 can still
    // opt back in, so route through readFileFlag rather than short-circuiting.
    return readFileFlag('library', FLAG_STORAGE_KEY, '0', search);
  }
  return readFileFlag('library', FLAG_STORAGE_KEY, '1', search);
}

/**
 * Where the Marketing Asset Library lives.
 *
 * The old grid at `/m/library` was retired (2026-08-20) in favour of the
 * unified Library. Rather than send the user OUT to `/files` (which ejected
 * them from the `/m` marketing shell into another section), `/m/library` now
 * EMBEDS the unified Library inside Marketing — same page, mounted with
 * `basePath="/m/library"` + `defaultView="marketing"` (see `MarketingAssetLibrary`
 * in App.tsx). So this is just that in-shell path: the marketing rail, the
 * mobile tab, and every "back to library" button use it and stay in Marketing.
 * The embedded page opens on the marketing view by itself, so a bare path is
 * all that is needed.
 */
export function marketingLibraryHref(): string {
  return '/m/library';
}

// ─── URL codec ────────────────────────────────────────────────────────────

const SORTS: BusinessFileSort[] = [
  'created_desc', 'created_asc', 'updated_desc',
  'title_asc', 'title_desc', 'size_desc', 'size_asc',
];
const GROUPINGS: LibraryGrouping[] = ['none', 'document_type', 'linked_model', 'owner', 'month'];
const LAYOUTS: LibraryLayout[] = ['grid', 'list'];

/** Every multi-value filter, as `url parameter` → `filters key`. One table so
 *  encode and decode can never drift apart by editing only one of them. */
const LIST_PARAMS = {
  type: 'document_type',
  status: 'status',
  kind: 'kind',
  origin: 'origin',
  conf: 'confidentiality',
  role: 'role',
  tag: 'tags',
  owner: 'owner_user_id',
  uploader: 'uploaded_by_user_id',
} as const satisfies Record<string, keyof LibraryFilters>;

const SCALAR_PARAMS = {
  model: 'linked_model',
  mid: 'model_id',
  rid: 'record_id',
  from: 'created_from',
  to: 'created_to',
  fclass: 'file_class',
} as const satisfies Record<string, keyof LibraryFilters>;

const NUMBER_PARAMS = {
  minsize: 'size_min',
  maxsize: 'size_max',
} as const satisfies Record<string, keyof LibraryFilters>;

const BOOL_PARAMS = {
  unlinked: 'unlinked',
  expired: 'expired',
  dupe: 'duplicate',
  archived: 'include_archived',
} as const satisfies Record<string, keyof LibraryFilters>;

export interface LibraryUrlState extends LibraryViewState {
  page: number;
  /** Which view is open — a system view key, `saved:<uuid>`, or null for an
   *  ad-hoc query the user built by hand. */
  view: string | null;
}

export function encodeLibraryUrl(state: LibraryUrlState): string {
  const p = new URLSearchParams();
  if (state.view) p.set('view', state.view);
  if (state.q.trim()) p.set('q', state.q.trim());

  const f = state.filters;
  for (const [param, key] of Object.entries(LIST_PARAMS)) {
    const v = f[key as keyof LibraryFilters] as string[] | undefined;
    if (Array.isArray(v) && v.length) p.set(param, v.join(','));
  }
  for (const [param, key] of Object.entries(SCALAR_PARAMS)) {
    const v = f[key as keyof LibraryFilters] as string | undefined;
    if (v) p.set(param, v);
  }
  for (const [param, key] of Object.entries(NUMBER_PARAMS)) {
    const v = f[key as keyof LibraryFilters] as number | undefined;
    if (typeof v === 'number' && Number.isFinite(v)) p.set(param, String(v));
  }
  for (const [param, key] of Object.entries(BOOL_PARAMS)) {
    if (f[key as keyof LibraryFilters] === true) p.set(param, '1');
  }

  // Only non-defaults, so a plain Library is a plain `/files`.
  if (state.grouping !== 'none') p.set('group', state.grouping);
  if (state.sort !== 'created_desc') p.set('sort', state.sort);
  if (state.layout !== 'grid') p.set('layout', state.layout);
  if (state.page > 1) p.set('page', String(state.page));

  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

export function decodeLibraryUrl(search: string): LibraryUrlState {
  const p = new URLSearchParams(search);
  const filters: LibraryFilters = {};

  for (const [param, key] of Object.entries(LIST_PARAMS)) {
    const raw = p.get(param);
    if (!raw) continue;
    const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
    // An empty list is NOT "no filter" to business_files_search — it is "match
    // nothing". `?type=` must therefore decode to an absent key, not to [].
    if (values.length) {
      (filters as Record<string, unknown>)[key] = values;
    }
  }
  for (const [param, key] of Object.entries(SCALAR_PARAMS)) {
    const raw = p.get(param)?.trim();
    if (raw) (filters as Record<string, unknown>)[key] = raw;
  }
  for (const [param, key] of Object.entries(NUMBER_PARAMS)) {
    const raw = p.get(param);
    if (raw === null) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) (filters as Record<string, unknown>)[key] = n;
  }
  for (const [param, key] of Object.entries(BOOL_PARAMS)) {
    if (p.get(param) === '1') (filters as Record<string, unknown>)[key] = true;
  }

  const grouping = p.get('group') as LibraryGrouping | null;
  const sort = p.get('sort') as BusinessFileSort | null;
  const layout = p.get('layout') as LibraryLayout | null;
  const page = Number(p.get('page') ?? '1');

  return {
    view: p.get('view'),
    q: p.get('q') ?? '',
    filters,
    // A value that is no longer in the vocabulary falls back to the default
    // rather than being passed through — an unknown sort makes the RPC RAISE,
    // which would turn a stale bookmark into a broken page.
    grouping: grouping && GROUPINGS.includes(grouping) ? grouping : 'none',
    sort: sort && SORTS.includes(sort) ? sort : 'created_desc',
    layout: layout && LAYOUTS.includes(layout) ? layout : 'grid',
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}

/** How many filters are active, for the "clear all" affordance and the chip
 *  count. Booleans count only when true; arrays only when non-empty. */
export function activeFilterCount(filters: LibraryFilters): number {
  let n = 0;
  for (const value of Object.values(filters)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) { if (value.length) n += 1; continue; }
    if (typeof value === 'boolean') { if (value) n += 1; continue; }
    n += 1;
  }
  return n;
}

/** Typed re-exports so the filter-bar components do not each re-declare the
 *  vocabularies. These are the values the UI offers; the facets decide which
 *  of them are worth showing. */
export const FILE_STATUSES: FileStatus[] = ['draft', 'active', 'superseded', 'archived'];
export const FILE_CONFIDENTIALITIES: FileConfidentiality[] = ['public', 'internal', 'restricted'];
export const FILE_ORIGINS: FileOrigin[] = [
  'user_upload', 'marketing_intake', 'integration_inbound',
  'generated_document', 'derived_rendition', 'system_artifact',
];
export const FILE_KINDS: FilePreviewKind[] = [
  'image', 'pdf', 'video', 'audio', 'document', 'wassel_doc', 'archive', 'other',
];
export const FILE_CLASSES: FileClass[] = ['business', 'system'];
export const LIBRARY_SORTS = SORTS;
export const LIBRARY_GROUPINGS = GROUPINGS;

/**
 * Phase 3 · B9 — the same folder-name → document_type classifier the backfill
 * migration used (b9_folder_name_to_type). Kept in lockstep with the SQL: a
 * folder whose name is a TYPE word ("صور", "فيديو") was captured as the files'
 * document_type and deliberately NOT as a tag, so the Legacy-folder banner must
 * offer the TYPE filter for those and the TAG filter for project folders. A
 * banner that always linked to ?tag= would land on zero results for every
 * type-word folder — which is exactly what it did before this existed.
 */
export function folderNameToDocType(name: string): string | null {
  const n = name.trim();
  if (/صور|الصور|معرض|gallery|صوره/.test(n)) return 'gallery_image';
  if (/فيديو|video|مقطع/.test(n)) return 'video';
  if (/دور|مخطط|floor|plan|طابق/.test(n)) return 'floor_plan';
  if (/بروش|brochure|كتيب/.test(n)) return 'brochure';
  if (/علامة|هوية|brand|شعار|logo/.test(n)) return 'reference';
  if (/محتوى|محتوي|تسويق|marketing|اعلان|إعلان/.test(n)) return 'marketing_asset';
  return null;
}

/** The Library query that is the metadata equivalent of a Legacy folder:
 *  its type filter if the name is a type-word, otherwise its name as a tag. */
export function equivalentViewSearch(folderName: string): string {
  const t = folderNameToDocType(folderName);
  return t ? `?type=${encodeURIComponent(t)}` : `?tag=${encodeURIComponent(folderName)}`;
}
