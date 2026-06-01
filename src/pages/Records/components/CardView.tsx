import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import Badge from '@/components/ui/Badge';
import DynamicCell from './DynamicCell';
import { resolveMirror, resolveLookupDisplayValue } from '@/lib/mirrorResolver';
import { collectViewFields, readExpandedValue, type ExpandedField } from '@/lib/sectionMirrorExpand';
import type { AppModel, AppRecord, ModelField, FieldOption } from '@/types';

/**
 * Resolve a field value to a display string for card title/subtitle.
 * Handles lookups and mirrors so cards never show raw UUIDs or blanks.
 */
function resolveFieldDisplay(
  field: ModelField,
  record: AppRecord,
  allRecords: Record<string, AppRecord[]>,
  allModels: AppModel[],
  isAr: boolean,
): string {
  if (field.type === 'mirror') {
    const res = resolveMirror(field, record.data, allRecords, allModels);
    if (res.status !== 'ok' || !res.targetField) return '—';
    return formatScalar(res.targetField, res.value, isAr);
  }
  if (field.type === 'lookup') {
    if (!field.lookup_model_id || !field.lookup_display_field) return '—';
    const linkedRecords = allRecords[field.lookup_model_id] ?? [];
    const targetModel = allModels.find((m) => m.id === field.lookup_model_id);
    const raw = record.data[field.name];
    const resolveOne = (id: unknown): string | null => {
      if (typeof id !== 'string' || !id) return null;
      const linked = linkedRecords.find((r) => r.id === id);
      if (!linked) return null;
      const v = resolveLookupDisplayValue(linked, field.lookup_display_field!, { targetModel, allModels, allRecords });
      return v !== null && v !== undefined && typeof v !== 'object' ? String(v) : null;
    };
    if (Array.isArray(raw)) {
      const labels = raw.map(resolveOne).filter((x): x is string => !!x);
      return labels.length > 0 ? labels.join(isAr ? '، ' : ', ') : '—';
    }
    return resolveOne(raw) ?? '—';
  }
  return formatScalar(field, record.data[field.name], isAr);
}

function formatScalar(field: ModelField, value: unknown, isAr: boolean): string {
  if (value === undefined || value === null || value === '') return '—';
  if (field.type === 'dropdown') {
    const opt = field.options?.find((o) => o.value === value);
    return opt ? (isAr ? opt.label_ar : opt.label_en) : String(value);
  }
  if (field.type === 'currency') {
    const n = Number(value);
    if (!isNaN(n)) return `${n.toLocaleString(isAr ? 'ar-SA' : 'en-SA')} ${isAr ? 'ر.س' : 'SAR'}`;
  }
  if (field.type === 'date' || field.type === 'datetime') {
    try {
      return new Date(String(value)).toLocaleDateString(isAr ? 'ar-SA' : 'en-GB');
    } catch {
      return String(value);
    }
  }
  if (field.type === 'multi_link') {
    const links = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];
    return links.length ? links.join(isAr ? '، ' : ', ') : '—';
  }
  return String(value);
}

/**
 * Resolve the badge option for the card. Handles mirrors of dropdown fields by
 * walking to the TARGET field's options (the mirror carries no options of its own).
 */
function resolveBadgeOption(
  field: ModelField,
  record: AppRecord,
  allRecords: Record<string, AppRecord[]>,
  allModels: AppModel[],
): FieldOption | null {
  if (field.type === 'mirror') {
    const res = resolveMirror(field, record.data, allRecords, allModels);
    if (res.status !== 'ok' || !res.targetField) return null;
    return res.targetField.options?.find((o) => o.value === res.value) ?? null;
  }
  return field.options?.find((o) => o.value === record.data[field.name]) ?? null;
}

/**
 * Display string for an ExpandedField (local OR a section-mirror child). Local
 * fields keep the existing record-based resolution; mirrored children read their
 * value through the section mirror (readExpandedValue) and then format it,
 * resolving lookups against the child's own target model.
 */
function displayExpandedField(
  ef: ExpandedField,
  record: AppRecord,
  allRecords: Record<string, AppRecord[]>,
  allModels: AppModel[],
  model: AppModel,
  isAr: boolean,
): string {
  if (ef.kind === 'local') return resolveFieldDisplay(ef.field, record, allRecords, allModels, isAr);
  const value = readExpandedValue(ef, record, allRecords, model, allModels);
  const field = ef.field;
  if (field.type === 'lookup') {
    if (!field.lookup_model_id || !field.lookup_display_field) return '—';
    const linkedRecords = allRecords[field.lookup_model_id] ?? [];
    const targetModel = allModels.find((m) => m.id === field.lookup_model_id);
    const resolveOne = (id: unknown): string | null => {
      if (typeof id !== 'string' || !id) return null;
      const linked = linkedRecords.find((r) => r.id === id);
      if (!linked) return null;
      const v = resolveLookupDisplayValue(linked, field.lookup_display_field!, { targetModel, allModels, allRecords });
      return v !== null && v !== undefined && typeof v !== 'object' ? String(v) : null;
    };
    if (Array.isArray(value)) {
      const labels = value.map(resolveOne).filter((x): x is string => !!x);
      return labels.length > 0 ? labels.join(isAr ? '، ' : ', ') : '—';
    }
    return resolveOne(value) ?? '—';
  }
  return formatScalar(field, value, isAr);
}

