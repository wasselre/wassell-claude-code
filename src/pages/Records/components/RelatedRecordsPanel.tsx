import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import RelatedModelTable from './RelatedModelTable';
import type { AppModel, AppRecord, ModelField } from '@/types';

interface RelatedRecordsPanelProps {
  clientId: string;
  /** Excluded model name — usually 'clients' itself, since the client's own
   *  record is already rendered in the parent tab pane. */
  excludeModelName?: string;
}

interface ModelMatch {
  model: AppModel;
  matches: AppRecord[];
}

/**
 * Cross-model "Client 360" related-records list. For a given client record id,
 * walks every model's schema, finds every `lookup` field whose
 * `lookup_model_id` points at the clients model, and lists all records whose
 * stored value for that field references this client. Multi-value lookups are
 * matched by array `.includes`.
 *
 * Each related model is rendered as a full table (`RelatedModelTable` wraps the
 * same `TableView` the Records list uses) with per-user adjustable columns and
 * column-header sorting — read-only, no filter. Clicking a row opens that
 * record on its own page.
 *
 * Pure client-side: reads from the in-memory `models` + `records` slices.
 * No SQL, no extra fetches. Memoized on `[clientId, models, records]` —
 * Zustand returns stable references for unchanged slices, so re-renders are
 * cheap.
 */
export default function RelatedRecordsPanel({ clientId, excludeModelName = 'clients' }: RelatedRecordsPanelProps) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const clientsModelId = useMemo(
    () => models.find((m) => m.name === 'clients')?.id ?? null,
    [models],
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
    if (!clientsModelId || !clientId) return [];
    const candidates = lookupFieldsByTarget.get(clientsModelId) ?? [];
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
          const hit = Array.isArray(v) ? v.includes(clientId) : v === clientId;
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
  }, [clientId, clientsModelId, models, records, lookupFieldsByTarget, excludeModelName, isAr]);

  if (matchesByModel.length === 0) {
    return (
      <section className="card">
        <h3 className="text-base font-semibold text-charcoal mb-2">
          {isAr ? 'السجلات المرتبطة' : 'Related Records'}
        </h3>
        <p className="text-sm text-charcoal/50">
          {isAr ? 'لا توجد سجلات في النماذج الأخرى مرتبطة بهذا العميل.' : 'No records in other models reference this client yet.'}
        </p>
      </section>
    );
  }

  return (
    <section>
      <h3 className="text-base font-semibold text-charcoal mb-3">
        {isAr ? 'السجلات المرتبطة' : 'Related Records'}
      </h3>
      <div className="space-y-6">
        {matchesByModel.map(({ model, matches }) => (
          <RelatedModelTable key={model.id} model={model} matches={matches} isAr={isAr} />
        ))}
      </div>
    </section>
  );
}
