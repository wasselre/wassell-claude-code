import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as lucideIcons from 'lucide-react';
import { Columns3, GripVertical, Plus, RotateCcw, Sparkles, X, type LucideIcon } from 'lucide-react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import TableView from './TableView';
import { useAppStore } from '@/stores/appStore';
import { collectViewFields, type ExpandedField } from '@/lib/sectionMirrorExpand';
import type { AppModel, AppRecord, ModelView } from '@/types';

// Same kebab-case → PascalCase icon mapping the rest of the app uses for model
// icons. Falls back to Sparkles when the name doesn't resolve.
function resolveLucideIcon(name?: string): LucideIcon {
  const pascal = (name ?? 'sparkles')
    .trim()
    .replace(/(^|-)(\w)/g, (_, _dash, c: string) => c.toUpperCase());
  const Icon = (lucideIcons as unknown as Record<string, LucideIcon>)[pascal];
  return Icon ?? Sparkles;
}

/**
 * Default column ids for a related-records table — mirrors TableView's own
 * no-view fallback: fields with `show_in_table=true`, with the model's card
 * title field prepended. Falls back to the first few local fields when a model
 * has neither, so the table never renders with zero data columns.
 */
function defaultColumnIds(model: AppModel, expandedFields: ExpandedField[]): string[] {
  const titleId = model.card_config?.title_field_id ?? null;
  const tableFields = expandedFields.filter((ef) => ef.kind === 'local' && ef.field.show_in_table);
  const ids: string[] = [];
  const titleEf = titleId
    ? expandedFields.find((ef) => ef.kind === 'local' && ef.id === titleId) ?? null
    : null;
  if (titleEf && !tableFields.some((f) => f.id === titleEf.id)) ids.push(titleEf.id);
  for (const ef of tableFields) if (!ids.includes(ef.id)) ids.push(ef.id);
  if (ids.length === 0) {
    for (const ef of expandedFields.filter((e) => e.kind === 'local').slice(0, 4)) ids.push(ef.id);
  }
  return ids;
}

