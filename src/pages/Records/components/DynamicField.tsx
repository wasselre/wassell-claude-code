import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { ExternalLink, Fingerprint, Calculator } from 'lucide-react';
import DropdownSelect from './DropdownSelect';
import MultiSelect from './MultiSelect';
import LookupCombobox from './LookupCombobox';
import PhoneInput from './PhoneInput';
import DynamicCell from './DynamicCell';
import NotesField from './NotesField';
import RangeField from './RangeField';
import TableField from './TableField';
import { resolveMirror } from '@/lib/mirrorResolver';
import { evaluateFormulaInModel, formatFormulaValue, isFormulaErrorValue } from '@/lib/formulaEngine';
import type { FieldOption, ModelField } from '@/types';

// Rotating palette used when the user inline-creates a new dropdown /
// multiselect option from the record form. Matches the palette the Builder's
// OptionsEditor uses when adding options manually.
const INLINE_OPTION_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899',
  '#06B6D4', '#84CC16', '#F97316', '#6366F1',
];

interface DynamicFieldProps {
  field: ModelField;
  value: unknown;
  onChange: (value: unknown) => void;
  recordData?: Record<string, unknown>;
  /**
   * When true, render only the input (no label, no placeholder, no required asterisk).
   * Used in table-like renderers (e.g. the research comparison table) where the
   * column header already carries the field title and repeating it per row is noise.
   */
  compact?: boolean;
}

