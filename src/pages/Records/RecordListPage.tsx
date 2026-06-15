import { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { getIconComponent } from '@/components/layout/Sidebar';
import { Plus, Search, Table2, LayoutGrid, MapPin, Trash2, Download, Upload, Pencil, FileDown } from 'lucide-react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import TableView from './components/TableView';
import CardView from './components/CardView';
import MapsView from './components/MapsView';
import ImportModal from './components/ImportModal';
import BulkEditModal from './components/BulkEditModal';
import ViewSelector from './components/ViewSelector';
import ViewEditor from './components/ViewEditor';
import AdvancedFilterPanel from './components/AdvancedFilterPanel';
import { PageSizeSelector, PageNavigator } from './components/PaginationControls';
import { exportToExcel, exportTemplate } from '@/lib/excelUtils';
import { applyConditions } from '@/lib/dashboardUtils';
import { buildRecordSearchText, buildExpandedFieldSearchText, normalizeForSearch } from '@/lib/recordSearch';
import { collectViewFields, type ExpandedField } from '@/lib/sectionMirrorExpand';
import {
  adhocStorageKey,
  applyAdhocFilters,
  loadAdhocFilters,
  saveAdhocFilters,
  type AdhocFilterState,
} from '@/lib/adhocFilterUtils';
import { useApplyViewScope, useApplyVisibleViews, useModelPermissions } from '@/hooks/usePermission';
import { sortRecordsByFieldName, type SortCtx } from '@/lib/recordSort';
import type { AppRecord, ModelView } from '@/types';

// Stable empty array reference. Returned when a model has no records yet
// (the key is simply missing from the store's `records` map — not initialized
// to `[]` by refreshSystemModels for freshly seeded models). Using a module-
// scoped constant keeps `modelRecords`, `filteredRecords`, and
// `orderedFilteredRecords` referentially stable across renders, which
// prevents the setRecordNavContext effect below from looping.
const EMPTY_RECORDS: AppRecord[] = [];

export default function RecordListPage() {
  const { modelName } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { models, records, views, language, currentUserId, users, deleteRecord, addToast, setRecordNavContext, loadChatsFromHaberchat } = useAppStore();
  const isAr = language === 'ar';

  const model = models.find((m) => m.name === modelName);
  const rawModelRecords = model ? (records[model.id] ?? EMPTY_RECORDS) : EMPTY_RECORDS;
  // Inject cross-record rollup values (our_projects → units stats) BEFORE
  // view-scope / search / filters run, so a profile can filter or sort by
  // Project rollup fields are now STORED in record.data (maintained by a DB
  // trigger), so the raw records already carry them — no read-time rollup.
  const allModelRecords = rawModelRecords as AppRecord[];
  // Apply the profile's view-scope BEFORE any user-controlled filter runs.
  // Records that don't pass view-scope are invisible everywhere downstream:
  // counts, search, ad-hoc filters, exports, sort/pagination, prev/next nav.
  const modelRecords = useApplyViewScope(model, allModelRecords);
  const perms = useModelPermissions(model?.id ?? '');

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);

  // Pagination — persisted page size per-model (survives refresh); page resets
  // to 1 whenever the filter pipeline output changes length.
  const pageSizeKey = model ? `wassell_page_size_${model.id}` : null;
  const [pageSize, setPageSize] = useState<number>(() => {
    const stored = pageSizeKey ? localStorage.getItem(pageSizeKey) : null;
    const n = stored ? Number(stored) : 25;
    return Number.isFinite(n) && n > 0 ? n : 25;
  });
  const [currentPage, setCurrentPage] = useState(1);
  const updatePageSize = (n: number) => {
    setPageSize(n);
    setCurrentPage(1);
    if (pageSizeKey) localStorage.setItem(pageSizeKey, String(n));
  };

  const storedView = modelName ? localStorage.getItem(`view_mode_${modelName}`) : null;
  const [viewMode, setViewMode] = useState<'table' | 'cards' | 'maps'>(
    (storedView as 'table' | 'cards' | 'maps') ?? 'table',
  );
  const [search, setSearch] = useState('');
  const [searchField, setSearchField] = useState<string>('all'); // 'all' or an expanded field id
  const [deletingRecord, setDeletingRecord] = useState<AppRecord | null>(null);
  const [showImport, setShowImport] = useState(false);

  // Saved-view state: null = "Default view" (show_in_table fallback).
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingView, setEditingView] = useState<ModelView | null>(null);

  const rawModelViews = useMemo(
    () => (model ? views.filter((v) => v.model_id === model.id && (v.user_id === currentUserId || v.is_shared)) : []),
    [views, model, currentUserId],
  );
  // Apply per-profile view-visibility (deny-list). Author always sees their
  // own views; admins see everything; otherwise filter by hidden_view_ids.
  const modelViews = useApplyVisibleViews(rawModelViews);
  const activeView = modelViews.find((v) => v.id === activeViewId) ?? null;

  // Column-header sort, lifted out of TableView so it sorts the FULL filtered
  // list before pagination — otherwise a header click would only reorder the
  // visible page, and computed rollup columns (e.g. All Projects' Project
  // Details) couldn't sort across all pages. Seeded from the active view's
  // default sort; reset whenever the active view changes.
  const resolveViewSortName = (v: ModelView | null): string | null => {
    const id = v?.sort_field_id ?? null;
    if (!id || !model) return null;
    const f = model.schema.sections.flatMap((s) => s.fields).find((x) => x.id === id);
    return f ? f.name : null;
  };
  const [sortFieldName, setSortFieldName] = useState<string | null>(() => resolveViewSortName(activeView));
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(activeView?.sort_direction ?? 'asc');
  useEffect(() => {
    setSortFieldName(resolveViewSortName(activeView));
    setSortDir(activeView?.sort_direction ?? 'asc');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewId, activeView?.sort_field_id, activeView?.sort_direction]);
  const toggleColumnSort = (fieldName: string) => {
    setCurrentPage(1);
    if (sortFieldName === fieldName) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortFieldName(fieldName);
      setSortDir('asc');
    }
  };

  // If the previously-active view becomes hidden after a permission change,
  // reset to the Default view so the table doesn't render against a view
  // the user can no longer pick. activeViewId still resolves to "no active
  // view" via the find above, but cleaning up the state keeps subsequent
  // localStorage writes consistent.
  useEffect(() => {
    if (activeViewId && !modelViews.find((v) => v.id === activeViewId)) {
      setActiveViewId(null);
    }
  }, [activeViewId, modelViews]);
  const lastUsedKey = model && currentUserId ? `wassell_view_last_${model.id}_${currentUserId}` : null;

  // On mount / model switch: pick last-used view, then user's default, else "Default".
  useEffect(() => {
    if (!model || !currentUserId) return;
    const last = lastUsedKey ? localStorage.getItem(lastUsedKey) : null;
    const lastValid = last && modelViews.some((v) => v.id === last) ? last : null;
    if (lastValid) {
      setActiveViewId(lastValid);
      return;
    }
    const userDefault = modelViews.find((v) => v.user_id === currentUserId && v.is_default);
    setActiveViewId(userDefault?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.id, currentUserId]);

  const selectView = (viewId: string | null) => {
    setActiveViewId(viewId);
    if (lastUsedKey) {
      if (viewId) localStorage.setItem(lastUsedKey, viewId);
      else localStorage.removeItem(lastUsedKey);
    }
  };

  // Ad-hoc faceted filters — scoped per (user, model, view); persisted in localStorage.
  const adhocKey = model && currentUserId
    ? adhocStorageKey(model.id, currentUserId, activeViewId)
    : null;
  const [adhocFilters, setAdhocFilters] = useState<AdhocFilterState>({});

  // Rehydrate when scope changes (model / user / active view).
  useEffect(() => {
    if (!adhocKey) { setAdhocFilters({}); return; }
    setAdhocFilters(loadAdhocFilters(adhocKey));
  }, [adhocKey]);

  const updateAdhocFilters = (next: AdhocFilterState) => {
    setAdhocFilters(next);
    if (adhocKey) saveAdhocFilters(adhocKey, next);
  };

  const openEditor = (view: ModelView | null) => {
    setEditingView(view);
    setEditorOpen(true);
  };

  const toggleView = (mode: 'table' | 'cards' | 'maps') => {
    setViewMode(mode);
    if (modelName) localStorage.setItem(`view_mode_${modelName}`, mode);
  };

  // Reset selection + search scope when the model changes (field ids are
  // model-specific, so a carried-over scope would be meaningless).
  useEffect(() => {
    setSelectedIds(new Set());
    setSearchField('all');
  }, [model?.id]);

  // Chats-specific: on every mount of /model/chats, pull fresh conversations
  // from Haberchat (via our proxy) into the records store. Idempotent — the
  // store merges new rows and preserves manual fields. Silent failure keeps
  // the list usable offline; the Settings page surfaces token/device errors.
  useEffect(() => {
    if (model?.name !== 'chats') return;
    void loadChatsFromHaberchat();
  }, [model?.id, model?.name, loadChatsFromHaberchat]);

  // Filter pipeline: view conditions → ad-hoc faceted filters → text search.
  // Scope options for the search box: local fields + mirrored children (so search
  // can target a lookup or a mirrored field). Same expansion the table columns use.
  const expandedSearchFields = useMemo<ExpandedField[]>(
    () => (model ? collectViewFields(model, models) : []),
    [model, models],
  );

  // Per-record searchable text, built once per data/scope change (NOT per
  // keystroke — resolving lookups/mirrors is O(linked rows)). Scope is a single
  // picked field, or ALL fields (resolving dropdown labels + lookup/mirror
  // display values + Arabic/ASCII digits). The keystroke filter below just does
  // a Map lookup + substring test, so typing stays fast even on large models.
  const searchIndex = useMemo(() => {
    const idx = new Map<string, string>();
    if (!model) return idx;
    const ctx = { models, records };
    const scopedField =
      searchField === 'all' ? null : expandedSearchFields.find((f) => f.id === searchField) ?? null;
    for (const rec of modelRecords) {
      const text = scopedField
        ? buildExpandedFieldSearchText(scopedField, rec, model, ctx)
        : buildRecordSearchText(rec, model, ctx);
      idx.set(rec.id, normalizeForSearch(text));
    }
    return idx;
  }, [modelRecords, model, models, records, searchField, expandedSearchFields]);

  const searchPlaceholder = (() => {
    if (searchField === 'all') return t('records.search_placeholder');
    const ef = expandedSearchFields.find((f) => f.id === searchField);
    if (!ef) return t('records.search_placeholder');
    const label = isAr ? ef.field.label_ar : ef.field.label_en;
    return isAr ? `بحث في «${label}»…` : `Search ${label}…`;
  })();

  const filteredRecords = useMemo(() => {
    if (!model) return modelRecords;
    const allFields = model.schema.sections.flatMap((s) => s.fields);

    // 1. Saved view filter conditions (AND-only).
    let out = activeView
      ? applyConditions(modelRecords, activeView.conditions, allFields)
      : modelRecords;

    // 2. Ad-hoc faceted filters (OR within field, AND across fields).
    //    Pass the model + all models/records so mirror fields can resolve
    //    their live value through the sibling lookup at filter time.
    out = applyAdhocFilters(out, adhocFilters, model, models, records);

    // 3. Text search (top-of-page search box) — matches the scoped field, or ALL
    //    fields, via the prebuilt `searchIndex` (resolves dropdown labels,
    //    lookup/mirror display values, and normalizes Arabic/ASCII digits).
    if (search.trim()) {
      const q = normalizeForSearch(search.trim());
      out = out.filter((rec) => (searchIndex.get(rec.id) ?? '').includes(q));
    }
    return out;
  }, [search, modelRecords, model, models, records, activeView, adhocFilters, searchIndex]);

  // Sort the FULL filtered list before pagination, using the lifted
  // column-header sort (seeded from the active view's default sort). This is
  // what makes a header click reorder the whole dataset (not just the visible
  // page) and what lets computed rollup columns sort — their values are
  // injected into record.data by useRolledUpRecordList above, so the shared
  // type-aware comparator keys them by field type just like stored values.
  // Also drives prev/next nav context, so the record form's arrows follow
  // whatever the user sorted by here.
  const orderedFilteredRecords = useMemo(() => {
    if (!model) return filteredRecords;
    const ctx: SortCtx = { isAr, allRecords: records, models, users };
    return sortRecordsByFieldName(filteredRecords, model, sortFieldName, sortDir, ctx);
  }, [filteredRecords, model, sortFieldName, sortDir, isAr, records, models, users]);

  // Publish the currently-visible, sorted record IDs so the record form can
  // offer prev/next navigation in the same order the user was browsing.
  useEffect(() => {
    if (!model) return;
    setRecordNavContext(model.id, orderedFilteredRecords.map((r) => r.id));
  }, [model, orderedFilteredRecords, setRecordNavContext]);

  // Reset to first page whenever the filter pipeline changes its output size
  // (new search, different view, ad-hoc filter edits, records added/deleted).
  useEffect(() => {
    setCurrentPage(1);
  }, [orderedFilteredRecords.length, activeViewId]);

  const pagedRecords = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return orderedFilteredRecords.slice(start, start + pageSize);
  }, [orderedFilteredRecords, currentPage, pageSize]);

  if (!model) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-charcoal/40">
        <p className="text-lg font-bold">404 — {isAr ? 'النموذج غير موجود' : 'Model not found'}</p>
      </div>
    );
  }

  const Icon = getIconComponent(model.icon);

  const handleDelete = () => {
    if (!deletingRecord) return;
    deleteRecord(model.id, deletingRecord.id);
    addToast(t('toast.deleted'), 'success');
    setDeletingRecord(null);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    // Select-all toggles the currently VISIBLE (paginated) records — matches
    // Gmail / Sheets. Selection persists across pages, so users can paginate
    // and select more. For all-in-view, use selectAllInView().
    const allVisibleIds = pagedRecords.map((r) => r.id);
    const allSelected = allVisibleIds.length > 0 && allVisibleIds.every((id) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of allVisibleIds) next.delete(id);
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of allVisibleIds) next.add(id);
        return next;
      });
    }
  };

  const selectAllInView = () => {
    setSelectedIds(new Set(filteredRecords.map((r) => r.id)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkDelete = () => {
    if (!model || selectedIds.size === 0) return;
    for (const id of selectedIds) deleteRecord(model.id, id);
    addToast(t('toast.deleted'), 'success');
    setSelectedIds(new Set());
    setBulkDeleteOpen(false);
  };

  const handleBulkExport = () => {
    if (!model || selectedIds.size === 0) return;
    const selectedRecords = modelRecords.filter((r) => selectedIds.has(r.id));
    exportToExcel(model, selectedRecords, language, records, models);
  };

  // Shared view-mode toggle, used both inline (table/cards) and floating
  // over the map (maps). One copy keeps both surfaces in sync.
  const viewModeToggle = (
    <div className="flex bg-cream/50 p-1 rounded-lg">
      <button
        onClick={() => toggleView('table')}
        className={`p-2 rounded-md transition-colors ${
          viewMode === 'table' ? 'bg-white text-copper shadow-sm' : 'text-charcoal/40 hover:text-charcoal'
        }`}
        title={t('records.view_table')}
      >
        <Table2 size={18} />
      </button>
      <button
        onClick={() => toggleView('cards')}
        className={`p-2 rounded-md transition-colors ${
          viewMode === 'cards' ? 'bg-white text-copper shadow-sm' : 'text-charcoal/40 hover:text-charcoal'
        }`}
        title={t('records.view_cards')}
      >
        <LayoutGrid size={18} />
      </button>
      <button
        onClick={() => toggleView('maps')}
        className={`p-2 rounded-md transition-colors ${
          viewMode === 'maps' ? 'bg-white text-copper shadow-sm' : 'text-charcoal/40 hover:text-charcoal'
        }`}
        title={t('records.view_maps')}
      >
        <MapPin size={18} />
      </button>
    </div>
  );

  return (
    <div>
      {viewMode !== 'maps' && (
        <>
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ backgroundColor: `${model.color}15` }}
              >
                <Icon size={22} style={{ color: model.color }} />
              </div>
              <div>
                <h1 className="text-xl font-bold text-charcoal">
                  {isAr ? model.label_ar : model.label_en}
                </h1>
                <span className="text-xs text-charcoal/40">
                  {t('records.record_count', { count: modelRecords.length })}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {perms.has('export') && (
                <Button variant="ghost" onClick={() => exportToExcel(model, modelRecords, language, records, models)}>
                  <Download size={16} />
                  {isAr ? 'تصدير' : 'Export'}
                </Button>
              )}
              {perms.has('import') && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    void exportTemplate(model, language, models).catch((e) => {
                      console.error('[exportTemplate]', e);
                      addToast(isAr ? 'تعذّر تنزيل القالب' : 'Could not download template', 'error');
                    });
                  }}
                >
                  <FileDown size={16} />
                  {isAr ? 'قالب' : 'Template'}
                </Button>
              )}
              {perms.has('import') && (
                <Button variant="secondary" onClick={() => setShowImport(true)}>
                  <Upload size={16} />
                  {isAr ? 'استيراد' : 'Import'}
                </Button>
              )}
              {perms.has('create') && (
                <Button onClick={() => navigate(`/model/${model.name}/new`)}>
                  <Plus size={16} />
                  {t('records.new_record')}
                </Button>
              )}
            </div>
          </div>

          {/* Advanced (faceted) filters — shown in table mode only.
              Maps mode renders its own floating filter panel below. */}
          <AdvancedFilterPanel
            model={model}
            state={adhocFilters}
            onChange={updateAdhocFilters}
            collapseKey={`wassell_adhoc_collapsed_v2_${model.id}`}
          />

          {/* Search (scope selector + query) + View selector + View-mode toggle */}
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-2 flex-1 max-w-2xl min-w-0">
              <select
                value={searchField}
                onChange={(e) => setSearchField(e.target.value)}
                className="form-input text-sm w-auto max-w-[12rem] shrink-0"
                title={isAr ? 'نطاق البحث' : 'Search scope'}
                aria-label={isAr ? 'نطاق البحث' : 'Search scope'}
              >
                <option value="all">{isAr ? 'كل الحقول' : 'All fields'}</option>
                {expandedSearchFields.map((ef) => (
                  <option key={ef.id} value={ef.id}>
                    {(isAr ? ef.field.label_ar : ef.field.label_en) +
                      (ef.kind === 'mirrored' ? (isAr ? ' (مرآة)' : ' (mirror)') : '')}
                  </option>
                ))}
              </select>
              <div className="relative flex-1 min-w-0">
                <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-charcoal/30" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="form-input ps-9 text-sm"
                />
              </div>
            </div>
            {viewMode === 'table' && (
              <ViewSelector
                modelId={model.id}
                views={modelViews}
                activeViewId={activeViewId}
                onSelect={selectView}
                onCreateNew={() => openEditor(null)}
                onEdit={(v) => openEditor(v)}
              />
            )}
            {viewModeToggle}
          </div>
        </>
      )}

      {/* Bulk action bar — hidden in maps mode (no selection in maps). */}
      {viewMode !== 'maps' && selectedIds.size > 0 && (() => {
        const pageIds = pagedRecords.map((r) => r.id);
        const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
        const hasMoreBeyondPage = filteredRecords.length > pagedRecords.length;
        const allInViewSelected = filteredRecords.length > 0 && selectedIds.size >= filteredRecords.length
          && filteredRecords.every((r) => selectedIds.has(r.id));
        const showSelectAllInView = allOnPageSelected && hasMoreBeyondPage && !allInViewSelected;
        return (
        <div className="mb-3 flex items-center justify-between bg-copper/8 border border-copper/30 rounded-xl px-4 py-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-bold text-copper">
              {allInViewSelected
                ? t('records.all_in_view_selected', { count: filteredRecords.length })
                : t('records.selected_count', { count: selectedIds.size })}
            </span>
            {showSelectAllInView && (
              <button
                onClick={selectAllInView}
                className="text-xs font-semibold text-copper underline underline-offset-2 hover:text-terracotta transition-colors"
              >
                {t('records.select_all_in_view', { count: filteredRecords.length })}
              </button>
            )}
            <button
              onClick={clearSelection}
              className="text-xs text-charcoal/60 hover:text-charcoal transition-colors"
            >
              {t('records.clear_selection')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            {perms.has('export') && (
              <Button variant="ghost" onClick={handleBulkExport}>
                <Download size={14} />
                {t('records.bulk_export')}
              </Button>
            )}
            {perms.has('edit') && (
              <Button variant="secondary" onClick={() => setBulkEditOpen(true)}>
                <Pencil size={14} />
                {t('records.bulk_edit')}
              </Button>
            )}
            {perms.has('delete') && (
              <Button variant="danger" onClick={() => setBulkDeleteOpen(true)}>
                <Trash2 size={14} />
                {t('records.bulk_delete')}
              </Button>
            )}
          </div>
        </div>
        );
      })()}

      {/* Page size selector — sits just above the list (hidden in maps mode) */}
      {viewMode !== 'maps' && filteredRecords.length > 0 && (
        <div className="flex items-center justify-end mb-2">
          <PageSizeSelector pageSize={pageSize} onChange={updatePageSize} />
        </div>
      )}

      {/* Content */}
      {viewMode === 'table' && (
        <TableView
          model={model}
          records={pagedRecords}
          onRowClick={(rec) => navigate(`/model/${model.name}/${rec.id}`)}
          onDelete={setDeletingRecord}
          view={activeView}
          sortField={sortFieldName}
          sortDir={sortDir}
          onToggleSort={toggleColumnSort}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
        />
      )}
      {viewMode === 'cards' && (
        <CardView
          model={model}
          records={pagedRecords}
          onCardClick={(rec) => navigate(`/model/${model.name}/${rec.id}`)}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
        />
      )}
      {viewMode === 'maps' && (
        // Full-bleed map: negative margins escape AppLayout's `<main>` padding
        // (`px-4 md:px-8 py-6`); explicit height fills the viewport minus the
        // sticky header (~64px). MapsView fills this container via height:100%.
        <div
          className="-mx-4 md:-mx-8 -mt-6 -mb-6 relative bg-cream-light"
          style={{ height: 'calc(100vh - 64px)' }}
        >
          <MapsView
            model={model}
            records={filteredRecords}
            onCardClick={(rec) => navigate(`/model/${model.name}/${rec.id}`)}
          />

          {/* Floating filter chip — top-center. Defaults collapsed so it
              looks like a chip, not a panel; expands inline downward when
              opened. Same persistence key as table mode so collapse state
              follows the user across views. */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 w-[92%] max-w-2xl pointer-events-none">
            <div className="pointer-events-auto shadow-lg rounded-xl">
              <AdvancedFilterPanel
                model={model}
                state={adhocFilters}
                onChange={updateAdhocFilters}
                collapseKey={`wassell_adhoc_collapsed_v2_${model.id}`}
                defaultCollapsed
                solid
              />
            </div>
          </div>

          {/* Floating view-mode toggle — top-right (physical right). */}
          <div className="absolute top-4 right-4 z-20 bg-white shadow-lg rounded-xl border border-sand/30 p-0.5">
            {viewModeToggle}
          </div>
        </div>
      )}

      {/* Page navigator — sits below the list (not shown in maps view) */}
      {viewMode !== 'maps' && (
        <PageNavigator
          totalCount={filteredRecords.length}
          currentPage={currentPage}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
        />
      )}

      {/* View editor modal */}
      <ViewEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        model={model}
        view={editingView}
        onSaved={(v) => selectView(v.id)}
      />

      {/* Delete confirmation */}
      <Modal
        open={!!deletingRecord}
        onClose={() => setDeletingRecord(null)}
        title={t('records.delete_record')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeletingRecord(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={handleDelete}>
              <Trash2 size={14} />
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-charcoal">{t('records.delete_confirm')}</p>
      </Modal>

      {/* Bulk delete confirmation */}
      <Modal
        open={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        title={t('records.bulk_delete')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkDeleteOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={handleBulkDelete}>
              <Trash2 size={14} />
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-charcoal">{t('records.bulk_delete_confirm', { count: selectedIds.size })}</p>
      </Modal>

      {/* Import modal */}
      {model && (
        <ImportModal
          open={showImport}
          onClose={() => setShowImport(false)}
          model={model}
        />
      )}

      {/* Bulk edit modal */}
      {model && (
        <BulkEditModal
          open={bulkEditOpen}
          onClose={() => setBulkEditOpen(false)}
          model={model}
          selectedRecords={modelRecords.filter((r) => selectedIds.has(r.id))}
          onApplied={(count) => {
            addToast(t('records.bulk_edit_updated', { count }), 'success');
            setSelectedIds(new Set());
          }}
        />
      )}
    </div>
  );
}
