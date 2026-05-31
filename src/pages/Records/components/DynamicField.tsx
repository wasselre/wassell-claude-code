import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { ExternalLink, Fingerprint, Calculator, X } from 'lucide-react';
import DropdownSelect from './DropdownSelect';
import MultiSelect from './MultiSelect';
import LookupCombobox from './LookupCombobox';
import PhoneInput from './PhoneInput';
import DynamicCell from './DynamicCell';
import AutoGrowTextarea from './AutoGrowTextarea';
import NotesField from './NotesField';
import RangeField from './RangeField';
import TableField from './TableField';
import DateTimePicker from './DateTimePicker';
import TemplateVariablesField from './TemplateVariablesField';
import TemplatesPickerModal from './TemplatesPickerModal';
import GenerationsGallery, { GENERATION_STATUS_LABELS, GenerationStatusBadge } from './GenerationsGallery';
import { filterEligibleAssignees } from '@/lib/assigneeEligibility';
import { resolveMirror } from '@/lib/mirrorResolver';
import { evaluateFormulaInModel, formatFormulaValue, isFormulaErrorValue } from '@/lib/formulaEngine';
import {
  ImageFieldInput,
  MultiImageFieldInput,
  FileFieldInput,
  MultiFileFieldInput,
} from './DriveFieldInputs';
import AttachmentFieldInput from './AttachmentFieldInput';
import type { AttachmentRef, FieldOption, ModelField } from '@/types';

// Rotating palette used when the user inline-creates a new dropdown /
// multiselect option from the record form. Matches the palette the Builder's
// OptionsEditor uses when adding options manually.
const INLINE_OPTION_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899',
  '#06B6D4', '#84CC16', '#F97316', '#6366F1',
];

/**
 * Stable slug from a user-typed option label. Replaces the previous
 * `value: uuid()` so that re-typing the same label (e.g. "الرياض") produces
 * the same `value` instead of a fresh UUID — old code caused filter
 * localStorage / record values / option list to drift apart whenever an
 * option got re-created after a schema regression.
 *
 * Unicode-aware: keeps Arabic/Latin letters and digits, strips diacritics
 * and punctuation, lowercases, replaces whitespace runs with hyphens.
 */
function slugifyOptionLabel(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip Latin diacritics
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // keep letters/digits/space/hyphen
    .trim()
    .replace(/\s+/g, '-');
  return base || 'option';
}

/**
 * Find an existing option on this field that matches the typed label.
 * Compares against label_ar AND label_en (case- and whitespace-insensitive)
 * AND against the slugified value, so re-typing the same label — even with
 * different casing/spacing — surfaces the existing option instead of
 * creating a duplicate. Critical: this also rescues UUID-valued options
 * that pre-date the slug-value change. If a user previously inline-created
 * "الرياض" (got UUID-A) and types "الرياض" again, we return UUID-A and
 * don't create a new entry.
 */
function findExistingOption(
  options: readonly FieldOption[],
  label: string,
): FieldOption | undefined {
  const norm = label.trim().toLowerCase();
  const slug = slugifyOptionLabel(label);
  return options.find(
    (o) =>
      (o.label_ar ?? '').trim().toLowerCase() === norm ||
      (o.label_en ?? '').trim().toLowerCase() === norm ||
      o.value === slug,
  );
}

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
  /**
   * Used by the Drive-backed field types (image / multi_image / file / multi_file
   * / attachment) to tag any new file uploaded through the field with the owning
   * record. Without these, uploads still work but the file lands in the user's
   * Drive untethered to any record. Optional everywhere — bulk-edit & table
   * inline-edit callers don't carry these, and that's fine.
   */
  modelId?: string;
  recordId?: string;
}

