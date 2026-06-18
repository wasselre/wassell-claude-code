import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Loader2, ArrowRight, ArrowLeft, Eye, CheckCircle2 } from 'lucide-react';
import {
  standardizableColumns,
  distinctColumnValues,
  isMultiValueColumn,
  importableFields,
} from '../../lib/targetFields';
import { optionCandidates, lookupCandidates, buildColumnStandardization, preResolveColumn } from '../../lib/buildStandardization';
import { standardizeColumn, type StandardizeDecision } from '../../lib/client';
import ValueStandardizationColumn from '../ValueStandardizationColumn';
import type { AppModel } from '@/types';
import type { RawTable, ColumnStandardization } from '../../lib/types';

interface StepStandardizeProps {
  isAr: boolean;
  model: AppModel;
  table: RawTable;
  mappings: Record<number, string | null>;
  standardization: Record<number, ColumnStandardization> | undefined;
  onChangeColumn: (colIndex: number, plan: ColumnStandardization) => void;
  /** Persist the whole initial computation (all columns) in ONE save — avoids a
   * burst of racing patches that the optimistic-version check would reject. */
  onComputed: (std: Record<number, ColumnStandardization>) => void;
  onProceed: () => void;
  onBack: () => void;
}

export default function StepStandardize({
  isAr,
  model,
  table,
  mappings,
  standardization,
  onChangeColumn,
  onComputed,
  onProceed,
  onBack,
}: StepStandardizeProps) {
  const addToast = useAppStore((s) => s.addToast);
  const allRecords = useAppStore((s) => s.records);
  const allModels = useAppStore((s) => s.models);
  const [loading, setLoading] = useState(false);
  const fetched = useRef(false);
  const Back = isAr ? ArrowRight : ArrowLeft;

  const cols = standardizableColumns(model, mappings);

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    const missingCols = cols.filter((c) => !standardization?.[c.colIndex]);
    if (missingCols.length === 0) return;
    setLoading(true);
    void (async () => {
      // Run every column-standardization in PARALLEL, then persist them all in
      // ONE save (onComputed). One save per call previously raced the
      // optimistic-version check and looped the spinner forever.
      const stdTasks = missingCols.map(async (c) => {
        const multi = isMultiValueColumn(c.field);
        const distinct = distinctColumnValues(table.rows, c.colIndex, multi);
        // Deterministic normalized match first (links existing options/records
        // regardless of how large the lookup target is); AI only for the rest.
        const { decisions: preDecisions, unmatched } = preResolveColumn(c.field, c.fieldType, distinct, allRecords);
        let aiDecisions: StandardizeDecision[] = [];
        if (unmatched.length > 0) {
          try {
            const candidates =
              c.fieldType === 'lookup'
                ? lookupCandidates(c.field, allRecords).slice(0, 300)
                : optionCandidates(c.field);
            aiDecisions = await standardizeColumn({
              fieldType: c.fieldType,
              fieldLabel: isAr ? c.field.label_ar : c.field.label_en,
              candidates,
              rawValues: unmatched.map((d) => d.raw),
              language: isAr ? 'ar' : 'en',
            });
          } catch (err) {
            addToast(
              (isAr ? 'تعذّر توحيد القيم: ' : 'Standardization failed: ') +
                (err instanceof Error ? err.message : String(err)),
              'error',
            );
            // leave AI-less; unmatched stay 'unmatched' for manual resolution
          }
        }
        return {
          colIndex: c.colIndex,
          plan: buildColumnStandardization(c.colIndex, c.field, c.fieldType, distinct, [...preDecisions, ...aiDecisions], isAr),
        };
      });

      const stdDone = await Promise.all(stdTasks);
      const stdAcc: Record<number, ColumnStandardization> = {};
      stdDone.forEach((r) => {
        stdAcc[r.colIndex] = r.plan;
      });
      if (Object.keys(stdAcc).length > 0) {
        onComputed(stdAcc);
      }
      setLoading(false);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Routing destinations: any importable field except range (needs .min/.max)
  // and table (needs sub-column row assembly, not a single routed value).
  const otherScalarFields = importableFields(model).filter((f) => f.type !== 'range' && f.type !== 'table');

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center text-center p-12 gap-3 h-full">
        <Loader2 size={30} className="text-copper animate-spin" />
        <div className="font-semibold text-charcoal">
          {isAr ? 'يراجع الذكاء القيم ويقترح التوحيد…' : 'AI is reviewing values and proposing fixes…'}
        </div>
      </div>
    );
  }

  return (
    <div className="p-5 flex flex-col h-full">
      <div className="mb-3">
        <h3 className="font-bold text-charcoal">{isAr ? 'راجع القيم قبل الترحيل' : 'Review values before migrating'}</h3>
        <p className="text-xs text-charcoal/50">
          {isAr
            ? 'وافق على كل تحويل أو غيّره. لا شيء يُطبَّق قبل الضغط على «ترحيل».'
            : 'Approve or change each transformation. Nothing is applied until you click Migrate.'}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-2.5 pe-1">
        {cols.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-10 gap-2 text-charcoal/60">
            <CheckCircle2 size={28} className="text-green-500" />
            <p className="text-sm">
              {isAr
                ? 'لا توجد حقول قوائم أو بحث تحتاج توحيدًا — جاهز للترحيل.'
                : 'No dropdown / lookup fields need standardizing — ready to migrate.'}
            </p>
          </div>
        ) : (
          cols.map((c) => {
            const plan = standardization?.[c.colIndex];
            if (!plan) return null;
            return (
              <ValueStandardizationColumn
                key={c.colIndex}
                isAr={isAr}
                header={table.headers[c.colIndex] ?? ''}
                fieldLabel={isAr ? c.field.label_ar : c.field.label_en}
                field={c.field}
                model={model}
                allModels={allModels}
                plan={plan}
                otherFields={otherScalarFields
                  .filter((f) => f.name !== c.field.name)
                  .map((f) => ({ name: f.name, label: isAr ? f.label_ar : f.label_en }))}
                onChange={(next) => onChangeColumn(c.colIndex, next)}
              />
            );
          })
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
          onClick={onProceed}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors font-medium"
        >
          <Eye size={16} />
          {isAr ? 'معاينة السجلات' : 'Preview records'}
        </button>
      </div>
    </div>
  );
}
