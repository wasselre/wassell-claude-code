import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import RelatedModelTable from './RelatedModelTable';
import type { AppModel, AppRecord, ModelField } from '@/types';

interface RelatedRecordsPanelProps {
  /** The record whose incoming links we list. */
  recordId: string;
  /** The model these incoming `lookup` fields must point at (e.g. 'clients',
   *  'advertisers'). */
  targetModelName: string;
  /** Model name to skip (usually the target itself). Defaults to targetModelName. */
  excludeModelName?: string;
  titleAr?: string;
  titleEn?: string;
}

interface ModelMatch {
  model: AppModel;
  matches: AppRecord[];
}

/**
 * Generic cross-model related-records list (the "Client 360" reverse-lookup,
 * generalized to any target model). For a given record id, walks every model's
 * schema, finds every `lookup` field whose `lookup_model_id` points at
 * `targetModelName`, and lists all records whose stored value for that field
 * references this record. Multi-value lookups are matched by array `.includes`.
 * Used for clients (their follow-ups/appointments/… ) and advertisers (their
 * linked market_listings).
 *
 * Each related model is rendered as a full table (`RelatedModelTable` wraps the
 * same `TableView` the Records list uses) with per-user adjustable columns and
 * column-header sorting — read-only, no filter. Clicking a row opens that
 * record on its own page.
 *
 * Pure client-side: reads from the in-memory `models` + `records` slices.
 * No SQL, no extra fetches.
 */
export default function RelatedRecordsPanel({
  recordId,
  targetModelName,
  excludeModelName = targetModelName,
  titleAr = 'السجلات المرتبطة',
  titleEn = 'Related Records',
}: RelatedRecordsPanelProps) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const targetModelId = useMemo(
    () => models.find((m) => m.name === targetModelName)?.id ?? null,
    [models, targetModelName],
  );

  // Map: target model id → fields (across all models) that lookup INTO it.
  // Memoized on `models` so we don't re-walk every record's render. Zustand's
  // models slice is reference-stable when nothing changed.
  const lookupFieldsByTarget = useMemo(() => {
    const byTarget = new Map<string, Array<{ modelId: string; field: ModelField }>>();
    for (const m of models) {
      for (const sec of m.schema.sections) {
        for (const f of sec.fields) {
          if (f.type !== 'lookup' || !f.lookup_model_id) continue;
          const list = byTarget.get(f.lookup_model_id) ?? [];
          list.push({ modelId: m.id, field: f });
          byTarget.set(f.lookup_model_id, list);
        }
      }
    }
    return byTarget;
  }, [models]);

  const matchesByModel: ModelMatch[] = useMemo(() => {
    if (!targetModelId || !recordId) return [];
    const candidates = lookupFieldsByTarget.get(targetModelId) ?? [];
    // Group candidates by model so we don't double-count a record matched on
    // two different lookup fields pointing at clients.
    const byModelId = new Map<string, ModelField[]>();
    for (const c of candidates) {
      const list = byModelId.get(c.modelId) ?? [];
      list.push(c.field);
      byModelId.set(c.modelId, list);
    }
    const out: ModelMatch[] = [];
    for (const [modelId, fields] of byModelId.entries()) {
      const m = models.find((mm) => mm.id === modelId);
      if (!m) continue;
      if (excludeModelName && m.name === excludeModelName) continue;
      const list = records[modelId] ?? [];
      const seen = new Set<string>();
      const matches: AppRecord[] = [];
      for (const r of list) {
        for (const f of fields) {
          const v = (r.data as Record<string, unknown>)[f.name];
          const hit = Array.isArray(v) ? v.includes(recordId) : v === recordId;
          if (hit && !seen.has(r.id)) {
            seen.add(r.id);
            matches.push(r);
            break;
          }
        }
      }
      if (matches.length > 0) out.push({ model: m, matches });
    }
    // Sort groups by model label so the panel layout is stable.
    out.sort((a, b) => {
      const al = isAr ? a.model.label_ar : a.model.label_en;
      const bl = isAr ? b.model.label_ar : b.model.label_en;
      return al.localeCompare(bl);
    });
    return out;
  }, [recordId, targetModelId, models, records, lookupFieldsByTarget, excludeModelName, isAr]);

  if (matchesByModel.length === 0) {
    return (
      <section className="card">
        <h3 className="text-base font-semibold text-charcoal mb-2">
          {isAr ? titleAr : titleEn}
        </h3>
        <p className="text-sm text-charcoal/50">
          {isAr ? 'لا توجد سجلات في النماذج الأخرى مرتبطة بهذا السجل.' : 'No records in other models reference this record yet.'}
        </p>
      </section>
    );
  }

  return (
    <section>
      <h3 className="text-base font-semibold text-charcoal mb-3">
        {isAr ? titleAr : titleEn}
      </h3>
      <div className="space-y-6">
        {matchesByModel.map(({ model, matches }) => (
          <RelatedModelTable key={model.id} model={model} matches={matches} isAr={isAr} />
        ))}
      </div>
    </section>
  );
}
