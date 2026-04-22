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
import { collectViewFields, readExpandedValue, type ExpandedField } from '@/lib/sectionMirrorExpand';
import type { AppModel, AppRecord, ModelField, ModelView } from '@/types';

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
}

export default function TableView({ model, records, onRowClick, onDelete, view, selectedIds, onToggleSelect, onToggleSelectAll }: TableViewProps) {
  const { t } = useTranslation();
  const { language, records: allRecords, saveRecord, addToast, models } = useAppStore();
  const isAr = language === 'ar';

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

  const [sortField, setSortField] = useState<string | null>(resolveSortName(view?.sort_field_id));
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(view?.sort_direction ?? 'asc');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editData, setEditData] = useState<Record<string, unknown>>({});

  // When the active view changes, reset the sort to the view's sort.
  useEffect(() => {
    setSortField(resolveSortName(view?.sort_field_id));
    setSortDir(view?.sort_direction ?? 'asc');
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

  const toggleSort = (fieldName: string) => {
    if (sortField === fieldName) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(fieldName);
      setSortDir('asc');
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

  const sortedRecords = [...records].sort((a, b) => {
    if (!sortField) return 0;
    const va = a.data[sortField];
    const vb = b.data[sortField];
    if (va === vb) return 0;
    if (va === undefined || va === null) return 1;
    if (vb === undefined || vb === null) return -1;
    const cmp = String(va).localeCompare(String(vb), isAr ? 'ar' : 'en', { numeric: true });
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const startEdit = (record: AppRecord) => {
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
            <th className="w-28">{t('common.actions')}</th>
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
                    : readExpandedValue(ef, record, allRecords, model);
                  const effectiveData = ef.kind === 'local' ? (isEditing ? editData : record.data) : record.data;
                  // Inline-edit is disabled for virtual mirrored columns (wiring edits
                  // back to the source record from a table row is v2 work).
                  const canInlineEdit = ef.kind === 'local' && field.type !== 'mirror';
                  return (
                    <td key={ef.id}>
                      {isEditing && canInlineEdit ? (
                        <InlineInput
                          field={field}
                          value={editData[field.name]}
                          onChange={(val) => updateField(field.name, val)}
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
                        <button
                          onClick={() => onDelete(record)}
                          className="p-1.5 rounded-lg hover:bg-red-50 text-charcoal/40 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </td>
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
}: {
  field: ModelField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { language, records, users } = useAppStore();
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
      return (
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cls}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="">—</option>
          {linkedRecords.map((rec) => {
            const display = rec.data[field.lookup_display_field!];
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
      const roleIds = field.assignee_role_ids ?? [];
      const eligibleUsers = users.filter((u) => {
        if (!u.is_active) return false;
        if (roleIds.length === 0) return true;
        return u.role_assignments.some((ra) => roleIds.includes(ra.role_id));
      });
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
    onChange(draft.trim() === '' ? undefined : draft);
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
