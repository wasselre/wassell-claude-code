import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { Pencil, Trash2, ArrowUpDown, Check, X, Link2, ExternalLink } from 'lucide-react';
import DynamicCell from './DynamicCell';
import PhoneInput from './PhoneInput';
import RangeField from './RangeField';
import LookupCombobox from './LookupCombobox';
import DropdownSelect from './DropdownSelect';
import MultiSelect from './MultiSelect';
import {
  ImageFieldInput,
  MultiImageFieldInput,
  FileFieldInput,
  MultiFileFieldInput,
} from './DriveFieldInputs';
import { VideoFieldInput, MultiVideoFieldInput } from './VideoField';
import AttachmentFieldInput from './AttachmentFieldInput';
import { filterEligibleAssignees } from '@/lib/assigneeEligibility';
import { resolveLookupDisplayValue } from '@/lib/mirrorResolver';
import { collectViewFields, readExpandedValue, type ExpandedField } from '@/lib/sectionMirrorExpand';
import { canEditRecord, getFieldPermission } from '@/lib/permissions';
import type { AppModel, AppRecord, AttachmentRef, ModelField, ModelView } from '@/types';
import { sortRecordsByFieldName, type SortCtx } from '@/lib/recordSort';
import { shortenGoogleMapsUrl } from '@/lib/urlUtils';

interface TableViewProps {
  model: AppModel;
  records: AppRecord[];
  onRowClick: (record: AppRecord) => void;
  onDelete: (record: AppRecord) => void;
  /**
   * Optional saved view. When provided, its field_ids (in order) drive columns
   * and its sort is used as the initial sort. When absent, columns fall back
   * to fields with `show_in_table=true` (with the title field prepended).
   */
  view?: ModelView | null;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onToggleSelectAll?: () => void;
  /**
   * Read-only overview mode. When true: clicking a row calls `onRowClick`
   * (instead of starting inline edit), and the per-row actions column (open /
   * delete) is hidden. Columns are still sortable. Used by the Client Details
   * "Related Records" tables, which are a read-only 360 view — edits happen on
   * each record's own page.
   */
  readOnly?: boolean;
  /**
   * Controlled sort. The paginated list pages (Records list, Units tab) own the
   * sort so it applies to the FULL dataset before pagination — otherwise a
   * column-header click would only reorder the visible page, and computed
   * rollup columns (e.g. All Projects' Project Details) couldn't sort globally.
   * When `onToggleSort` is provided, TableView renders `records` as-is (already
   * sorted upstream) and reports header clicks via `onToggleSort`. When omitted,
   * TableView sorts internally — used by the read-only Related-Records tables,
   * which receive the full unpaginated match set.
   */
  sortField?: string | null;
  sortDir?: 'asc' | 'desc';
  onToggleSort?: (fieldName: string) => void;
}