export default function DynamicField({
  field, value, onChange, recordData, compact, modelId, recordId,
}: DynamicFieldProps) {
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

    // Dedupe: if an option with this label (or matching slug) already exists,
    // return its value instead of creating a duplicate. Prevents the UUID-
    // drift bug where re-typing "الرياض" produced a new UUID each time and
    // broke filters that referenced the older one.
    const existingMatch = findExistingOption(existing, label);
    if (existingMatch) return existingMatch.value;

    // Stable, deterministic value from the label so re-creates produce the
    // same value. Append a numeric suffix on the rare case where two
    // distinct labels slugify to the same string (e.g. "الرياض!" and
    // "الرياض?" both → "الرياض").
    const baseSlug = slugifyOptionLabel(label);
    const usedValues = new Set(existing.map((o) => o.value));
    let value = baseSlug;
    let suffix = 2;
    while (usedValues.has(value)) {
      value = `${baseSlug}-${suffix}`;
      suffix++;
    }

    const newOption: FieldOption = {
      id: uuid(),
      label_ar: label,
      label_en: label,
      value,
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
          <AutoGrowTextarea
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
          <DateTimePicker
            mode="date"
            value={value as string | null | undefined}
            onChange={onChange}
            placeholder={placeholder}
          />
        );

      case 'datetime':
        return (
          <DateTimePicker
            mode="datetime"
            value={value as string | null | undefined}
            onChange={onChange}
            placeholder={placeholder}
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

      case 'image':
        return (
          <ImageFieldInput
            value={typeof value === 'string' ? value : ''}
            acceptMime={field.image_accept ?? 'image/*'}
            maxSizeMb={field.image_max_size_mb ?? 25}
            defaultFolderId={field.attachment_default_folder_id ?? null}
            modelId={modelId ?? null}
            recordId={recordId ?? null}
            onChange={(v) => onChange(v)}
            isAr={isAr}
          />
        );

      case 'multi_image': {
        const list = Array.isArray(value)
          ? value.filter((v): v is string => typeof v === 'string')
          : [];
        return (
          <MultiImageFieldInput
            value={list}
            acceptMime={field.image_accept ?? 'image/*'}
            maxSizeMb={field.image_max_size_mb ?? 25}
            maxItems={field.attachment_max_items}
            defaultFolderId={field.attachment_default_folder_id ?? null}
            modelId={modelId ?? null}
            recordId={recordId ?? null}
            onChange={(v) => onChange(v)}
            isAr={isAr}
          />
        );
      }

      case 'file':
        return (
          <FileFieldInput
            value={typeof value === 'string' ? value : ''}
            acceptMime={field.image_accept}
            maxSizeMb={field.image_max_size_mb ?? 500}
            defaultFolderId={field.attachment_default_folder_id ?? null}
            modelId={modelId ?? null}
            recordId={recordId ?? null}
            onChange={(v) => onChange(v)}
            isAr={isAr}
          />
        );

      case 'multi_file': {
        const list = Array.isArray(value)
          ? value.filter((v): v is string => typeof v === 'string')
          : [];
        return (
          <MultiFileFieldInput
            value={list}
            acceptMime={field.image_accept}
            maxSizeMb={field.image_max_size_mb ?? 500}
            maxItems={field.attachment_max_items}
            defaultFolderId={field.attachment_default_folder_id ?? null}
            modelId={modelId ?? null}
            recordId={recordId ?? null}
            onChange={(v) => onChange(v)}
            isAr={isAr}
          />
        );
      }

      case 'attachment': {
        // Tolerant parse — legacy/empty/malformed values become an empty list.
        const refs: AttachmentRef[] = Array.isArray(value)
          ? value.filter(
              (r): r is AttachmentRef =>
                !!r && typeof r === 'object' && 'type' in r && 'id' in r &&
                (r.type === 'file' || r.type === 'folder') && typeof r.id === 'string',
            )
          : [];
        return (
          <AttachmentFieldInput
            value={refs}
            onChange={(v) => onChange(v)}
            isAr={isAr}
            defaultFolderId={field.attachment_default_folder_id ?? null}
            maxItems={field.attachment_max_items}
            modelId={modelId ?? null}
            recordId={recordId ?? null}
          />
        );
      }

      case 'template_variables': {
        const owningModel = models.find((m) =>
          m.schema.sections.some((s) => s.fields.some((f) => f.id === field.id)),
        );
        if (!owningModel) {
          return (
            <div className="form-input bg-sand/5 text-charcoal/40 italic cursor-not-allowed">
              {isAr ? 'تعذّر تحديد النموذج' : 'Owning model unresolved'}
            </div>
          );
        }
        const safeValue = (value && typeof value === 'object' && !Array.isArray(value))
          ? (value as Record<string, Record<string, { source: 'manual' | 'mirror'; value: string | number; mirror_field?: string }>>)
          : {};
        return (
          <TemplateVariablesField
            model={owningModel}
            recordData={recordData ?? {}}
            value={safeValue}
            onChange={onChange}
          />
        );
      }

      case 'templates_picker': {
        // Pull the per-template generation map (written by the
        // marketing/generate orchestrator) so each chip can show its
        // own status badge inline. Replaces the old single-status
        // dropdown that was meaningless once one record could trigger
        // N templates with independent outcomes.
        const generations = (recordData?.generations && typeof recordData.generations === 'object' && !Array.isArray(recordData.generations))
          ? (recordData.generations as Record<string, unknown>)
          : {};
        return (
          <TemplatesPickerInput
            value={Array.isArray(value) ? (value as string[]) : []}
            generations={generations}
            onChange={onChange}
            isAr={isAr}
          />
        );
      }

      case 'generations_gallery': {
        const generations = (recordData?.generations && typeof recordData.generations === 'object' && !Array.isArray(recordData.generations))
          ? (recordData.generations as Record<string, unknown>)
          : {};
        const templateIds = Array.isArray(recordData?.templates) ? (recordData?.templates as string[]) : [];
        return (
          <GenerationsGallery
            templateIds={templateIds}
            generations={generations}
            isAr={isAr}
          />
        );
      }

      case 'assignee': {
        const { users: allUsers } = useAppStore.getState();
        const eligibleUsers = filterEligibleAssignees(field, allUsers);
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

      case 'whatsapp_history':
      case 'call_history':
        // Display-only derived field types. The full panel lives in
        // SectionBlock (which has access to recordId / model phones); inside
        // DynamicField — which is also reused in compact / mirrored / table
        // contexts — they collapse to a quiet dash. SectionBlock short-circuits
        // before reaching here on the main form path.
        return <span className="text-charcoal/30 italic text-xs">—</span>;

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

// `ImageFieldInput` and `MultiImageFieldInput` used to live inline here as
// thin wrappers over the legacy `marketing-assets` Storage bucket. They
// were rewritten on top of the Files System (wassel-files bucket + files
// table) so uploads land in the user's Drive (/files) and can be tagged
// to the owning record. New implementations live in `./DriveFieldInputs.tsx`
// next to the file/multi_file/attachment inputs.

interface TemplatesPickerInputProps {
  value: string[];
  /** Per-template generation map keyed by template id. Each entry's
   *  `.status` drives the status badge on that template's chip. */
  generations: Record<string, unknown>;
  onChange: (value: unknown) => void;
  isAr: boolean;
}

/**
 * Renders the trigger button + selected-template chips for a
 * `templates_picker` field. Clicking opens the card-grid modal.
 *
 * Stored value: `string[]` of template IDs. The marketing-operations
 * orchestrator iterates this list and runs the three-phase generation
 * once per id.
 */
function TemplatesPickerInput({ value, generations, onChange, isAr }: TemplatesPickerInputProps) {
  const { models, records } = useAppStore();
  const [modalOpen, setModalOpen] = useState(false);

  const designTemplates = useMemo(() => {
    const dt = models.find((m) => m.name === 'design_templates');
    if (!dt) return [];
    return records[dt.id] ?? [];
  }, [models, records]);

  const selected = value
    .map((id) => {
      const r = designTemplates.find((rec) => rec.id === id);
      if (!r) return null;
      const data = r.data as Record<string, unknown>;
      return {
        id,
        name: typeof data.name === 'string' ? data.name : id,
        referenceImage: typeof data.reference_image === 'string' ? data.reference_image : '',
      };
    })
    .filter((x): x is { id: string; name: string; referenceImage: string } => x !== null);

  const removeOne = (id: string) => {
    onChange(value.filter((x) => x !== id));
  };

  return (
    <>
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="form-input w-full flex items-center justify-between text-start hover:bg-cream/40 transition-colors"
        >
          <span className={value.length === 0 ? 'text-charcoal/40' : 'text-charcoal'}>
            {value.length === 0
              ? (isAr ? 'انقر لاختيار قوالب...' : 'Click to pick templates...')
              : isAr
                ? `${value.length} قالب مختار`
                : `${value.length} template${value.length === 1 ? '' : 's'} selected`}
          </span>
          <span className="text-charcoal/40 text-sm">
            {isAr ? 'تعديل' : 'Edit'}
          </span>
        </button>
        {selected.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {selected.map((s) => {
              const slot = (generations[s.id] && typeof generations[s.id] === 'object' && !Array.isArray(generations[s.id]))
                ? (generations[s.id] as { status?: string })
                : null;
              const status = slot?.status ?? 'pending';
              const statusInfo = GENERATION_STATUS_LABELS[status] ?? GENERATION_STATUS_LABELS.pending!;
              return (
                <div
                  key={s.id}
                  className="relative rounded-lg overflow-hidden border border-sand/40 bg-white"
                >
                  <div className="aspect-square bg-sand/20 flex items-center justify-center overflow-hidden">
                    {s.referenceImage ? (
                      <img src={s.referenceImage} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : null}
                  </div>
                  <div className="p-2 space-y-1">
                    <div className="text-xs font-bold text-charcoal truncate">{s.name}</div>
                    <GenerationStatusBadge tone={statusInfo.tone} label={isAr ? statusInfo.ar : statusInfo.en} compact />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeOne(s.id)}
                    className="absolute top-1.5 end-1.5 p-1 rounded-full bg-charcoal/70 text-white hover:bg-charcoal transition-colors"
                    aria-label={isAr ? 'إزالة' : 'Remove'}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {modalOpen && (
        <TemplatesPickerModal
          selectedIds={value}
          onSave={(ids) => onChange(ids)}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}
