import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { ArrowRight, ArrowLeft, Loader2, Sparkles, CheckSquare, Square, Calculator } from 'lucide-react';
import { mappingTargets, targetFieldLites, countableFields } from '../../lib/targetFields';
import { suggestMappings } from '../../lib/client';
import type { AppModel } from '@/types';
import type { RawTable, ColumnMappingSuggestion } from '../../lib/types';

interface StepMappingProps {
  isAr: boolean;
  model: AppModel;
  table: RawTable;
  mappings: Record<number, string | null> | undefined;
  suggestions: ColumnMappingSuggestion[] | undefined;
  countFields: string[] | undefined;
  onMappings: (mappings: Record<number, string | null>, suggestions?: ColumnMappingSuggestion[]) => void;
  onCountFields: (next: string[]) => void;
  onContinue: () => void;
  onBack: () => void;
}

/** Exact/contains header→field fallback used only if the AI call fails, so the
 * grid is still usable for manual mapping. */
function seedMappings(table: RawTable, targets: { value: string; label: string }[]): Record<number, string | null> {
  const out: Record<number, string | null> = {};
  table.headers.forEach((h, i) => {
    const hl = h.trim().toLowerCase();
    const m = targets.find((t) => t.label.trim().toLowerCase() === hl);
    out[i] = m ? m.value : null;
  });
  return out;
}

