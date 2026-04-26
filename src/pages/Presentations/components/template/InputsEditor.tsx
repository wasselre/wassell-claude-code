import { useMemo } from 'react';
import {
  Trash2, Plus, ArrowUp, ArrowDown, X, GripVertical,
} from 'lucide-react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { slugify } from '@/lib/autoTranslate';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import type {
  PresentationInput,
  PresentationInputType,
  PresentationInputDropdownOption,
  PresentationRecordBinding,
} from '@/types';

/**
 * Editor for `template.input_schema`. Each input is a card with inline
 * fields. Reorder via up/down buttons (drag-to-reorder is a follow-up
 * polish; up/down is accessible and good enough for the typical 1–5
 * inputs on a template).
 *
 * Source = 'record_field' is only meaningful when the template has a
 * `record_binding` set. We hide that source option otherwise, and when
 * present we render a dropdown of the bound model's field slugs so the
 * author can't typo a field name.
 */
interface InputsEditorProps {
  inputs: PresentationInput[];
  recordBinding: PresentationRecordBinding | null;
  onChange: (inputs: PresentationInput[]) => void;
  readonly?: boolean;
}

const INPUT_TYPES: PresentationInputType[] = ['text', 'textarea', 'number', 'date', 'dropdown'];

const TYPE_LABELS: Record<PresentationInputType, { en: string; ar: string }> = {
  text: { en: 'Short text', ar: 'نص قصير' },
  textarea: { en: 'Long text', ar: 'نص طويل' },
  number: { en: 'Number', ar: 'رقم' },
  date: { en: 'Date', ar: 'تاريخ' },
  dropdown: { en: 'Dropdown', ar: 'قائمة منسدلة' },
};

export default function InputsEditor({
  inputs,
  recordBinding,
  onChange,
  readonly,
}: InputsEditorProps): JSX.Element {
  const { models, language } = useAppStore();
  const isAr = language === 'ar';

  // Resolve the bound model's fields once — we use them as options for the
  // record_field dropdown, so the author picks from a real list instead of
  // typing a slug from memory.
  const boundModelFields = useMemo(() => {
    if (!recordBinding) return [];
    const model = models.find((m) => m.name === recordBinding.model_slug);
    if (!model) return [];
    return model.schema.sections.flatMap((s) => s.fields).map((f) => ({
      slug: f.name,
      label_en: f.label_en,
      label_ar: f.label_ar,
    }));
  }, [models, recordBinding]);

  const patchInput = (idx: number, patch: Partial<PresentationInput>): void => {
    const next = inputs.map((inp, i) => (i === idx ? { ...inp, ...patch } : inp));
    onChange(next);
  };

  const removeInput = (idx: number): void => {
    onChange(inputs.filter((_, i) => i !== idx));
  };

  const moveInput = (idx: number, delta: -1 | 1): void => {
    const target = idx + delta;
    if (target < 0 || target >= inputs.length) return;
    const next = [...inputs];
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    onChange(next);
  };

  const addInput = (): void => {
    const labelEn = `Input ${inputs.length + 1}`;
    onChange([
      ...inputs,
      {
        name: slugify(`input_${inputs.length + 1}`),
        label_ar: `مدخل ${inputs.length + 1}`,
        label_en: labelEn,
        type: 'text',
        required: false,
        source: 'user',
      },
    ]);
  };

  // Hooks must run regardless of inputs.length — keep ALL hooks above any
  // early return. dnd-kit needs a stable id per item; slugs are unique
  // within a template so prefix with `input:` to avoid collisions with
  // other dnd contexts.
  const sortableIds = useMemo(() => inputs.map((i) => `input:${i.name}`), [inputs]);

  const handleDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const fromIdx = sortableIds.indexOf(String(active.id));
    const toIdx = sortableIds.indexOf(String(over.id));
    if (fromIdx === -1 || toIdx === -1) return;
    onChange(arrayMove(inputs, fromIdx, toIdx));
  };

  if (inputs.length === 0) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-dashed border-sand/60 bg-cream/20 p-6 text-center text-sm text-charcoal/50">
          {isAr
            ? 'لا توجد مدخلات بعد. اضغط "إضافة مدخل" لبدء تعريف ما يملؤه المستخدم عند إنشاء عرض.'
            : 'No inputs yet. Click "Add input" to define what the user fills in when generating a deck.'}
        </div>
        {!readonly && (
          <Button variant="ghost" onClick={addInput}>
            <Plus size={14} />
            {isAr ? 'إضافة مدخل' : 'Add input'}
          </Button>
        )}
      </div>
    );
  }

  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div className="space-y-3">
          {inputs.map((input, idx) => (
            <InputCard
              key={`input:${input.name}`}
              dndId={`input:${input.name}`}
              input={input}
              idx={idx}
              total={inputs.length}
              isAr={isAr}
              recordBinding={recordBinding}
              boundModelFields={boundModelFields}
              readonly={readonly}
              onPatch={(patch) => patchInput(idx, patch)}
              onRemove={() => removeInput(idx)}
              onMove={(d) => moveInput(idx, d)}
            />
          ))}
          {!readonly && (
            <Button variant="ghost" onClick={addInput}>
              <Plus size={14} />
              {isAr ? 'إضافة مدخل' : 'Add input'}
            </Button>
          )}
        </div>
      </SortableContext>
    </DndContext>
  );
}

