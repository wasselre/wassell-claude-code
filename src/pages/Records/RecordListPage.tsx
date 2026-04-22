import { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { getIconComponent } from '@/components/layout/Sidebar';
import { Plus, Search, Table2, LayoutGrid, MapPin, Trash2, Download, Upload, Pencil } from 'lucide-react';
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
import { exportToExcel } from '@/lib/excelUtils';
import { applyConditions } from '@/lib/dashboardUtils';
import {
  adhocStorageKey,
  applyAdhocFilters,
  loadAdhocFilters,
  saveAdhocFilters,
  type AdhocFilterState,
} from '@/lib/adhocFilterUtils';
import { useModelPermissions } from '@/hooks/usePermission';
import type { AppRecord, ModelView } from '@/types';

export default function RecordListPage() {
  const { modelName } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { models, records, views, language, currentUserId, deleteRecord, addToast } = useAppStore();
  const isAr = language === 'ar';

  const model = models.find((m) => m.name === modelName);
  const modelRecords = model ? (records[model.id] ?? []) : [];
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
  const [deletingRecord, setDeletingRecord] = useState<AppRecord | null>(null);
  const [showImport, setShowImport] = useState(false);

  // Saved-view state: null = "Default view" (show_in_table fallback).
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingView, setEditingView] = useState<ModelView | null>(null);

  const modelViews = useMemo(
    () => (model ? views.filter((v) => v.model_id === model.id && (v.user_id === currentUserId || v.is_shared)) : []),
    [views, model, currentUserId],
  );
  const activeView = modelViews.find((v) => v.id === activeViewId) ?? null;
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

  // Reset selection when the model changes.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [model?.id]);

  // Filter pipeline: view conditions → ad-hoc faceted filters → text search.
  const filteredRecords = useMemo(() => {
    if (!model) return modelRecords;
    const allFields = model.schema.sections.flatMap((s) => s.fields);

    // 1. Saved view filter conditions (AND-only).
    let out = activeView
      ? applyConditions(modelRecords, activeView.conditions, allFields)
      : modelRecords;

    // 2. Ad-hoc faceted filters (OR within field, AND across fields).
    out = applyAdhocFilters(out, adhocFilters, allFields);

    // 3. Text search (top-of-page search box).
    if (search.trim()) {
      const q = search.toLowerCase();
      const searchableFields = allFields.filter((f) => ['text', 'email', 'phone'].includes(f.type));
      out = out.filter((rec) =>
        searchableFields.some((f) => {
          const val = rec.data[f.name];
          return val && String(val).toLowerCase().includes(q);
        }),
      );
    }
    return out;
  }, [search, modelRecords, model, activeView, adhocFilters]);

  // Reset to first page whenever the filter pipeline changes its output size
  // (new search, different view, ad-hoc filter edits, records added/deleted).
  useEffect(() => {
    setCurrentPage(1);
  }, [filteredRecords.length, activeViewId]);

  const pagedRecords = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredRecords.slice(start, start + pageSize);
  }, [filteredRecords, currentPage, pageSize]);

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

  return (
    <div>
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

      {/* Advanced (faceted) filters — only in table mode */}
      {viewMode === 'table' && (
        <AdvancedFilterPanel
          model={model}
          state={adhocFilters}
          onChange={updateAdhocFilters}
          collapseKey={`wassell_adhoc_collapsed_${model.id}`}
        />
      )}

      {/* Search + View selector + View-mode toggle */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-charcoal/30" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('records.search_placeholder')}
            className="form-input ps-9 text-sm"
          />
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
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (() => {
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
        <MapsView
          model={model}
          records={filteredRecords}
          onCardClick={(rec) => navigate(`/model/${model.name}/${rec.id}`)}
        />
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