// Per-(model, user) column preference for the related-records table. Kept in
// localStorage — a column-visibility choice is a non-critical UI pref, the same
// posture as ad-hoc filters and page size elsewhere in Records.
function colsStorageKey(modelId: string, userId: string | null): string {
  return `wassell_related_cols_${modelId}_${userId ?? 'anon'}`;
}
function loadStoredCols(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : null;
  } catch {
    // Malformed JSON in a UI-pref key — fall back to the computed default.
    return null;
  }
}
function saveStoredCols(key: string, ids: string[] | null): void {
  try {
    if (ids === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // localStorage full / unavailable — the pref simply stays in-memory for the
    // session. No user data is lost (this is a display preference only).
  }
}

interface RelatedModelTableProps {
  model: AppModel;
  matches: AppRecord[];
  isAr: boolean;
}

/**
 * One related-model group in the Client Details "Related Records" panel,
 * rendered as a full table (the same `TableView` the Records list uses) with
 * per-user adjustable columns. Read-only: clicking a row opens that record on
 * its own page. No filter — column choice only.
 */
export default function RelatedModelTable({ model, matches, isAr }: RelatedModelTableProps) {
  const navigate = useNavigate();
  const models = useAppStore((s) => s.models);
  const currentUserId = useAppStore((s) => s.currentUserId);

  const expandedFields = useMemo(() => collectViewFields(model, models), [model, models]);
  const defaults = useMemo(() => defaultColumnIds(model, expandedFields), [model, expandedFields]);

  const storageKey = colsStorageKey(model.id, currentUserId);
  // null = no custom pref → use the computed default. Read once on mount; the
  // component is keyed by model.id upstream, so the key never changes here.
  const [storedCols, setStoredCols] = useState<string[] | null>(() => loadStoredCols(storageKey));

  // Effective columns: the stored pref filtered to ids that still exist on the
  // model (fields can be deleted/renamed), else the default.
  const columnIds = useMemo(() => {
    const base = storedCols ?? defaults;
    const valid = base.filter((id) => expandedFields.some((ef) => ef.id === id));
    return valid.length > 0 ? valid : defaults;
  }, [storedCols, defaults, expandedFields]);

  const setColumns = (ids: string[]) => {
    setStoredCols(ids);
    saveStoredCols(storageKey, ids);
  };
  const resetColumns = () => {
    setStoredCols(null);
    saveStoredCols(storageKey, null);
  };

  // Synthetic, stable-id ModelView so TableView renders exactly our columns.
  // The stable id keeps TableView's sort-reset effect from re-firing when the
  // user changes columns (it keys on view.id + sort fields, all unchanged here).
  const syntheticView: ModelView = useMemo(
    () => ({
      id: `related-${model.id}`,
      model_id: model.id,
      user_id: currentUserId ?? 'anonymous',
      is_shared: false,
      is_default: false,
      label_ar: '',
      label_en: '',
      field_ids: columnIds,
      sort_field_id: null,
      sort_direction: null,
      conditions: [],
      created_at: '',
      updated_at: '',
    }),
    [model.id, currentUserId, columnIds],
  );

  const Icon = resolveLucideIcon(model.icon);

  return (
    <div>
      <header className="flex items-center gap-2 mb-2">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${model.color}15` }}
        >
          <Icon size={14} style={{ color: model.color }} />
        </div>
        <span className="font-bold text-sm text-charcoal">
          {isAr ? model.label_ar : model.label_en}
        </span>
        <span className="text-xs text-charcoal/50">({matches.length})</span>
        <div className="ms-auto">
          <ColumnsButton
            expandedFields={expandedFields}
            selectedIds={columnIds}
            isAr={isAr}
            onChange={setColumns}
            onReset={resetColumns}
            isCustomized={storedCols !== null}
          />
        </div>
      </header>

      <TableView
        model={model}
        records={matches}
        view={syntheticView}
        onRowClick={(rec) => navigate(`/model/${model.name}/${rec.id}`)}
        onDelete={() => undefined}
        readOnly
      />
    </div>
  );
}

/** "Columns" popover trigger — toggle visibility + drag to reorder. */
function ColumnsButton({
  expandedFields,
  selectedIds,
  isAr,
  onChange,
  onReset,
  isCustomized,
}: {
  expandedFields: ExpandedField[];
  selectedIds: string[];
  isAr: boolean;
  onChange: (ids: string[]) => void;
  onReset: () => void;
  isCustomized: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const orderedSelected = selectedIds
    .map((id) => expandedFields.find((f) => f.id === id))
    .filter((f): f is ExpandedField => !!f);
  const unselected = expandedFields.filter((f) => !selectedIds.includes(f.id));

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      if (selectedIds.length <= 1) return; // keep at least one column visible
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = selectedIds.indexOf(String(active.id));
    const newIndex = selectedIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    onChange(arrayMove(selectedIds, oldIndex, newIndex));
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-sand/50 hover:border-copper/40 hover:bg-copper/5 text-charcoal/70 text-xs font-bold transition-colors"
        title={isAr ? 'تخصيص الأعمدة' : 'Customize columns'}
      >
        <Columns3 size={13} />
        {isAr ? 'الأعمدة' : 'Columns'}
        <span className="text-charcoal/40">({selectedIds.length})</span>
      </button>

      {open && (
        <div className="absolute z-30 top-full mt-1 end-0 w-72 bg-white rounded-xl border border-sand shadow-lg p-3 animate-[fadeIn_0.1s_ease]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-charcoal">
              {isAr ? 'الأعمدة المعروضة' : 'Shown columns'}
            </span>
            {isCustomized && (
              <button
                type="button"
                onClick={onReset}
                className="inline-flex items-center gap-1 text-[11px] text-charcoal/50 hover:text-copper transition-colors"
              >
                <RotateCcw size={11} />
                {isAr ? 'إعادة تعيين' : 'Reset'}
              </button>
            )}
          </div>

          <div className="max-h-48 overflow-y-auto">
            <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={selectedIds} strategy={verticalListSortingStrategy}>
                <div className="space-y-1">
                  {orderedSelected.map((ef) => (
                    <ColumnRow
                      key={ef.id}
                      expanded={ef}
                      isAr={isAr}
                      canRemove={selectedIds.length > 1}
                      onRemove={() => toggle(ef.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>

          {unselected.length > 0 && (
            <div className="mt-3 pt-2 border-t border-sand/40">
              <div className="text-[11px] font-bold text-charcoal/50 mb-1">
                {isAr ? 'حقول أخرى' : 'Other fields'}
              </div>
              <div className="flex flex-wrap gap-1">
                {unselected.map((ef) => (
                  <button
                    key={ef.id}
                    type="button"
                    onClick={() => toggle(ef.id)}
                    className="pill text-xs border-sand/40 hover:border-copper/30 hover:bg-copper/5"
                  >
                    <Plus size={11} />
                    {isAr ? ef.field.label_ar : ef.field.label_en}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One draggable row in the selected-columns list. */
function ColumnRow({
  expanded,
  isAr,
  canRemove,
  onRemove,
}: {
  expanded: ExpandedField;
  isAr: boolean;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: expanded.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 bg-cream-light px-2 py-1.5 rounded-md border border-sand/30"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-charcoal/30 hover:text-charcoal/60"
        aria-label="drag"
      >
        <GripVertical size={13} />
      </button>
      <span className="text-xs text-charcoal flex-1 truncate">
        {isAr ? expanded.field.label_ar : expanded.field.label_en}
      </span>
      {canRemove && (
        <button
          onClick={onRemove}
          className="p-1 rounded hover:bg-red-50 text-charcoal/30 hover:text-red-500"
          aria-label="remove"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
