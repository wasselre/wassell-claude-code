import { X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { filterEligibleAssignees } from '@/lib/assigneeEligibility';
import { resolveLookupDisplayValue } from '@/lib/mirrorResolver';
import type { ModelField } from '@/types';

interface FieldValueInputProps {
  field: ModelField | undefined;
  value: unknown;
  onChange: (value: unknown) => void;
  className?: string;
}

/**
 * Data-aware value input for the workflow builder.
 * Renders the actual options/records for dropdown, multiselect, lookup, and checkbox fields.
 * Falls back to a plain text input for free-text/number fields.
 */
export default function FieldValueInput({ field, value, onChange, className = '' }: FieldValueInputProps) {
  const { models, records, users, language } = useAppStore();
  const isAr = language === 'ar';

  const baseClass = `form-input text-sm bg-white ${className}`;

  // No field selected yet — plain text
  if (!field) {
    return (
      <input
        type="text"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className={baseClass}
        placeholder="..."
      />
    );
  }

  switch (field.type) {
    // Dropdown — show actual options as <select> (single value)
    case 'dropdown': {
      const options = field.options ?? [];
      return (
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
        >
          <option value="">— {isAr ? 'اختر قيمة' : 'Select value'} —</option>
          {options.map((opt) => (
            <option key={opt.id} value={opt.value}>
              {isAr ? opt.label_ar : opt.label_en}
            </option>
          ))}
        </select>
      );
    }

    // Multi-select and section_selector both store arrays on the record. Render
    // the same checkbox picker so the static value saved here matches what the
    // record form expects — otherwise the UI renders empty because MultiSelect
    // requires Array.isArray(value) to be true.
    case 'multiselect':
    case 'section_selector': {
      const options = field.options ?? [];
      // Coerce legacy single-string values into an array for display parity.
      const selected = Array.isArray(value)
        ? (value as string[])
        : value ? [String(value)] : [];
      // "Fail loudly" (see CLAUDE.md "Silent Failures"): values stored here that
      // match no current option — e.g. an option whose value drifted (inline-
      // create UUID drift) or was deleted — used to be invisible in this picker
      // (no checkbox renders for them) yet were silently re-saved on every edit,
      // letting orphaned values accumulate. Surface them as removable chips so
      // they can be seen and dropped instead of riding along unnoticed.
      const knownValues = new Set(options.map((o) => o.value));
      const unknownValues = [...new Set(selected.filter((v) => !knownValues.has(v)))];
      return (
        <div className={`space-y-1 ${className}`}>
          <div className="p-2 rounded-xl border border-sand/30 bg-white space-y-1 max-h-32 overflow-y-auto">
            {options.length === 0 && (
              <span className="text-xs text-charcoal/30">{isAr ? 'لا توجد خيارات' : 'No options'}</span>
            )}
            {options.map((opt) => {
              const checked = selected.includes(opt.value);
              return (
                <label key={opt.id} className="flex items-center gap-2 cursor-pointer py-0.5 px-1 rounded hover:bg-cream/50">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = checked
                        ? selected.filter((v) => v !== opt.value)
                        : [...selected, opt.value];
                      onChange(next);
                    }}
                    className="w-3.5 h-3.5 rounded border-sand text-copper focus:ring-copper/30"
                  />
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: opt.color ?? '#6B7280' }}
                  />
                  <span className="text-xs">{isAr ? opt.label_ar : opt.label_en}</span>
                </label>
              );
            })}
          </div>
          {unknownValues.length > 0 && (
            <div className="p-2 rounded-xl border border-red-200 bg-red-50/60 space-y-1.5">
              <span className="block text-[11px] font-bold text-red-600/90">
                {isAr ? '⚠ قيم غير معروفة لا تطابق أي خيار:' : '⚠ Unknown values (match no current option):'}
              </span>
              <div className="flex flex-wrap gap-1">
                {unknownValues.map((val) => (
                  <span
                    key={val}
                    className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-md bg-white text-red-700 border border-red-200"
                  >
                    <span className="font-mono break-all">{val}</span>
                    <button
                      type="button"
                      onClick={() => onChange(selected.filter((v) => v !== val))}
                      className="text-red-400 hover:text-red-700 shrink-0"
                      aria-label={isAr ? 'إزالة القيمة' : 'Remove value'}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    // Lookup — show actual records from the linked model
    case 'lookup': {
      const linkedModelId = field.lookup_model_id;
      const displayField = field.lookup_display_field;
      if (!linkedModelId || !displayField) {
        return (
          <input
            type="text"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className={baseClass}
            placeholder="..."
          />
        );
      }
      const linkedModel = models.find((m) => m.id === linkedModelId);
      const linkedRecords = records[linkedModelId] ?? [];
      return (
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
        >
          <option value="">— {isAr ? 'اختر سجل' : 'Select record'} —</option>
          {linkedRecords.map((rec) => {
            const display = resolveLookupDisplayValue(rec, displayField, {
              targetModel: linkedModel,
              allModels: models,
              allRecords: records,
            });
            return (
              <option key={rec.id} value={rec.id}>
                {display ? String(display) : rec.id.slice(0, 8)}
              </option>
            );
          })}
          {linkedRecords.length === 0 && linkedModel && (
            <option disabled>
              ({isAr ? `لا توجد سجلات في ${linkedModel.label_ar}` : `No records in ${linkedModel.label_en}`})
            </option>
          )}
        </select>
      );
    }

    // Checkbox — Yes/No select
    case 'checkbox':
      return (
        <select
          value={value === true ? 'true' : value === false ? 'false' : ''}
          onChange={(e) => {
            if (e.target.value === 'true') onChange(true);
            else if (e.target.value === 'false') onChange(false);
            else onChange('');
          }}
          className={baseClass}
        >
          <option value="">—</option>
          <option value="true">{isAr ? 'نعم' : 'Yes'}</option>
          <option value="false">{isAr ? 'لا' : 'No'}</option>
        </select>
      );

    // Number / Currency — number input
    case 'number':
    case 'currency':
      return (
        <input
          type="number"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}
          className={baseClass}
          placeholder={field.type === 'currency' ? (isAr ? 'ر.س' : 'SAR') : '0'}
        />
      );

    // Date / DateTime
    case 'date':
      return (
        <input
          type="date"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
        />
      );

    case 'datetime':
      return (
        <input
          type="datetime-local"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
        />
      );

    // Assignee — show users filtered by the field's role + profile constraints
    case 'assignee': {
      const eligibleUsers = filterEligibleAssignees(field, users);
      return (
        <select
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
        >
          <option value="">— {isAr ? 'اختر مستخدم' : 'Select user'} —</option>
          {eligibleUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {isAr ? u.name_ar : u.name_en} ({u.email})
            </option>
          ))}
          {eligibleUsers.length === 0 && (
            <option disabled>({isAr ? 'لا يوجد أعضاء مؤهلون' : 'No eligible members'})</option>
          )}
        </select>
      );
    }

    // Free text fields — plain input
    default:
      return (
        <input
          type="text"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
          placeholder="..."
        />
      );
  }
}
