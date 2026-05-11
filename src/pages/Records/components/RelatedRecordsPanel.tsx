import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import * as lucideIcons from 'lucide-react';
import { ChevronRight, Sparkles, type LucideIcon } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppModel, AppRecord, ModelField } from '@/types';

// Match the kebab-case → PascalCase mapping `RecordFormPage.tsx:21` uses for
// model icons. Falls back to Sparkles when the name doesn't resolve.
function resolveLucideIcon(name?: string): LucideIcon {
  const pascal = (name ?? 'sparkles')
    .trim()
    .replace(/(^|-)(\w)/g, (_, _dash, c: string) => c.toUpperCase());
  const Icon = (lucideIcons as unknown as Record<string, LucideIcon>)[pascal];
  return Icon ?? Sparkles;
}

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
 * Pure client-side: reads from the in-memory `models` + `records` slices.
 * No SQL, no extra fetches. Memoized on `[clientId, models, records]` —
 * Zustand returns stable references for unchanged slices, so re-renders are
 * cheap.
 */
export default function RelatedRecordsPanel({ clientId, excludeModelName = 'clients' }: RelatedRecordsPanelProps) {
  const navigate = useNavigate();
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
    <section className="card">
      <h3 className="text-base font-semibold text-charcoal mb-3">
        {isAr ? 'السجلات المرتبطة' : 'Related Records'}
      </h3>
      <div className="space-y-4">
        {matchesByModel.map(({ model, matches }) => (
          <ModelGroup
            key={model.id}
            model={model}
            matches={matches}
            isAr={isAr}
            onOpen={(name, id) => navigate(`/model/${name}/${id}`)}
          />
        ))}
      </div>
    </section>
  );
}

function ModelGroup({
  model,
  matches,
  isAr,
  onOpen,
}: {
  model: AppModel;
  matches: AppRecord[];
  isAr: boolean;
  onOpen: (modelName: string, recordId: string) => void;
}) {
  const Icon = resolveLucideIcon(model.icon);
  const titleFieldId = model.card_config?.title_field_id;
  const subtitleFieldId = model.card_config?.subtitle_field_id;
  const allFields = model.schema.sections.flatMap((s) => s.fields);
  const titleField = titleFieldId ? allFields.find((f) => f.id === titleFieldId) : null;
  const subtitleField = subtitleFieldId ? allFields.find((f) => f.id === subtitleFieldId) : null;

  return (
    <div>
      <header className="flex items-center gap-2 mb-2">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${model.color}15` }}
        >
          <Icon size={14} style={{ color: model.color }} />
        </div>
        <span className="font-bold text-sm text-charcoal">
          {isAr ? model.label_ar : model.label_en}
        </span>
        <span className="text-xs text-charcoal/50">({matches.length})</span>
      </header>
      <ul className="space-y-1.5 ms-9">
        {matches.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onOpen(model.name, r.id)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-sand/30 transition-colors text-start"
            >
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-sm font-medium text-charcoal truncate">
                  {pickFieldLabel(r, titleField) ?? r.id.slice(0, 8)}
                </span>
                {subtitleField && pickFieldLabel(r, subtitleField) && (
                  <span className="text-xs text-charcoal/50 truncate">
                    {pickFieldLabel(r, subtitleField)}
                  </span>
                )}
              </div>
              <ChevronRight size={14} className="text-charcoal/30 flex-shrink-0 rtl:rotate-180" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function pickFieldLabel(record: AppRecord, field: ModelField | null | undefined): string | null {
  if (!field) return null;
  const v = (record.data as Record<string, unknown>)[field.name];
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) {
    return v.length === 0 ? null : v.map(String).join(', ');
  }
  if (typeof v === 'object') {
    if ('min' in v || 'max' in v) {
      const r = v as { min?: number; max?: number };
      return `${r.min ?? ''} – ${r.max ?? ''}`;
    }
    return null;
  }
  return String(v);
}
