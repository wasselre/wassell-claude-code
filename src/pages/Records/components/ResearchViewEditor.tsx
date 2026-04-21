import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type { AppModel, AppRecord, ModelField, ModelView } from '@/types';

interface ResearchViewEditorProps {
  open: boolean;
  onClose: () => void;
  /** Model being edited (e.g. projects_research). */
  currentModel: AppModel;
  /** Model supplying the comparison columns (e.g. all_projects). */
  sourceModel: AppModel;
  /** The section_mirror field the view is scoped to. */
  container: ModelField;
  /** Target-origin columns — fields from the source section (per-project values). */
  includedFields: ModelField[];
  /** Current-origin columns — fields from the research model itself (record-level values, repeat per row). */
  currentModelFields: ModelField[];
  /** All currently-linked targets for row-picking, with their records for labels. */
  targets: Array<{ id: string; targetRecord: AppRecord | null }>;
  /** View being edited; null = creating a new view. */
  view: ModelView | null;
  /** Called with the saved view after writing to the store. */
  onSaved: (view: ModelView) => void;
}

/**
 * Research comparison view editor. Scopes a `ModelView` to two axes:
 *   - Columns: which fields from the source section to include (drag-reorder)
 *   - Rows:    which linked target records to include (checklist, no reorder)
 *
 * Sort + filters are omitted — they don't apply to fixed-row comparison tables.
 */