export default function DynamicField({ field, value, onChange, recordData, compact }: DynamicFieldProps) {
  const { t } = useTranslation();
  const { language, models, records, saveModel } = useAppStore();
  const isAr = language === 'ar';

  /**
   * Inline-create a new dropdown / multiselect option for this field. Appends
   * a fresh `FieldOption` to the field inside its parent model's schema,
   * persists via `saveModel`, and returns the new option's `value` so the
   * picker can select it. `section_selector` fields are intentionally not
   * wired to this path because their options carry section-id semantics.
   */
  const createOptionOnField = (label: string): string => {
    const owningModel = models.find((m) =>
      m.schema.sections.some((s) => s.fields.some((f) => f.id === field.id)),
    );
    if (!owningModel) return '';
    const existing = field.options ?? [];
    const newOption: FieldOption = {
      id: uuid(),
      label_ar: label,
      label_en: label,
      value: uuid(),
      color: INLINE_OPTION_COLORS[existing.length % INLINE_OPTION_COLORS.length],
    };
    const updatedModel = {
      ...owningModel,
      schema: {
        ...owningModel.schema,
        sections: owningModel.schema.sections.map((sec) => ({
          ...sec,
          fields: sec.fields.map((f) =>
            f.id === field.id ? { ...f, options: [...existing, newOption] } : f,
          ),
        })),
      },
    };
    saveModel(updatedModel);
    return newOption.value;
  };
  const label = isAr ? field.label_ar : field.label_en;
  // In compact mode the column header already shows the field title — strip
  // placeholders so empty cells don't echo the same label on every row.
  const placeholder = compact ? '' : label;

  const renderInput = () => {
    switch (field.type) {
      case 'text':
        return (
          <input
            type="text"
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
            className="form-input"
            placeholder={placeholder}
          />
        );

      case 'textarea':
        return (
          <textarea
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
            className="form-input"
            rows={3}
            placeholder={placeholder}
          />
        );

      case 'notes':
        return <NotesField value={value} onChange={onChange} />;

      case 'range':
        return <RangeField field={field} value={value} onChange={onChange} />;

      case 'table':
        return <TableField field={field} value={value} onChange={onChange} />;

      case 'number':
        return (
          <input
            type="number"
            value={(value as number) ?? ''}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
            className="form-input"
            placeholder={placeholder}
          />
        );

      case 'email':
        return (
          <input
            type="email"
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
            className="form-input"
            placeholder={placeholder}
            dir="ltr"
          />
        );

      case 'phone':
        return (
          <PhoneInput
            value={value as string | null | undefined}
            onChange={onChange}
            defaultCountryCode={field.default_country_code}
            placeholder={placeholder || undefined}
          />
        );

      case 'date':
        return (
          <input
            type="date"
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
            className="form-input"
          />
        );

      case 'datetime':
        return (
          <input
            type="datetime-local"
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
            className="form-input"
          />
        );

      case 'currency':
        return (
          <div className="relative">
            <input
              type="number"
              value={(value as number) ?? ''}
              onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
              className="form-input pe-14"
              placeholder="0"
            />
            <span className="absolute end-3 top-1/2 -translate-y-1/2 text-sm text-charcoal/40 font-bold">
              {t('records.currency_sar')}
            </span>
          </div>
        );

      case 'url':
        return (
          <div className="relative">
            <input
              type="url"
              value={(value as string) ?? ''}
              onChange={(e) => onChange(e.target.value)}
              className="form-input pe-10"
              placeholder="https://..."
              dir="ltr"
            />
            {typeof value === 'string' && value && (
              <a
                href={value as string}
                target="_blank"
                rel="noopener noreferrer"
                className="absolute end-3 top-1/2 -translate-y-1/2 text-copper hover:text-terracotta"
              >
                <ExternalLink size={14} />
              </a>
            )}
          </div>
        );

      case 'checkbox':
        return (
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={!!value}
              onChange={(e) => onChange(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-sand/50 peer-focus:ring-2 peer-focus:ring-copper/30 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-copper" />
          </label>
        );

      case 'dropdown':
        return (
          <DropdownSelect
            options={field.options ?? []}
            groups={field.option_groups}
            value={(value as string) ?? undefined}
            onChange={onChange}
            placeholder={placeholder}
            onCreateOption={createOptionOnField}
          />
        );

      case 'multiselect':
        return (
          <MultiSelect
            options={field.options ?? []}
            groups={field.option_groups}
            value={Array.isArray(value) ? (value as string[]) : []}
            onChange={onChange}
            placeholder={placeholder}
            onCreateOption={createOptionOnField}
          />
        );

      case 'section_selector':
        return (
          <MultiSelect
            options={field.options ?? []}
            groups={field.option_groups}
            value={Array.isArray(value) ? (value as string[]) : []}
            onChange={onChange}
            placeholder={placeholder}
          />
        );

      case 'lookup':
        if (!field.lookup_model_id || !field.lookup_display_field) {
          return <div className="text-sm text-red-400">{isAr ? 'لم يتم إعداد الربط' : 'Lookup not configured'}</div>;
        }
        return (
          <LookupCombobox
            lookupModelId={field.lookup_model_id}
            lookupDisplayField={field.lookup_display_field}
            isMulti={field.is_multi}
            maxRecords={field.lookup_max_records}
            value={value as string | string[] | undefined}
            onChange={onChange}
          />
        );

      case 'mirror': {
        const res = resolveMirror(field, recordData ?? null, records, models);
        if (res.status === 'sibling_not_selected') {
          return (
            <div className="form-input bg-sand/5 text-charcoal/40 italic cursor-not-allowed">
              {isAr ? '—' : '—'}
            </div>
          );
        }
        if (res.status === 'target_record_missing') {
          return (
            <div className="form-input bg-sand/5 text-charcoal/30 italic cursor-not-allowed">
              {t('fields.mirror_deleted_record')}
            </div>
          );
        }
        if (res.status !== 'ok' || !res.targetField) {
          return (
            <div className="form-input bg-sand/5 text-charcoal/30 italic cursor-not-allowed">
              {t('fields.mirror_not_configured')}
            </div>
          );
        }
        if (Array.isArray(res.value)) {
          const items = res.value as unknown[];
          if (items.length === 0) {
            return (
              <div className="form-input bg-sand/5 text-charcoal/40 italic cursor-not-allowed">—</div>
            );
          }
          return (
            <div className="form-input bg-sand/5 text-charcoal/80 cursor-not-allowed flex flex-wrap gap-1 items-center">
              {items.map((v, i) => (
                <DynamicCell
                  key={i}
                  field={res.targetField!}
                  value={v}
                  allRecords={records}
                  recordData={res.targetRecord?.data}
                />
              ))}
            </div>
          );
        }
        return (
          <div className="form-input bg-sand/5 text-charcoal/80 cursor-not-allowed flex items-center">
            <DynamicCell
              field={res.targetField}
              value={res.value}
              allRecords={records}
              recordData={res.targetRecord?.data}
            />
          </div>
        );
      }

      case 'auto_id': {
        const str = typeof value === 'string' && value ? value : null;
        return (
          <div className="form-input bg-sand/5 text-charcoal/80 cursor-not-allowed flex items-center gap-2" dir="ltr">
            <Fingerprint size={14} className="text-copper/50 shrink-0" />
            {str
              ? <span className="font-mono font-bold text-copper">{str}</span>
              : <span className="text-charcoal/30 italic text-sm">{t('fields.auto_id.unassigned')}</span>}
          </div>
        );
      }

      case 'formula': {
        // Live-compute against the current form data, running the full
        // dependency graph so formulas that reference other formulas resolve
        // correctly (not stale snapshots from recordData). On save, the same
        // engine runs in the store and the result is snapshotted into record.data.
        const ownerModel = models.find((m) =>
          m.schema.sections.some((s) => s.fields.some((f) => f.id === field.id)),
        );
        const live = ownerModel
          ? evaluateFormulaInModel(field, ownerModel, recordData ?? {})
          : null;
        const isError = isFormulaErrorValue(live);
        const locale = isAr ? 'ar-SA' : 'en-SA';
        const display = live === null || live === undefined
          ? '—'
          : typeof live === 'boolean'
            ? (live ? (isAr ? 'نعم' : 'true') : (isAr ? 'لا' : 'false'))
            : isError
              ? String(live)
              : formatFormulaValue(live, field, locale);
        return (
          <div className={`form-input bg-sand/5 cursor-not-allowed flex items-center gap-2 ${isError ? 'text-red-500' : 'text-charcoal/80'}`}>
            <Calculator size={14} className={`shrink-0 ${isError ? 'text-red-400' : 'text-copper/50'}`} />
            <span className={`${isError ? 'font-mono font-bold' : ''}`} dir="ltr">{display}</span>
          </div>
        );
      }

      case 'assignee': {
        const { users: allUsers } = useAppStore.getState();
        const roleIds = field.assignee_role_ids ?? [];
        const eligibleUsers = allUsers.filter((u) =>
          u.is_active && u.role_assignments.some((ra) => roleIds.includes(ra.role_id)),
        );
        return (
          <select
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value || undefined)}
            className="form-input"
          >
            <option value="">— {isAr ? 'اختر مستخدم' : 'Select user'} —</option>
            {eligibleUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {isAr ? u.name_ar : u.name_en} ({u.email})
              </option>
            ))}
            {eligibleUsers.length === 0 && (
              <option disabled>({isAr ? 'لا يوجد أعضاء' : 'No members'})</option>
            )}
          </select>
        );
      }

      default:
        return (
          <input
            type="text"
            value={(value as string) ?? ''}
            onChange={(e) => onChange(e.target.value)}
            className="form-input"
          />
        );
    }
  };

  if (compact) {
    return <>{renderInput()}</>;
  }

  return (
    <div>
      <label className="block text-sm font-bold text-charcoal mb-1">
        {label}
        {field.required && <span className="text-red-500 ms-1">*</span>}
      </label>
      {renderInput()}
    </div>
  );
}
