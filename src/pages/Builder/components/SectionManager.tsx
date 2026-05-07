import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { v4 as uuid } from 'uuid';
import { Plus, Copy } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import SectionCard from './SectionCard';
import FieldEditor, { FieldEditorEmpty } from './FieldEditor';
import FieldTypeCatalog from './FieldTypeCatalog';
import FieldTemplateCatalog from './FieldTemplateCatalog';
import { bilingualFromInput } from '@/lib/autoTranslate';
import { countRecordsWithFieldData } from '@/lib/fieldDataImpact';
import type { AppModel, ModelSection, ModelField, FieldType, FieldTemplate, FieldOption } from '@/types';

interface SectionManagerProps {
  model: AppModel;
  onChange: (model: AppModel) => void;
  /**
   * Identifies the schema owner. Forwarded to FieldEditor so renames are
   * handled correctly:
   * - 'model' (default): slug rename propagates via `renameField`.
   * - 'role': schema-local edit, no propagation. Roles reuse this entire
   *   component by wrapping their schema in an AppModel-shaped object.
   */
  ownerKind?: 'model' | 'role';
  /**
   * When true, every editing affordance is suppressed and pointer events
   * are blocked on the rendered schema. Used by the Builder for frozen
   * (hardcoded) models — see ModelEditor's read-only banner. Defaults to
   * false; the role-schema variant never sets it.
   */
  readOnly?: boolean;
}

const SECTION_COLORS = ['#B8734F', '#C09B5F', '#8E4E3A', '#4A2C2A', '#4A4E54', '#3B82F6'];

