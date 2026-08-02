/**
 * Record-value translations Review panel (bilingual W2, REV 4 §D3/W9-early).
 *
 * The gate between imported legacy seeds and anything a user ever sees:
 * per-model → per-field seed batches with random sample pairs; an admin
 * ACCEPTS a batch (activates every generation-valid seed candidate — the only
 * path a seed can reach display) or REJECTS it (candidates marked rejected;
 * the worker regenerates fresh at cutover). Also shows the live unit/variant
 * counts per model so the cutover state is observable in-app.
 *
 * All mutations go through the admin-gated SQL RPCs
 * (translation_seed_accept — auth checked in-body); this panel is display +
 * intent only.
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Check, X, RefreshCw, Languages } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import { useIsAr } from '@/hooks/useLang';

interface OverviewRow {
  model_id: string; model_name: string;
  units: number; dirty: number; pending: number;
  translated: number; approved: number; failed: number;
  seeds_awaiting: number;
}

interface FieldSummary {
  field_path: string;
  seed_count: number;
  accepted_count: number;
  samples: Array<{ src: string; en: string }> | null;
}

export default function RecordValueTranslationsPanel() {
  const isAr = useIsAr();
  const addToast = useAppStore((s) => s.addToast);
  const [rows, setRows] = useState<OverviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openModel, setOpenModel] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, FieldSummary[]>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error: err } = await supabase.rpc('translation_review_overview');
    if (err) { setError(err.message); return; }
    setError(null);
    setRows((data ?? []) as OverviewRow[]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openFields = async (modelId: string) => {
    if (openModel === modelId) { setOpenModel(null); return; }
    setOpenModel(modelId);
    if (!fields[modelId] && supabase) {
      const { data, error: err } = await supabase.rpc('translation_seed_field_summary', {
        p_model_id: modelId,
      });
      if (err) { addToast(err.message, 'error'); return; }
      setFields((f) => ({ ...f, [modelId]: (data ?? []) as FieldSummary[] }));
    }
  };

  const decide = async (modelId: string, fieldPath: string, accept: boolean) => {
    if (!supabase) return;
    const key = `${modelId}:${fieldPath}`;
    setBusyKey(key);
    const { data, error: err } = await supabase.rpc('translation_seed_accept', {
      p_model_id: modelId, p_field_path: fieldPath, p_accept: accept,
    });
    setBusyKey(null);
    if (err) { addToast(err.message, 'error'); return; }
    addToast(
      accept
        ? (isAr ? `تم اعتماد ${data} ترجمة لحقل ${fieldPath}` : `Accepted ${data} translations for ${fieldPath}`)
        : (isAr ? `تم رفض دفعة ${fieldPath} — ستُعاد ترجمتها` : `Rejected ${fieldPath} batch — will be regenerated`),
      'success',
    );
    // Refresh in place — keep the current list rendered while the fresh data
    // loads (blanking it to "Loading…" flashed the whole panel on every
    // accept/reject).
    const { data: fresh } = await supabase.rpc('translation_seed_field_summary', { p_model_id: modelId });
    setFields((f) => ({ ...f, [modelId]: (fresh ?? []) as FieldSummary[] }));
    void load();
  };

  if (!supabase) return null;

  return (
    <div className="card p-5 mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Languages size={18} className="text-copper" />
          <h2 className="font-bold text-charcoal">
            {isAr ? 'ترجمات قيم السجلات (ثنائي اللغة)' : 'Record value translations (bilingual)'}
          </h2>
        </div>
        <button onClick={() => void load()} className="text-copper hover:text-terracotta" title={isAr ? 'تحديث' : 'Refresh'}>
          <RefreshCw size={16} />
        </button>
      </div>
      <p className="text-xs text-charcoal/50 mb-4">
        {isAr
          ? 'اعتمد دفعات الترجمات المستوردة (عيّنة لكل حقل) قبل أن تظهر لأي مستخدم. الرفض يعيد الترجمة آلياً عند التفعيل.'
          : 'Accept imported translation batches (sampled per field) before anything is shown to users. Rejecting regenerates them at cutover.'}
      </p>

      {error && <div className="text-sm text-red-600 mb-3">{error}</div>}
      {rows === null && !error && (
        <div className="text-sm text-charcoal/40">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>
      )}
      {rows !== null && rows.length === 0 && (
        <div className="text-sm text-charcoal/40">
          {isAr ? 'لا توجد وحدات ترجمة بعد.' : 'No translation units yet.'}
        </div>
      )}

      {(rows ?? []).map((r) => (
        <div key={r.model_id} className="border border-sand/40 rounded-lg mb-2">
          <button
            onClick={() => void openFields(r.model_id)}
            className="w-full flex items-center justify-between px-3 py-2 text-start"
          >
            <span className="font-bold text-sm text-charcoal">{r.model_name}</span>
            <span className="flex items-center gap-3 text-xs text-charcoal/50">
              <span>{isAr ? `وحدات ${r.units}` : `${r.units} units`}</span>
              {r.seeds_awaiting > 0 && (
                <span className="text-copper font-bold">
                  {isAr ? `بانتظار الاعتماد ${r.seeds_awaiting}` : `${r.seeds_awaiting} awaiting acceptance`}
                </span>
              )}
              {r.failed > 0 && <span className="text-red-600">{isAr ? `فشل ${r.failed}` : `${r.failed} failed`}</span>}
              <span>{isAr ? `مترجم ${r.translated + r.approved}` : `${r.translated + r.approved} translated`}</span>
              {openModel === r.model_id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </span>
          </button>

          {openModel === r.model_id && (
            <div className="border-t border-sand/30 px-3 py-2">
              {!fields[r.model_id] && <div className="text-xs text-charcoal/40 py-2">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>}
              {fields[r.model_id]?.length === 0 && (
                <div className="text-xs text-charcoal/40 py-2">{isAr ? 'لا توجد دفعات مستوردة لهذا النموذج.' : 'No imported batches for this model.'}</div>
              )}
              {fields[r.model_id]?.map((f) => (
                <div key={f.field_path} className="py-2 border-b border-sand/20 last:border-b-0">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-charcoal/80" dir="ltr">{f.field_path}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-charcoal/40">
                        {isAr ? `مرشح ${f.seed_count} · معتمد ${f.accepted_count}` : `${f.seed_count} candidate · ${f.accepted_count} accepted`}
                      </span>
                      {f.seed_count > 0 && (
                        <>
                          <button
                            disabled={busyKey === `${r.model_id}:${f.field_path}`}
                            onClick={() => void decide(r.model_id, f.field_path, true)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold bg-copper text-white hover:bg-terracotta disabled:opacity-50"
                          >
                            <Check size={12} /> {isAr ? 'اعتماد الدفعة' : 'Accept batch'}
                          </button>
                          <button
                            disabled={busyKey === `${r.model_id}:${f.field_path}`}
                            onClick={() => void decide(r.model_id, f.field_path, false)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold border border-sand text-charcoal/60 hover:text-red-600 hover:border-red-300 disabled:opacity-50"
                          >
                            <X size={12} /> {isAr ? 'رفض' : 'Reject'}
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                  {(f.samples ?? []).slice(0, 5).map((s, i) => (
                    <div key={i} className="mt-1 grid grid-cols-2 gap-2 text-xs bg-cream-light/40 rounded p-1.5">
                      <span dir="rtl" className="text-charcoal/70 truncate">{s.src}</span>
                      <span dir="ltr" className="text-charcoal/70 truncate">{s.en}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