export default function StepMapping({
  isAr,
  model,
  table,
  mappings,
  suggestions,
  countFields,
  onMappings,
  onCountFields,
  onContinue,
  onBack,
}: StepMappingProps) {
  const addToast = useAppStore((s) => s.addToast);
  const [loading, setLoading] = useState(false);
  const fetched = useRef(false);
  const Next = isAr ? ArrowLeft : ArrowRight;
  const Back = isAr ? ArrowRight : ArrowLeft;
  const counted = new Set(countFields ?? []);
  // Counted fields are computed by the AI, not mapped from a column — exclude
  // them as column targets.
  const targets = mappingTargets(model, isAr).filter((t) => !counted.has(t.value));
  const countables = countableFields(model);

  useEffect(() => {
    if (mappings !== undefined || fetched.current) return;
    fetched.current = true;
    setLoading(true);
    void (async () => {
      try {
        const sug = await suggestMappings(table.headers, table.rows.slice(0, 6), targetFieldLites(model), isAr ? 'ar' : 'en');
        const next: Record<number, string | null> = {};
        table.headers.forEach((_, i) => {
          const s = sug.find((x) => x.columnIndex === i);
          next[i] = s && s.fieldName ? s.fieldName : null;
        });
        onMappings(next, sug);
      } catch (err) {
        addToast(
          (isAr ? 'تعذّر اقتراح الربط: ' : 'Mapping suggestion failed: ') +
            (err instanceof Error ? err.message : String(err)),
          'error',
        );
        onMappings(seedMappings(table, targets)); // manual fallback
      } finally {
        setLoading(false);
      }
    })();
  }, [mappings, table, model, targets, onMappings, addToast, isAr]);

  const current = mappings ?? {};
  const mappedCount = Object.values(current).filter(Boolean).length;
  const sampleFor = (i: number) =>
    table.rows.slice(0, 4).map((r) => r[i] ?? '').filter(Boolean).slice(0, 2).join(' · ');

  const toggleCount = (slug: string) => {
    const set = new Set(counted);
    if (set.has(slug)) {
      set.delete(slug);
    } else {
      set.add(slug);
      // A counted field is AI-computed, not column-mapped — clear any column
      // currently pointed at it.
      const cleared: Record<number, string | null> = { ...current };
      let changed = false;
      for (const [k, v] of Object.entries(cleared)) {
        if (v === slug) {
          cleared[Number(k)] = null;
          changed = true;
        }
      }
      if (changed) onMappings(cleared, suggestions);
    }
    onCountFields([...set]);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center text-center p-12 gap-3 h-full">
        <Loader2 size={30} className="text-copper animate-spin" />
        <div className="font-semibold text-charcoal">
          {isAr ? 'يقترح الذكاء ربط الأعمدة…' : 'AI is suggesting column mappings…'}
        </div>
      </div>
    );
  }

  return (
    <div className="p-5 flex flex-col h-full">
      <div className="mb-3">
        <h3 className="font-bold text-charcoal">{isAr ? 'ربط الأعمدة بالحقول' : 'Map columns to fields'}</h3>
        <p className="text-xs text-charcoal/50">
          {isAr
            ? `اربط كل عمود بالحقل المناسب. ${mappedCount} من ${table.headers.length} مرتبط.`
            : `Link each column to its field. ${mappedCount} of ${table.headers.length} mapped.`}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pe-1">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {table.headers.map((header, idx) => {
          const mapped = current[idx] ?? '';
          const sug = suggestions?.find((s) => s.columnIndex === idx);
          const sample = sampleFor(idx);
          return (
            <div
              key={idx}
              className={`p-3 rounded-xl border transition-colors ${
                mapped ? 'border-copper/20 bg-copper/[0.02]' : 'border-sand/20 bg-white'
              }`}
            >
              <div className="text-sm font-bold text-charcoal truncate">{header || (isAr ? '(بدون اسم)' : '(unnamed)')}</div>
              {sample && <div className="text-[11px] text-charcoal/40 truncate mb-1">{sample}</div>}
              <select
                value={mapped || '__skip__'}
                onChange={(e) => {
                  const val = e.target.value === '__skip__' ? null : e.target.value;
                  onMappings({ ...current, [idx]: val }, suggestions);
                }}
                className="form-input text-sm py-1.5 w-full"
              >
                <option value="__skip__">{isAr ? 'تجاهل هذا العمود' : 'Skip this column'}</option>
                {targets.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              {sug && sug.fieldName && mapped === sug.fieldName && (
                <div className="flex items-center gap-1 mt-1.5 text-[11px] text-copper/80">
                  <Sparkles size={11} />
                  {isAr ? 'اقتراح ذكي' : 'AI suggested'}
                  {sug.confidence ? ` · ${Math.round(sug.confidence * 100)}%` : ''}
                </div>
              )}
            </div>
          );
        })}
        </div>

        {countables.length > 0 && (
          <div className="mt-4 pt-3 border-t border-sand/20">
            <div className="flex items-center gap-1.5 mb-1">
              <Calculator size={14} className="text-copper" />
              <span className="text-sm font-bold text-charcoal">
                {isAr ? 'حقول تُحسب تلقائيًا' : 'AI-counted fields'}
              </span>
            </div>
            <p className="text-xs text-charcoal/50 mb-2">
              {isAr
                ? 'لهذه الحقول الرقمية، يقرأ الذكاء وصف كل وحدة ويحسب الإجمالي (مثل إجمالي الحمامات أو الغرف) بدلاً من ربطها بعمود.'
                : "For these number fields the AI reads each unit's full description and computes the total (e.g. total bathrooms / bedrooms) instead of mapping a single column."}
            </p>
            <div className="flex flex-wrap gap-2">
              {countables.map((f) => {
                const on = counted.has(f.name);
                return (
                  <button
                    key={f.id}
                    onClick={() => toggleCount(f.name)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors ${
                      on ? 'border-copper bg-copper/10 text-copper' : 'border-sand/40 text-charcoal/70 hover:bg-cream'
                    }`}
                  >
                    {on ? <CheckSquare size={14} /> : <Square size={14} />}
                    {isAr ? f.label_ar : f.label_en}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-sand/20">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-charcoal/60 hover:bg-cream transition-colors"
        >
          <Back size={15} />
          {isAr ? 'رجوع' : 'Back'}
        </button>
        <button
          onClick={onContinue}
          disabled={mappedCount === 0}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 transition-colors font-medium"
        >
          {isAr ? 'مراجعة القيم' : 'Review values'}
          <Next size={15} />
        </button>
      </div>
    </div>
  );
}
