import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import type { PresentationTemplate, PresentationInput, AppRecord, AppModel } from '@/types';

// (selectedRecord memo removed — resolveDefaultValue is called with the fresh
// record directly in onRecordChange, so we don't need the intermediate var.)

interface InputFormProps {
  template: PresentationTemplate;
  /** When the template is record-bound and a record has already been chosen
   *  (e.g. the form was opened from a record page), pre-select it and hide
   *  the record picker. */
  lockedRecordId?: string | null;
  /** Fires after a successful queue. */
  onSubmit: (args: {
    templateId: string;
    recordId: string | null;
    inputs: Record<string, unknown>;
  }) => Promise<void> | void;
  onCancel?: () => void;
  submitting?: boolean;
}

function fieldValueToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '';
  return '';
}

function resolveDefaultValue(
  input: PresentationInput,
  record: AppRecord | null,
): string {
  if (input.source === 'record_field' && input.record_field && record) {
    return fieldValueToString(record.data[input.record_field]);
  }
  if (input.default_value !== undefined) return String(input.default_value);
  return '';
}

export default function InputForm({
  template,
  lockedRecordId,
  onSubmit,
  onCancel,
  submitting = false,
}: InputFormProps) {
  const { t } = useTranslation();
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';

  const boundModel: AppModel | null = useMemo(() => {
    if (!template.record_binding) return null;
    return models.find((m) => m.name === template.record_binding!.model_slug) ?? null;
  }, [template, models]);

  const boundRecords: AppRecord[] = useMemo(() => {
    if (!boundModel) return [];
    return records[boundModel.id] ?? [];
  }, [boundModel, records]);

  const [recordId, setRecordId] = useState<string | null>(lockedRecordId ?? null);

  // Form values keyed by input name. Initialize from defaults + record.
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const input of template.input_schema) {
      seed[input.name] = resolveDefaultValue(input, null);
    }
    return seed;
  });

  // When the user picks a different record, refresh any `record_field` inputs
  // that the user hasn't manually edited yet. We track touched-by-user keys
  // so we don't clobber typed content.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const onRecordChange = (id: string | null): void => {
    setRecordId(id);
    const pickedRecord = id && boundModel
      ? (records[boundModel.id] ?? []).find((r) => r.id === id) ?? null
      : null;
    setValues((prev) => {
      const next = { ...prev };
      for (const input of template.input_schema) {
        if (input.source !== 'record_field') continue;
        if (touched[input.name]) continue;
        next[input.name] = resolveDefaultValue(input, pickedRecord);
      }
      return next;
    });
  };

  const setValue = (name: string, value: string): void => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setTouched((prev) => ({ ...prev, [name]: true }));
  };

  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    for (const input of template.input_schema) {
      if (!input.required) continue;
      const v = values[input.name];
      if (!v || String(v).trim() === '') {
        next[input.name] = isAr ? 'هذا الحقل مطلوب' : 'Required';
      }
    }
    if (
      template.record_binding &&
      !template.record_binding.optional &&
      !recordId
    ) {
      next['__record__'] = isAr ? 'اختر سجلاً' : 'Pick a record';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (): Promise<void> => {
    if (!validate()) return;
    // Coerce numbers; everything else stays string.
    const payload: Record<string, unknown> = {};
    for (const input of template.input_schema) {
      const raw = values[input.name] ?? '';
      if (input.type === 'number') {
        const n = Number(raw);
        payload[input.name] = Number.isFinite(n) ? n : raw;
      } else {
        payload[input.name] = raw;
      }
    }
    await onSubmit({
      templateId: template.id,
      recordId: recordId ?? null,
      inputs: payload,
    });
  };

  const recordLabel = (rec: AppRecord): string => {
    const untitled = isAr ? 'بدون اسم' : '(Untitled)';
    if (!boundModel) return untitled;
    const allFields = boundModel.schema.sections.flatMap((s) => s.fields);
    const titleId = boundModel.card_config.title_field_id;
    const titleField = titleId ? allFields.find((f) => f.id === titleId) ?? null : null;
    const readStr = (slug: string): string | null => {
      const v = rec.data[slug];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number') return String(v);
      return null;
    };
    if (titleField) {
      const v = readStr(titleField.name);
      if (v !== null) return v;
    }
    // card_config.title_field_id may dangle (field deleted after card_config
    // was saved) or the title field's value may be empty. Fall back to the
    // first TEXT/TEXTAREA field with content — those are user-typed strings,
    // never UUIDs. Explicitly skip lookup / mirror / auto_id / section_mirror
    // which all store UUID-like identifiers that look readable but aren't.
    for (const f of allFields) {
      if (f.type !== 'text' && f.type !== 'textarea') continue;
      const v = readStr(f.name);
      if (v !== null) return v;
    }
    return untitled;
  };

  return (
    <div className="space-y-5">
      {/* Record picker — only when the template is record-bound AND no record is locked */}
      {boundModel && !lockedRecordId && (
        <div className="space-y-1">
          <label className="block text-sm font-bold text-charcoal">
            {isAr ? 'السجل المرتبط' : 'Linked record'}
            {!template.record_binding?.optional && (
              <span className="text-red-500 ms-1">*</span>
            )}
          </label>
          <select
            value={recordId ?? ''}
            onChange={(e) => onRecordChange(e.target.value || null)}
            className={`form-input ${errors['__record__'] ? 'border-red-400' : ''}`}
          >
            <option value="">
              {isAr
                ? `— اختر من ${boundModel.label_ar} —`
                : `— pick from ${boundModel.label_en} —`}
            </option>
            {boundRecords.map((rec) => (
              <option key={rec.id} value={rec.id}>
                {recordLabel(rec)}
              </option>
            ))}
          </select>
          {errors['__record__'] && <p className="text-xs text-red-500">{errors['__record__']}</p>}
          <p className="text-xs text-charcoal/40">
            {isAr
              ? 'سيتم تضمين بيانات هذا السجل كمرجع عند إنشاء العرض.'
              : 'This record is attached as context when the deck is generated.'}
          </p>
        </div>
      )}

      {/* Input fields from the template schema */}
      {template.input_schema.map((input) => {
        const label = isAr ? input.label_ar : input.label_en;
        const placeholder = isAr ? input.placeholder_ar : input.placeholder_en;
        const error = errors[input.name];
        const value = values[input.name] ?? '';

        if (input.type === 'textarea') {
          return (
            <div key={input.name} className="space-y-1">
              <label className="block text-sm font-bold text-charcoal">
                {label}
                {input.required && <span className="text-red-500 ms-1">*</span>}
              </label>
              <textarea
                value={value}
                onChange={(e) => setValue(input.name, e.target.value)}
                placeholder={placeholder}
                rows={8}
                className={`form-input resize-y ${error ? 'border-red-400' : ''}`}
              />
              {error && <p className="text-xs text-red-500">{error}</p>}
            </div>
          );
        }

        if (input.type === 'dropdown') {
          return (
            <div key={input.name} className="space-y-1">
              <label className="block text-sm font-bold text-charcoal">
                {label}
                {input.required && <span className="text-red-500 ms-1">*</span>}
              </label>
              <select
                value={value}
                onChange={(e) => setValue(input.name, e.target.value)}
                className={`form-input ${error ? 'border-red-400' : ''}`}
              >
                <option value="">—</option>
                {(input.options ?? []).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {isAr ? opt.label_ar : opt.label_en}
                  </option>
                ))}
              </select>
              {error && <p className="text-xs text-red-500">{error}</p>}
            </div>
          );
        }

        return (
          <Input
            key={input.name}
            label={label}
            required={input.required}
            type={input.type === 'number' ? 'number' : input.type === 'date' ? 'date' : 'text'}
            value={value}
            onChange={(e) => setValue(input.name, e.target.value)}
            placeholder={placeholder}
            error={error}
          />
        );
      })}

      <div className="flex items-center justify-end gap-2 pt-2">
        {onCancel && (
          <Button variant="ghost" type="button" onClick={onCancel} disabled={submitting}>
            {t('common.cancel')}
          </Button>
        )}
        <Button onClick={() => void handleSubmit()} disabled={submitting}>
          {submitting
            ? isAr ? 'جاري الإرسال...' : 'Queueing...'
            : isAr ? 'إنشاء العرض' : 'Generate deck'}
        </Button>
      </div>
    </div>
  );
}