export default function TableView({ model, records, onRowClick, onDelete, view, selectedIds, onToggleSelect, onToggleSelectAll, readOnly = false, sortField: controlledSortField, sortDir: controlledSortDir, onToggleSort }: TableViewProps) {
  const { t } = useTranslation();
  const { language, records: allRecords, saveRecord, addToast, models, currentUserId, users, profiles, roles } = useAppStore();
  const isAr = language === 'ar';
  // Edit eligibility per row (canEditRecord = model.edit perm AND view_scope AND
  // edit_scope). Per-field permission for each cell. Both bypass for admins.
  const canEditFor = (record: AppRecord): boolean =>
    canEditRecord(currentUserId, users, profiles, roles, model, record);
  const fieldPermFor = (field: ModelField) =>
    getFieldPermission(currentUserId, users, profiles, model.id, field);

  // Build column list from the expanded field set (local + virtual mirrored children).
  // With view: use view.field_ids in order (skipping any fields removed from the model).
  // Without view: fall back to show_in_table on local fields, with title field prepended.
  const expandedFields = useMemo(() => collectViewFields(model, models), [model, models]);
  const titleFieldId = model.card_config.title_field_id;
  const titleExpanded = titleFieldId
    ? expandedFields.find((f) => f.kind === 'local' && f.id === titleFieldId) ?? null
    : null;

  // sortField is the LOCAL field name (slug); view stores the field id, so resolve it.
  // Mirrored virtual columns are not sortable in v1 (per-record resolve on every compare
  // is too expensive and UX is unclear), so view.sort_field_id pointing at a virtual id
  // naturally resolves to null here.
  const viewId = view?.id ?? null;
  const resolveSortName = (id: string | null | undefined): string | null => {
    if (!id) return null;
    const ef = expandedFields.find((f) => f.id === id);
    if (!ef || ef.kind !== 'local') return null;
    return ef.field.name;
  };

  // Sort is CONTROLLED when the parent passes onToggleSort (paginated list
  // pages — so the sort drives the full dataset before pagination), otherwise
  // UNCONTROLLED with local state (read-only Related-Records tables, which get
  // the full unpaginated set so a local sort covers everything).
  const controlledSort = !!onToggleSort;
  const [localSortField, setLocalSortField] = useState<string | null>(resolveSortName(view?.sort_field_id));
  const [localSortDir, setLocalSortDir] = useState<'asc' | 'desc'>(view?.sort_direction ?? 'asc');
  const sortField = controlledSort ? (controlledSortField ?? null) : localSortField;
  const sortDir = controlledSort ? (controlledSortDir ?? 'asc') : localSortDir;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editData, setEditData] = useState<Record<string, unknown>>({});

  // When the active view changes, reset the LOCAL sort to the view's sort.
  // (Controlled mode ignores local state — the parent owns + resets its sort.)
  useEffect(() => {
    setLocalSortField(resolveSortName(view?.sort_field_id));
    setLocalSortDir(view?.sort_direction ?? 'asc');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId, view?.sort_field_id, view?.sort_direction]);

  let columns: ExpandedField[] = [];
  if (view) {
    for (const id of view.field_ids) {
      const ef = expandedFields.find((x) => x.id === id);
      if (ef) columns.push(ef);
    }
  } else {
    const tableFields = expandedFields.filter((ef) => ef.kind === 'local' && ef.field.show_in_table);
    if (titleExpanded && !tableFields.find((f) => f.id === titleExpanded.id)) {
      columns.push(titleExpanded);
    }
    for (const ef of tableFields) {
      if (!columns.find((c) => c.id === ef.id)) columns.push(ef);
    }
  }
  // Drop columns the current profile is not allowed to see. Only filter
  // local (non-mirrored) fields — mirrored children belong to a different
  // model with its own permission rules.
  columns = columns.filter((ef) => {
    if (ef.kind !== 'local') return true;
    return fieldPermFor(ef.field) !== 'hidden';
  });

  const toggleSort = (fieldName: string) => {
    if (controlledSort) {
      onToggleSort!(fieldName);
      return;
    }
    if (localSortField === fieldName) {
      setLocalSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setLocalSortField(fieldName);
      setLocalSortDir('asc');
    }
  };

  const selectionEnabled = !!selectedIds && !!onToggleSelect && !!onToggleSelectAll;
  const allSelected = selectionEnabled && records.length > 0 && records.every((r) => selectedIds!.has(r.id));
  const someSelected = selectionEnabled && records.some((r) => selectedIds!.has(r.id));
  const headerCheckboxRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = !allSelected && someSelected;
    }
  }, [allSelected, someSelected]);

  const sortedRecords = useMemo(() => {
    // Controlled: the parent already sorted the full list (and paginated), so
    // render rows in the order received.
    if (controlledSort) return records;
    const ctx: SortCtx = { isAr, allRecords, models, users };
    return sortRecordsByFieldName(records, model, sortField, sortDir, ctx);
  }, [controlledSort, records, model, sortField, sortDir, isAr, allRecords, models, users]);

  const startEdit = (record: AppRecord) => {
    // Inline-edit is gated by the same edit-scope check the form page uses.
    // When the user can't edit this record (no edit perm, or the row fails
    // edit_scope), fall through to opening the form so they at least get a
    // read-only view instead of a click that silently does nothing.
    if (!canEditFor(record)) {
      onRowClick(record);
      return;
    }
    setEditingId(record.id);
    setEditData({ ...record.data });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditData({});
  };

  const saveEdit = (record: AppRecord) => {
    saveRecord({ ...record, data: editData, updated_at: new Date().toISOString() });
    addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
    setEditingId(null);
    setEditData({});
  };

  const updateField = (fieldName: string, value: unknown) => {
    setEditData((prev) => ({ ...prev, [fieldName]: value }));
  };

  // Dual horizontal scrollbars: a ghost scrollbar above the table mirrors the
  // real one below so the user can scroll wide tables from the top without
  // having to reach for the bottom edge. We sync scrollLeft in both directions
  // and hide the top bar entirely when the table doesn't overflow.
  const topScrollRef = useRef<HTMLDivElement>(null);
  const bottomScrollRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = bottomScrollRef.current;
    if (!el) return;
    const update = () => {
      setContentWidth(el.scrollWidth);
      setOverflows(el.scrollWidth > el.clientWidth + 1);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const tbl = el.querySelector('table');
    if (tbl) ro.observe(tbl);
    return () => ro.disconnect();
  }, [records.length, sortedRecords.length, editingId]);

  const syncingRef = useRef<'top' | 'bottom' | null>(null);
  const handleTopScroll = () => {
    if (syncingRef.current === 'bottom') return;
    syncingRef.current = 'top';
    if (bottomScrollRef.current && topScrollRef.current) {
      bottomScrollRef.current.scrollLeft = topScrollRef.current.scrollLeft;
    }
    requestAnimationFrame(() => { syncingRef.current = null; });
  };
  const handleBottomScroll = () => {
    if (syncingRef.current === 'top') return;
    syncingRef.current = 'bottom';
    if (bottomScrollRef.current && topScrollRef.current) {
      topScrollRef.current.scrollLeft = bottomScrollRef.current.scrollLeft;
    }
    requestAnimationFrame(() => { syncingRef.current = null; });
  };

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-charcoal/30">
        <p className="text-lg font-bold mb-2">{t('records.no_records')}</p>
      </div>
    );
  }

  return (
    <div className="card">
      {overflows && (
        <div
          ref={topScrollRef}
          onScroll={handleTopScroll}
          className="overflow-x-auto overflow-y-hidden border-b border-sand/20"
          style={{ height: 14 }}
          aria-hidden="true"
        >
          <div style={{ width: contentWidth, height: 1 }} />
        </div>
      )}
      <div
        ref={bottomScrollRef}
        onScroll={handleBottomScroll}
        className="overflow-x-auto"
      >
      <table className="data-table">
        <thead>
          <tr>
            {selectionEnabled && (
              <th className="w-10">
                <input
                  ref={headerCheckboxRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={onToggleSelectAll}
                  className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30 cursor-pointer"
                  title={isAr ? (allSelected ? 'إلغاء تحديد الكل' : 'تحديد الكل') : (allSelected ? 'Deselect all' : 'Select all')}
                />
              </th>
            )}
            {columns.map((ef) => {
              const field = ef.field;
              const sortable = ef.kind === 'local' && field.type !== 'mirror';
              return (
                <th key={ef.id}>
                  {sortable ? (
                    <button
                      onClick={() => toggleSort(field.name)}
                      className="flex items-center gap-1 hover:text-copper transition-colors"
                    >
                      {isAr ? field.label_ar : field.label_en}
                      <ArrowUpDown size={12} className={sortField === field.name ? 'text-copper' : 'text-charcoal/20'} />
                    </button>
                  ) : (
                    <span className="flex items-center gap-1">
                      {isAr ? field.label_ar : field.label_en}
                      {ef.kind === 'mirrored' && (
                        <span className="inline-flex items-center gap-0.5 text-[9px] text-chocolate/70 bg-chocolate/8 px-1 py-0.5 rounded-full font-bold">
                          <Link2 size={8} />
                          {isAr ? 'مرآة' : 'Mirrored'}
                        </span>
                      )}
                    </span>
                  )}
                </th>
              );
            })}
            {!readOnly && <th className="w-28">{t('common.actions')}</th>}
          </tr>
        </thead>
        <tbody>
          {sortedRecords.map((record) => {
            const isEditing = editingId === record.id;
            const isSelected = selectionEnabled && selectedIds!.has(record.id);

            return (
              <tr
                key={record.id}
                className={`cursor-pointer ${isEditing ? 'bg-copper/[0.03]' : isSelected ? 'bg-copper/[0.06]' : ''}`}
                onClick={() => {
                  if (readOnly) { onRowClick(record); return; }
                  if (!isEditing) startEdit(record);
                }}
              >
                {selectionEnabled && (
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleSelect!(record.id)}
                      className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30 cursor-pointer"
                    />
                  </td>
                )}
                {columns.map((ef) => {
                  const field = ef.field;
                  const value = ef.kind === 'local'
                    ? record.data[field.name]
                    : readExpandedValue(ef, record, allRecords, model, models);
                  const effectiveData = ef.kind === 'local' ? (isEditing ? editData : record.data) : record.data;
                  // Inline-edit is disabled for virtual mirrored columns (wiring edits
                  // back to the source record from a table row is v2 work) AND for
                  // fields the profile has marked read-only — the cell renders as
                  // DynamicCell instead so the value is visible but not writable.
                  const fieldPerm = ef.kind === 'local' ? fieldPermFor(field) : 'editable';
                  const canInlineEdit =
                    ef.kind === 'local' && field.type !== 'mirror' && fieldPerm === 'editable';
                  return (
                    <td key={ef.id}>
                      {isEditing && canInlineEdit ? (
                        <InlineInput
                          field={field}
                          value={editData[field.name]}
                          onChange={(val) => updateField(field.name, val)}
                          modelId={model.id}
                          recordId={record.id}
                        />
                      ) : (
                        <DynamicCell
                          field={field}
                          value={value}
                          allRecords={allRecords}
                          recordData={effectiveData}
                        />
                      )}
                    </td>
                  );
                })}
                {!readOnly && (
                <td>
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    {isEditing ? (
                      <>
                        <button
                          onClick={() => saveEdit(record)}
                          className="p-1.5 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors"
                          title={isAr ? 'حفظ' : 'Save'}
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="p-1.5 rounded-lg hover:bg-cream text-charcoal/40 hover:text-charcoal transition-colors"
                          title={isAr ? 'إلغاء' : 'Cancel'}
                        >
                          <X size={14} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => onRowClick(record)}
                          className="p-1.5 rounded-lg hover:bg-cream text-charcoal/40 hover:text-copper transition-colors"
                          title={isAr ? 'فتح السجل' : 'Open record'}
                        >
                          <Pencil size={14} />
                        </button>
                        {canEditFor(record) && (
                          <button
                            onClick={() => onDelete(record)}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-charcoal/40 hover:text-red-500 transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** Compact inline input for table cells — uses native elements to avoid overflow issues */
function InlineInput({
  field,
  value,
  onChange,
  modelId,
  recordId,
}: {
  field: ModelField;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Owning model + record id — passed through to the Drive-backed inputs so
   *  files uploaded while inline-editing get tagged to this record. */
  modelId: string;
  recordId: string;
}) {
  const { language, records, users, models } = useAppStore();
  const isAr = language === 'ar';

  const cls = 'form-input text-sm py-1 px-2';

  // Width = (content length + padding) in ch units, clamped so the input stays
  // usable but grows to fit what the user is typing. Matches the user's ask
  // that the field adjust to the text inside it.
  const autoWidth = (text: string, min = 8, max = 48) => {
    const len = Math.max(text.length, 0) + 2;
    const ch = Math.min(Math.max(len, min), max);
    return `${ch}ch`;
  };

  switch (field.type) {
    case 'text':
    case 'email':
    case 'textarea': {
      const text = String(value ?? '');
      return (
        <input
          type={field.type === 'email' ? 'email' : 'text'}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
          style={{ width: autoWidth(text) }}
          dir={field.type === 'email' ? 'ltr' : undefined}
          onClick={(e) => e.stopPropagation()}
        />
      );
    }

    case 'url':
      return <UrlInlineEditor value={value} onChange={onChange} isAr={isAr} />;

    case 'multi_link':
      // Variable-length link list — edited in the full form page. Inline table
      // edit shows a read-only hint (like notes) so the default text input
      // never clobbers the string[] with a stringified value.
      return (
        <span
          className="text-xs text-charcoal/40 italic"
          onClick={(e) => e.stopPropagation()}
        >
          {isAr ? 'افتح السجل للتعديل' : 'Open record to edit'}
        </span>
      );

    case 'phone':
      return (
        <PhoneInput
          value={value as string | null | undefined}
          onChange={onChange}
          defaultCountryCode={field.default_country_code}
          compact
        />
      );

    case 'number':
    case 'currency':
      return (
        <input
          type="number"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
          className={`${cls} w-24`}
          onClick={(e) => e.stopPropagation()}
        />
      );

    case 'range':
      return <RangeField field={field} value={value} onChange={onChange} />;

    case 'notes':
      // Notes are edited in the full form page; inline table edit is a read-only hint.
      return (
        <span
          className="text-xs text-charcoal/40 italic"
          onClick={(e) => e.stopPropagation()}
        >
          {isAr ? 'افتح السجل للتعديل' : 'Open record to edit'}
        </span>
      );

    case 'date':
      return (
        <input
          type="date"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
          onClick={(e) => e.stopPropagation()}
        />
      );

    case 'datetime':
      return (
        <input
          type="datetime-local"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
          onClick={(e) => e.stopPropagation()}
        />
      );

    case 'checkbox':
      return (
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30 cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        />
      );

    case 'dropdown': {
      return (
        <div onClick={(e) => e.stopPropagation()} className="min-w-[9rem]">
          <DropdownSelect
            options={field.options ?? []}
            groups={field.option_groups}
            value={(value as string) ?? undefined}
            onChange={onChange}
            compact
          />
        </div>
      );
    }

    case 'multiselect':
    case 'section_selector': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div onClick={(e) => e.stopPropagation()} className="min-w-[10rem]">
          <MultiSelect
            options={field.options ?? []}
            groups={field.option_groups}
            value={selected}
            onChange={onChange as (v: string[]) => void}
            compact
          />
        </div>
      );
    }

    case 'lookup': {
      if (!field.lookup_model_id || !field.lookup_display_field) {
        return <span className="text-charcoal/20">—</span>;
      }
      if (field.is_multi) {
        return (
          <div onClick={(e) => e.stopPropagation()} className="min-w-[10rem]">
            <LookupCombobox
              lookupModelId={field.lookup_model_id}
              lookupDisplayField={field.lookup_display_field}
              isMulti
              maxRecords={field.lookup_max_records}
              value={value as string | string[] | undefined}
              onChange={onChange}
            />
          </div>
        );
      }
      const linkedRecords = records[field.lookup_model_id] ?? [];
      const targetModel = models.find((m) => m.id === field.lookup_model_id);
      return (
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cls}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="">—</option>
          {linkedRecords.map((rec) => {
            const display = resolveLookupDisplayValue(rec, field.lookup_display_field!, { targetModel, allModels: models, allRecords: records });
            return (
              <option key={rec.id} value={rec.id}>
                {display ? String(display) : rec.id.slice(0, 8)}
              </option>
            );
          })}
        </select>
      );
    }

    case 'assignee': {
      const eligibleUsers = filterEligibleAssignees(field, users);
      return (
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cls}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="">— {isAr ? 'اختر' : 'Select'} —</option>
          {eligibleUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {isAr ? u.name_ar : u.name_en}
            </option>
          ))}
        </select>
      );
    }

    // Drive-backed file fields (image / multi_image / file / multi_file /
    // attachment). Reuse the EXACT same Files-system inputs the record form
    // uses, wired with the field's accept/size/folder/cap config. Without
    // these cases they'd fall through to the `default` text input below, which
    // stringifies and clobbers the structured value (a `files.id` string,
    // string[], or AttachmentRef[]) — destroying the file links on save.
    // Wrapped in a stopPropagation div like the other rich inputs; the pickers
    // themselves portal out (fixed inset-0), so they escape the table scroll box.
    case 'image':
      return (
        <div onClick={(e) => e.stopPropagation()} className="min-w-[12rem]">
          <ImageFieldInput
            value={typeof value === 'string' ? value : ''}
            acceptMime={field.image_accept ?? 'image/*'}
            maxSizeMb={field.image_max_size_mb ?? 25}
            defaultFolderId={field.attachment_default_folder_id ?? null}
            modelId={modelId}
            recordId={recordId}
            onChange={(v) => onChange(v)}
            isAr={isAr}
          />
        </div>
      );

    case 'multi_image': {
      const list = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : [];
      return (
        <div onClick={(e) => e.stopPropagation()} className="min-w-[12rem]">
          <MultiImageFieldInput
            value={list}
            acceptMime={field.image_accept ?? 'image/*'}
            maxSizeMb={field.image_max_size_mb ?? 25}
            maxItems={field.attachment_max_items}
            defaultFolderId={field.attachment_default_folder_id ?? null}
            modelId={modelId}
            recordId={recordId}
            onChange={(v) => onChange(v)}
            isAr={isAr}
          />
        </div>
      );
    }

    case 'video':
      return (
        <div onClick={(e) => e.stopPropagation()} className="min-w-[12rem]">
          <VideoFieldInput
            value={typeof value === 'string' ? value : ''}
            acceptMime={field.image_accept ?? 'video/*'}
            maxSizeMb={field.image_max_size_mb ?? 200}
            defaultFolderId={field.attachment_default_folder_id ?? null}
            modelId={modelId}
            recordId={recordId}
            onChange={(v) => onChange(v)}
            isAr={isAr}
          />
        </div>
      );

    case 'multi_video': {
      const list = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : [];
      return (
        <div onClick={(e) => e.stopPropagation()} className="min-w-[12rem]">
          <MultiVideoFieldInput
            value={list}
            acceptMime={field.image_accept ?? 'video/*'}
            maxSizeMb={field.image_max_size_mb ?? 200}
            maxItems={field.attachment_max_items}
            defaultFolderId={field.attachment_default_folder_id ?? null}
            modelId={modelId}
            recordId={recordId}
            onChange={(v) => onChange(v)}
            isAr={isAr}
          />
        </div>
      );
    }

    case 'file':
      return (
        <div onClick={(e) => e.stopPropagation()} className="min-w-[12rem]">
          <FileFieldInput
            value={typeof value === 'string' ? value : ''}
            acceptMime={field.image_accept}
            maxSizeMb={field.image_max_size_mb ?? 500}
            defaultFolderId={field.attachment_default_folder_id ?? null}
            modelId={modelId}
            recordId={recordId}
            onChange={(v) => onChange(v)}
            isAr={isAr}
          />
        </div>
      );

    case 'multi_file': {
      const list = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : [];
      return (
        <div onClick={(e) => e.stopPropagation()} className="min-w-[12rem]">
          <MultiFileFieldInput
            value={list}
            acceptMime={field.image_accept}
            maxSizeMb={field.image_max_size_mb ?? 500}
            maxItems={field.attachment_max_items}
            defaultFolderId={field.attachment_default_folder_id ?? null}
            modelId={modelId}
            recordId={recordId}
            onChange={(v) => onChange(v)}
            isAr={isAr}
          />
        </div>
      );
    }

    case 'attachment': {
      // Tolerant parse — legacy/empty/malformed values become an empty list,
      // matching DynamicField's attachment case.
      const refs: AttachmentRef[] = Array.isArray(value)
        ? value.filter(
            (r): r is AttachmentRef =>
              !!r && typeof r === 'object' && 'type' in r && 'id' in r &&
              ((r as AttachmentRef).type === 'file' || (r as AttachmentRef).type === 'folder') &&
              typeof (r as AttachmentRef).id === 'string',
          )
        : [];
      return (
        <div onClick={(e) => e.stopPropagation()} className="min-w-[12rem]">
          <AttachmentFieldInput
            value={refs}
            onChange={(v) => onChange(v)}
            isAr={isAr}
            defaultFolderId={field.attachment_default_folder_id ?? null}
            maxItems={field.attachment_max_items}
            modelId={modelId}
            recordId={recordId}
          />
        </div>
      );
    }

    default:
      return (
        <input
          type="text"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
          onClick={(e) => e.stopPropagation()}
        />
      );
  }
}

/**
 * Inline URL editor — renders as an "Edit link" chip in the table cell. Clicking
 * opens a small popover with a real URL input so the user can edit the value
 * without a full-width input crowding the row. Enter / Save commits, Escape /
 * click-outside discards.
 */
function UrlInlineEditor({
  value,
  onChange,
  isAr,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  isAr: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ''));
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const current = String(value ?? '');
  const hasValue = current.trim() !== '';
  const safeHref = hasValue
    ? (/^https?:\/\//i.test(current) ? current : `https://${current}`)
    : '';

  useEffect(() => {
    if (open) {
      setDraft(current);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const commit = () => {
    // Shorten a pasted Google Maps link to its compact ?q=lat,lng form on save
    // (no-op for any other URL); empty input clears the value.
    onChange(draft.trim() === '' ? undefined : shortenGoogleMapsUrl(draft));
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-copper/10 hover:bg-copper/20 text-copper text-xs font-bold transition-colors"
        title={hasValue ? current : isAr ? 'أضف رابطًا' : 'Add a link'}
      >
        <Link2 size={12} />
        {isAr ? 'تعديل الرابط' : 'Edit link'}
      </button>
      {hasValue && safeHref && (
        <a
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-copper/60 hover:text-copper transition-colors"
          title={isAr ? 'فتح' : 'Open'}
          dir="ltr"
        >
          <ExternalLink size={12} />
        </a>
      )}
      {open && (
        <div
          className="absolute z-30 top-full mt-1 start-0 w-72 bg-white rounded-lg border border-sand shadow-lg p-3 animate-[fadeIn_0.1s_ease]"
        >
          <label className="block text-[11px] font-bold text-charcoal/60 mb-1">
            {isAr ? 'الرابط' : 'Link URL'}
          </label>
          <input
            ref={inputRef}
            type="url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
            }}
            className="form-input text-sm py-1.5 px-2"
            placeholder="https://..."
            dir="ltr"
          />
          <div className="flex items-center justify-end gap-1.5 mt-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-2.5 py-1 rounded-lg text-xs hover:bg-cream text-charcoal/60"
            >
              {isAr ? 'إلغاء' : 'Cancel'}
            </button>
            <button
              type="button"
              onClick={commit}
              className="px-2.5 py-1 rounded-lg text-xs bg-copper text-white hover:bg-terracotta font-bold"
            >
              {isAr ? 'حفظ' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
