import { useMemo } from 'react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { ArrowRight, ArrowLeft, PlayCircle, AlertTriangle, Plus, Link2, CornerDownRight, Ban, CheckCircle2 } from 'lucide-react';
import { buildMigrationPlan, isRecordValid } from '../../lib/runMigration';
import { projectNameField } from '../../lib/buildRecords';
import { resolveDisplay } from '../../lib/previewRecords';
import { isProjectProfileTarget } from '../../lib/types';
import type { AppModel, ModelField } from '@/types';
import type { RawTable, ColumnStandardization, BuiltRecord, RowIssue, ProjectIntelligenceSection } from '../../lib/types';

interface StepPreviewProps {
  isAr: boolean;
  model: AppModel;
  table: RawTable;
  mappings: Record<number, string | null>;
  standardization: Record<number, ColumnStandardization> | undefined;
  /** PROJECT-PROFILE mode: injected into each record's marketing_document. */
  projectDocument?: string;
  /** PROJECT-PROFILE mode: injected (rendered) into each record's project_analysis. */
  projectIntelligence?: ProjectIntelligenceSection[];
  /** PROJECT-PROFILE mode: which existing project to UPDATE (undefined = auto by
   * name, null = create new, id = that record). */
  projectUpdateTargetId?: string | null;
  onProjectUpdateTarget?: (target: string | null) => void;
  excludedRows: number[] | undefined;
  onChangeExcluded: (next: number[]) => void;
  onConfirm: () => void;
  onBack: () => void;
  /** The migration already ran (status='done'): this is now a READ-ONLY review
   * of what was migrated — the Migrate action is replaced by "View result" so
   * the import can never be re-run from here. */
  alreadyMigrated?: boolean;
  onViewResult?: () => void;
}

const RENDER_CAP = 500;

/** Bilingual one-liner for a row issue. */
function issueText(issue: RowIssue, isAr: boolean): string {
  const f = issue.fieldLabel;
  const raw = issue.raw ? ` "${issue.raw}"` : '';
  switch (issue.code) {
    case 'unresolved_option':
      return isAr ? `قيمة${raw} غير معروفة في ${f}` : `${f}: value${raw} not a known option`;
    case 'unresolved_lookup':
      return isAr ? `لا يوجد سجل مطابق${raw} في ${f}` : `${f}: no matching record${raw}`;
    case 'required_blank':
      return isAr ? `${f} مطلوب وفارغ` : `${f} is required but empty`;
    case 'route_invalid':
      return isAr ? `قيمة محوّلة${raw} غير صالحة لـ ${f}` : `${f}: routed value${raw} is invalid`;
    case 'create_blocked':
      return (isAr ? `تعذّر الإنشاء في ${f}: ` : `${f}: can't create — `) + (issue.detail ?? '');
    case 'invalid_number':
      return isAr ? `قيمة رقمية غير صالحة في ${f}` : `${f}: not a valid number`;
    default:
      return isAr ? `قيمة غير صالحة في ${f}` : `${f}: invalid value`;
  }
}

/**
 * Step "preview" — the final approval gate. Builds the exact records that would
 * be created (no writes) via the shared `buildMigrationPlan`, shows resolved
 * display values + per-cell action markers (link / new / routed), and surfaces
 * pending creates and validation errors. Rows with a blocking error are shown
 * but cannot be selected — they never migrate. Only valid + approved records do.
 */