export default function ResearchViewEditor({
  open,
  onClose,
  currentModel,
  sourceModel,
  container,
  includedFields,
  currentModelFields,
  targets,
  view,
  onSaved,
}: ResearchViewEditorProps) {
  const { t } = useTranslation();
  const { language, currentUserId, saveView, addToast } = useAppStore();
  const isAr = language === 'ar';

  const isEdit = view !== null;

  // Pool of pickable columns: source section fields + research-model fields, tagged by origin.
  const allCandidates = [
    ...includedFields.map((f) => ({ field: f, origin: 'target' as const })),
    ...currentModelFields.map((f) => ({ field: f, origin: 'current' as const })),
  ];

  // Column selection — ordered list of field ids. Default: all source-section candidates.
  const seedFieldIds = view?.field_ids ?? includedFields.map((f) => f.id);
  const [labelAr, setLabelAr] = useState(view?.label_ar ?? '');
  const [labelEn, setLabelEn] = useState(view?.label_en ?? '');
  const [fieldIds, setFieldIds] = useState<string[]>(seedFieldIds);
  // Row selection — subset of currently-linked target ids. Default: all targets.
  const [projectIds, setProjectIds] = useState<string[]>(
    view?.project_ids ?? targets.map((t) => t.id),
  );
  const [isShared, setIsShared] = useState<boolean>(view?.is_shared ?? false);
  const [isDefault, setIsDefault] = useState<boolean>(view?.is_default ?? false);
  const [error, setError] = useState<string | null>(null);

  const candidateById = new Map(allCandidates.map((c) => [c.field.id, c]));
  const orderedSelected = fieldIds
    .map((id) => candidateById.get(id))
    .filter((c): c is { field: ModelField; origin: 'target' | 'current' } => !!c);
  const unselectedCandidates = allCandidates.filter((c) => !fieldIds.includes(c.field.id));

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

  const toggleProject = (id: string) => {
    setProjectIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const resolveTargetLabel = (record: AppRecord | null, fallbackId: string): string => {
    if (!record) return isAr ? 'مشروع محذوف' : 'Deleted project';
    const titleFieldId = sourceModel.card_config?.title_field_id ?? null;
    const titleField = titleFieldId
      ? sourceModel.schema.sections.flatMap((s) => s.fields).find((f) => f.id === titleFieldId)
      : null;
    if (titleField) {
      const v = record.data[titleField.name];
      if (typeof v === 'string' || typeof v === 'number') return String(v);
    }
    return `#${fallbackId.slice(0, 6)}`;
  };

  const handleSave = () => {
    if (fieldIds.length === 0) {
      setError(isAr ? 'اختر حقلاً واحداً على الأقل كعمود.' : 'Select at least one field as a column.');
      return;
    }
    if (projectIds.length === 0) {
      setError(isAr ? 'اختر مشروعاً واحداً على الأقل كصف.' : 'Select at least one project as a row.');
      return;
    }
    const now = new Date().toISOString();
    const saved: ModelView = {
      id: view?.id ?? uuid(),
      model_id: currentModel.id,
      user_id: view?.user_id ?? currentUserId ?? 'anonymous',
      is_shared: isShared,
      is_default: isDefault,
      label_ar: labelAr.trim() || labelEn.trim() || (isAr ? 'عرض بدون اسم' : 'Untitled view'),
      label_en: labelEn.trim() || labelAr.trim() || (isAr ? 'عرض بدون اسم' : 'Untitled view'),
      field_ids: fieldIds,
      sort_field_id: null,
      sort_direction: null,
      conditions: [],
      project_ids: projectIds,
      research_container_field_id: container.id,
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
      title={isEdit ? (isAr ? 'تعديل عرض المقارنة' : 'Edit comparison view') : (isAr ? 'عرض مقارنة جديد' : 'New comparison view')}
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
              {isAr ? 'اسم العرض (عربي)' : 'View name (Arabic)'}
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
              {isAr ? 'اسم العرض (إنجليزي)' : 'View name (English)'}
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

        {/* Columns (fields) */}
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <label className="text-sm font-bold text-charcoal">
              {isAr ? 'الأعمدة (الحقول)' : 'Columns (fields)'}
            </label>
            <span className="text-xs text-charcoal/40">
              {isAr ? 'اسحب لإعادة الترتيب' : 'Drag to reorder'}
            </span>
          </div>

          {orderedSelected.length > 0 && (
            <div className="border border-sand/40 rounded-lg p-2 mb-3 bg-cream-light">
              <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={fieldIds} strategy={verticalListSortingStrategy}>
                  <div className="space-y-1">
                    {orderedSelected.map((c) => (
                      <ColumnRow
                        key={c.field.id}
                        field={c.field}
                        origin={c.origin}
                        isAr={isAr}
                        onRemove={() => toggleField(c.field.id)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}

          {unselectedCandidates.length > 0 && (
            <div>
              <div className="text-xs font-bold text-charcoal/50 mb-1">
                {isAr ? 'حقول أخرى' : 'Other fields'}
              </div>
              <div className="flex flex-wrap gap-1">
                {unselectedCandidates.map((c) => (
                  <button
                    key={c.field.id}
                    onClick={() => toggleField(c.field.id)}
                    className="pill text-xs border-sand/40 hover:border-copper/30 hover:bg-copper/5"
                    title={c.origin === 'current' ? (isAr ? 'حقل من نموذج البحث (نفس القيمة لكل الصفوف)' : 'Research-model field (same value across rows)') : undefined}
                  >
                    <Plus size={12} />
                    {isAr ? c.field.label_ar : c.field.label_en}
                    {c.origin === 'current' && (
                      <span className="ms-1 text-[9px] text-chocolate/60 bg-chocolate/8 px-1 py-0.5 rounded-full font-bold">
                        {isAr ? 'عام' : 'Shared'}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Rows (projects) */}
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <label className="text-sm font-bold text-charcoal">
              {isAr ? 'الصفوف (المشاريع)' : 'Rows (projects)'}
            </label>
            <span className="text-xs text-charcoal/40">
              {isAr ? 'المشاريع المرتبطة بهذه الدراسة' : 'Projects linked to this study'}
            </span>
          </div>
          {targets.length === 0 ? (
            <p className="text-[11px] text-charcoal/40 italic">
              {isAr ? 'لا توجد مشاريع مرتبطة بعد.' : 'No projects linked yet.'}
            </p>
          ) : (
            <div className="space-y-0.5 max-h-56 overflow-y-auto bg-sand/5 rounded-lg p-2">
              {targets.map((t) => {
                const label = resolveTargetLabel(t.targetRecord, t.id);
                const checked = projectIds.includes(t.id);
                return (
                  <label
                    key={t.id}
                    className={`flex items-center gap-2.5 py-1.5 px-2 rounded-md cursor-pointer transition-colors ${
                      checked ? 'bg-copper/[0.08]' : 'hover:bg-sand/15'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleProject(t.id)}
                      className="w-3.5 h-3.5 rounded border-sand/50 text-copper focus:ring-copper/20"
                    />
                    <span className={`text-[12px] flex-1 ${checked ? 'text-charcoal font-semibold' : 'text-charcoal/60'}`}>
                      {label}
                    </span>
                    {!t.targetRecord && (
                      <span className="text-[10px] text-red-400 bg-red-50 px-1.5 py-0.5 rounded-full">
                        {isAr ? 'محذوف' : 'Deleted'}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}

        {/* Sharing + default */}
        <div className="flex flex-wrap gap-4 pt-2 border-t border-sand/40">
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={isShared}
              onChange={(e) => setIsShared(e.target.checked)}
              className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
            />
            <span className="text-charcoal">{isAr ? 'مشاركة هذا العرض مع الفريق' : 'Share this view with the team'}</span>
          </label>
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
            />
            <span className="text-charcoal">{isAr ? 'جعله العرض الافتراضي' : 'Make it the default view'}</span>
          </label>
        </div>
      </div>
    </Modal>
  );
}

function ColumnRow({
  field,
  origin,
  isAr,
  onRemove,
}: {
  field: ModelField;
  origin: 'target' | 'current';
  isAr: boolean;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.id,
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
        {isAr ? field.label_ar : field.label_en}
      </span>
      {origin === 'current' && (
        <span
          className="text-[10px] font-bold text-chocolate/70 bg-chocolate/8 px-1.5 py-0.5 rounded-full"
          title={isAr ? 'حقل من نموذج البحث' : 'Research-model field'}
        >
          {isAr ? 'عام' : 'Shared'}
        </span>
      )}
      <span className="text-[10px] text-charcoal/30 bg-sand/10 px-1.5 py-0.5 rounded-full">
        {field.type}
      </span>
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