export default function SectionManager({ model, onChange, ownerKind = 'model', readOnly = false }: SectionManagerProps) {
  const { t } = useTranslation();
  const { language, records, saveRecord } = useAppStore();
  const [showAddSection, setShowAddSection] = useState(false);
  // Data-loss guard: when the user clicks delete on a field that has record
  // data, we show a confirmation modal instead of deleting immediately. Null
  // means no confirmation pending. Role schemas skip this because role fields
  // don't back any records.
  const [deleteFieldPrompt, setDeleteFieldPrompt] = useState<{
    sectionId: string;
    field: ModelField;
    recordCount: number;
  } | null>(null);
  const [newSectionName, setNewSectionName] = useState('');
  const [newSectionBase, setNewSectionBase] = useState(false);
  const [newSectionColor, setNewSectionColor] = useState(SECTION_COLORS[0]!);
  const isAr = language === 'ar';

  // Active field: { sectionId, field } — field=null means creating new
  const [activeField, setActiveField] = useState<{ sectionId: string; field: ModelField | null } | null>(null);

  // Keep the active field in sync with the latest model state. Needed when the
  // store mutates the field outside of SectionManager's saveField — e.g. after
  // `renameField` propagates a slug change, the field object identity changes
  // and the FieldEditor needs to re-read its props.
  const activeFieldId = activeField?.field?.id;
  useEffect(() => {
    if (!activeFieldId) return;
    const fresh = model.schema.sections.flatMap((s) => s.fields).find((f) => f.id === activeFieldId);
    if (!fresh) return;
    setActiveField((prev) => (prev?.field === fresh ? prev : { sectionId: fresh.section_id, field: fresh }));
  }, [model, activeFieldId]);
  // Track which section is "active" for new field placement
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  // Default type for the new field (set when clicking a type card)
  const [newFieldType, setNewFieldType] = useState<FieldType>('text');

  const sections = [...model.schema.sections].sort((a, b) => a.order - b.order);

  // Fields eligible as a duplicate-check key. Excludes types whose stored value
  // is a structure (range, notes), a derived value (mirror/section_mirror,
  // formula), or UI-only (section_selector, assignee, multiselect) — these
  // don't yield a stable, comparable identity per record.
  const DUPLICATE_CHECK_EXCLUDED_TYPES = new Set([
    'textarea',
    'notes',
    'range',
    'mirror',
    'section_mirror',
    'section_selector',
    'assignee',
    'multiselect',
    'checkbox',
    'formula',
  ]);
  const duplicateCheckCandidates = sections.flatMap((s) =>
    s.fields.filter((f) => !DUPLICATE_CHECK_EXCLUDED_TYPES.has(f.type)),
  );
  const duplicateCheckFieldId = model.schema.duplicate_check_field_id ?? '';
  const setDuplicateCheckFieldId = (id: string) => {
    onChange({
      ...model,
      schema: { ...model.schema, duplicate_check_field_id: id || null },
    });
  };

  // -- Section CRUD --
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sections.findIndex((s) => s.id === active.id);
    const newIndex = sections.findIndex((s) => s.id === over.id);
    const reordered = arrayMove(sections, oldIndex, newIndex).map((s, i) => ({ ...s, order: i }));
    onChange({ ...model, schema: { ...model.schema, sections: reordered } });
  };

  const addSection = () => {
    if (!newSectionName.trim()) return;
    const labels = bilingualFromInput(newSectionName.trim(), language);
    const section: ModelSection = {
      id: uuid(),
      label_ar: labels.label_ar,
      label_en: labels.label_en,
      order: sections.length,
      is_base: newSectionBase,
      color: newSectionColor,
      fields: [],
    };
    const updatedSections = [...model.schema.sections, section];
    const updated = { ...model, schema: { ...model.schema, sections: updatedSections } };
    onChange(updateSectionSelectorOptions(updated));
    setShowAddSection(false);
    setNewSectionName('');
    setNewSectionBase(false);
  };

  const updateSection = (sectionId: string, updates: Partial<ModelSection>) => {
    const updatedSections = model.schema.sections.map((s) =>
      s.id === sectionId ? { ...s, ...updates } : s,
    );
    const updated = { ...model, schema: { ...model.schema, sections: updatedSections } };
    onChange(updateSectionSelectorOptions(updated));
  };

  const deleteSection = (sectionId: string) => {
    const updatedSections = model.schema.sections
      .filter((s) => s.id !== sectionId)
      .map((s, i) => ({ ...s, order: i }));
    const updated = { ...model, schema: { ...model.schema, sections: updatedSections } };
    onChange(updateSectionSelectorOptions(updated));

    // Audit fix M6: prune the deleted section id from every record's
    // section_selector field. The form's render filter already silently
    // drops missing sections (they don't render), but the stored value
    // accumulates dead ids over time and corrupts exports / scope rules
    // that compare against the option list. Walk the records once on
    // delete instead of carrying the cruft forward.
    if (ownerKind === 'model') {
      const selectorFieldId = model.schema.section_selector_field_id;
      if (selectorFieldId) {
        const selectorField = model.schema.sections
          .flatMap((s) => s.fields)
          .find((f) => f.id === selectorFieldId);
        if (selectorField) {
          const list = records[model.id] ?? [];
          for (const rec of list) {
            const v = rec.data[selectorField.name];
            if (Array.isArray(v) && v.includes(sectionId)) {
              const next = v.filter((x) => x !== sectionId);
              void saveRecord({
                ...rec,
                data: { ...rec.data, [selectorField.name]: next },
                updated_at: new Date().toISOString(),
              });
            }
          }
        }
      }
    }

    // Clear active field if it was in the deleted section
    if (activeField?.sectionId === sectionId) setActiveField(null);
    if (activeSectionId === sectionId) setActiveSectionId(null);
  };

  // -- Field CRUD --
  const selectField = (sectionId: string, field: ModelField) => {
    setActiveField({ sectionId, field });
    setActiveSectionId(sectionId);
  };

  const startNewField = (type: FieldType) => {
    // Skip mirrored sections — they have no local fields.
    const currentActive = activeSectionId ? sections.find((s) => s.id === activeSectionId) : null;
    const fallback = sections.find((s) => !s.is_mirrored);
    const targetSectionId = currentActive && !currentActive.is_mirrored
      ? currentActive.id
      : fallback?.id;
    if (!targetSectionId) return;
    setNewFieldType(type);
    setActiveField({ sectionId: targetSectionId, field: null });
  };

  /**
   * Insert a copy of a saved template into the active (or first non-mirrored) section.
   * Regenerates `id`, `section_id`, `order`, and all option `id`s so the copy is
   * independent of the template and of any other copies. Slug is auto-suffixed
   * if it collides with an existing field on the target section.
   */
  const insertTemplate = (tpl: FieldTemplate) => {
    const currentActive = activeSectionId ? sections.find((s) => s.id === activeSectionId) : null;
    const fallback = sections.find((s) => !s.is_mirrored);
    const targetSection = currentActive && !currentActive.is_mirrored ? currentActive : fallback;
    if (!targetSection) return;

    // Dedupe the slug against the target section's existing field names.
    const existingSlugs = new Set(targetSection.fields.map((f) => f.name));
    let name = tpl.field.name;
    if (existingSlugs.has(name)) {
      let n = 2;
      while (existingSlugs.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }

    const newField: ModelField = {
      ...tpl.field,
      id: uuid(),
      section_id: targetSection.id,
      order: targetSection.fields.length,
      name,
      options: tpl.field.options?.map((o) => ({ ...o, id: uuid() })),
    };

    const updatedSections = model.schema.sections.map((s) =>
      s.id === targetSection.id ? { ...s, fields: [...s.fields, newField] } : s,
    );
    let updated = { ...model, schema: { ...model.schema, sections: updatedSections } };
    if (newField.type === 'section_selector') {
      updated.schema.section_selector_field_id = newField.id;
      updated = updateSectionSelectorOptions(updated);
    }
    onChange(updated);
    // Select the newly inserted field so the user can rename/tweak immediately.
    setActiveField({ sectionId: targetSection.id, field: newField });
    setActiveSectionId(targetSection.id);
  };

  const saveField = (sectionId: string, field: ModelField) => {
    const targetSectionId = field.section_id;
    // Guard: disallow adding/moving fields into a mirrored section.
    const targetSection = model.schema.sections.find((s) => s.id === targetSectionId);
    if (targetSection?.is_mirrored) return;

    const isMoving = targetSectionId !== sectionId;

    const updatedSections = model.schema.sections.map((s) => {
      const withoutField = s.fields.filter((f) => f.id !== field.id);
      if (s.id === targetSectionId) {
        return { ...s, fields: [...withoutField, field] };
      }
      if (isMoving && s.id === sectionId) {
        return { ...s, fields: withoutField };
      }
      if (s.fields.some((f) => f.id === field.id) && s.id !== targetSectionId) {
        return { ...s, fields: withoutField };
      }
      return s;
    });
    let updated = { ...model, schema: { ...model.schema, sections: updatedSections } };
    if (field.type === 'section_selector') {
      updated.schema.section_selector_field_id = field.id;
      updated = updateSectionSelectorOptions(updated);
    }
    onChange(updated);
    // Keep the field selected after save, refresh with saved data
    setActiveField({ sectionId: field.section_id, field });
    setActiveSectionId(field.section_id);
  };

  // Public entry point called by FieldRow's delete button. For model schemas
  // we first count affected records and show a confirm modal if any exist.
  // For role schemas (which don't back records) we bypass the check.
  const deleteField = (sectionId: string, fieldId: string) => {
    const targetSection = model.schema.sections.find((s) => s.id === sectionId);
    if (targetSection?.is_mirrored) return; // Mirrored sections have no local fields to delete.

    const targetField = targetSection?.fields.find((f) => f.id === fieldId);
    if (!targetField) return;

    if (ownerKind === 'model') {
      const recordCount = countRecordsWithFieldData(model.id, targetField.name, records);
      if (recordCount > 0) {
        setDeleteFieldPrompt({ sectionId, field: targetField, recordCount });
        return;
      }
    }
    performDeleteField(sectionId, fieldId);
  };

  // Actually performs the deletion. Reached either directly (no record data)
  // or after the user confirms the data-loss modal.
  const performDeleteField = (sectionId: string, fieldId: string) => {
    const updatedSections = model.schema.sections.map((s) => {
      if (s.id !== sectionId) return s;
      return { ...s, fields: s.fields.filter((f) => f.id !== fieldId) };
    });
    let updated = { ...model, schema: { ...model.schema, sections: updatedSections } };
    if (model.schema.section_selector_field_id === fieldId) {
      updated.schema.section_selector_field_id = null;
    }
    if (model.schema.duplicate_check_field_id === fieldId) {
      updated.schema.duplicate_check_field_id = null;
    }
    onChange(updated);
    // Clear active if deleted field was selected
    if (activeField?.field?.id === fieldId) setActiveField(null);
  };

  const reorderFields = (sectionId: string, oldIndex: number, newIndex: number) => {
    const updatedSections = model.schema.sections.map((s) => {
      if (s.id !== sectionId) return s;
      const sorted = [...s.fields].sort((a, b) => a.order - b.order);
      const reordered = arrayMove(sorted, oldIndex, newIndex).map((f, i) => ({ ...f, order: i }));
      return { ...s, fields: reordered };
    });
    onChange({ ...model, schema: { ...model.schema, sections: updatedSections } });
  };

  // Determine the selected field id for highlighting
  const selectedFieldId = activeField?.field?.id ?? null;

  return (
    <div
      className={`flex flex-col md:flex-row gap-4 h-full ${
        readOnly ? 'pointer-events-none select-none opacity-75' : ''
      }`}
      // For frozen models: aria-disabled hint for assistive tech; the
      // pointer-events-none class blocks every click, drag, and input
      // inside this subtree without removing the schema from the DOM
      // (the user can still read it).
      aria-disabled={readOnly || undefined}
    >
      {/* Left Panel — Field Properties. Desktop: 260px fixed rail.
          Mobile: full-width card above the sections, capped to 60vh so it
          doesn't push the rest of the page offscreen when a field is open. */}
      <div className="w-full md:w-[260px] shrink-0 bg-white rounded-2xl border border-sand/15 overflow-hidden max-h-[60vh] md:max-h-none">
        {activeField ? (
          <FieldEditor
            field={activeField.field}
            sectionId={activeField.sectionId}
            model={model}
            defaultType={newFieldType}
            onSave={(field) => saveField(activeField.sectionId, field)}
            ownerKind={ownerKind}
          />
        ) : (
          <FieldEditorEmpty />
        )}
      </div>

      {/* Center — Sections & Fields */}
      <div className="flex-1 overflow-y-auto md:pe-1">
        {/* Model-level settings — duplicate-check key used by import */}
        <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 rounded-2xl border border-sand/15 bg-white">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-copper/8 flex items-center justify-center shrink-0">
              <Copy size={15} className="text-copper" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-charcoal">
                {isAr ? 'حقل التحقق من التكرار' : 'Duplicate Check Field'}
              </div>
              <div className="text-xs text-charcoal/50">
                {isAr
                  ? 'عند الاستيراد، يتم تجاهل السجلات التي تتطابق قيمتها في هذا الحقل مع سجل موجود.'
                  : 'On import, rows whose value for this field matches an existing record are skipped.'}
              </div>
            </div>
          </div>
          <select
            value={duplicateCheckFieldId}
            onChange={(e) => setDuplicateCheckFieldId(e.target.value)}
            className="form-input text-sm py-1.5 w-full sm:w-[200px] shrink-0"
          >
            <option value="">{isAr ? 'بدون تحقق' : 'No check'}</option>
            {duplicateCheckCandidates.map((f) => (
              <option key={f.id} value={f.id}>
                {isAr ? f.label_ar : f.label_en}
              </option>
            ))}
          </select>
        </div>

        <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-5">
              {sections.map((section) => (
                <SectionCard
                  key={section.id}
                  section={section}
                  language={language}
                  model={model}
                  selectedFieldId={selectedFieldId}
                  onUpdate={(updates) => updateSection(section.id, updates)}
                  onDelete={() => deleteSection(section.id)}
                  onEditField={(field) => selectField(section.id, field)}
                  onDeleteField={(fieldId) => deleteField(section.id, fieldId)}
                  onReorderFields={(oldIdx, newIdx) => reorderFields(section.id, oldIdx, newIdx)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <button
          onClick={() => setShowAddSection(true)}
          className="mt-5 w-full flex items-center justify-center gap-2 px-5 py-4 rounded-2xl border border-dashed border-sand/40 hover:border-copper/40 text-charcoal/25 hover:text-copper transition-all text-sm font-bold hover:bg-copper/[0.02]"
        >
          <Plus size={16} />
          {t('builder.add_section')}
        </button>
      </div>

      {/* Right Panel — two independently collapsible accordion cards. Desktop:
          190px fixed rail. Mobile: full-width cards below the sections so the
          catalogs remain usable without forcing a horizontal scroll. */}
      <div className="w-full md:w-[190px] shrink-0 flex flex-col gap-3 md:overflow-y-auto">
        <div className="bg-white rounded-2xl border border-sand/15 overflow-hidden">
          <FieldTypeCatalog onSelectType={startNewField} />
        </div>
        <div className="bg-white rounded-2xl border border-sand/15 overflow-hidden">
          <FieldTemplateCatalog onSelectTemplate={insertTemplate} />
        </div>
      </div>

      {/* Add Section Modal */}
      <Modal
        open={showAddSection}
        onClose={() => setShowAddSection(false)}
        title={t('builder.add_section')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowAddSection(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={addSection} disabled={!newSectionName.trim()}>
              {t('common.add')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label={isAr ? 'اسم القسم' : 'Section Name'}
            value={newSectionName}
            onChange={(e) => setNewSectionName(e.target.value)}
            required
            dir={isAr ? 'rtl' : 'ltr'}
            placeholder={isAr ? 'مثال: بيانات التواصل' : 'e.g. Contact Details'}
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={newSectionBase}
              onChange={(e) => setNewSectionBase(e.target.checked)}
              className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
            />
            <span className="text-sm font-bold text-charcoal">{t('builder.base_section')}</span>
          </label>
          <div>
            <label className="block text-sm font-bold text-charcoal mb-1">
              {t('builder.section_color')}
            </label>
            <div className="flex gap-2">
              {SECTION_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setNewSectionColor(c)}
                  className={`w-7 h-7 rounded-full border-2 ${
                    c === newSectionColor ? 'border-charcoal scale-110' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* Data-loss confirmation — field deletion with existing record data */}
      <Modal
        open={deleteFieldPrompt !== null}
        onClose={() => setDeleteFieldPrompt(null)}
        title={isAr ? 'تأكيد حذف الحقل' : 'Confirm field deletion'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteFieldPrompt(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!deleteFieldPrompt) return;
                performDeleteField(deleteFieldPrompt.sectionId, deleteFieldPrompt.field.id);
                setDeleteFieldPrompt(null);
              }}
            >
              {isAr ? 'حذف الحقل' : 'Delete field'}
            </Button>
          </>
        }
      >
        {deleteFieldPrompt && (
          <div className="space-y-3 text-sm text-charcoal">
            <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-800">
              {isAr ? (
                <>
                  سيتم حذف الحقل
                  {' '}
                  <b>{deleteFieldPrompt.field.label_ar}</b>
                  {' '}
                  وسيصبح المحتوى المخزن في{' '}
                  <b>{deleteFieldPrompt.recordCount}</b>
                  {' '}
                  سجل غير قابل للوصول.
                </>
              ) : (
                <>
                  Deleting the field <b>{deleteFieldPrompt.field.label_en}</b> will orphan its
                  values in <b>{deleteFieldPrompt.recordCount}</b>{' '}
                  {deleteFieldPrompt.recordCount === 1 ? 'record' : 'records'}. This cannot be
                  undone.
                </>
              )}
            </div>
            <p className="text-charcoal/70">
              {isAr
                ? 'هل أنت متأكد من المتابعة؟'
                : 'Are you sure you want to continue?'}
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}

/**
 * Refresh a section_selector field's options so the section-linked ones match
 * the model's current non-base / non-mirrored sections, while preserving any
 * custom (non-section) options the user has added via the options editor.
 *
 * Section options are marked with `is_section_option: true`; their id + value
 * equal the corresponding section id so the record form's visibility filter
 * (`selectorValue.includes(section.id)`) matches them. Custom options have
 * their own uuid and user-chosen value — they render in the dropdown as normal
 * choices but don't control section visibility.
 */
function updateSectionSelectorOptions(model: AppModel): AppModel {
  const selectorFieldId = model.schema.section_selector_field_id;
  if (!selectorFieldId) return model;

  const nonBaseSections = model.schema.sections.filter((s) => !s.is_base && !s.is_mirrored);
  const sectionOptions: FieldOption[] = nonBaseSections.map((s) => ({
    id: s.id,
    label_ar: s.label_ar,
    label_en: s.label_en,
    value: s.id,
    color: s.color,
    is_section_option: true,
  }));
  // Anything whose value matches a current or historical section id is
  // treated as section-managed. This also migrates legacy options that were
  // auto-generated before `is_section_option` existed — they don't carry the
  // flag but their value is the section id, so we drop them here to avoid
  // duplicate rows (locked section option + lookalike "custom" option).
  const allSectionIds = new Set(model.schema.sections.map((s) => s.id));

  const updatedSections = model.schema.sections.map((section) => ({
    ...section,
    fields: section.fields.map((f) => {
      if (f.id !== selectorFieldId) return f;
      const existing = f.options ?? [];
      const customOptions = existing.filter(
        (o) => !o.is_section_option && !allSectionIds.has(o.value),
      );
      return { ...f, options: [...sectionOptions, ...customOptions] };
    }),
  }));

  return { ...model, schema: { ...model.schema, sections: updatedSections } };
}