export default function StepPreview({
  isAr,
  model,
  table,
  mappings,
  standardization,
  projectDocument,
  projectIntelligence,
  projectUpdateTargetId,
  onProjectUpdateTarget,
  excludedRows,
  onChangeExcluded,
  onConfirm,
  onBack,
  alreadyMigrated,
  onViewResult,
}: StepPreviewProps) {
  const allModels = useAppStore((s) => s.models);
  const allRecords = useAppStore((s) => s.records);
  const Next = isAr ? ArrowLeft : ArrowRight;
  const Back = isAr ? ArrowRight : ArrowLeft;

  const plan = useMemo(
    () =>
      buildMigrationPlan({
        model,
        table,
        mappings,
        standardization: standardization ?? {},
        projectDocument,
        projectIntelligence,
        projectUpdateTargetId,
        allModels,
        allRecords,
        isAr,
        makeId: uuid,
      }),
    [model, table, mappings, standardization, projectDocument, projectIntelligence, projectUpdateTargetId, allModels, allRecords, isAr],
  );

  // PROJECT-PROFILE: pick whether this migration UPDATES an existing project (so
  // its units/rollups are kept) or creates a new one. Default = the name-matched
  // project the plan resolved.
  const projectMode = isProjectProfileTarget(model);
  const nameField = useMemo(() => projectNameField(model), [model]);
  const existingProjects = useMemo(() => {
    if (!projectMode || !nameField) return [] as { id: string; name: string }[];
    return (allRecords[model.id] ?? [])
      .map((r) => ({ id: r.id, name: String(r.data[nameField.name] ?? '').trim() || (isAr ? '(بدون اسم)' : '(no name)') }))
      .sort((a, b) => a.name.localeCompare(b.name, isAr ? 'ar' : 'en'));
  }, [projectMode, nameField, allRecords, model.id, isAr]);
  // Effective target the plan resolved (auto-match or explicit pick); '' = new.
  const effectiveTargetId = plan.records[0]?.matchedExistingId ?? '';

  // temp-id → label, so "create new" lookup decisions show the real name.
  const pendingLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of plan.newLookupRecords) m.set(p.tempId, p.label);
    return m;
  }, [plan.newLookupRecords]);

  // Columns = the importable fields actually populated by any record, in schema order.
  const columns: ModelField[] = useMemo(() => {
    const present = new Set<string>();
    plan.records.forEach((r) => Object.keys(r.data).forEach((k) => present.add(k)));
    return model.schema.sections.flatMap((s) => s.fields).filter((f) => present.has(f.name));
  }, [plan, model]);

  const excluded = new Set(excludedRows ?? []);
  const valid = (r: BuiltRecord) => isRecordValid(r);
  const invalidCount = plan.records.filter((r) => !valid(r)).length;
  const warnCount = plan.records.filter((r) => valid(r) && r.issues.length > 0).length;
  const approvedCount = plan.records.filter((r) => valid(r) && !excluded.has(r.rowIndex)).length;
  const selectableCount = plan.records.filter((r) => valid(r)).length;

  const toggle = (rowIndex: number) => {
    const next = new Set(excluded);
    if (next.has(rowIndex)) next.delete(rowIndex);
    else next.add(rowIndex);
    onChangeExcluded([...next]);
  };
  // "Approve all" only un-excludes valid rows; invalid rows stay out anyway.
  const selectAll = () => onChangeExcluded([]);
  const selectNone = () => onChangeExcluded(plan.records.filter(valid).map((r) => r.rowIndex));

  const shown = plan.records.slice(0, RENDER_CAP);

  const actionBadge = (rec: BuiltRecord, fieldName: string) => {
    const meta = rec.audit[fieldName];
    if (!meta) return null;
    switch (meta.action) {
      case 'create_option':
      case 'create_record':
        return <Plus size={11} className="inline text-amber-600 shrink-0" />;
      case 'link':
        return <Link2 size={11} className="inline text-copper/70 shrink-0" />;
      case 'route':
        return <CornerDownRight size={11} className="inline text-blue-600 shrink-0" />;
      default:
        return null;
    }
  };

  return (
    <div className="p-5 flex flex-col h-full">
      {alreadyMigrated && (
        <div className="mb-3 shrink-0 flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-green-50 border border-green-200 text-sm text-charcoal/80">
          <CheckCircle2 size={16} className="text-green-500 shrink-0" />
          {isAr
            ? 'تم ترحيل هذه العملية بالفعل — هذه معاينة للقراءة فقط، لا يمكن إعادة الترحيل.'
            : "This migration already ran — this is a read-only review; it can't be re-run."}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-charcoal">
            {isAr ? 'راجع السجلات قبل الترحيل' : 'Review the records before migrating'}
          </h3>
          <p className="text-xs text-charcoal/50">
            {isAr
              ? `${approvedCount} من ${plan.records.length} سجل ستتم إضافته إلى ${model.label_ar}.`
              : `${approvedCount} of ${plan.records.length} records will be added to ${model.label_en}.`}
            {plan.skipped > 0 && (isAr ? ` تم تخطي ${plan.skipped} مكرر.` : ` ${plan.skipped} duplicates skipped.`)}
            {(projectDocument ?? '').trim() !== '' &&
              (isAr ? ' تتضمن الوثيقة التسويقية للمشروع.' : ' Includes the project marketing document.')}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button onClick={selectAll} className="px-2.5 py-1 rounded-lg bg-copper/10 text-copper font-bold hover:bg-copper/20">
            {isAr ? 'الموافقة على الكل' : 'Approve all'}
          </button>
          <button onClick={selectNone} className="px-2.5 py-1 rounded-lg bg-charcoal/5 text-charcoal/60 font-bold hover:bg-charcoal/10">
            {isAr ? 'إلغاء الكل' : 'Deselect all'}
          </button>
        </div>
      </div>

      {/* PROJECT-PROFILE: create-new vs update-an-existing-project target. */}
      {projectMode && existingProjects.length > 0 && (
        <div className="mb-3 rounded-xl border border-copper/30 bg-copper/[0.04] p-3">
          <div className="text-xs font-bold text-charcoal mb-1.5">
            {isAr ? 'وجهة الترحيل' : 'Migration target'}
          </div>
          <select
            value={effectiveTargetId}
            onChange={(e) => onProjectUpdateTarget?.(e.target.value || null)}
            className="form-input text-sm py-1.5 w-full max-w-md"
          >
            <option value="">{isAr ? '✦ إنشاء مشروع جديد' : '✦ Create a new project'}</option>
            {existingProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {(isAr ? 'تحديث: ' : 'Update: ') + p.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-charcoal/55 mt-1.5">
            {effectiveTargetId
              ? isAr
                ? 'سيُحدَّث المشروع الموجود (مع الإبقاء على وحداته وأرقامه المحسوبة)؛ تُكتب عليه البيانات والوثيقة التسويقية والتحليل.'
                : 'The existing project is updated (its units + computed rollups are kept); the data, marketing document, and analysis are written onto it.'
              : isAr
                ? 'سيُنشأ مشروع جديد. اختر مشروعًا موجودًا أعلاه لتحديثه بدلًا من إنشاء نسخة مكررة.'
                : 'A new project will be created. Pick an existing project above to update it instead of making a duplicate.'}
          </p>
        </div>
      )}

      {/* Pending creates + validation summary */}
      {(plan.newOptions.length > 0 || plan.newLookupRecords.length > 0 || invalidCount > 0 || warnCount > 0) && (
        <div className="flex flex-wrap gap-1.5 mb-3 text-[11px]">
          {plan.newLookupRecords.length > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 text-amber-700 border border-amber-200">
              <Plus size={11} />
              {isAr ? `${plan.newLookupRecords.length} سجل مرتبط جديد` : `${plan.newLookupRecords.length} new linked records`}
            </span>
          )}
          {plan.newOptions.length > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 text-amber-700 border border-amber-200">
              <Plus size={11} />
              {isAr ? `${plan.newOptions.length} خيار جديد` : `${plan.newOptions.length} new options`}
              {plan.newOptions.some((o) => o.frozen) && (isAr ? ' (يُضاف للمخطط)' : ' (added to schema)')}
            </span>
          )}
          {invalidCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-red-50 text-red-700 border border-red-200">
              <Ban size={11} />
              {isAr ? `${invalidCount} صف لا يمكن ترحيله` : `${invalidCount} rows can't migrate`}
            </span>
          )}
          {warnCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-gold/10 text-charcoal/70 border border-gold/30">
              <AlertTriangle size={11} />
              {isAr ? `${warnCount} تنبيه` : `${warnCount} warnings`}
            </span>
          )}
        </div>
      )}

      {plan.records.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 text-charcoal/60">
          <AlertTriangle size={26} className="text-amber-500" />
          <p className="text-sm">
            {isAr
              ? 'لا توجد سجلات للترحيل. تأكد من ربط الأعمدة بالحقول.'
              : 'No records to migrate. Check that columns are mapped to fields.'}
          </p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto border border-sand/30 rounded-xl">
          <table className="text-sm border-collapse min-w-full">
            <thead className="sticky top-0 z-10 bg-cream-light">
              <tr>
                <th className="w-12 border-b border-e border-sand/20 p-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={selectableCount > 0 && approvedCount === selectableCount}
                    ref={(el) => {
                      if (el) el.indeterminate = approvedCount > 0 && approvedCount < selectableCount;
                    }}
                    onChange={(e) => (e.target.checked ? selectAll() : selectNone())}
                    className="accent-copper"
                  />
                </th>
                <th className="w-10 border-b border-e border-sand/20 p-1.5 text-charcoal/40 text-xs font-normal">#</th>
                {columns.map((f) => (
                  <th key={f.id} className="border-b border-e border-sand/20 p-2 text-start font-bold text-charcoal whitespace-nowrap min-w-[120px]">
                    {isAr ? f.label_ar : f.label_en}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((rec, i) => {
                const isValid = valid(rec);
                const on = isValid && !excluded.has(rec.rowIndex);
                const errs = rec.issues.filter((x) => x.severity === 'error');
                const fieldsWithError = new Set(errs.map((x) => x.fieldName));
                return (
                  <tr
                    key={rec.rowIndex}
                    className={
                      !isValid
                        ? 'bg-red-50/60'
                        : on
                          ? 'hover:bg-cream/40'
                          : 'opacity-40 bg-charcoal/[0.02]'
                    }
                  >
                    <td className="border-b border-e border-sand/10 p-1.5 text-center align-middle">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!isValid}
                        title={!isValid ? (isAr ? 'صف غير صالح — لا يمكن ترحيله' : 'Invalid row — cannot migrate') : undefined}
                        onChange={() => toggle(rec.rowIndex)}
                        className="accent-copper disabled:opacity-40"
                      />
                    </td>
                    <td className="border-b border-e border-sand/10 p-1.5 text-center text-charcoal/30 text-xs align-middle">
                      {i + 1}
                    </td>
                    {columns.map((f) => {
                      const cellErr = fieldsWithError.has(f.name);
                      return (
                        <td
                          key={f.id}
                          className={`border-b border-e border-sand/10 p-2 align-middle ${cellErr ? 'text-red-600' : 'text-charcoal'}`}
                        >
                          <span className="inline-flex items-center gap-1">
                            {actionBadge(rec, f.name)}
                            {f.type === 'textarea' ? (
                              <span className="max-w-[320px] line-clamp-3 whitespace-pre-wrap text-xs">
                                {resolveDisplay(f, rec.data[f.name], allRecords, pendingLabels, isAr)}
                              </span>
                            ) : (
                              resolveDisplay(f, rec.data[f.name], allRecords, pendingLabels, isAr)
                            )}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {plan.records.length > RENDER_CAP && (
            <div className="p-2 text-xs text-amber-700 bg-amber-50 border-t border-amber-200">
              {isAr
                ? `يتم عرض أول ${RENDER_CAP} من ${plan.records.length} سجل. زر «الموافقة على الكل» يشمل جميع السجلات الصالحة.`
                : `Showing the first ${RENDER_CAP} of ${plan.records.length}. "Approve all" covers every valid record.`}
            </div>
          )}
        </div>
      )}

      {/* Per-row issue list (errors + warnings) for the shown rows */}
      {shown.some((r) => r.issues.length > 0) && (
        <div className="mt-3 max-h-32 overflow-y-auto rounded-xl border border-sand/30 bg-cream-light/40 p-2 space-y-1">
          {shown.map((rec, i) =>
            rec.issues.length === 0 ? null : (
              <div key={rec.rowIndex} className="text-[11px] flex items-start gap-1.5">
                <span className="text-charcoal/40 shrink-0 mt-0.5">#{i + 1}</span>
                <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                  {rec.issues.map((issue, k) => (
                    <span
                      key={k}
                      className={issue.severity === 'error' ? 'text-red-600' : 'text-charcoal/55'}
                    >
                      {issue.severity === 'error' ? '⛔ ' : '⚠ '}
                      {issueText(issue, isAr)}
                    </span>
                  ))}
                </span>
              </div>
            ),
          )}
        </div>
      )}

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-sand/20">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-charcoal/60 hover:bg-cream transition-colors"
        >
          <Back size={15} />
          {isAr ? 'رجوع' : 'Back'}
        </button>
        {alreadyMigrated ? (
          <button
            onClick={onViewResult}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors font-medium"
          >
            <CheckCircle2 size={16} />
            {isAr ? 'عرض النتيجة' : 'View result'}
            <Next size={15} />
          </button>
        ) : (
          <button
            onClick={onConfirm}
            disabled={approvedCount === 0}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 transition-colors font-medium"
          >
            <PlayCircle size={16} />
            {isAr ? `ترحيل ${approvedCount} سجل` : `Migrate ${approvedCount} records`}
            <Next size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
