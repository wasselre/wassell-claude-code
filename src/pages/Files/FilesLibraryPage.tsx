/**
 * Phase 3 · B5 — the Business Files Library.
 *
 * `/files` stops being a folder tree and becomes a metadata-driven library over
 * the whole canonical store. Folders are still there, one tab away, and nothing
 * about them changed — this page does not read or write a single folder row.
 *
 * ── THE ONE FAILURE MODE THIS PAGE IS DESIGNED AROUND ─────────────────────
 * A slow or failing query that renders as an empty state reads to a user as
 * "there are no files". The Project Finder shipped exactly that — a 504 that
 * looked like "no matches" — and it went unnoticed for weeks. So this page
 * carries THREE distinct terminal states and never conflates them:
 *
 *     loading   → a spinner
 *     error     → a red card naming the failure, with Retry. Never an empty grid.
 *     total = 0 → the empty state, which says "nothing matched" and offers to
 *                 clear the filters, because after B4 a genuinely empty library
 *                 is nearly impossible and a filter is the likely cause.
 *
 * ── WHY THE SEARCH IS DEBOUNCED, AND WHAT ELSE IS NOT ─────────────────────
 * `business_files_search` measures 350–1,100 ms on production (2026-08-19,
 * seven real users). Typing "brochure" un-debounced would put eight of those in
 * flight. Free text is therefore debounced by 400 ms; every OTHER control —
 * a facet, a sort, a page — fires immediately, because those are deliberate
 * single actions and delaying them just feels broken.
 *
 * Responses are sequence-guarded: a slow early request can land after a fast
 * later one, and without the guard the grid would show the older answer. That
 * is the same class of bug as the empty-vs-error trap — a wrong result that
 * looks like a right one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, FolderSearch, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import ConfirmModal from '@/components/ui/ConfirmModal';
import type {
  BusinessFileFacets, BusinessFileRow, BusinessFileSort, FileDocumentTypeRow, FileViewRow,
  LibraryFilters, LibraryGrouping, PageLinkSummary, FileRow,
} from '@/types';
import {
  LIBRARY_PAGE_SIZE, errorText, fetchPageLinks, listDocumentTypes, searchBusinessFiles,
} from '@/lib/files/library';
import {
  deleteFileView, listFileViews, saveFileView, systemView, viewStateFromRow,
} from '@/lib/files/views';
import { activeFilterCount, decodeLibraryUrl, encodeLibraryUrl } from '@/lib/files/libraryUrl';
import { getFile, signDownloadUrl, signViewUrls } from '@/lib/files/client';
import { useMarqueeSelection } from './useMarqueeSelection';
import FilesTabs from './components/FilesTabs';
import FilePreviewModal from './components/FilePreviewModal';
import LibraryFilterBar from './library/LibraryFilterBar';
import LibraryChips from './library/LibraryChips';
import LibraryResults from './library/LibraryResults';
import LibraryViewsRail from './library/LibraryViewsRail';
import LibraryDetailPanel from './library/LibraryDetailPanel';
import SaveViewModal from './library/SaveViewModal';
import LibraryBulkBar from './library/LibraryBulkBar';
import BulkEditModal from './library/BulkEditModal';

const SEARCH_DEBOUNCE_MS = 400;

export default function FilesLibraryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const currentUserId = useAppStore((s) => s.currentUserId);
  const addToast = useAppStore((s) => s.addToast);

  // ── Query state, sourced from the URL ───────────────────────────────────
  // The URL is the single source of truth for the query, which is what makes
  // any filtered state a shareable link (spec §6) AND makes Back work.
  const urlState = useMemo(() => decodeLibraryUrl(location.search), [location.search]);
  const { view, q, filters, grouping, sort, layout, page } = urlState;

  /** The live text in the box. Diverges from `q` for one debounce interval. */
  const [searchInput, setSearchInput] = useState(q);
  // Keep the box in step when the query changes from anywhere else — opening a
  // view, following a shared link, pressing Back.
  useEffect(() => { setSearchInput(q); }, [q]);

  const pushState = useCallback(
    (next: Partial<typeof urlState>, replace = false) => {
      const merged = { ...urlState, ...next };
      // Any change to WHAT is being asked resets to page 1. Landing on page 4
      // of a two-page result is the classic offset-pagination papercut.
      if (next.page === undefined) merged.page = 1;
      navigate({ pathname: '/files', search: encodeLibraryUrl(merged) }, { replace });
    },
    [navigate, urlState],
  );

  // Debounce ONLY the free text.
  useEffect(() => {
    if (searchInput === q) return;
    const id = window.setTimeout(() => {
      // `replace` so a burst of typing leaves one history entry, not eight.
      pushState({ q: searchInput, view: null }, true);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput, q, pushState]);

  // ── Results ─────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<BusinessFileRow[]>([]);
  const [facets, setFacets] = useState<BusinessFileFacets | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  /** Monotonic request id — a stale response is dropped, never rendered. */
  const seqRef = useRef(0);
  const [reloadKey, setReloadKey] = useState(0);

  const runSearch = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    const t0 = performance.now();
    try {
      const res = await searchBusinessFiles({ q, filters, sort, page, pageSize: LIBRARY_PAGE_SIZE });
      if (seq !== seqRef.current) return;      // a newer query already answered
      setRows(res.rows ?? []);
      setFacets(res.facets ?? null);
      setTotal(res.total ?? 0);
      setElapsedMs(Math.round(performance.now() - t0));
    } catch (e) {
      if (seq !== seqRef.current) return;
      // THE point of this branch: the grid is NOT emptied. Whatever was on
      // screen stays, above a red card explaining what broke — an empty grid
      // would read as "no files", which is the failure this page exists to
      // avoid repeating.
      setError(errorText(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [q, filters, sort, page]);

  useEffect(() => { void runSearch(); }, [runSearch, reloadKey]);

  // ── The document-type vocabulary (16 rows, effectively static) ───────────
  const [types, setTypes] = useState<FileDocumentTypeRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listDocumentTypes();
        if (!cancelled) setTypes(list);
      } catch {
        // listDocumentTypes toasted. Labels fall back to the raw slug, which
        // is ugly but true — far better than a Library that refuses to render
        // because a lookup table did not load.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Thumbnails: ONE batch sign for the whole visible slice ──────────────
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    const imageIds = rows.filter((r) => r.kind === 'image').map((r) => r.id);
    if (imageIds.length === 0) { setThumbs({}); return; }
    let cancelled = false;
    void (async () => {
      try {
        const map = await signViewUrls(imageIds);
        if (!cancelled) setThumbs(map);
      } catch {
        // Thumbnails are decoration. Tiles fall back to the kind icon, and
        // signViewUrls has already surfaced the failure.
        if (!cancelled) setThumbs({});
      }
    })();
    return () => { cancelled = true; };
  }, [rows]);

  // ── Linked records for the slice: one query, lazily, never blocking ─────
  const [links, setLinks] = useState<Map<string, PageLinkSummary[]>>(new Map());
  const [linksLoading, setLinksLoading] = useState(false);
  const needLinks = layout === 'list' || grouping === 'linked_model';
  useEffect(() => {
    if (!needLinks || rows.length === 0) { setLinks(new Map()); return; }
    let cancelled = false;
    setLinksLoading(true);
    void (async () => {
      try {
        const map = await fetchPageLinks(rows.map((r) => r.id));
        if (!cancelled) setLinks(map);
      } catch {
        // fetchPageLinks toasted. Rows fall back to the link COUNT they already
        // carry, which is true, so nothing on screen becomes wrong.
        if (!cancelled) setLinks(new Map());
      } finally {
        if (!cancelled) setLinksLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [rows, needLinks]);

  // ── Saved views ─────────────────────────────────────────────────────────
  const [savedViews, setSavedViews] = useState<FileViewRow[]>([]);
  const [savedLoading, setSavedLoading] = useState(true);
  const [savedError, setSavedError] = useState<string | null>(null);

  const loadViews = useCallback(async () => {
    setSavedLoading(true);
    setSavedError(null);
    try {
      setSavedViews(await listFileViews());
    } catch (e) {
      // Same rule as the grid: "could not load" is not "you have none".
      setSavedError(errorText(e));
    } finally {
      setSavedLoading(false);
    }
  }, []);
  useEffect(() => { void loadViews(); }, [loadViews]);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FileViewRow | null>(null);

  const openSystemView = useCallback((key: string) => {
    if (!key) {
      navigate({ pathname: '/files', search: '' });
      return;
    }
    const v = systemView(key);
    if (!v) return;
    const state = v.build(currentUserId);
    navigate({
      pathname: '/files',
      search: encodeLibraryUrl({ ...state, page: 1, view: key }),
    });
  }, [navigate, currentUserId]);

  const openSavedView = useCallback((row: FileViewRow) => {
    navigate({
      pathname: '/files',
      search: encodeLibraryUrl({ ...viewStateFromRow(row), page: 1, view: `saved:${row.id}` }),
    });
  }, [navigate]);

  const onSaveView = useCallback(async (name: string, visibility: 'private' | 'shared') => {
    setSaveBusy(true);
    try {
      const row = await saveFileView({ name, visibility, q, filters, grouping, sort, layout });
      setSaveOpen(false);
      await loadViews();
      addToast(t('files.library.view_saved', { name: row.name }), 'success');
      navigate({
        pathname: '/files',
        search: encodeLibraryUrl({ ...urlState, view: `saved:${row.id}` }),
      }, { replace: true });
    } catch {
      // saveFileView toasted. The modal stays open with the typed name intact
      // so the user can adjust and retry rather than retyping.
    } finally {
      setSaveBusy(false);
    }
  }, [q, filters, grouping, sort, layout, loadViews, addToast, t, navigate, urlState]);

  const onDeleteView = useCallback(async () => {
    const target = deleteTarget;
    if (!target) return;
    try {
      await deleteFileView(target.id);
      setDeleteTarget(null);
      await loadViews();
      if (view === `saved:${target.id}`) navigate({ pathname: '/files', search: '' });
    } catch {
      // deleteFileView toasted; keep the confirm open so the user sees why.
    }
  }, [deleteTarget, loadViews, view, navigate]);

  // ── Multi-select ────────────────────────────────────────────────────────
  // Page-scoped by design: `rows` is one page of a server-side query, so
  // "select all" can only ever mean "all 60 on screen". A cross-page selection
  // would be a set of ids the user cannot see and cannot verify before acting
  // on — that is a different feature (select-the-whole-query) and it needs its
  // own confirmation, not a silent extension of this one.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  // A page change or a new query invalidates the selection: keeping ids from a
  // slice that is no longer on screen means a bulk action hits files the user
  // can no longer see.
  useEffect(() => { setSelectedIds(new Set()); }, [rows]);

  const toggleSelected = useCallback((f: BusinessFileRow, additive: boolean) => {
    setSelectedIds((cur) => {
      if (!additive) return new Set([f.id]);
      const next = new Set(cur);
      if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
      return next;
    });
  }, []);

  const { marquee, onGridMouseDown } = useMarqueeSelection<Set<string>>({
    gridRef,
    captureBase: () => new Set(selectedIds),
    applyHits: (hits, mode, base) => {
      const ids = hits.map((h) => h.id);
      if (mode === 'replace') { setSelectedIds(new Set(ids)); return; }
      const next = new Set(base);
      if (mode === 'add') ids.forEach((id) => next.add(id));
      else ids.forEach((id) => next.has(id) ? next.delete(id) : next.add(id));
      setSelectedIds(next);
    },
    onBackgroundClick: () => setSelectedIds(new Set()),
    clearSelection: () => setSelectedIds(new Set()),
    disabled: bulkBusy,
  });

  // Esc clears, Ctrl/Cmd+A selects the page. Both skip while typing, or the
  // filter box loses its own select-all.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'Escape') { setSelectedIds(new Set()); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && rows.length > 0) {
        e.preventDefault();
        setSelectedIds(new Set(rows.map((r) => r.id)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows]);

  const onBulkDownload = useCallback(async () => {
    setBulkBusy(true);
    try {
      // Sequential, and each download is its own signed request: the browser
      // drops concurrent navigations to blob URLs, and a burst of parallel
      // sign calls is exactly the pattern the compress poller was rewritten to
      // avoid.
      for (const id of selectedIds) {
        try {
          const { url } = await signDownloadUrl(id);
          window.open(url, '_blank', 'noopener');
        } catch { /* signDownloadUrl toasted; keep going for the rest */ }
      }
    } finally { setBulkBusy(false); }
  }, [selectedIds]);

  // ── Detail panel + full preview ─────────────────────────────────────────
  const [selected, setSelected] = useState<BusinessFileRow | null>(null);
  const [previewRow, setPreviewRow] = useState<FileRow | null>(null);

  // A saved edit patches the row in place instead of refetching the page: a
  // refetch would re-run a 400 ms query and could REORDER the grid under the
  // user (title_asc after a rename), which is disorienting right after a save.
  const onRowSaved = useCallback((saved: BusinessFileRow) => {
    setRows((prev) => prev.map((r) => (r.id === saved.id ? { ...r, ...saved } : r)));
    setSelected((cur) => (cur && cur.id === saved.id ? { ...cur, ...saved } : cur));
  }, []);

  const openPreview = useCallback(async (fileId: string) => {
    try {
      // FilePreviewModal wants the full storage row (preview cache, mime,
      // record attachment). The search payload deliberately omits those, so
      // one row is fetched on demand rather than widening every search result.
      const row = await getFile(fileId);
      if (row) setPreviewRow(row);
    } catch {
      // getFile toasted.
    }
  }, []);

  const onDrillDown = useCallback((g: LibraryGrouping, key: string) => {
    const next: LibraryFilters = { ...filters };
    if (g === 'document_type') next.document_type = [key];
    else if (g === 'owner') next.owner_user_id = [key];
    else if (g === 'linked_model') next.linked_model = key;
    else return;                                  // month has no server filter
    pushState({ filters: next, grouping: 'none', view: null });
  }, [filters, pushState]);

  const activeCount = activeFilterCount(filters) + (q.trim() ? 1 : 0);
  const savedView = view?.startsWith('saved:')
    ? savedViews.find((v) => v.id === view.slice('saved:'.length)) ?? null
    : null;
  const sysView = view && !view.startsWith('saved:') ? systemView(view) : undefined;

  return (
    <div className="p-6 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-charcoal mb-3">{t('files.title')}</h1>
          <FilesTabs />
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Views rail */}
        <div className="w-full lg:w-56 shrink-0">
          <LibraryViewsRail
            activeView={view}
            onOpenSystem={openSystemView}
            onOpenSaved={openSavedView}
            savedViews={savedViews}
            savedLoading={savedLoading}
            savedError={savedError}
            onRetrySaved={() => void loadViews()}
            onDeleteSaved={setDeleteTarget}
            onSaveCurrent={() => setSaveOpen(true)}
            canSaveCurrent={activeCount > 0 || grouping !== 'none' || sort !== 'created_desc'}
          />
        </div>

        {/* Main column */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Header band — orientation, not chrome. Mirrors Marketing's
              «N مادة · N مشروعًا». Total BYTES is deliberately absent: the RPC
              returns per-page sizes only, and summing the page would print a
              number that changes as you paginate. */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-bold text-charcoal">
              {t('files.library.result_count', { count: total })}
            </span>
            {facets && (
              <>
                <span className="text-charcoal/25">·</span>
                <span className="text-xs text-charcoal/50">
                  {t('files.library.type_count', { count: Object.keys(facets.document_type).length })}
                </span>
                <span className="text-charcoal/25">·</span>
                <span className="text-xs text-charcoal/50">
                  {t('files.library.model_count', { count: Object.keys(facets.linked_model).length })}
                </span>
              </>
            )}
            {loading && <Loader2 size={13} className="animate-spin text-copper" aria-hidden />}
            {!loading && elapsedMs !== null && (
              <span className="text-[11px] text-charcoal/30 tabular-nums">
                {t('files.library.elapsed', { ms: elapsedMs })}
              </span>
            )}
          </div>

          {(sysView || savedView) && (
            <p className="text-xs text-charcoal/45" dir="auto">
              {sysView ? (isAr ? sysView.hint_ar : sysView.hint_en) : savedView?.name}
            </p>
          )}

          <LibraryFilterBar
            searchInput={searchInput}
            onSearchInput={setSearchInput}
            filters={filters}
            onFilters={(next) => pushState({ filters: next, view: null })}
            facets={facets}
            types={types}
            sort={sort}
            onSort={(s: BusinessFileSort) => pushState({ sort: s })}
            grouping={grouping}
            onGrouping={(g) => pushState({ grouping: g })}
            layout={layout}
            onLayout={(l) => pushState({ layout: l })}
          />

          <LibraryChips
            filters={filters}
            onFilters={(next) => pushState({ filters: next, view: null })}
            types={types}
            q={q}
            onClearQuery={() => { setSearchInput(''); pushState({ q: '', view: null }); }}
          />

          {/* Error card. Rendered ABOVE whatever is already on screen, never
              instead of it — see the header comment. */}
          {error && (
            <div className="p-4 rounded-xl bg-red-500/5 border border-red-500/25" role="alert">
              <div className="flex items-start gap-2.5">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-red-700">{t('files.library.search_failed')}</p>
                  <p className="mt-0.5 text-xs text-red-700/80 break-words">{error}</p>
                  <p className="mt-1 text-xs text-charcoal/50">{t('files.library.search_failed_hint')}</p>
                </div>
                <Button
                  variant="secondary"
                  className="!px-3 !py-1.5 text-xs shrink-0"
                  onClick={() => setReloadKey((k) => k + 1)}
                >
                  {t('files.library.retry')}
                </Button>
              </div>
            </div>
          )}

          <div className="flex gap-6 items-start">
            <div className="flex-1 min-w-0">
              {loading && rows.length === 0 ? (
                <div className="py-24 flex justify-center">
                  <Loader2 size={28} className="animate-spin text-copper" aria-hidden />
                </div>
              ) : !error && total === 0 ? (
                <div className="py-20 flex flex-col items-center justify-center text-center">
                  <div className="w-20 h-20 rounded-3xl bg-cream flex items-center justify-center mb-4">
                    <FolderSearch size={30} className="text-copper/60" aria-hidden />
                  </div>
                  <p className="text-sm font-bold text-charcoal/70">{t('files.library.empty_title')}</p>
                  <p className="mt-1 text-xs text-charcoal/45 max-w-sm">
                    {activeCount > 0 ? t('files.library.empty_filtered') : t('files.library.empty_none')}
                  </p>
                  {activeCount > 0 && (
                    <Button
                      variant="secondary"
                      className="mt-4 !px-4 !py-2 text-xs"
                      onClick={() => { setSearchInput(''); navigate({ pathname: '/files', search: '' }); }}
                    >
                      {t('files.library.clear_all')}
                    </Button>
                  )}
                </div>
              ) : (
                <div className={loading ? 'opacity-60 transition-opacity' : undefined}>
                  <LibraryResults
                    rows={rows}
                    types={types}
                    facets={facets}
                    links={links}
                    linksLoading={linksLoading}
                    thumbs={thumbs}
                    grouping={grouping}
                    layout={layout}
                    selectedId={selected?.id ?? null}
                    selectedIds={selectedIds}
                    onOpen={setSelected}
                    onToggle={toggleSelected}
                    gridRef={gridRef}
                    onGridMouseDown={onGridMouseDown}
                    marquee={marquee}
                    onDrillDown={onDrillDown}
                    page={page}
                    pageSize={LIBRARY_PAGE_SIZE}
                    total={total}
                    onPage={(p) => pushState({ page: p })}
                  />
                </div>
              )}
            </div>

            {selected && (
              <LibraryDetailPanel
                file={selected}
                types={types}
                thumbUrl={thumbs[selected.id] ?? null}
                onClose={() => setSelected(null)}
                onSaved={onRowSaved}
                onOpenPreview={(id) => void openPreview(id)}
              />
            )}
          </div>
        </div>
      </div>

      <LibraryBulkBar
        count={selectedIds.size}
        busy={bulkBusy}
        onEdit={() => setBulkEditOpen(true)}
        onDownload={() => void onBulkDownload()}
        onClear={() => setSelectedIds(new Set())}
      />

      <BulkEditModal
        open={bulkEditOpen}
        fileIds={[...selectedIds]}
        types={types}
        onClose={() => setBulkEditOpen(false)}
        onApplied={() => { setReloadKey((k) => k + 1); setSelectedIds(new Set()); }}
      />

      <SaveViewModal
        open={saveOpen}
        initialName={savedView?.name}
        initialVisibility={savedView?.visibility}
        existing={savedViews}
        busy={saveBusy}
        onCancel={() => setSaveOpen(false)}
        onSave={(name, visibility) => void onSaveView(name, visibility)}
      />

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={t('files.library.delete_view_title')}
        message={t('files.library.delete_view_message', { name: deleteTarget?.name ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void onDeleteView()}
        onClose={() => setDeleteTarget(null)}
      />

      {/* The full-screen viewer is the EXISTING component, unchanged. The
          Library is a different way to FIND a file, not a different file
          system, so opening one lands in the same viewer as everywhere else. */}
      <FilePreviewModal
        file={previewRow}
        open={Boolean(previewRow)}
        canEdit={false}
        canDelete={false}
        onClose={() => setPreviewRow(null)}
        onShare={() => {}}
        onPermissions={() => {}}
        onDelete={() => {}}
      />
    </div>
  );
}
