import { useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type {
  SalesExperiment, SalesExperimentAssignmentMode, SalesPrimaryMetric, SalesGuardrailMetric, SalesExperimentTargetRules,
} from '@/types';
import {
  PRIMARY_METRIC_OPTIONS, PRIMARY_METRIC_LABELS, GUARDRAIL_METRIC_OPTIONS, GUARDRAIL_METRIC_LABELS, pick,
} from '../lib/labels';

const splitList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);
const joinList = (a: string[] | undefined): string => (a ?? []).join(', ');

/** Create / edit a sales experiment. status starts as draft. */
export default function ExperimentBuilderModal({
  open, onClose, existing,
}: {
  open: boolean;
  onClose: () => void;
  existing?: SalesExperiment | null;
}) {
  const { language, salesProcesses, salesProcessVersions, currentUserId, saveSalesExperiment, addToast } = useAppStore();
  const isAr = language === 'ar';

  const versionOptions = useMemo(() => salesProcessVersions
    .filter((v) => v.status !== 'archived')
    .map((v) => {
      const p = salesProcesses.find((x) => x.id === v.sales_process_id);
      return { id: v.id, label: `${p ? (isAr ? p.name_ar : p.name_en) : '—'} · v${v.version_number} (${v.status})` };
    }), [salesProcessVersions, salesProcesses, isAr]);

  const e = existing;
  const r = e?.target_rules_json ?? {};
  const [nameAr, setNameAr] = useState(e?.name_ar ?? '');
  const [nameEn, setNameEn] = useState(e?.name_en ?? '');
  const [hypAr, setHypAr] = useState(e?.hypothesis_ar ?? '');
  const [hypEn, setHypEn] = useState(e?.hypothesis_en ?? '');
  const [control, setControl] = useState(e?.control_process_version_id ?? '');
  const [variant, setVariant] = useState(e?.variant_process_version_id ?? '');
  const [mode, setMode] = useState<SalesExperimentAssignmentMode>(e?.assignment_mode ?? 'manual');
  const [split, setSplit] = useState(e?.split_percentage ?? 50);
  const [startDate, setStartDate] = useState(e?.start_date?.slice(0, 10) ?? '');
  const [endDate, setEndDate] = useState(e?.end_date?.slice(0, 10) ?? '');
  const [primary, setPrimary] = useState<SalesPrimaryMetric>(e?.primary_metric ?? 'appointment_booking_rate');
  const [guardrails, setGuardrails] = useState<SalesGuardrailMetric[]>(e?.guardrail_metrics_json ?? ['lost_rate', 'no_next_action_count']);
  // target rules (comma-separated text)
  const [source, setSource] = useState(joinList(r.source));
  const [project, setProject] = useState(joinList(r.project));
  const [city, setCity] = useState(joinList(r.city));
  const [district, setDistrict] = useState(joinList(r.district));
  const [stage, setStage] = useState(joinList(r.client_stage));
  const [status, setStatus] = useState(joinList(r.client_status));
  const [rep, setRep] = useState(joinList(r.sales_rep));
  const [budgetMin, setBudgetMin] = useState(r.budget_min != null ? String(r.budget_min) : '');
  const [budgetMax, setBudgetMax] = useState(r.budget_max != null ? String(r.budget_max) : '');
  const [leadFrom, setLeadFrom] = useState(r.lead_created_from?.slice(0, 10) ?? '');
  const [leadTo, setLeadTo] = useState(r.lead_created_to?.slice(0, 10) ?? '');

  const canSave = nameAr.trim() && nameEn.trim();

  const submit = () => {
    if (!canSave) return;
    const now = new Date().toISOString();
    const rules: SalesExperimentTargetRules = {
      source: splitList(source), project: splitList(project), city: splitList(city), district: splitList(district),
      client_stage: splitList(stage), client_status: splitList(status), sales_rep: splitList(rep),
      budget_min: budgetMin ? Number(budgetMin) : null, budget_max: budgetMax ? Number(budgetMax) : null,
      lead_created_from: leadFrom ? new Date(leadFrom).toISOString() : null,
      lead_created_to: leadTo ? new Date(leadTo).toISOString() : null,
    };
    const exp: SalesExperiment = {
      id: e?.id ?? uuid(),
      name_ar: nameAr.trim(), name_en: nameEn.trim(),
      hypothesis_ar: hypAr.trim() || null, hypothesis_en: hypEn.trim() || null,
      status: e?.status ?? 'draft',
      start_date: startDate ? new Date(startDate).toISOString() : null,
      end_date: endDate ? new Date(endDate).toISOString() : null,
      target_rules_json: rules,
      control_process_version_id: control || null,
      variant_process_version_id: variant || null,
      primary_metric: primary,
      guardrail_metrics_json: guardrails,
      assignment_mode: mode,
      split_percentage: split,
      owner_id: e?.owner_id ?? currentUserId,
      result_summary_json: e?.result_summary_json ?? null,
      created_at: e?.created_at ?? now,
      updated_at: now,
    };
    saveSalesExperiment(exp);
    addToast(isAr ? 'تم حفظ التجربة' : 'Experiment saved', 'success');
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={e ? (isAr ? 'تعديل التجربة' : 'Edit experiment') : (isAr ? 'تجربة جديدة' : 'New experiment')}
      maxWidth="max-w-2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
          <Button variant="primary" onClick={submit} disabled={!canSave}>{isAr ? 'حفظ' : 'Save'}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <F label={isAr ? 'الاسم (عربي)' : 'Name (Arabic)'}><input value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" className="form-input w-full" /></F>
          <F label={isAr ? 'الاسم (إنجليزي)' : 'Name (English)'}><input value={nameEn} onChange={(e) => setNameEn(e.target.value)} dir="ltr" className="form-input w-full" /></F>
          <F label={isAr ? 'الفرضية (عربي)' : 'Hypothesis (Arabic)'}><textarea value={hypAr} onChange={(e) => setHypAr(e.target.value)} rows={2} dir="rtl" className="form-input w-full" /></F>
          <F label={isAr ? 'الفرضية (إنجليزي)' : 'Hypothesis (English)'}><textarea value={hypEn} onChange={(e) => setHypEn(e.target.value)} rows={2} dir="ltr" className="form-input w-full" /></F>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <F label={isAr ? 'المسار الضابط' : 'Control process version'}>
            <select value={control} onChange={(e) => setControl(e.target.value)} className="form-input w-full">
              <option value="">{isAr ? 'اختر' : 'Select'}</option>
              {versionOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </F>
          <F label={isAr ? 'المسار المتغيّر' : 'Variant process version'}>
            <select value={variant} onChange={(e) => setVariant(e.target.value)} className="form-input w-full">
              <option value="">{isAr ? 'اختر' : 'Select'}</option>
              {versionOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </F>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <F label={isAr ? 'وضع الإسناد' : 'Assignment mode'}>
            <select value={mode} onChange={(e) => setMode(e.target.value as SalesExperimentAssignmentMode)} className="form-input w-full">
              <option value="manual">{isAr ? 'يدوي' : 'Manual'}</option>
              <option value="rules">{isAr ? 'حسب القواعد' : 'Rules'}</option>
              <option value="random_split">{isAr ? 'تقسيم عشوائي' : 'Random split'}</option>
            </select>
          </F>
          {mode === 'random_split' && (
            <F label={isAr ? 'نسبة المتغيّرة %' : 'Variant split %'}>
              <input type="number" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} dir="ltr" className="form-input w-full" />
            </F>
          )}
          <F label={isAr ? 'المقياس الرئيسي' : 'Primary metric'}>
            <select value={primary} onChange={(e) => setPrimary(e.target.value as SalesPrimaryMetric)} className="form-input w-full">
              {PRIMARY_METRIC_OPTIONS.map((m) => <option key={m} value={m}>{pick(PRIMARY_METRIC_LABELS[m], isAr)}</option>)}
            </select>
          </F>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <F label={isAr ? 'تاريخ البدء' : 'Start date'}><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} dir="ltr" className="form-input w-full" /></F>
          <F label={isAr ? 'تاريخ الانتهاء' : 'End date'}><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} dir="ltr" className="form-input w-full" /></F>
        </div>

        {/* guardrails */}
        <F label={isAr ? 'مقاييس الحماية (حواجز)' : 'Guardrail metrics'}>
          <div className="flex flex-wrap gap-2">
            {GUARDRAIL_METRIC_OPTIONS.map((g) => {
              const on = guardrails.includes(g);
              return (
                <button key={g} type="button" onClick={() => setGuardrails((s) => on ? s.filter((x) => x !== g) : [...s, g])}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${on ? 'bg-copper text-white' : 'border border-sand text-charcoal/70 hover:bg-cream'}`}>
                  {pick(GUARDRAIL_METRIC_LABELS[g], isAr)}
                </button>
              );
            })}
          </div>
        </F>

        {/* target rules */}
        {mode !== 'manual' && (
          <details className="rounded-xl border border-sand/40 p-3" open>
            <summary className="cursor-pointer text-xs font-bold text-charcoal/60">{isAr ? 'قواعد الاستهداف (افصل بفواصل)' : 'Target rules (comma-separated)'}</summary>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <F label={isAr ? 'المصدر' : 'Source'}><input value={source} onChange={(e) => setSource(e.target.value)} className="form-input w-full text-sm" /></F>
              <F label={isAr ? 'المشروع' : 'Project'}><input value={project} onChange={(e) => setProject(e.target.value)} className="form-input w-full text-sm" /></F>
              <F label={isAr ? 'المدينة' : 'City'}><input value={city} onChange={(e) => setCity(e.target.value)} className="form-input w-full text-sm" /></F>
              <F label={isAr ? 'الحي' : 'District'}><input value={district} onChange={(e) => setDistrict(e.target.value)} className="form-input w-full text-sm" /></F>
              <F label={isAr ? 'المرحلة' : 'Client stage'}><input value={stage} onChange={(e) => setStage(e.target.value)} dir="rtl" className="form-input w-full text-sm" /></F>
              <F label={isAr ? 'الحالة' : 'Client status'}><input value={status} onChange={(e) => setStatus(e.target.value)} dir="rtl" className="form-input w-full text-sm" /></F>
              <F label={isAr ? 'المندوب (معرّف)' : 'Sales rep (id)'}><input value={rep} onChange={(e) => setRep(e.target.value)} className="form-input w-full text-sm" /></F>
              <div className="grid grid-cols-2 gap-2">
                <F label={isAr ? 'ميزانية من' : 'Budget min'}><input type="number" value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} dir="ltr" className="form-input w-full text-sm" /></F>
                <F label={isAr ? 'إلى' : 'Budget max'}><input type="number" value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} dir="ltr" className="form-input w-full text-sm" /></F>
              </div>
              <F label={isAr ? 'تاريخ العميل من' : 'Lead created from'}><input type="date" value={leadFrom} onChange={(e) => setLeadFrom(e.target.value)} dir="ltr" className="form-input w-full text-sm" /></F>
              <F label={isAr ? 'إلى' : 'Lead created to'}><input type="date" value={leadTo} onChange={(e) => setLeadTo(e.target.value)} dir="ltr" className="form-input w-full text-sm" /></F>
            </div>
          </details>
        )}
      </div>
    </Modal>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-charcoal/60">{label}</label>
      {children}
    </div>
  );
}
