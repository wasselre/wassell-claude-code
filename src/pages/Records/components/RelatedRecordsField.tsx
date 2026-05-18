import { useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { ExternalLink } from 'lucide-react';
import RecordFormModal from './RecordFormModal';
import type { ModelField } from '@/types';

interface RelatedRecordsFieldProps {
  field: ModelField;
  /** Current record's data — used to resolve `match_source_field_name`. */
  recordData: Record<string, unknown>;
}

/**
 * Renders a compact read-only list of records from `field.related_records_model_id`
 * whose `data[match_field_name]` equals THIS record's `data[match_source_field_name]`.
 * Used to surface "all visits for this client" / "all appointments for this client"
 * inline inside a follow-up form. Click a row → opens the target record in a
 * nested RecordFormModal.
 *
 * No store mutations, no remote fetch — all data comes from the in-memory
 * `records[modelId]` slice that's already been hydrated by `initialize()`.
 */
export default function RelatedRecordsField({ field, recordData }: RelatedRecordsFieldProps) {
  const { records, models, language } = useAppStore();
  const isAr = language === 'ar';
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);

  const targetModelId = field.related_records_model_id ?? null;
  const matchFieldName = field.related_records_match_field_name ?? null;
  const matchSourceFieldName = field.related_records_match_source_field_name ?? null;
  const displayFieldNames = field.related_records_display_fields ?? [];
  const statusFieldName = field.related_records_status_field ?? null;

  const targetModel = targetModelId ? models.find((m) => m.id === targetModelId) ?? null : null;

  const matches = useMemo(() => {
    if (!targetModelId || !matchFieldName || !matchSourceFieldName) return [];
    const sourceValue = recordData[matchSourceFieldName];
    if (sourceValue === undefined || sourceValue === null || sourceValue === '') return [];
    const all = records[targetModelId] ?? [];
    return all.filter((r) => r.data[matchFieldName] === sourceValue);
  }, [records, targetModelId, matchFieldName, matchSourceFieldName, recordData]);

  if (!targetModel) {
    return (
      <div className="text-[12px] text-amber-500 italic">
        {isAr ? 'لم يتم تعريف النموذج المرتبط لهذا الحقل.' : 'Related model not configured.'}
      </div>
    );
  }

  if (matches.length === 0) {
    return (
      <div className="text-[12px] text-charcoal/40 italic">
        {isAr ? `لا توجد سجلات مرتبطة في ${targetModel.label_ar}.` : `No related records in ${targetModel.label_en}.`}
      </div>
    );
  }

  // Resolve a field's bilingual label by slug for the column headers.
  const targetFields = targetModel.schema.sections.flatMap((s) => s.fields);
  const labelFor = (slug: string): string => {
    const f = targetFields.find((x) => x.name === slug);
    if (!f) return slug;
    return isAr ? f.label_ar : f.label_en;
  };

  // Resolve a status option's color from the target model's schema.
  const statusOptionColor = (slug: string): string | undefined => {
    if (!statusFieldName) return undefined;
    const f = targetFields.find((x) => x.name === statusFieldName);
    if (!f || !f.options) return undefined;
    return f.options.find((o) => o.value === slug)?.color;
  };

  return (
    <>
      <div className="border border-sand/30 rounded-lg overflow-hidden">
        <div className="bg-sand/10 px-3 py-1.5 text-[11px] font-bold text-charcoal/60 flex gap-3">
          {displayFieldNames.map((slug) => (
            <span key={slug} className="flex-1">{labelFor(slug)}</span>
          ))}
          {statusFieldName && <span className="w-24 text-end">{labelFor(statusFieldName)}</span>}
          <span className="w-5" />
        </div>
        {matches.map((r) => {
          const status = statusFieldName ? (r.data[statusFieldName] as string | undefined) : undefined;
          const statusColor = status ? statusOptionColor(status) : undefined;
          return (
            <button
              type="button"
              key={r.id}
              onClick={() => setOpenRecordId(r.id)}
              className="w-full px-3 py-2 flex gap-3 items-center text-start text-sm hover:bg-sand/15 border-t border-sand/20 transition-colors"
            >
              {displayFieldNames.map((slug) => {
                const raw = r.data[slug];
                const display = raw === undefined || raw === null || raw === ''
                  ? '—'
                  : typeof raw === 'string' || typeof raw === 'number'
                    ? String(raw)
                    : Array.isArray(raw)
                      ? raw.join(', ')
                      : '—';
                return (
                  <span key={slug} className="flex-1 truncate text-charcoal">{display}</span>
                );
              })}
              {statusFieldName && (
                <span className="w-24 text-end">
                  {status ? (
                    <span
                      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold"
                      style={{
                        backgroundColor: statusColor ? `${statusColor}22` : '#e5e7eb',
                        color: statusColor ?? '#6b7280',
                      }}
                    >
                      {status}
                    </span>
                  ) : (
                    <span className="text-charcoal/30">—</span>
                  )}
                </span>
              )}
              <ExternalLink size={12} className="text-charcoal/40 w-5" />
            </button>
          );
        })}
      </div>

      {openRecordId && (
        <RecordFormModal
          modelId={targetModel.id}
          recordId={openRecordId}
          onClose={() => setOpenRecordId(null)}
        />
      )}
    </>
  );
}
