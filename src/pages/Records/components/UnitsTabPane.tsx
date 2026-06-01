import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, Trash2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useApplyViewScope, useApplyVisibleViews } from '@/hooks/usePermission';
import { buildExpandedFieldSearchText, buildRecordSearchText, normalizeForSearch } from '@/lib/recordSearch';
import { collectViewFields, type ExpandedField } from '@/lib/sectionMirrorExpand';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import TableView from './TableView';
import ViewSelector from './ViewSelector';
import ViewEditor from './ViewEditor';
import { PageSizeSelector, PageNavigator } from './PaginationControls';
import type { AppRecord, ModelField, ModelView } from '@/types';

interface UnitsTabPaneProps {
  projectId: string;
}

/**
 * Embedded "Units" view rendered inside the record form when the user selects
 * the Units tab. For a given All Projects record id, lists every record in the
 * `units` model whose project lookup points at this project — rendered with the
 * same `TableView` the Units list page uses, including the same saved-view
 * machinery so columns are adjustable (and shared with the Units list page).
 *
 * Parallel to `ClientDetailsTabPane`: the tab appears when a record either IS
 * an All Projects record or has a populated lookup field pointing at it (see
 * the `projectCandidateIds` detection in `RecordFormPage`). Edits to a unit
 * happen inline in the table or by opening the unit's own page.
 */
