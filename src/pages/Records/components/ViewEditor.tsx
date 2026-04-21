import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2, Filter, Link2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { collectViewFields, type ExpandedField } from '@/lib/sectionMirrorExpand';
import type {
  AppModel,
  ModelField,
  ModelView,
  WidgetFilterCondition,
  WidgetFilterOperator,
} from '@/types';

interface ViewEditorProps {
  open: boolean;
  onClose: () => void;
  model: AppModel;
  /** View to edit; null = creating a new view. */
  view: ModelView | null;
  /** Seed field_ids when creating (e.g. current effective columns). */
  initialFieldIds?: string[];
  /** Seed sort when creating. */
  initialSort?: { field_id: string | null; direction: 'asc' | 'desc' | null };
  onSaved: (view: ModelView) => void;
}

export default function ViewEditor({
  open,
  onClose,
  model,
  view,
  initialFieldIds,
  initialSort,
  onSaved,
}: ViewEditorProps) {
  const { t } = useTranslation();
  const { language, currentUserId, saveView, addToast, models } = useAppStore();
  const isAr = language === 'ar';

  // Columns list: local fields (section_mirror containers filtered out) plus
  // virtual mirrored children expanded out of each container. Both are
  // identified by the same compound `id` — local ids are plain field UUIDs;
  // mirrored ids are `${containerId}::${childSlug}`.
  const expandedFields: ExpandedField[] = useMemo(
    () => collectViewFields(model, models),
    [model, models],
  );
  // Only local fields are usable for sort + filter (those need per-record
  // resolution to compare values; we don't do that for mirrored children yet).
  const localFields: ModelField[] = useMemo(
    () => expandedFields.filter((f) => f.kind === 'local').map((f) => f.field),
    [expandedFields],
  );

  const isEdit = view !== null;

  // Seed state — default to fields with show_in_table=true (local only, since
  // mirrored children have no show_in_table semantics).
  const seedFieldIds = view?.field_ids
    ?? initialFieldIds
    ?? localFields.filter((f) => f.show_in_table).map((f) => f.id);

  const [labelAr, setLabelAr] = useState(view?.label_ar ?? '');
  const [labelEn, setLabelEn] = useState(view?.label_en ?? '');
  const [fieldIds, setFieldIds] = useState<string[]>(seedFieldIds);
  const [sortFieldId, setSortFieldId] = useState<string | null>(
    view?.sort_field_id ?? initialSort?.field_id ?? null,
  );
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(
    (view?.sort_direction ?? initialSort?.direction ?? 'asc') as 'asc' | 'desc',
  );
  const [conditions, setConditions] = useState<WidgetFilterCondition[]>(view?.conditions ?? []);
  const [isShared, setIsShared] = useState<boolean>(view?.is_shared ?? false);
  const [isDefault, setIsDefault] = useState<boolean>(view?.is_default ?? false);
  const [error, setError] = useState<string | null>(null);

  const orderedSelected: ExpandedField[] = fieldIds
    .map((id) => expandedFields.find((f) => f.id === id))
    .filter((f): f is ExpandedField => !!f);
  const unselectedFields: ExpandedField[] = expandedFields.filter((f) => !fieldIds.includes(f.id));

  const toggleField = (id: string) => {
    setFieldIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = fieldIds.indexOf(String(active.id));
    const newIndex = fieldIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    setFieldIds(arrayMove(fieldIds, oldIndex, newIndex));
  };

  const handleSave = () => {
    if (fieldIds.length === 0) {
      setError(t('views.at_least_one_column'));
      return;
    }
    const now = new Date().toISOString();
    const saved: ModelView = {
      id: view?.id ?? uuid(),
      model_id: model.id,
      user_id: view?.user_id ?? currentUserId ?? 'anonymous',
      is_shared: isShared,
      is_default: isDefault,
      label_ar: labelAr.trim() || (labelEn.trim() || t('views.unnamed_view')),
      label_en: labelEn.trim() || (labelAr.trim() || t('views.unnamed_view')),
      field_ids: fieldIds,
      sort_field_id: sortFieldId,
      sort_direction: sortFieldId ? sortDir : null,
      conditions,
      created_at: view?.created_at ?? now,
      updated_at: now,
    };
    saveView(saved);
    addToast(t('toast.saved'), 'success');
    onSaved(saved);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? t('views.edit_current') : t('views.new_view')}
      maxWidth="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={handleSave}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Names */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-bold text-charcoal/60 mb-1">
              {t('views.view_name_ar')}
            </label>
            <input
              type="text"
              value={labelAr}
              onChange={(e) => setLabelAr(e.target.value)}
              className="form-input text-sm"
              dir="rtl"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-charcoal/60 mb-1">
              {t('views.view_name_en')}
            </label>
            <input
              type="text"
              value={labelEn}
              onChange={(e) => setLabelEn(e.target.value)}
              className="form-input text-sm"
              dir="ltr"
            />
          </div>
        </div>

        {/* Columns */}
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <label className="text-sm font-bold text-charcoal">{t('views.columns')}</label>
            <span className="text-xs text-charcoal/40">{t('views.columns_hint')}</span>
          </div>

          {/* Selected columns (reorderable) */}
          {orderedSelected.length > 0 && (
            <div className="border border-sand/40 rounded-lg p-2 mb-3 bg-cream-light">
              <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={fieldIds} strategy={verticalListSortingStrategy}>
                  <div className="space-y-1">
                    {orderedSelected.map((ef) => (
                      <ColumnRow
                        key={ef.id}
                        expanded={ef}
                        isAr={isAr}
                        onRemove={() => toggleField(ef.id)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}

          {/* Add more columns */}
          {unselectedFields.length > 0 && (
            <div>
              <div className="text-xs font-bold text-charcoal/50 mb-1">
                {isAr ? 'حقول أخرى' : 'Other fields'}
              </div>
              <div className="flex flex-wrap gap-1">
                {unselectedFields.map((ef) => (
                  <button
                    key={ef.id}
                    onClick={() => toggleField(ef.id)}
                    className="pill text-xs border-sand/40 hover:border-copper/30 hover:bg-copper/5"
                  >
                    <Plus size={12} />
                    {isAr ? ef.field.label_ar : ef.field.label_en}
                    {ef.kind === 'mirrored' && (
                      <span className="ms-1 inline-flex items-center gap-0.5 text-[9px] text-chocolate/60 bg-chocolate/8 px-1 py-0.5 rounded-full font-bold">
                        <Link2 size={8} />
                        {isAr ? 'مرآة' : 'Mirrored'}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
        </div>

        {/* Sort — local fields only; mirrored children can't be sorted yet. */}
        <div>
          <label className="block text-sm font-bold text-charcoal mb-2">{t('views.sort')}</label>
          <div className="flex items-center gap-2">
            <select
              value={sortFieldId ?? ''}
              onChange={(e) => setSortFieldId(e.target.value || null)}
              className="form-input text-sm flex-1"
            >
              <option value="">— {t('views.sort_none')} —</option>
              {localFields.map((f) => (
                <option key={f.id} value={f.id}>{isAr ? f.label_ar : f.label_en}</option>
              ))}
            </select>
            <select
              value={sortDir}
              onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}
              className="form-input text-sm w-40"
              disabled={!sortFieldId}
            >
              <option value="asc">{t('views.sort_asc')}</option>
              <option value="desc">{t('views.sort_desc')}</option>
            </select>
          </div>
        </div>

        {/* Filters — local fields only. */}
        <ConditionsEditor
          conditions={conditions}
          onChange={setConditions}
          allFields={localFields}
        />

        {/* Sharing + default */}
        <div className="flex flex-wrap gap-4 pt-2 border-t border-sand/40">
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={isShared}
              onChange={(e) => setIsShared(e.target.checked)}
              className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
            />
            <span className="text-charcoal">{t('views.is_shared')}</span>
          </label>
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
            />
            <span className="text-charcoal">{t('views.is_default')}</span>
          </label>
        </div>
      </div>
    </Modal>
  );
}

/** One draggable row in the selected-columns list. */
function ColumnRow({
  expanded,
  isAr,
  onRemove,
}: {
  expanded: ExpandedField;
  isAr: boolean;
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
      className="flex items-center gap-2 bg-white px-2 py-1.5 rounded-md border border-sand/30"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-charcoal/30 hover:text-charcoal/60"
        aria-label="drag"
      >
        <GripVertical size={14} />
      </button>
      <span className="text-sm text-charcoal flex-1 truncate">
        {isAr ? expanded.field.label_ar : expanded.field.label_en}
      </span>
      {expanded.kind === 'mirrored' && (
        <span className="inline-flex items-center gap-0.5 text-[9px] text-chocolate/70 bg-chocolate/8 px-1.5 py-0.5 rounded-full font-bold">
          <Link2 size={8} />
          {isAr ? 'مرآة' : 'Mirrored'}
        </span>
      )}
      <button
        onClick={onRemove}
        className="p-1 rounded hover:bg-red-50 text-charcoal/30 hover:text-red-500"
        aria-label="remove"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

/** Multi-condition filter editor (mirrors dashboard widget pattern). */
function ConditionsEditor({
  conditions,
  onChange,
  allFields,
}: {
  conditions: WidgetFilterCondition[];
  onChange: (conditions: WidgetFilterCondition[]) => void;
  allFields: ModelField[];
}) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';

  const operators: { value: WidgetFilterOperator; key: string }[] = [
    { value: 'equals', key: 'condition.equals' },
    { value: 'not_equals', key: 'condition.not_equals' },
    { value: 'contains', key: 'condition.contains' },
    { value: 'greater_than', key: 'condition.greater_than' },
    { value: 'less_than', key: 'condition.less_than' },
    { value: 'is_empty', key: 'condition.is_empty' },
    { value: 'is_not_empty', key: 'condition.is_not_empty' },
  ];

  const needsValue = (op: WidgetFilterOperator) => op !== 'is_empty' && op !== 'is_not_empty';

  const addCondition = () => {
    onChange([...conditions, { id: uuid(), field_id: '', operator: 'equals', value: '' }]);
  };
  const updateCondition = (id: string, updates: Partial<WidgetFilterCondition>) => {
    onChange(conditions.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  };
  // Seed field_path only for range fields; clear it otherwise so stored
  // conditions don't carry a stale path after the user switches field type.
  const pickField = (id: string, nextFieldId: string) => {
    const nextField = allFields.find((f) => f.id === nextFieldId);
    const field_path = nextField?.type === 'range' ? 'min' : undefined;
    updateCondition(id, { field_id: nextFieldId, field_path, value: '' });
  };
  const deleteCondition = (id: string) => {
    onChange(conditions.filter((c) => c.id !== id));
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Filter size={14} className="text-charcoal/40" />
        <label className="text-sm font-bold text-charcoal">{t('views.filters')}</label>
        {conditions.length > 0 && (
          <span className="text-xs text-copper bg-copper/10 px-1.5 py-0.5 rounded-full font-bold">
            {conditions.length}
          </span>
        )}
      </div>

      {conditions.length > 0 && (
        <div className="space-y-2 mb-3">
          {conditions.map((cond) => {
            const selectedField = allFields.find((f) => f.id === cond.field_id);
            return (
              <div key={cond.id} className="flex items-center gap-2 p-2 bg-cream-light rounded-lg flex-wrap">
                <select
                  value={cond.field_id}
                  onChange={(e) => pickField(cond.id, e.target.value)}
                  className="form-input text-xs py-1 flex-1 bg-white min-w-[120px]"
                >
                  <option value="">— {isAr ? 'حقل' : 'Field'} —</option>
                  {allFields.map((f) => (
                    <option key={f.id} value={f.id}>{isAr ? f.label_ar : f.label_en}</option>
                  ))}
                </select>
                {/* Range sub-path picker (min vs max). Hidden for empty-checks
                    since they evaluate against the whole range value. */}
                {selectedField?.type === 'range'
                  && cond.operator !== 'is_empty'
                  && cond.operator !== 'is_not_empty' && (
                  <select
                    value={cond.field_path ?? 'min'}
                    onChange={(e) => updateCondition(cond.id, { field_path: e.target.value })}
                    className="form-input text-xs py-1 w-20 bg-white"
                    aria-label={isAr ? 'الحد' : 'Bound'}
                  >
                    <option value="min">{isAr ? 'الحد الأدنى' : 'Min'}</option>
                    <option value="max">{isAr ? 'الحد الأعلى' : 'Max'}</option>
                  </select>
                )}
                <select
                  value={cond.operator}
                  onChange={(e) => updateCondition(cond.id, { operator: e.target.value as WidgetFilterOperator })}
                  className="form-input text-xs py-1 w-28 bg-white"
                >
                  {operators.map((op) => (
                    <option key={op.value} value={op.value}>{t(op.key)}</option>
                  ))}
                </select>
                {needsValue(cond.operator) && selectedField && (
                  selectedField.type === 'dropdown' || selectedField.type === 'multiselect' ? (
                    <select
                      value={String(cond.value ?? '')}
                      onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                      className="form-input text-xs py-1 flex-1 bg-white"
                    >
                      <option value="">—</option>
                      {(selectedField.options ?? []).map((opt) => (
                        <option key={opt.id} value={opt.value}>{isAr ? opt.label_ar : opt.label_en}</option>
                      ))}
                    </select>
                  ) : selectedField.type === 'checkbox' ? (
                    <select
                      value={String(cond.value ?? '')}
                      onChange={(e) => updateCondition(cond.id, { value: e.target.value === 'true' })}
                      className="form-input text-xs py-1 w-20 bg-white"
                    >
                      <option value="true">{t('common.yes')}</option>
                      <option value="false">{t('common.no')}</option>
                    </select>
                  ) : selectedField.type === 'number' || selectedField.type === 'currency' || selectedField.type === 'range' ? (
                    <input
                      type="number"
                      value={String(cond.value ?? '')}
                      onChange={(e) => updateCondition(cond.id, { value: e.target.value ? Number(e.target.value) : '' })}
                      className="form-input text-xs py-1 flex-1 bg-white"
                    />
                  ) : selectedField.type === 'date' ? (
                    <input
                      type="date"
                      value={String(cond.value ?? '')}
                      onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                      className="form-input text-xs py-1 flex-1 bg-white"
                    />
                  ) : (
                    <input
                      type="text"
                      value={String(cond.value ?? '')}
                      onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                      className="form-input text-xs py-1 flex-1 bg-white"
                      placeholder="..."
                    />
                  )
                )}
                {needsValue(cond.operator) && !selectedField && (
                  <input
                    type="text"
                    value={String(cond.value ?? '')}
                    onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                    className="form-input text-xs py-1 flex-1 bg-white"
                    placeholder="..."
                  />
                )}
                <button
                  onClick={() => deleteCondition(cond.id)}
                  className="p-1 rounded hover:bg-red-50 text-charcoal/20 hover:text-red-500 shrink-0"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <button onClick={addCondition} className="pill text-xs text-copper border-copper/30 hover:bg-copper/5">
        <Plus size={12} />
        {t('views.add_filter')}
      </button>
    </div>
  );
}
