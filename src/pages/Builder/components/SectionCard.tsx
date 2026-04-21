import { useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Pencil, Trash2, ChevronDown, Link2, AlertTriangle, ChevronsDownUp, ChevronsUpDown, FolderPlus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { bilingualFromInput } from '@/lib/autoTranslate';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import FieldRow from './FieldRow';
import SectionMirrorConfig from './SectionMirrorConfig';
import type { AppModel, ModelSection, ModelField, Language, SectionFieldGroup } from '@/types';

interface SectionCardProps {
  section: ModelSection;
  language: Language;
  model: AppModel;
  selectedFieldId?: string | null;
  onUpdate: (updates: Partial<ModelSection>) => void;
  onDelete: () => void;
  onEditField: (field: ModelField) => void;
  onDeleteField: (fieldId: string) => void;
  onReorderFields: (oldIndex: number, newIndex: number) => void;
}

export default function SectionCard({
  section,
  language,
  model,
  selectedFieldId,
  onUpdate,
  onDelete,
  onEditField,
  onDeleteField,
  onReorderFields,
}: SectionCardProps) {
  const { t } = useTranslation();
  const { models } = useAppStore();
  const isAr = language === 'ar';
  const [editing, setEditing] = useState(false);
  const [editAr, setEditAr] = useState(section.label_ar);
  const [editEn, setEditEn] = useState(section.label_en);
  const [collapsed, setCollapsed] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showMirrorConfig, setShowMirrorConfig] = useState(false);
  const [showGroupsConfig, setShowGroupsConfig] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const sortedFields = [...section.fields].sort((a, b) => a.order - b.order);

  const handleFieldDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sortedFields.findIndex((f) => f.id === active.id);
    const newIndex = sortedFields.findIndex((f) => f.id === over.id);
    onReorderFields(oldIndex, newIndex);
  };

  const saveEdit = () => {
    onUpdate({ label_ar: editAr, label_en: editEn });
    setEditing(false);
  };

  // Mirror config resolution — for the body pill when is_mirrored.
  const sibling = section.mirror_via_lookup_field_id
    ? model.schema.sections.flatMap((s) => s.fields).find((f) => f.id === section.mirror_via_lookup_field_id)
    : null;
  const targetModel = sibling?.lookup_model_id
    ? models.find((m) => m.id === sibling.lookup_model_id)
    : null;
  const sourceSection = targetModel && section.mirror_source_section_id
    ? targetModel.schema.sections.find((s) => s.id === section.mirror_source_section_id)
    : null;
  const mirrorBroken = !!section.is_mirrored && (!sibling || !targetModel || !sourceSection);

  return (
    <div ref={setNodeRef} style={style} className="section-block">
      {/* Header */}
      <div className="flex items-center px-6 py-4" {...attributes} {...listeners} style={{ cursor: 'grab' }}>
        {editing ? (
          <div
            className="flex-1 flex items-center gap-2"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <input
              value={editAr}
              onChange={(e) => setEditAr(e.target.value)}
              className="form-input text-sm py-1.5 flex-1"
              dir="rtl"
            />
            <input
              value={editEn}
              onChange={(e) => setEditEn(e.target.value)}
              className="form-input text-sm py-1.5 flex-1"
              dir="ltr"
            />
            <Button onClick={saveEdit} className="py-1.5 px-4 text-xs">{t('common.save')}</Button>
          </div>
        ) : (
          <>
            {/* Title + count */}
            <h3 className="text-[15px] font-bold text-chocolate flex-1">
              {isAr ? section.label_ar : section.label_en}
            </h3>

            {/* Field count pill (hidden for mirrored sections — they have no local fields) */}
            {!section.is_mirrored && (
              <span className="text-[11px] font-bold text-charcoal/35 bg-cream/60 px-2 py-0.5 rounded-full me-2">
                {section.fields.length}
              </span>
            )}

            {/* Base tag */}
            {section.is_base && (
              <span className="text-[10px] text-copper/60 bg-copper/6 px-2 py-0.5 rounded-full font-bold me-2">
                {isAr ? 'أساسي' : 'Base'}
              </span>
            )}

            {/* Mirrored tag */}
            {section.is_mirrored && (
              <span className="inline-flex items-center gap-1 text-[10px] text-copper/70 bg-copper/8 px-2 py-0.5 rounded-full font-bold me-2">
                <Link2 size={10} />
                {isAr ? 'منسوخ' : 'Mirrored'}
              </span>
            )}

            {section.default_collapsed && (
              <span
                title={isAr ? 'مطوي افتراضياً في نموذج السجل' : 'Collapsed by default in the record form'}
                className="inline-flex items-center gap-1 text-[10px] text-charcoal/45 bg-sand/25 px-2 py-0.5 rounded-full font-bold me-2"
              >
                <ChevronsDownUp size={10} />
                {isAr ? 'مطوي' : 'Collapsed'}
              </span>
            )}


            {mirrorBroken && (
              <span
                title={isAr ? 'إعدادات النسخ غير صحيحة' : 'Mirror config is broken'}
                className="inline-flex items-center gap-1 text-[10px] text-amber-500 bg-amber-50 px-2 py-0.5 rounded-full font-bold me-2"
              >
                <AlertTriangle size={10} />
                {isAr ? 'خلل' : 'Broken'}
              </span>
            )}

            {/* Actions — muted, grouped. stopPropagation on pointerdown so dnd-kit
                doesn't start a drag when the user presses an action button. */}
            <div
              className="flex items-center gap-0.5"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => onUpdate({ default_collapsed: !section.default_collapsed })}
                title={
                  section.default_collapsed
                    ? (isAr ? 'مفتوح افتراضياً في السجل' : 'Open by default in record')
                    : (isAr ? 'مطوي افتراضياً في السجل' : 'Collapsed by default in record')
                }
                className={`p-1.5 rounded-lg hover:bg-cream/60 transition-colors ${
                  section.default_collapsed ? 'text-copper/70 hover:text-copper' : 'text-charcoal/15 hover:text-charcoal/50'
                }`}
              >
                {section.default_collapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
              </button>
              {!section.is_mirrored && (
                <button
                  onClick={() => setShowGroupsConfig(true)}
                  title={isAr ? 'إدارة المجموعات داخل القسم' : 'Manage field groups in this section'}
                  className={`p-1.5 rounded-lg hover:bg-cream/60 transition-colors ${
                    (section.field_groups?.length ?? 0) > 0
                      ? 'text-copper/70 hover:text-copper'
                      : 'text-charcoal/15 hover:text-charcoal/50'
                  }`}
                >
                  <FolderPlus size={13} />
                </button>
              )}
              <button
                onClick={() => setShowMirrorConfig(true)}
                title={isAr ? 'نسخ من نموذج آخر' : 'Mirror from another model'}
                className={`p-1.5 rounded-lg hover:bg-cream/60 transition-colors ${
                  section.is_mirrored ? 'text-copper/70 hover:text-copper' : 'text-charcoal/15 hover:text-charcoal/50'
                }`}
              >
                <Link2 size={13} />
              </button>
              <button
                onClick={() => setEditing(true)}
                className="p-1.5 rounded-lg text-charcoal/15 hover:text-charcoal/50 hover:bg-cream/60 transition-colors"
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="p-1.5 rounded-lg text-charcoal/15 hover:text-red-400 hover:bg-red-50 transition-colors"
              >
                <Trash2 size={13} />
              </button>
              <button
                onClick={() => setCollapsed(!collapsed)}
                className="p-1.5 rounded-lg text-charcoal/15 hover:text-charcoal/50 hover:bg-cream/60 transition-colors"
              >
                <ChevronDown
                  size={14}
                  className={`transition-transform ${collapsed ? '-rotate-90 rtl:rotate-90' : ''}`}
                />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Body */}
      {!collapsed && (
        <div className="px-5 pb-5">
          {section.is_mirrored ? (
            <div className="px-3 py-6 text-center text-sm text-charcoal/50">
              {mirrorBroken ? (
                <span className="text-amber-600">
                  {isAr
                    ? 'إعدادات النسخ غير مكتملة. افتح الإعدادات لإصلاحها.'
                    : 'Mirror config is incomplete. Open settings to fix.'}
                </span>
              ) : (
                <span>
                  {isAr
                    ? `الحقول مأخوذة من: ${targetModel?.label_ar ?? ''} / ${sourceSection?.label_ar ?? ''}`
                    : `Fields are mirrored from: ${targetModel?.label_en ?? ''} / ${sourceSection?.label_en ?? ''}`}
                </span>
              )}
            </div>
          ) : (
            <>
              <DndContext collisionDetection={closestCenter} onDragEnd={handleFieldDragEnd}>
                <SortableContext items={sortedFields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0">
                    {sortedFields.map((field, idx) => (
                      <FieldRow
                        key={field.id}
                        field={field}
                        language={language}
                        isSelected={selectedFieldId === field.id}
                        onEdit={() => onEditField(field)}
                        onDelete={() => onDeleteField(field.id)}
                        showDivider={idx < sortedFields.length - 2}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              {sortedFields.length === 0 && (
                <p className="text-sm text-charcoal/20 py-8 text-center">
                  {isAr ? 'لا توجد حقول بعد' : 'No fields yet'}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Delete confirmation */}
      <Modal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title={t('common.delete')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowDeleteConfirm(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={() => { onDelete(); setShowDeleteConfirm(false); }}>{t('common.delete')}</Button>
          </>
        }
      >
        <p className="text-charcoal">
          {section.fields.length > 0
            ? (isAr ? `هذا القسم يحتوي على ${section.fields.length} حقول. هل أنت متأكد من الحذف؟` : `This section has ${section.fields.length} fields. Are you sure you want to delete it?`)
            : (isAr ? 'هل أنت متأكد من حذف هذا القسم؟' : 'Are you sure you want to delete this section?')
          }
        </p>
      </Modal>

      {/* Mirror config */}
      <SectionMirrorConfig
        open={showMirrorConfig}
        onClose={() => setShowMirrorConfig(false)}
        model={model}
        section={section}
        onSave={(updates) => onUpdate(updates)}
      />

      {/* Field-groups editor — manages collapsible sub-groups INSIDE this
          section. Each field's membership is set from the Field Properties
          panel via the Group picker. Deleting a group detaches its members
          back to "ungrouped" (doesn't delete the fields). */}
      <Modal
        open={showGroupsConfig}
        onClose={() => setShowGroupsConfig(false)}
        title={isAr ? 'مجموعات الحقول' : 'Field groups'}
        footer={
          <Button variant="secondary" onClick={() => setShowGroupsConfig(false)}>
            {t('common.close')}
          </Button>
        }
      >
        {(() => {
          const groups = [...(section.field_groups ?? [])].sort((a, b) => a.order - b.order);
          const addGroup = () => {
            const defaultLabel = isAr ? 'مجموعة جديدة' : 'New group';
            const labels = bilingualFromInput(defaultLabel, language);
            const next: SectionFieldGroup = {
              id: uuid(),
              label_ar: labels.label_ar,
              label_en: labels.label_en,
              order: groups.length,
              default_collapsed: false,
            };
            onUpdate({ field_groups: [...groups, next] });
          };
          const updateGroup = (id: string, updates: Partial<SectionFieldGroup>) => {
            onUpdate({
              field_groups: groups.map((g) => (g.id === id ? { ...g, ...updates } : g)),
            });
          };
          const deleteGroup = (id: string) => {
            // Detach member fields (set field_group_id to null) and drop the group.
            const remaining = groups
              .filter((g) => g.id !== id)
              .map((g, i) => ({ ...g, order: i }));
            const fields = section.fields.map((f) =>
              f.field_group_id === id ? { ...f, field_group_id: null } : f,
            );
            onUpdate({ field_groups: remaining, fields });
          };
          return (
            <div className="space-y-3">
              <p className="text-xs text-charcoal/50">
                {isAr
                  ? 'أضف مجموعات لتقسيم حقول هذا القسم إلى أقسام صغيرة قابلة للطي. اختر المجموعة لكل حقل من "خصائص الحقل".'
                  : 'Add groups to split this section\u2019s fields into small collapsible groups. Assign each field\u2019s group from the Field Properties panel.'}
              </p>
              {groups.length === 0 && (
                <p className="text-sm text-charcoal/40 italic py-2">
                  {isAr ? 'لا توجد مجموعات بعد.' : 'No groups yet.'}
                </p>
              )}
              {groups.map((g) => (
                <FieldGroupRow
                  key={g.id}
                  group={g}
                  isAr={isAr}
                  language={language}
                  onRename={(label) => {
                    const labels = bilingualFromInput(label, language);
                    updateGroup(g.id, labels);
                  }}
                  onToggleDefaultCollapsed={(v) => updateGroup(g.id, { default_collapsed: v })}
                  onDelete={() => deleteGroup(g.id)}
                />
              ))}
              <button
                onClick={addGroup}
                className="flex items-center gap-1.5 text-sm font-bold text-copper hover:text-copper/80 px-3 py-2 rounded-lg border border-dashed border-copper/40 hover:bg-copper/5 w-full justify-center"
              >
                <Plus size={14} />
                {isAr ? 'إضافة مجموعة' : 'Add group'}
              </button>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}

/**
 * Row for a single field-group inside the Field-groups modal. Keeps the name
 * input's state LOCAL and only commits to the parent model on blur or Enter.
 * This prevents per-keystroke re-renders of the whole Builder tree, which
 * was making typing feel laggy / unresponsive.
 */
function FieldGroupRow({
  group,
  isAr,
  language,
  onRename,
  onToggleDefaultCollapsed,
  onDelete,
}: {
  group: SectionFieldGroup;
  isAr: boolean;
  language: Language;
  onRename: (label: string) => void;
  onToggleDefaultCollapsed: (value: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const displayLabel = isAr ? group.label_ar : group.label_en;
  const [draft, setDraft] = useState(displayLabel);
  // Mirror `draft` into a ref so the blur/Enter handler always reads the
  // latest value — React can batch the final keystroke + blur in the same
  // microtask, which would leave a state closure stale otherwise.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Re-sync local draft if the upstream label changes (e.g. language toggle
  // or another edit) AND the user isn't mid-typing. We compare to the
  // previously-known display label to decide whether to overwrite.
  const [lastSynced, setLastSynced] = useState(displayLabel);
  if (displayLabel !== lastSynced && displayLabel !== draft) {
    setDraft(displayLabel);
    setLastSynced(displayLabel);
  }

  const commit = () => {
    const current = draftRef.current;
    const trimmed = current.trim();
    if (!trimmed) {
      setDraft(displayLabel);
      return;
    }
    if (trimmed !== displayLabel) {
      onRename(trimmed);
      setLastSynced(trimmed);
    }
  };

  // `language` isn't needed for typing — it only affects which bilingual
  // slot this input fills on commit (handled by the parent's onRename).
  void language;

  return (
    <div className="flex items-center gap-2 p-3 rounded-xl border border-sand/30">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === 'Escape') {
            setDraft(displayLabel);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="form-input text-sm py-1.5 flex-1"
        placeholder={isAr ? 'اسم المجموعة' : 'Group name'}
        dir={isAr ? 'rtl' : 'ltr'}
      />
      <label className="flex items-center gap-1.5 text-[11px] font-bold text-charcoal/60 cursor-pointer shrink-0">
        <input
          type="checkbox"
          checked={!!group.default_collapsed}
          onChange={(e) => onToggleDefaultCollapsed(e.target.checked)}
          className="w-3.5 h-3.5 rounded text-copper focus:ring-copper/20"
        />
        {isAr ? 'مطوية افتراضياً' : 'Collapsed by default'}
      </label>
      <button
        onClick={onDelete}
        className="p-1.5 rounded-lg text-charcoal/20 hover:text-red-500 hover:bg-red-50"
        title={t('common.delete')}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