export default function UnitsTabPane({ projectId }: UnitsTabPaneProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const views = useAppStore((s) => s.views);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const deleteRecord = useAppStore((s) => s.deleteRecord);
  const addToast = useAppStore((s) => s.addToast);

  const allProjectsModel = useMemo(
    () => models.find((m) => m.name === 'all_projects') ?? null,
    [models],
  );
  const unitsModel = useMemo(() => models.find((m) => m.name === 'units') ?? null, [models]);

  // Lookup field(s) on the units model that point at all_projects. Scanned
  // rather than hardcoding `project_id` so a rename in the Builder doesn't
  // silently break the link. Multi-value lookups are matched by `.includes`.
  const projectLookupFields = useMemo<ModelField[]>(() => {
    if (!unitsModel || !allProjectsModel) return [];
    const out: ModelField[] = [];
    for (const sec of unitsModel.schema.sections) {
      for (const f of sec.fields) {
        if (f.type === 'lookup' && f.lookup_model_id === allProjectsModel.id) out.push(f);
      }
    }
    return out;
  }, [unitsModel, allProjectsModel]);

  // All units belonging to this project (before view-scope / pagination).
  const matchedUnits = useMemo<AppRecord[]>(() => {
    if (!unitsModel || projectLookupFields.length === 0) return [];
    const list = records[unitsModel.id] ?? [];
    return list.filter((r) =>
      projectLookupFields.some((f) => {
        const v = (r.data as Record<string, unknown>)[f.name];
        return Array.isArray(v) ? v.includes(projectId) : v === projectId;
      }),
    );
  }, [unitsModel, projectLookupFields, records, projectId]);

  // Apply the profile's view-scope so units the user isn't allowed to see don't
  // leak in through this embedded table.
  const scopedUnits = useApplyViewScope(unitsModel, matchedUnits);

  // Saved views for the units model (own + shared), minus per-profile hidden.
  const rawUnitViews = useMemo(
    () =>
      unitsModel
        ? views.filter(
            (v) => v.model_id === unitsModel.id && (v.user_id === currentUserId || v.is_shared),
          )
        : [],
    [views, unitsModel, currentUserId],
  );
  const unitViews = useApplyVisibleViews(rawUnitViews);

  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const activeView = unitViews.find((v) => v.id === activeViewId) ?? null;
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingView, setEditingView] = useState<ModelView | null>(null);
  const [deletingRecord, setDeletingRecord] = useState<AppRecord | null>(null);
  const [search, setSearch] = useState('');
  const [searchField, setSearchField] = useState<string>('all'); // 'all' = every field

  // Options for the search-scope picker: local fields + mirrored children
  // (section_mirror). Lets search be scoped to a single field — including a
  // mirrored or lookup one.
  const expandedFields = useMemo<ExpandedField[]>(
    () => (unitsModel ? collectViewFields(unitsModel, models) : []),
    [unitsModel, models],
  );

  // Pre-build the searchable string per unit, once per data change (not per
  // keystroke — resolving lookups/mirrors is O(linked rows)). Scope is either a
  // single picked field or ALL fields; rebuilds when the scope changes.
  const unitSearchIndex = useMemo(() => {
    const idx = new Map<string, string>();
    if (!unitsModel) return idx;
    const ctx = { models, records };
    const scopedField =
      searchField === 'all' ? null : expandedFields.find((f) => f.id === searchField) ?? null;
    for (const rec of scopedUnits) {
      const text = scopedField
        ? buildExpandedFieldSearchText(scopedField, rec, unitsModel, ctx)
        : buildRecordSearchText(rec, unitsModel, ctx);
      idx.set(rec.id, normalizeForSearch(text));
    }
    return idx;
  }, [scopedUnits, unitsModel, models, records, searchField, expandedFields]);

  // Text search over the project's units — matches ANY field via the index above.
  // Applied after view-scope, before pagination.
  const searchedUnits = useMemo<AppRecord[]>(() => {
    const q = normalizeForSearch(search.trim());
    if (!q) return scopedUnits;
    return scopedUnits.filter((rec) => (unitSearchIndex.get(rec.id) ?? '').includes(q));
  }, [search, scopedUnits, unitSearchIndex]);

  // Pagination — local to the tab. Reset to page 1 whenever the visible set size
  // changes (project switch, view filter, search, add/delete).
  const [pageSize, setPageSize] = useState(25);
  const [currentPage, setCurrentPage] = useState(1);
  useEffect(() => {
    setCurrentPage(1);
  }, [searchedUnits.length, activeViewId, searchField]);
  const pagedUnits = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return searchedUnits.slice(start, start + pageSize);
  }, [searchedUnits, currentPage, pageSize]);

  // If the active view becomes hidden after a permission change, fall back to
  // the Default view so the table doesn't render against a missing view.
  useEffect(() => {
    if (activeViewId && !unitViews.find((v) => v.id === activeViewId)) {
      setActiveViewId(null);
    }
  }, [activeViewId, unitViews]);

  const projectName = useMemo(() => {
    if (!allProjectsModel) return projectId.slice(0, 8);
    const rec = (records[allProjectsModel.id] ?? []).find((r) => r.id === projectId);
    const v = (rec?.data as Record<string, unknown> | undefined)?.project_name;
    return (typeof v === 'string' && v.trim()) || projectId.slice(0, 8);
  }, [allProjectsModel, records, projectId]);

  if (!unitsModel) {
    return (
      <p className="text-sm text-charcoal/50">
        {isAr ? 'نموذج الوحدات غير موجود.' : 'Units model not found.'}
      </p>
    );
  }

  const handleDelete = () => {
    if (!deletingRecord) return;
    deleteRecord(unitsModel.id, deletingRecord.id);
    addToast(t('toast.deleted'), 'success');
    setDeletingRecord(null);
  };

  const selectedFieldLabel =
    searchField === 'all'
      ? null
      : (() => {
          const ef = expandedFields.find((f) => f.id === searchField);
          return ef ? (isAr ? ef.field.label_ar : ef.field.label_en) : null;
        })();
  const searchPlaceholder = selectedFieldLabel
    ? (isAr ? `بحث في «${selectedFieldLabel}»…` : `Search ${selectedFieldLabel}…`)
    : (isAr ? 'بحث في كل الحقول…' : 'Search all fields…');

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-chocolate mb-1">
            {isAr ? `الوحدات — ${projectName}` : `Units — ${projectName}`}
          </h2>
          <p className="text-xs text-charcoal/50">
            {isAr
              ? `${scopedUnits.length} وحدة مرتبطة بهذا المشروع`
              : `${scopedUnits.length} unit${scopedUnits.length === 1 ? '' : 's'} linked to this project`}
          </p>
        </div>
        <ViewSelector
          modelId={unitsModel.id}
          views={unitViews}
          activeViewId={activeViewId}
          onSelect={setActiveViewId}
          onCreateNew={() => {
            setEditingView(null);
            setEditorOpen(true);
          }}
          onEdit={(v) => {
            setEditingView(v);
            setEditorOpen(true);
          }}
        />
      </div>

      {scopedUnits.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-12 text-charcoal/40">
          <p className="text-sm font-bold">
            {isAr ? 'لا توجد وحدات مرتبطة بهذا المشروع بعد.' : 'No units linked to this project yet.'}
          </p>
        </div>
      ) : (
        <>
          {/* Toolbar: search scope (all fields / one field) + query + page size. */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <select
                value={searchField}
                onChange={(e) => setSearchField(e.target.value)}
                className="form-input text-sm w-auto max-w-[11rem] shrink-0"
                title={isAr ? 'نطاق البحث' : 'Search scope'}
                aria-label={isAr ? 'نطاق البحث' : 'Search scope'}
              >
                <option value="all">{isAr ? 'كل الحقول' : 'All fields'}</option>
                {expandedFields.map((ef) => (
                  <option key={ef.id} value={ef.id}>
                    {(isAr ? ef.field.label_ar : ef.field.label_en) +
                      (ef.kind === 'mirrored' ? (isAr ? ' (مرآة)' : ' (mirror)') : '')}
                  </option>
                ))}
              </select>
              <div className="relative flex-1 min-w-0 max-w-xs">
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
            <PageSizeSelector pageSize={pageSize} onChange={(n) => { setPageSize(n); setCurrentPage(1); }} />
          </div>
          {searchedUnits.length === 0 ? (
            <div className="card flex flex-col items-center justify-center py-12 text-charcoal/40">
              <p className="text-sm font-bold">
                {isAr ? 'لا توجد وحدات مطابقة لبحثك.' : 'No units match your search.'}
              </p>
            </div>
          ) : (
            <>
              <TableView
                model={unitsModel}
                records={pagedUnits}
                onRowClick={(rec) =>
                  navigate(`/model/${unitsModel.name}/${rec.id}`, {
                    state: { backTo: location.pathname + location.search },
                  })
                }
                onDelete={setDeletingRecord}
                view={activeView}
              />
              <PageNavigator
                totalCount={searchedUnits.length}
                currentPage={currentPage}
                pageSize={pageSize}
                onPageChange={setCurrentPage}
              />
            </>
          )}
        </>
      )}

      {/* View editor modal — create / edit the units columns + sort + filters */}
      <ViewEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        model={unitsModel}
        view={editingView}
        onSaved={(v) => setActiveViewId(v.id)}
      />

      {/* Delete confirmation */}
      <Modal
        open={!!deletingRecord}
        onClose={() => setDeletingRecord(null)}
        title={t('records.delete_record')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeletingRecord(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={handleDelete}>
              <Trash2 size={14} />
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-charcoal">{t('records.delete_confirm')}</p>
      </Modal>
    </div>
  );
}
