import { useAppStore } from '@/stores/appStore';
import { filterEligibleAssignees } from '@/lib/assigneeEligibility';
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
      return (
        <div className={`p-2 rounded-xl border border-sand/30 bg-white space-y-1 max-h-32 overflow-y-auto ${className}`}>
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
            const display = rec.data[displayField];
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