interface InputCardProps {
  dndId: string;
  input: PresentationInput;
  idx: number;
  total: number;
  isAr: boolean;
  recordBinding: PresentationRecordBinding | null;
  boundModelFields: Array<{ slug: string; label_en: string; label_ar: string }>;
  readonly?: boolean;
  onPatch: (patch: Partial<PresentationInput>) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
}

function InputCard({
  dndId,
  input,
  idx,
  total,
  isAr,
  recordBinding,
  boundModelFields,
  readonly,
  onPatch,
  onRemove,
  onMove,
}: InputCardProps): JSX.Element {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: dndId, disabled: readonly });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border border-sand/40 bg-white p-4 ${isDragging ? 'shadow-lg' : ''}`}
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 text-xs font-bold text-charcoal/50">
          {!readonly && (
            <button
              type="button"
              {...attributes}
              {...listeners}
              className="p-1 rounded hover:bg-cream/40 text-charcoal/40 cursor-grab active:cursor-grabbing touch-none"
              title={isAr ? 'سحب لإعادة الترتيب' : 'Drag to reorder'}
              aria-label={isAr ? 'سحب لإعادة الترتيب' : 'Drag to reorder'}
            >
              <GripVertical size={14} />
            </button>
          )}
          <span>#{idx + 1}</span>
          <span className="font-mono">·</span>
          <span className="font-mono">{input.name || '(no slug)'}</span>
        </div>
        {!readonly && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onMove(-1)}
              disabled={idx === 0}
              className="p-1 rounded hover:bg-cream/40 text-charcoal/50 disabled:opacity-30 disabled:cursor-not-allowed"
              title={isAr ? 'تحريك للأعلى' : 'Move up'}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              onClick={() => onMove(1)}
              disabled={idx === total - 1}
              className="p-1 rounded hover:bg-cream/40 text-charcoal/50 disabled:opacity-30 disabled:cursor-not-allowed"
              title={isAr ? 'تحريك للأسفل' : 'Move down'}
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="p-1 rounded hover:bg-red-50 text-charcoal/50 hover:text-red-600"
              title={isAr ? 'حذف' : 'Delete'}
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FieldLabel text={isAr ? 'الاسم (عربي)' : 'Name (Arabic)'} required>
          <input
            type="text"
            value={input.label_ar}
            onChange={(e) => onPatch({ label_ar: e.target.value })}
            disabled={readonly}
            dir="rtl"
            className="form-input text-sm"
          />
        </FieldLabel>
        <FieldLabel text={isAr ? 'الاسم (إنجليزي)' : 'Name (English)'} required>
          <input
            type="text"
            value={input.label_en}
            onChange={(e) => onPatch({ label_en: e.target.value })}
            disabled={readonly}
            dir="ltr"
            className="form-input text-sm"
          />
        </FieldLabel>
        <FieldLabel
          text={isAr ? 'الرمز (slug)' : 'Slug'}
          hint={isAr ? 'snake_case، فريد' : 'snake_case, unique'}
        >
          <input
            type="text"
            value={input.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            disabled={readonly}
            dir="ltr"
            className="form-input text-sm font-mono"
          />
        </FieldLabel>
        <FieldLabel text={isAr ? 'النوع' : 'Type'}>
          <select
            value={input.type}
            onChange={(e) => {
              const newType = e.target.value as PresentationInputType;
              onPatch({
                type: newType,
                // Initialize options when switching INTO dropdown; clear on switch out.
                options: newType === 'dropdown' ? input.options ?? [] : undefined,
              });
            }}
            disabled={readonly}
            className="form-input text-sm"
          >
            {INPUT_TYPES.map((t) => (
              <option key={t} value={t}>
                {isAr ? TYPE_LABELS[t].ar : TYPE_LABELS[t].en}
              </option>
            ))}
          </select>
        </FieldLabel>
        <FieldLabel text={isAr ? 'مصدر القيمة' : 'Value source'}>
          <select
            value={input.source}
            onChange={(e) =>
              onPatch({
                source: e.target.value as 'user' | 'record_field',
                record_field: e.target.value === 'user' ? undefined : input.record_field,
              })
            }
            disabled={readonly}
            className="form-input text-sm"
          >
            <option value="user">{isAr ? 'يكتبه المستخدم' : 'User types it'}</option>
            {recordBinding && (
              <option value="record_field">
                {isAr ? 'حقل من السجل المرتبط' : 'Field from bound record'}
              </option>
            )}
          </select>
        </FieldLabel>
        <FieldLabel text={isAr ? 'مطلوب' : 'Required'}>
          <label className="inline-flex items-center gap-2 cursor-pointer pt-2">
            <input
              type="checkbox"
              checked={input.required}
              onChange={(e) => onPatch({ required: e.target.checked })}
              disabled={readonly}
              className="w-4 h-4"
            />
            <span className="text-xs text-charcoal/60">
              {isAr ? 'لا يمكن ترك هذا فارغاً' : 'User must fill this in'}
            </span>
          </label>
        </FieldLabel>
        {input.source === 'record_field' && recordBinding && (
          <FieldLabel
            text={isAr ? 'الحقل المصدر' : 'Source field'}
            hint={isAr
              ? `سيتم تعبئة هذا المدخل من حقل في ${recordBinding.model_slug}`
              : `Pre-filled from a field on ${recordBinding.model_slug}`}
            full
          >
            {boundModelFields.length === 0 ? (
              <input
                type="text"
                value={input.record_field ?? ''}
                onChange={(e) => onPatch({ record_field: e.target.value })}
                disabled={readonly}
                placeholder={isAr ? 'الرمز اليدوي للحقل' : 'Manual field slug'}
                className="form-input text-sm font-mono"
                dir="ltr"
              />
            ) : (
              <select
                value={input.record_field ?? ''}
                onChange={(e) => onPatch({ record_field: e.target.value || undefined })}
                disabled={readonly}
                className="form-input text-sm"
              >
                <option value="">{isAr ? '— اختر حقلاً —' : '— pick a field —'}</option>
                {boundModelFields.map((f) => (
                  <option key={f.slug} value={f.slug}>
                    {isAr ? f.label_ar : f.label_en} ({f.slug})
                  </option>
                ))}
              </select>
            )}
          </FieldLabel>
        )}
        <FieldLabel
          text={isAr ? 'العنصر النائب (عربي)' : 'Placeholder (Arabic)'}
          hint={isAr ? 'يظهر في الحقل قبل الكتابة' : 'Shown in the empty field as a hint'}
          full
        >
          <input
            type="text"
            value={input.placeholder_ar ?? ''}
            onChange={(e) =>
              onPatch({ placeholder_ar: e.target.value === '' ? undefined : e.target.value })
            }
            disabled={readonly}
            dir="rtl"
            className="form-input text-sm"
          />
        </FieldLabel>
        <FieldLabel
          text={isAr ? 'العنصر النائب (إنجليزي)' : 'Placeholder (English)'}
          full
        >
          <input
            type="text"
            value={input.placeholder_en ?? ''}
            onChange={(e) =>
              onPatch({ placeholder_en: e.target.value === '' ? undefined : e.target.value })
            }
            disabled={readonly}
            dir="ltr"
            className="form-input text-sm"
          />
        </FieldLabel>
      </div>

      {input.type === 'dropdown' && (
        <DropdownOptionsEditor
          options={input.options ?? []}
          isAr={isAr}
          readonly={readonly}
          onChange={(options) => onPatch({ options })}
        />
      )}
    </div>
  );
}

function DropdownOptionsEditor({
  options,
  isAr,
  readonly,
  onChange,
}: {
  options: PresentationInputDropdownOption[];
  isAr: boolean;
  readonly?: boolean;
  onChange: (options: PresentationInputDropdownOption[]) => void;
}): JSX.Element {
  const patch = (idx: number, p: Partial<PresentationInputDropdownOption>): void => {
    onChange(options.map((o, i) => (i === idx ? { ...o, ...p } : o)));
  };
  const add = (): void => {
    onChange([
      ...options,
      { value: `option_${options.length + 1}`, label_ar: '', label_en: '' },
    ]);
  };
  const remove = (idx: number): void => onChange(options.filter((_, i) => i !== idx));

  return (
    <div className="mt-3 pt-3 border-t border-sand/30">
      <div className="text-xs font-bold text-charcoal/60 mb-2">
        {isAr ? 'خيارات القائمة المنسدلة' : 'Dropdown options'}
      </div>
      <div className="space-y-2">
        {options.map((opt, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <input
              type="text"
              value={opt.value}
              onChange={(e) => patch(idx, { value: e.target.value })}
              disabled={readonly}
              placeholder={isAr ? 'القيمة' : 'value'}
              dir="ltr"
              className="form-input text-xs font-mono w-32"
            />
            <input
              type="text"
              value={opt.label_ar}
              onChange={(e) => patch(idx, { label_ar: e.target.value })}
              disabled={readonly}
              placeholder={isAr ? 'العنوان (عربي)' : 'Label (Arabic)'}
              dir="rtl"
              className="form-input text-xs flex-1"
            />
            <input
              type="text"
              value={opt.label_en}
              onChange={(e) => patch(idx, { label_en: e.target.value })}
              disabled={readonly}
              placeholder={isAr ? 'العنوان (إنجليزي)' : 'Label (English)'}
              dir="ltr"
              className="form-input text-xs flex-1"
            />
            {!readonly && (
              <button
                type="button"
                onClick={() => remove(idx)}
                className="p-1 rounded hover:bg-red-50 text-charcoal/50 hover:text-red-600 shrink-0"
                title={isAr ? 'حذف' : 'Remove'}
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      {!readonly && (
        <button
          type="button"
          onClick={add}
          className="mt-2 inline-flex items-center gap-1 text-xs text-copper hover:text-terracotta"
        >
          <Plus size={12} />
          {isAr ? 'إضافة خيار' : 'Add option'}
        </button>
      )}
    </div>
  );
}

function FieldLabel({
  text,
  hint,
  required,
  full,
  children,
}: {
  text: string;
  hint?: string;
  required?: boolean;
  full?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <label className="block text-[10px] font-bold text-charcoal/60 uppercase tracking-wide mb-1">
        {text}
        {required && <span className="text-red-500 ms-1">*</span>}
      </label>
      {children}
      {hint && <p className="text-[10px] text-charcoal/40 mt-0.5">{hint}</p>}
    </div>
  );
}

export type { InputsEditorProps };
