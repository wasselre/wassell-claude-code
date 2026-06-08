import { createPortal } from 'react-dom';
import { Copy, Pencil, ArrowUpRight } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppModel, ModelField } from '@/types';
import type { DuplicateMatch } from '../utils/findDuplicateRecord';

interface Props {
  model: AppModel;
  match: DuplicateMatch;
  /** Dismiss the modal and stay on the form so the user can fix the value. */
  onEdit: () => void;
  /** Abandon the new draft and open the colliding record. */
  onOpenExisting: () => void;
}

/** First `auto_id` field on the model, used to show the existing record's code (e.g. ع240). */
function autoIdField(model: AppModel): ModelField | undefined {
  return model.schema.sections
    .filter((s) => !s.is_mirrored)
    .flatMap((s) => s.fields)
    .find((f) => f.type === 'auto_id');
}

/**
 * Shown when a user tries to create a record whose duplicate-check value
 * (e.g. phone) already exists on another record. Offers two ways out — fix the
 * value, or open the existing record — never a silent "create anyway", so the
 * duplicate-check field actually prevents duplicates on the form path the way
 * it already does on import.
 */
export default function DuplicateWarningModal({ model, match, onEdit, onOpenExisting }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');

  const fieldLabel = isAr ? match.field.label_ar : match.field.label_en;
  const modelLabel = isAr ? model.label_ar : model.label_en;

  // Identity of the colliding record: its card title + auto-id code, if any.
  const titleFieldId = model.card_config?.title_field_id ?? null;
  const titleField = titleFieldId
    ? model.schema.sections.flatMap((s) => s.fields).find((f) => f.id === titleFieldId)
    : undefined;
  const titleVal = titleField ? match.record.data[titleField.name] : undefined;
  const title = typeof titleVal === 'string' && titleVal.trim() ? titleVal : null;

  const codeField = autoIdField(model);
  const codeVal = codeField ? match.record.data[codeField.name] : undefined;
  const code = codeVal === null || codeVal === undefined || codeVal === '' ? null : String(codeVal);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onEdit();
      }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-sand/20">
          <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
            <Copy size={16} />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-chocolate">
              {isAr ? 'قيمة مكررة' : 'Duplicate value'}
            </h2>
            <p className="text-xs text-charcoal/55">
              {isAr
                ? `يوجد بالفعل سجل بنفس ${fieldLabel}.`
                : `A record with the same ${fieldLabel} already exists.`}
            </p>
          </div>
        </div>

        {/* Body — the existing record + the colliding value */}
        <div className="px-5 py-4 space-y-3">
          <div className="rounded-xl border border-sand/25 bg-cream/40 px-3.5 py-3">
            <div className="text-[11px] font-bold uppercase tracking-wide text-charcoal/40 mb-1.5">
              {isAr ? 'السجل الموجود' : 'Existing record'}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {code && (
                <span className="font-mono font-bold text-copper text-sm" dir="ltr">
                  {code}
                </span>
              )}
              {title && <span className="font-semibold text-sm text-charcoal truncate">{title}</span>}
              {!code && !title && (
                <span className="text-sm text-charcoal/50">{modelLabel}</span>
              )}
            </div>
            <div className="mt-1.5 text-xs text-charcoal/60">
              <span className="text-charcoal/40">{fieldLabel}: </span>
              <span className="font-mono" dir="ltr">{match.existingValue}</span>
            </div>
          </div>

          <p className="text-xs text-charcoal/55 leading-relaxed">
            {isAr
              ? 'يمكنك تعديل القيمة المكررة في هذا النموذج، أو فتح السجل الموجود بدلاً من إنشاء سجل جديد.'
              : 'Edit the duplicate value on this form, or open the existing record instead of creating a new one.'}
          </p>
        </div>

        {/* Footer — two ways out, never a silent "create anyway" */}
        <div className="flex gap-2 justify-end px-5 py-4 border-t border-sand/20">
          <button type="button" onClick={onEdit} className="btn-secondary inline-flex items-center gap-1.5">
            <Pencil size={14} />
            {isAr ? 'تعديل القيمة' : 'Edit value'}
          </button>
          <button type="button" onClick={onOpenExisting} className="btn-primary inline-flex items-center gap-1.5">
            <ArrowUpRight size={14} />
            {isAr ? 'فتح السجل الموجود' : 'Open existing record'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
