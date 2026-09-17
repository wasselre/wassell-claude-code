/**
 * Update Operations — PROVISIONAL, READ-ONLY (governing decision #6 + spec §4).
 *
 * This surface shows ONLY the truthful facts already stored on `unit_updates`
 * records. There is deliberately NO scheduler, execution engine, credential
 * handling, automated Claude session, human-in-the-loop control, or any
 * nonfunctional button — the full feature is designed in a separate session.
 * The Update Operations discovery report (delivered with the Phase 1 audit)
 * documents what exists and what is missing.
 */
import { useMemo } from 'react';
import { RefreshCw, ExternalLink } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { modelByName, fieldByCandidates, optionFor, asString } from '@/lib/projects/projectView';

export default function UpdateOperationsSection({ isAr }: { isAr: boolean }) {
  const { models, records } = useAppStore();

  const model = modelByName(models, 'unit_updates');
  const allModel = modelByName(models, 'all_projects');
  const sourceField = fieldByCandidates(model, ['source_type']);
  const freqField = fieldByCandidates(model, ['update_frequency']);

  const rows = useMemo(() => {
    if (!model) return [];
    const projById = new Map<string, string>();
    if (allModel) for (const r of records[allModel.id] ?? []) projById.set(r.id, asString(r.data?.project_name) ?? `#${r.id.slice(0, 8)}`);
    const resolveProject = (raw: unknown): string => {
      const id = Array.isArray(raw) ? (typeof raw[0] === 'string' ? raw[0] : null) : (typeof raw === 'string' ? raw : null);
      return (id && projById.get(id)) || (isAr ? 'غير مرتبط' : 'Unlinked');
    };
    return (records[model.id] ?? []).map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      const src = optionFor(sourceField, d.source_type);
      const freq = optionFor(freqField, d.update_frequency);
      return {
        id: r.id,
        project: resolveProject(d.project),
        source: src ? (isAr ? src.label_ar : src.label_en) : (asString(d.source_type) ?? '—'),
        sourceUrl: asString(d.source_url),
        frequency: freq ? (isAr ? freq.label_ar : freq.label_en) : (asString(d.update_frequency) ?? '—'),
        lastMigrated: asString(d.last_migrated_at) ?? '—',
        nextDue: asString(d.next_due) ?? '—',
        active: d.is_active === true,
        instructions: asString(d.migration_instructions) ?? '',
      };
    });
  }, [model, allModel, records, sourceField, freqField, isAr]);

  const dash = isAr ? '—' : '—';

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <RefreshCw size={18} className="text-copper mt-0.5 shrink-0" />
        <p className="text-xs text-charcoal/50 max-w-2xl">
          {isAr
            ? 'عرض للقراءة فقط لإعدادات تحديث المخزون الحالية. لم تُبنَ بعد الجدولة أو التنفيذ الآلي — سيُصمَّم ذلك في جلسة منفصلة.'
            : 'A read-only view of the current inventory-update configurations. Scheduling and automated execution are not built yet — they will be designed in a separate session.'}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="card p-10 text-center text-charcoal/45 text-sm">
          {isAr ? 'لا توجد إعدادات تحديث مسجَّلة بعد.' : 'No update configurations recorded yet.'}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-charcoal/40 text-xs border-b border-sand/50">
                <th className="text-start p-3 font-medium">{isAr ? 'المشروع' : 'Project'}</th>
                <th className="text-start p-3 font-medium">{isAr ? 'المصدر' : 'Source'}</th>
                <th className="text-start p-3 font-medium">{isAr ? 'الدورية' : 'Frequency'}</th>
                <th className="text-start p-3 font-medium">{isAr ? 'آخر تحديث' : 'Last migrated'}</th>
                <th className="text-start p-3 font-medium">{isAr ? 'التحديث القادم' : 'Next due'}</th>
                <th className="text-start p-3 font-medium">{isAr ? 'نشط' : 'Active'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-sand/30 align-top">
                  <td className="p-3 text-charcoal font-medium">
                    {row.project}
                    {row.instructions && (
                      <div className="text-[11px] text-charcoal/40 font-normal mt-0.5 line-clamp-2 max-w-xs">{row.instructions}</div>
                    )}
                  </td>
                  <td className="p-3 text-charcoal/80">
                    {row.source}
                    {row.sourceUrl && (
                      <a href={row.sourceUrl} target="_blank" rel="noreferrer" className="text-copper hover:underline inline-flex items-center gap-0.5 ms-1 align-middle">
                        <ExternalLink size={11} />
                      </a>
                    )}
                  </td>
                  <td className="p-3 text-charcoal/80">{row.frequency}</td>
                  <td className="p-3 text-charcoal/60 tabular-nums">{row.lastMigrated || dash}</td>
                  <td className="p-3 text-charcoal/60 tabular-nums">{row.nextDue || dash}</td>
                  <td className="p-3">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${row.active ? 'bg-green-100 text-green-700' : 'bg-charcoal/5 text-charcoal/40'}`}>
                      {row.active ? (isAr ? 'نشط' : 'Active') : (isAr ? 'متوقف' : 'Paused')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