/** Badge option for an ExpandedField — mirrored children read the value through the section mirror. */
function badgeOptionForExpanded(
  ef: ExpandedField,
  record: AppRecord,
  allRecords: Record<string, AppRecord[]>,
  allModels: AppModel[],
  model: AppModel,
): FieldOption | null {
  if (ef.kind === 'local') return resolveBadgeOption(ef.field, record, allRecords, allModels);
  const value = readExpandedValue(ef, record, allRecords, model, allModels);
  const v = Array.isArray(value) ? value[0] : value;
  return ef.field.options?.find((o) => o.value === v) ?? null;
}

interface CardViewProps {
  model: AppModel;
  records: AppRecord[];
  onCardClick: (record: AppRecord) => void;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onToggleSelectAll?: () => void;
}

export default function CardView({ model, records, onCardClick, selectedIds, onToggleSelect, onToggleSelectAll }: CardViewProps) {
  const { t } = useTranslation();
  const { language, records: allRecords, models } = useAppStore();
  const isAr = language === 'ar';

  const selectionEnabled = !!selectedIds && !!onToggleSelect && !!onToggleSelectAll;
  const allSelected = selectionEnabled && records.length > 0 && records.every((r) => selectedIds!.has(r.id));

  // Resolve config field ids against the expanded field set (local fields PLUS
  // section-mirror children) so cards can show mirrored data the same way the
  // table view does.
  const expandedById = useMemo(() => {
    const m = new Map<string, ExpandedField>();
    for (const ef of collectViewFields(model, models)) m.set(ef.id, ef);
    return m;
  }, [model, models]);
  const titleEf = model.card_config.title_field_id ? expandedById.get(model.card_config.title_field_id) : undefined;
  const subtitleEf = model.card_config.subtitle_field_id ? expandedById.get(model.card_config.subtitle_field_id) : undefined;
  const badgeEf = model.card_config.badge_field_id ? expandedById.get(model.card_config.badge_field_id) : undefined;
  const shownEfs = model.card_config.shown_field_ids
    .map((id) => expandedById.get(id))
    .filter((ef): ef is ExpandedField => Boolean(ef));

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-charcoal/30">
        <p className="text-lg font-bold mb-2">
          {isAr ? 'لا توجد سجلات بعد' : 'No records yet'}
        </p>
      </div>
    );
  }

  return (
    <div>
      {selectionEnabled && (
        <div className="flex items-center mb-3">
          <button
            onClick={onToggleSelectAll}
            className="text-sm font-bold text-copper hover:text-terracotta transition-colors"
          >
            {allSelected ? t('records.deselect_all') : t('records.select_all')}
          </button>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {records.map((record) => {
        const badgeOption = badgeEf ? badgeOptionForExpanded(badgeEf, record, allRecords, models, model) : null;
        const stripColor = badgeOption?.color ?? model.color;
        const isSelected = selectionEnabled && selectedIds!.has(record.id);

        return (
          <div
            key={record.id}
            className={`record-card relative ${isSelected ? 'ring-2 ring-copper' : ''}`}
            onClick={() => onCardClick(record)}
          >
            {selectionEnabled && (
              <label
                className="absolute top-2 end-2 z-10 bg-white/90 rounded p-1 shadow-sm cursor-pointer"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggleSelect!(record.id)}
                  className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30 cursor-pointer block"
                />
              </label>
            )}
            {/* Color strip */}
            <div className="h-1" style={{ backgroundColor: stripColor }} />

            <div className="p-4">
              {/* Badge */}
              {badgeOption && (
                <div className="mb-2">
                  <Badge
                    label={isAr ? badgeOption.label_ar : badgeOption.label_en}
                    color={badgeOption.color}
                  />
                </div>
              )}

              {/* Title */}
              <div className="text-base font-bold text-charcoal mb-0.5">
                {titleEf
                  ? displayExpandedField(titleEf, record, allRecords, models, model, isAr)
                  : `#${record.id.slice(0, 8)}`}
              </div>

              {/* Subtitle */}
              {subtitleEf && (
                <div className="text-sm text-charcoal/50">
                  {displayExpandedField(subtitleEf, record, allRecords, models, model, isAr)}
                </div>
              )}

              {/* Additional fields */}
              {shownEfs.length > 0 && (
                <>
                  <hr className="my-3 border-sand/40" />
                  <div className="space-y-1.5">
                    {shownEfs.map((ef) => (
                      <div key={ef.id} className="flex justify-between text-sm">
                        <span className="text-charcoal/50">
                          {isAr ? ef.field.label_ar : ef.field.label_en}
                        </span>
                        <DynamicCell
                          field={ef.field}
                          value={readExpandedValue(ef, record, allRecords, model, models)}
                          allRecords={allRecords}
                          recordData={record.data}
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Date */}
              <div className="mt-3 text-xs text-charcoal/30">
                {new Date(record.created_at).toLocaleDateString(isAr ? 'ar-SA' : 'en-GB')}
              </div>
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
