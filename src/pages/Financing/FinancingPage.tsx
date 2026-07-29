/**
 * Financing V2 — one page, three areas.
 *
 *   Scenarios (entry point + history) · Calculator wizard + Results · Admin
 *
 * V1 had a dashboard with data-health KPIs, an ingestion-run browser, a
 * source-snapshot viewer and a review queue. All removed: they served an
 * ingestion platform that no longer exists.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Calculator, Check, ChevronLeft, ChevronRight, Database, FileText, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import {
  confidenceLabel, financingApi, formatPct, formatSar, formatYears,
  isLegacySnapshot, rateBasisLabel, statusLabel, statusTone,
} from '@/lib/financing/client';
import type { FinancingInput, FinancingResult, ProductMatch, ResultStatus } from '@/lib/financing/types';

// ── Shared chips ───────────────────────────────────────────────────────────
const TONE: Record<'good' | 'warn' | 'bad' | 'neutral', string> = {
  good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warn: 'bg-amber-50 text-amber-700 border-amber-200',
  bad: 'bg-red-50 text-red-700 border-red-200',
  neutral: 'bg-charcoal/5 text-charcoal/70 border-charcoal/15',
};

function StatusChip({ status, isAr }: { status: ResultStatus | string; isAr: boolean }) {
  return (
    <span className={`inline-block rounded-lg border px-2.5 py-1 text-xs font-bold ${TONE[statusTone(status)]}`}>
      {statusLabel(status, isAr)}
    </span>
  );
}

/** The load-bearing honesty component: green only for a contractual rate or a
 *  bank quotation. Everything else is visibly an approximation. */
function RateBasisChip({ basis, isAr }: { basis: ProductMatch['rate_basis'] | string; isAr: boolean }) {
  const l = rateBasisLabel(basis);
  return (
    <span className={`inline-block rounded-lg border px-2 py-0.5 text-[11px] font-bold ${l.exact ? TONE.good : TONE.warn}`}>
      {isAr ? l.ar : l.en}
    </span>
  );
}

/** Scenario lifecycle, not a result status — its own small vocabulary. */
function scenarioStatusLabel(status: string, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    draft: { ar: 'مسودة', en: 'Draft' },
    calculated: { ar: 'محسوبة', en: 'Calculated' },
    shared: { ar: 'تمت المشاركة', en: 'Shared' },
    converted: { ar: 'حُوّلت إلى معاملة', en: 'Converted' },
    archived: { ar: 'مؤرشفة', en: 'Archived' },
  };
  const l = map[status];
  return l ? (isAr ? l.ar : l.en) : status;
}

const inputCls = 'w-full rounded-lg border border-sand/40 bg-white px-3 py-2 text-sm text-charcoal outline-none focus:border-copper focus:ring-2 focus:ring-copper/20';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold text-charcoal/70">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-charcoal/45">{hint}</span>}
    </label>
  );
}

function emptyInput(): FinancingInput {
  return {
    as_of_date: new Date().toISOString().slice(0, 10),
    nationality: null, date_of_birth: null, age: null,
    employment_type: null, employment_sector: null, employer_name: null,
    willing_to_transfer_salary: null,
    gross_monthly_salary: null, other_income: [], obligations: [],
    is_first_home: null, sakani_redf_status: 'unknown', confirmed_support_amount: null,
    property_price: null, property_type: null, project_record_id: null, unit_record_id: null,
    available_down_payment: null, term_months: 240,
    preferred_provider_keys: null, max_comfortable_installment: null,
    quoted_rate_pct: null, quoted_rate_provider_key: null,
  };
}

type Tab = 'scenarios' | 'admin';
type View = { mode: 'list' } | { mode: 'wizard'; id: string | null } | { mode: 'result'; id: string };

export default function FinancingPage() {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const addToast = useAppStore((s) => s.addToast);
  const isAdmin = useAppStore((s) => {
    const u = s.users.find((x) => x.id === s.currentUserId);
    return s.profiles.find((p) => p.id === u?.profile_id)?.is_admin === true;
  });
  const t = useCallback((ar: string, en: string) => (isAr ? ar : en), [isAr]);

  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('scenarios');
  const [view, setView] = useState<View>({ mode: 'list' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [scenarios, setScenarios] = useState<Array<Record<string, unknown>>>([]);
  const [scenario, setScenario] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState<FinancingResult | null>(null);

  const clientParam = params.get('client') ?? undefined;
  const projectParam = params.get('project') ?? undefined;
  const unitParam = params.get('unit') ?? undefined;
  const scenarioParam = params.get('scenario') ?? undefined;

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await financingApi.scenarioList(clientParam ? { client_record_id: clientParam } : {});
      setScenarios(res.scenarios);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast, clientParam]);

  const open = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const res = await financingApi.scenarioGet(id);
      setScenario(res.scenario);
      const snap = res.scenario.result_snapshot as FinancingResult | null;
      setResult(snap);
      setView(snap ? { mode: 'result', id } : { mode: 'wizard', id });
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }, [addToast]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    if (scenarioParam) void open(scenarioParam);
    else if (clientParam || projectParam || unitParam) setView({ mode: 'wizard', id: null });
  }, [scenarioParam, clientParam, projectParam, unitParam, open]);

  // ── Wizard ──────────────────────────────────────────────────────────────
  if (view.mode === 'wizard') {
    return (
      <Wizard
        isAr={isAr}
        scenarioId={view.id}
        existing={scenario}
        prefill={{ client_record_id: clientParam, project_record_id: projectParam, unit_record_id: unitParam }}
        onCancel={() => { setView({ mode: 'list' }); setParams({}); }}
        onDone={async (id) => { await open(id); void loadList(); }}
      />
    );
  }

  // ── Result ──────────────────────────────────────────────────────────────
  if (view.mode === 'result' && result && scenario) {
    return (
      <div className="mx-auto max-w-6xl p-4 sm:p-6" dir={isAr ? 'rtl' : 'ltr'}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold text-charcoal">
              {String(scenario.title ?? t('نتيجة التمويل', 'Financing result'))}
            </h1>
            <p className="text-xs text-charcoal/50">
              {t('سيناريو', 'Scenario')} #{String(scenario.scenario_number ?? '')}
              {result.calculation_version
                ? ` · ${t('نسخة الحساب', 'calc')} v${result.calculation_version}`
                : ` · ${t('إصدار سابق', 'earlier version')}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void convert(view.id)} disabled={busy}>
              <FileText size={15} /> {t('تحويل إلى ملف تمويل', 'Convert to financing case')}
            </Button>
            <Button variant="secondary" onClick={() => { setView({ mode: 'list' }); setParams({}); }}>
              {t('رجوع', 'Back')}
            </Button>
          </div>
        </div>

        {scenario.consent_to_share !== true && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
            <span className="flex items-center gap-2">
              <ShieldCheck size={15} />
              {t('لم تُسجَّل موافقة العميل على مشاركة بياناته المالية. التحويل يتطلب هذه الموافقة.',
                 'Customer consent to share financial data has not been recorded. Conversion requires it.')}
            </span>
            <Button variant="secondary" onClick={async () => {
              await financingApi.recordConsent(view.id, true);
              await open(view.id);
              addToast(t('تم تسجيل الموافقة', 'Consent recorded'), 'success');
            }}>
              {t('تسجيل الموافقة', 'Record consent')}
            </Button>
          </div>
        )}

        <Results result={result} isAr={isAr} />
      </div>
    );
  }

  async function convert(id: string) {
    setBusy(true);
    try {
      await financingApi.convertToCase(id);
      addToast(t('تم إنشاء ملف التمويل', 'Financing case created'), 'success');
      void loadList();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  // ── List + admin ────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-charcoal">
            <Calculator size={20} className="text-copper" />
            {t('حاسبة التمويل العقاري', 'Financing calculator')}
          </h1>
          <p className="text-xs text-charcoal/50">
            {t('تقدير استرشادي مبني على بيانات منشورة رسميًا — ليست موافقة تمويلية',
               'Indicative estimate from officially published data — not a financing approval')}
          </p>
        </div>
        <Button onClick={() => { setScenario(null); setResult(null); setView({ mode: 'wizard', id: null }); }}>
          <Plus size={15} /> {t('سيناريو جديد', 'New scenario')}
        </Button>
      </div>

      {isAdmin && (
        <div className="mb-4 flex gap-1.5">
          {([['scenarios', t('السيناريوهات', 'Scenarios'), FileText], ['admin', t('المنتجات والأسعار', 'Products & rates'), Database]] as Array<[Tab, string, typeof FileText]>).map(([id, label, Icon]) => (
            <button key={id} type="button" onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ${tab === id ? 'bg-copper text-white' : 'bg-white text-charcoal/60 hover:bg-cream'}`}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-charcoal/50">
          <Loader2 size={18} className="animate-spin" /> {t('جارٍ التحميل…', 'Loading…')}
        </div>
      ) : tab === 'admin' && isAdmin ? (
        <AdminPanel isAr={isAr} />
      ) : (
        <div className="card p-5">
          {scenarios.length === 0 ? (
            <p className="py-8 text-center text-sm text-charcoal/50">{t('لا توجد سيناريوهات بعد', 'No scenarios yet')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead>
                  <tr className="border-b border-sand/30 text-charcoal/50">
                    <th className="p-2 text-start">#</th>
                    <th className="p-2 text-start">{t('العنوان', 'Title')}</th>
                    <th className="p-2 text-start">{t('الحالة', 'Status')}</th>
                    <th className="p-2 text-end">{t('أقصى قسط', 'Max installment')}</th>
                    <th className="p-2 text-start">{t('آخر تحديث', 'Updated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map((s) => {
                    const snap = s.result_snapshot as FinancingResult | null;
                    return (
                      <tr key={String(s.id)} className="cursor-pointer border-b border-sand/10 hover:bg-cream/40" onClick={() => void open(String(s.id))}>
                        <td className="p-2 text-charcoal/60">{String(s.scenario_number ?? '')}</td>
                        <td className="p-2 font-medium text-charcoal">{String(s.title ?? t('بدون عنوان', 'Untitled'))}</td>
                        <td className="p-2 text-charcoal/70">{scenarioStatusLabel(String(s.status), isAr)}</td>
                        <td className="p-2 text-end text-charcoal/70">{formatSar(snap?.capacity?.max_installment ?? null, isAr)}</td>
                        <td className="p-2 text-charcoal/50">{String(s.updated_at ?? '').slice(0, 10)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Wizard: four steps ─────────────────────────────────────────────────────
const STEPS = [
  { ar: 'العميل', en: 'Customer' },
  { ar: 'الدخل والالتزامات', en: 'Income & obligations' },
  { ar: 'العقار والدعم', en: 'Property & support' },
  { ar: 'التمويل', en: 'Financing' },
];

function Wizard({
  isAr, scenarioId, existing, prefill, onCancel, onDone,
}: {
  isAr: boolean;
  scenarioId: string | null;
  existing: Record<string, unknown> | null;
  prefill: { client_record_id?: string; project_record_id?: string; unit_record_id?: string };
  onCancel: () => void;
  onDone: (id: string) => void;
}) {
  const t = (ar: string, en: string) => (isAr ? ar : en);
  const addToast = useAppStore((s) => s.addToast);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState(String(existing?.title ?? ''));
  /**
   * The banks we actually hold products for, read from reference data rather than
   * hardcoded: a fixed slug list shows internal keys to reps and silently goes
   * stale when a product is added or retired.
   */
  const [banks, setBanks] = useState<Array<{ key: string; ar: string; en: string }>>([]);
  useEffect(() => {
    let alive = true;
    financingApi.reference()
      .then((ref) => {
        if (!alive) return;
        const seen = new Map<string, { key: string; ar: string; en: string }>();
        for (const p of ref.products) {
          if (!seen.has(p.provider_key)) {
            seen.set(p.provider_key, { key: p.provider_key, ar: p.provider_name_ar, en: p.provider_name_en });
          }
        }
        setBanks([...seen.values()].sort((a, b) => (isAr ? a.ar.localeCompare(b.ar, 'ar') : a.en.localeCompare(b.en))));
      })
      .catch((e: unknown) => addToast(e instanceof Error ? e.message : String(e), 'error'));
    return () => { alive = false; };
  }, [isAr, addToast]);
  const [input, setInput] = useState<FinancingInput>(() => ({
    ...emptyInput(),
    ...((existing?.input_snapshot as Partial<FinancingInput>) ?? {}),
    project_record_id: prefill.project_record_id ?? null,
    unit_record_id: prefill.unit_record_id ?? null,
  }));

  const set = <K extends keyof FinancingInput>(k: K, v: FinancingInput[K]) => setInput((p) => ({ ...p, [k]: v }));
  const n = (s: string): number | null => (s === '' ? null : Number(s));

  async function persist(): Promise<string | null> {
    setSaving(true);
    try {
      const res = await financingApi.scenarioSave({
        scenario_id: scenarioId,
        scenario: {
          title: title || null,
          client_record_id: prefill.client_record_id ?? existing?.client_record_id ?? null,
          project_record_id: input.project_record_id,
          unit_record_id: input.unit_record_id,
          input_snapshot: input as unknown as Record<string, unknown>,
        },
      });
      return res.scenario_id;
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function calculate() {
    const id = await persist();
    if (!id) return;
    setSaving(true);
    try {
      await financingApi.calculate(id);
      onDone(id);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-charcoal">{t('حاسبة التمويل العقاري', 'Financing calculator')}</h1>
        <Button variant="secondary" onClick={onCancel}>{t('إلغاء', 'Cancel')}</Button>
      </div>

      <div className="card flex flex-wrap gap-1.5 p-4">
        {STEPS.map((s, i) => (
          <button key={s.en} type="button" onClick={() => setStep(i)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold ${
              i === step ? 'bg-copper text-white' : i < step ? 'bg-emerald-50 text-emerald-700' : 'bg-charcoal/5 text-charcoal/50'}`}>
            {i < step ? <Check size={12} /> : <span>{i + 1}</span>} {isAr ? s.ar : s.en}
          </button>
        ))}
      </div>

      <div className="card space-y-4 p-5">
        {step === 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('عنوان السيناريو', 'Scenario title')}>
              <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label={t('الجنسية', 'Nationality')} hint={t('سقف المسكن الأول ٩٠٪ للمواطنين فقط', 'The 90% first-home ceiling is citizens-only')}>
              <select className={inputCls} value={input.nationality ?? ''} onChange={(e) => set('nationality', (e.target.value || null) as FinancingInput['nationality'])}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                <option value="saudi">{t('مواطن سعودي', 'Saudi citizen')}</option>
                <option value="resident">{t('مقيم', 'Resident')}</option>
              </select>
            </Field>
            <Field label={t('تاريخ الميلاد', 'Date of birth')}>
              <input type="date" className={inputCls} value={input.date_of_birth ?? ''} onChange={(e) => set('date_of_birth', e.target.value || null)} />
            </Field>
            <Field label={t('نوع التوظيف', 'Employment type')} hint={t('المتقاعد: سقف الاستقطاع ٢٥٪ لا ٣٣٫٣٣٪', 'Retiree: the deduction ceiling is 25%, not 33.33%')}>
              <select className={inputCls} value={input.employment_type ?? ''} onChange={(e) => set('employment_type', (e.target.value || null) as FinancingInput['employment_type'])}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                <option value="employee">{t('موظف', 'Employee')}</option>
                <option value="military">{t('عسكري', 'Military')}</option>
                <option value="retiree">{t('متقاعد', 'Retiree')}</option>
                <option value="self_employed">{t('عمل حر', 'Self-employed')}</option>
                <option value="business_owner">{t('صاحب عمل', 'Business owner')}</option>
              </select>
            </Field>
            <Field label={t('قطاع جهة العمل', 'Employer sector')}>
              <select className={inputCls} value={input.employment_sector ?? ''} onChange={(e) => set('employment_sector', (e.target.value || null) as FinancingInput['employment_sector'])}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                <option value="government">{t('حكومي', 'Government')}</option>
                <option value="semi_government">{t('شبه حكومي', 'Semi-government')}</option>
                <option value="military">{t('عسكري', 'Military')}</option>
                <option value="private">{t('قطاع خاص', 'Private')}</option>
              </select>
            </Field>
            <Field label={t('جهة العمل (اختياري)', 'Employer (optional)')}>
              <input className={inputCls} value={input.employer_name ?? ''} onChange={(e) => set('employer_name', e.target.value || null)} />
            </Field>
            <Field label={t('هل يوافق على تحويل الراتب؟', 'Willing to transfer salary?')} hint={t('بنك الرياض يشترطه إلزاميًا', 'Riyad Bank requires it outright')}>
              <select className={inputCls}
                value={input.willing_to_transfer_salary === true ? 'yes' : input.willing_to_transfer_salary === false ? 'no' : ''}
                onChange={(e) => set('willing_to_transfer_salary', e.target.value === '' ? null : e.target.value === 'yes')}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                <option value="yes">{t('نعم', 'Yes')}</option>
                <option value="no">{t('لا', 'No')}</option>
              </select>
            </Field>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('الراتب الشهري الإجمالي', 'Gross monthly salary')} hint={t('الحقل الوحيد المطلوب لإخراج نتيجة', 'The only field required to produce a result')}>
                <input type="number" min={0} className={inputCls} value={input.gross_monthly_salary ?? ''} onChange={(e) => set('gross_monthly_salary', n(e.target.value))} />
              </Field>
              <Field label={t('أقصى قسط مقبول (اختياري)', 'Max comfortable installment (optional)')}>
                <input type="number" min={0} className={inputCls} value={input.max_comfortable_installment ?? ''} onChange={(e) => set('max_comfortable_installment', n(e.target.value))} />
              </Field>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-bold text-charcoal">{t('دخل إضافي', 'Other income')}</span>
                <Button variant="secondary" onClick={() => set('other_income', [...input.other_income, { kind: 'other', monthly_amount: 0, verified: false }])}>
                  <Plus size={13} /> {t('إضافة', 'Add')}
                </Button>
              </div>
              <p className="mb-2 text-[11px] text-charcoal/50">
                {t('الدخل الإضافي غير الموثق يُحتسب صفرًا — لا نصفًا.', 'Unverified other income counts as ZERO, not a reduced share.')}
              </p>
              {input.other_income.map((row, i) => (
                <div key={i} className="mb-2 grid grid-cols-1 gap-2 rounded-lg border border-sand/30 p-2.5 sm:grid-cols-4">
                  <Field label={t('الوصف', 'Label')}>
                    <input className={inputCls} value={row.label ?? ''} onChange={(e) => set('other_income', input.other_income.map((r, j) => j === i ? { ...r, label: e.target.value } : r))} />
                  </Field>
                  <Field label={t('المبلغ الشهري', 'Monthly amount')}>
                    <input type="number" min={0} className={inputCls} value={row.monthly_amount || ''} onChange={(e) => set('other_income', input.other_income.map((r, j) => j === i ? { ...r, monthly_amount: Number(e.target.value || 0) } : r))} />
                  </Field>
                  <div className="flex items-end">
                    <label className="mb-2 flex items-center gap-1.5 text-xs text-charcoal/70">
                      <input type="checkbox" className="accent-copper" checked={row.verified}
                        onChange={(e) => set('other_income', input.other_income.map((r, j) => j === i ? { ...r, verified: e.target.checked } : r))} />
                      {t('موثق بمستند', 'Documented')}
                    </label>
                  </div>
                  <div className="flex items-end justify-end">
                    <button type="button" className="mb-2 text-red-500" onClick={() => set('other_income', input.other_income.filter((_, j) => j !== i))}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-bold text-charcoal">{t('الالتزامات القائمة', 'Existing obligations')}</span>
                <Button variant="secondary" onClick={() => set('obligations', [...input.obligations, { kind: 'other', monthly_payment: 0 }])}>
                  <Plus size={13} /> {t('إضافة', 'Add')}
                </Button>
              </div>
              <p className="mb-2 text-[11px] text-charcoal/50">
                {t('البطاقة الائتمانية: أدخل حد البطاقة لا الرصيد — النظام يحتسب نسبة من الحد.',
                   'Credit card: enter the LIMIT, not the balance — a percentage of the ceiling is charged.')}
              </p>
              {input.obligations.map((row, i) => (
                <div key={i} className="mb-2 grid grid-cols-1 gap-2 rounded-lg border border-sand/30 p-2.5 sm:grid-cols-4">
                  <Field label={t('النوع', 'Type')}>
                    <select className={inputCls} value={row.kind} onChange={(e) => set('obligations', input.obligations.map((r, j) => j === i ? { ...r, kind: e.target.value as 'credit_card' | 'other' } : r))}>
                      <option value="other">{t('قسط شهري', 'Monthly instalment')}</option>
                      <option value="credit_card">{t('بطاقة ائتمانية', 'Credit card')}</option>
                    </select>
                  </Field>
                  <Field label={t('الوصف', 'Label')}>
                    <input className={inputCls} value={row.label ?? ''} onChange={(e) => set('obligations', input.obligations.map((r, j) => j === i ? { ...r, label: e.target.value } : r))} />
                  </Field>
                  {row.kind === 'credit_card' ? (
                    <Field label={t('حد البطاقة', 'Card limit')}>
                      <input type="number" min={0} className={inputCls} value={row.card_limit ?? ''} onChange={(e) => set('obligations', input.obligations.map((r, j) => j === i ? { ...r, card_limit: n(e.target.value) } : r))} />
                    </Field>
                  ) : (
                    <Field label={t('القسط الشهري', 'Monthly payment')}>
                      <input type="number" min={0} className={inputCls} value={row.monthly_payment ?? ''} onChange={(e) => set('obligations', input.obligations.map((r, j) => j === i ? { ...r, monthly_payment: n(e.target.value) } : r))} />
                    </Field>
                  )}
                  <div className="flex items-end justify-end">
                    <button type="button" className="mb-2 text-red-500" onClick={() => set('obligations', input.obligations.filter((_, j) => j !== i))}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('سعر العقار', 'Property price')} hint={t('اتركه فارغًا لمعرفة القدرة فقط', 'Leave blank for affordability only')}>
              <input type="number" min={0} className={inputCls} value={input.property_price ?? ''} onChange={(e) => set('property_price', n(e.target.value))} />
            </Field>
            <Field label={t('نوع العقار', 'Property type')}>
              <select className={inputCls} value={input.property_type ?? ''} onChange={(e) => set('property_type', e.target.value || null)}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                <option value="apartment">{t('شقة', 'Apartment')}</option>
                <option value="villa">{t('فيلا', 'Villa')}</option>
                <option value="townhouse">{t('تاون هاوس', 'Townhouse')}</option>
                <option value="duplex">{t('دبلكس', 'Duplex')}</option>
                <option value="floor">{t('دور', 'Floor')}</option>
                <option value="land">{t('أرض', 'Land')}</option>
              </select>
            </Field>
            <Field label={t('الدفعة الأولى المتاحة', 'Available down payment')}>
              <input type="number" min={0} className={inputCls} value={input.available_down_payment ?? ''} onChange={(e) => set('available_down_payment', n(e.target.value))} />
            </Field>
            <Field label={t('هل هو المسكن الأول؟', 'Is this the first home?')} hint={t('يرفع السقف إلى ٩٠٪ ويفعّل إعفاء الضريبة', 'Raises the ceiling to 90% and triggers the tax relief')}>
              <select className={inputCls}
                value={input.is_first_home === true ? 'yes' : input.is_first_home === false ? 'no' : ''}
                onChange={(e) => set('is_first_home', e.target.value === '' ? null : e.target.value === 'yes')}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                <option value="yes">{t('نعم', 'Yes')}</option>
                <option value="no">{t('لا', 'No')}</option>
              </select>
            </Field>
            <Field label={t('حالة الدعم السكني', 'Sakani / REDF status')} hint={t('«مؤكد» تعني الاطلاع على الشهادة', '"Confirmed" means the certificate was seen')}>
              <select className={inputCls} value={input.sakani_redf_status} onChange={(e) => set('sakani_redf_status', e.target.value as FinancingInput['sakani_redf_status'])}>
                <option value="unknown">{t('غير معروف', 'Unknown')}</option>
                <option value="self_declared">{t('إقرار العميل', 'Self-declared')}</option>
                <option value="confirmed">{t('مؤكد بشهادة', 'Confirmed by certificate')}</option>
                <option value="not_eligible">{t('غير مؤهل', 'Not eligible')}</option>
              </select>
            </Field>
            <Field label={t('مبلغ الدعم المؤكد', 'Confirmed support amount')} hint={t('يُحتسب ضمن الدخل عند التأكيد فقط', 'Counted as income only when confirmed')}>
              <input type="number" min={0} className={inputCls} value={input.confirmed_support_amount ?? ''} onChange={(e) => set('confirmed_support_amount', n(e.target.value))} />
            </Field>
          </div>
        )}

        {step === 3 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('مدة التمويل (بالأشهر)', 'Term (months)')}>
              <input type="number" min={12} max={360} className={inputCls} value={input.term_months ?? ''} onChange={(e) => set('term_months', n(e.target.value))} />
            </Field>
            <Field label={t('سعر من عرض البنك (اختياري)', 'Bank quotation rate (optional)')}
              hint={t('إدخاله يحوّل التقدير إلى حساب دقيق لهذا البنك', 'Entering it turns the estimate into an exact calculation for that bank')}>
              <input type="number" step="0.01" min={0} className={inputCls} value={input.quoted_rate_pct ?? ''} onChange={(e) => set('quoted_rate_pct', n(e.target.value))} />
            </Field>
            <Field label={t('بنك عرض السعر', 'Quotation bank')}>
              <select className={inputCls} value={input.quoted_rate_provider_key ?? ''} onChange={(e) => set('quoted_rate_provider_key', e.target.value || null)}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                {banks.map((b) => <option key={b.key} value={b.key}>{isAr ? b.ar : b.en}</option>)}
              </select>
            </Field>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Button variant="secondary" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
          {isAr ? <ChevronRight size={15} /> : <ChevronLeft size={15} />} {t('السابق', 'Back')}
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={persist} disabled={saving}>{t('حفظ المسودة', 'Save draft')}</Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={async () => { if (await persist()) setStep((s) => s + 1); }} disabled={saving}>
              {t('التالي', 'Next')} {isAr ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
            </Button>
          ) : (
            <Button onClick={calculate} disabled={saving}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t('احتساب', 'Calculate')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Results ────────────────────────────────────────────────────────────────
function Stat({ label, value, sub, emphasis }: { label: string; value: string; sub?: string | null; emphasis?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${emphasis ? 'border-copper/30 bg-copper/5' : 'border-sand/30 bg-white'}`}>
      <div className="text-[11px] font-bold uppercase tracking-wide text-charcoal/50">{label}</div>
      <div className={`mt-1 font-bold ${emphasis ? 'text-2xl text-copper' : 'text-lg text-charcoal'}`}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-charcoal/50">{sub}</div>}
    </div>
  );
}

/**
 * A scenario calculated before V2, shown exactly as it was recorded.
 *
 * These snapshots are frozen customer history — what the rep was actually told
 * on that date — so they are NOT re-computed or translated into the V2
 * vocabulary. Only the fields common to both engines are read, defensively, and
 * the banner tells the reader why the layout is different.
 */
function LegacyResult({ result, isAr }: { result: FinancingResult; isAr: boolean }) {
  const t = (ar: string, en: string) => (isAr ? ar : en);
  const r = result as unknown as Record<string, unknown>;
  const cap = (r.capacity ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const matches = Array.isArray(r.matches) ? (r.matches as Array<Record<string, unknown>>) : [];

  return (
    <div className="space-y-4">
      <div className="card border-l-4 border-l-amber-400 p-5">
        <div className="mb-2 flex items-center gap-2">
          <AlertTriangle size={16} className="text-amber-600" />
          <h3 className="font-bold text-charcoal">{t('نتيجة محفوظة من إصدار سابق', 'Result saved by an earlier version')}</h3>
        </div>
        <p className="text-xs leading-relaxed text-charcoal/60">
          {t('هذه النتيجة حُسبت قبل تبسيط النظام، وتُعرض كما سُجّلت في حينها دون إعادة حساب — فهي سجل لما أُبلغ به العميل. لإجراء حساب بالنموذج الحالي أنشئ سيناريو جديدًا.',
             'This result was calculated before the system was simplified. It is shown exactly as recorded rather than recalculated, because it is the record of what the customer was told. For a calculation on the current model, create a new scenario.')}
        </p>
      </div>

      <div className="card p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <StatusChip status={String(r.status ?? '')} isAr={isAr} />
          <span className="text-xs text-charcoal/50">{String(r.as_of_date ?? '')}</span>
          {typeof r.engine_version === 'string' && (
            <span className="text-xs text-charcoal/40">{t('محرّك', 'engine')} {r.engine_version}</span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={t('أقصى قسط شهري', 'Max monthly installment')} value={formatSar(num(cap.max_installment), isAr)} emphasis />
          <Stat label={t('الدخل المؤهل', 'Qualifying income')} value={formatSar(num(cap.qualifying_income), isAr)} />
          <Stat label={t('الالتزامات القائمة', 'Existing obligations')} value={formatSar(num(cap.existing_obligations), isAr)} />
          <Stat label={t('أقصى قيمة عقار', 'Max property value')} value={formatSar(num(r.max_property_value), isAr)} />
        </div>
      </div>

      {matches.length > 0 && (
        <div className="card p-5">
          <h3 className="mb-3 font-bold text-charcoal">
            {t('المنتجات كما سُجّلت', 'Products as recorded')} ({matches.length})
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="border-b border-sand/30 text-charcoal/50">
                  <th className="p-2 text-start">{t('المنتج', 'Product')}</th>
                  <th className="p-2 text-start">{t('الحالة المسجلة', 'Recorded status')}</th>
                  <th className="p-2 text-end">{t('القسط', 'Monthly')}</th>
                  <th className="p-2 text-end">{t('التمويل', 'Financing')}</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m, i) => {
                  const prod = (m.product ?? {}) as Record<string, unknown>;
                  const name = String((isAr ? prod.name_ar : prod.name_en) ?? prod.product_key ?? '—');
                  const bank = String((isAr ? prod.provider_name_ar : prod.provider_name_en) ?? '');
                  return (
                    <tr key={i} className="border-b border-sand/10">
                      <td className="p-2 text-charcoal/80">{bank ? `${bank} · ${name}` : name}</td>
                      <td className="p-2 text-charcoal/60">{statusLabel(String(m.status ?? ''), isAr)}</td>
                      <td className="p-2 text-end text-charcoal/70">{formatSar(num(m.monthly_payment), isAr)}</td>
                      <td className="p-2 text-end text-charcoal/70">{formatSar(num(m.financing_amount), isAr)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Results({ result, isAr }: { result: FinancingResult; isAr: boolean }) {
  const t = (ar: string, en: string) => (isAr ? ar : en);

  // A result frozen by an earlier engine has a different match shape and status
  // vocabulary. Forcing it through this renderer white-screened the page on the
  // two scenarios migrated from V1, so show it as recorded instead.
  if (isLegacySnapshot(result)) return <LegacyResult result={result} isAr={isAr} />;

  const cap = result.capacity;
  const sel = result.selected;

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <StatusChip status={result.status} isAr={isAr} />
          <span className={`rounded-lg border px-2 py-0.5 text-[11px] font-bold ${TONE[result.confidence === 'high' ? 'good' : result.confidence === 'medium' ? 'warn' : 'neutral']}`}>
            {isAr ? confidenceLabel(result.confidence).ar : confidenceLabel(result.confidence).en}
          </span>
          <span className="text-xs text-charcoal/50">{result.as_of_date}</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={t('أقصى قسط شهري', 'Max monthly installment')} value={formatSar(cap.max_installment, isAr)}
            sub={cap.binding_constraint ? t(`القيد الحاكم: ${cap.binding_constraint}`, `Binding: ${cap.binding_constraint}`) : null} emphasis />
          <Stat label={t('أقصى تمويل', 'Max financing')} value={formatSar(result.max_financing, isAr)} />
          <Stat label={t('أقصى قيمة عقار', 'Max property value')} value={formatSar(result.max_property_value, isAr)} />
          <Stat label={t('نسبة الاستقطاع الحالية', 'Current DBR')} value={formatPct(cap.current_dbr_pct, isAr)} />
          <Stat label={t('الدخل المُقر', 'Declared income')} value={formatSar(cap.declared_income, isAr)} />
          <Stat label={t('الدخل المؤهل', 'Qualifying income')} value={formatSar(cap.qualifying_income, isAr)} />
          <Stat label={t('الالتزامات القائمة', 'Existing obligations')} value={formatSar(cap.existing_obligations, isAr)} />
        </div>
      </div>

      {sel && (
        <div className="card p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-bold text-charcoal">
              {t('العقار المحدد', 'Selected property')} — {isAr ? sel.product.name_ar : sel.product.name_en}
            </h3>
            <RateBasisChip basis={sel.rate_basis} isAr={isAr} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t('القسط الشهري', 'Monthly payment')}
              value={sel.monthly_payment !== null ? formatSar(sel.monthly_payment, isAr) : t('يتطلب عرض سعر', 'Requires a quotation')} emphasis />
            <Stat label={t('مبلغ التمويل', 'Financing amount')} value={formatSar(sel.financing_amount, isAr)}
              sub={sel.financing_not_capacity_tested
                ? t('لم يُختبر مقابل القدرة الشهرية', 'Not tested against monthly capacity')
                : undefined} />
            <Stat label={t('الدفعة الأولى', 'Down payment')} value={formatSar(sel.down_payment, isAr)} />
            <Stat label={t('النقد المطلوب مقدمًا', 'Upfront cash')} value={formatSar(sel.upfront_cash, isAr)}
              sub={sel.cash_shortfall !== null && sel.cash_shortfall > 0
                ? t(`ينقص ${formatSar(sel.cash_shortfall, isAr)}`, `Short by ${formatSar(sel.cash_shortfall, isAr)}`)
                : undefined} />
            <Stat label={t('نسبة التمويل', 'LTV')} value={formatPct(sel.ltv_pct, isAr)} sub={t(`السقف ${formatPct(sel.max_ltv_pct, isAr)}`, `Ceiling ${formatPct(sel.max_ltv_pct, isAr)}`)} />
            <Stat label={t('إجمالي السداد', 'Total repayment')} value={sel.total_repayment !== null ? formatSar(sel.total_repayment, isAr) : '—'} />
            <Stat label={t('النسبة السنوية المنشورة', 'Published APR')} value={formatPct(sel.published_apr_pct, isAr)} />
            <Stat label={t('تاريخ التحقق', 'Rate verified')} value={sel.rate_verified_at ?? '—'} />
          </div>
        </div>
      )}

      <div className="card p-5">
        <h3 className="mb-3 font-bold text-charcoal">{t('مقارنة المنتجات', 'Product comparison')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-xs">
            <thead>
              <tr className="border-b border-sand/30 text-charcoal/50">
                <th className="p-2 text-start">{t('البنك', 'Bank')}</th>
                <th className="p-2 text-start">{t('المنتج', 'Product')}</th>
                <th className="p-2 text-start">{t('الحالة', 'Status')}</th>
                <th className="p-2 text-end">{t('القسط', 'Monthly')}</th>
                <th className="p-2 text-end">{t('التمويل', 'Financing')}</th>
                <th className="p-2 text-end">{t('النسبة السنوية', 'APR')}</th>
                <th className="p-2 text-start">{t('أساس السعر', 'Rate basis')}</th>
                <th className="p-2 text-start">{t('المصدر / التحقق', 'Source / verified')}</th>
              </tr>
            </thead>
            <tbody>
              {result.matches.map((m) => (
                <tr key={m.product.id} className="border-b border-sand/10">
                  <td className="p-2 font-medium text-charcoal">{isAr ? m.product.provider_name_ar : m.product.provider_name_en}</td>
                  <td className="p-2 text-charcoal/80">{isAr ? m.product.name_ar : m.product.name_en}</td>
                  <td className="p-2"><StatusChip status={m.status} isAr={isAr} /></td>
                  <td className="p-2 text-end font-bold text-charcoal">
                    {m.monthly_payment !== null ? formatSar(m.monthly_payment, isAr) : t('عرض سعر', 'Quotation')}
                  </td>
                  <td className="p-2 text-end text-charcoal/70">{formatSar(m.financing_amount, isAr)}</td>
                  <td className="p-2 text-end text-charcoal/70">{formatPct(m.published_apr_pct, isAr)}</td>
                  <td className="p-2"><RateBasisChip basis={m.rate_basis} isAr={isAr} /></td>
                  <td className="p-2 text-[11px] text-charcoal/50">
                    {m.rate_source_url
                      ? <a href={m.rate_source_url} target="_blank" rel="noreferrer" className="text-copper hover:underline">{t('المصدر', 'Source')}</a>
                      : '—'}
                    {m.rate_verified_at ? ` · ${m.rate_verified_at}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(result.missing.length > 0 || result.assumptions.length > 0) && (
        <div className="card grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          {result.missing.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-bold text-charcoal">{t('معلومات ناقصة وتحفظات', 'Missing information & caveats')}</div>
              <ul className="space-y-1 text-xs text-charcoal/70">
                {result.missing.map((m) => <li key={m.code}>• {isAr ? m.ar : m.en}</li>)}
              </ul>
            </div>
          )}
          {result.assumptions.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-bold text-charcoal">{t('الافتراضات', 'Assumptions')}</div>
              <ul className="space-y-1 text-xs text-charcoal/70">
                {result.assumptions.map((a) => <li key={a.code}>• {isAr ? a.ar : a.en}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-xs leading-relaxed text-amber-900">
        <div className="mb-1 flex items-center gap-2 font-bold"><AlertTriangle size={14} /> {t('تنبيه مهم', 'Important')}</div>
        {isAr ? result.disclaimer_ar : result.disclaimer_en}
      </div>
    </div>
  );
}

// ── Admin: products, rates, rules ──────────────────────────────────────────
function AdminPanel({ isAr }: { isAr: boolean }) {
  const t = (ar: string, en: string) => (isAr ? ar : en);
  const addToast = useAppStore((s) => s.addToast);
  const [data, setData] = useState<Awaited<ReturnType<typeof financingApi.adminData>> | null>(null);
  const [rateFor, setRateFor] = useState<string | null>(null);
  const [rate, setRate] = useState<Record<string, unknown>>({ disclosure_type: 'starting_from', rate_type: 'fixed' });

  const load = useCallback(() => {
    financingApi.adminData().then(setData).catch((e: unknown) => addToast(e instanceof Error ? e.message : String(e), 'error'));
  }, [addToast]);
  useEffect(load, [load]);

  if (!data) {
    return <div className="card flex items-center gap-2 p-8 text-charcoal/50"><Loader2 size={16} className="animate-spin" /> {t('جارٍ التحميل…', 'Loading…')}</div>;
  }

  /** Which product a rate belongs to. Rates arrive as bare rows, so resolve locally. */
  const productLabel = (productId: unknown): string => {
    const p = data.products.find((x) => String(x.id) === String(productId));
    if (!p) return '—';
    return `${String(isAr ? p.provider_name_ar : p.provider_name_en)} · ${String(isAr ? p.name_ar : p.name_en)}`;
  };

  /**
   * 0% is a REAL published rate here (Albilad's subsidised product), so a
   * truthiness test would print "unavailable" for the one exact rate we have.
   * Only null/undefined means "not published".
   */
  const pctCell = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    return Number.isFinite(n) ? `${n.toFixed(2)}%` : '—';
  };

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h3 className="mb-3 font-bold text-charcoal">{t('المنتجات', 'Products')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-xs">
            <thead>
              <tr className="border-b border-sand/30 text-charcoal/50">
                <th className="p-2 text-start">{t('البنك', 'Bank')}</th>
                <th className="p-2 text-start">{t('المنتج', 'Product')}</th>
                <th className="p-2 text-end">{t('أدنى راتب', 'Min salary')}</th>
                <th className="p-2 text-end">{t('أقصى مدة', 'Max term')}</th>
                <th className="p-2 text-start">{t('التحقق', 'Verified')}</th>
                <th className="p-2 text-start">{t('إجراءات', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((p) => (
                <tr key={String(p.id)} className={`border-b border-sand/10 ${p.is_active ? '' : 'opacity-50'}`}>
                  <td className="p-2 font-medium text-charcoal">{String(isAr ? p.provider_name_ar : p.provider_name_en)}</td>
                  <td className="p-2 text-charcoal/80">{String(isAr ? p.name_ar : p.name_en)}</td>
                  <td className="p-2 text-end text-charcoal/70">{p.min_salary ? formatSar(Number(p.min_salary), isAr) : '—'}</td>
                  <td className="p-2 text-end text-charcoal/70">{p.max_term_months ? formatYears(Number(p.max_term_months), isAr) : '—'}</td>
                  <td className="p-2 text-charcoal/50">{String(p.last_verified_at ?? '—')}</td>
                  <td className="p-2">
                    <div className="flex gap-2">
                      <button type="button" className="text-copper hover:underline" onClick={() => { setRateFor(String(p.id)); setRate({ disclosure_type: 'starting_from', rate_type: 'fixed', product_id: p.id }); }}>
                        {t('سعر جديد', 'Add rate')}
                      </button>
                      <button type="button" className="text-red-500 hover:underline"
                        onClick={async () => {
                          try { await financingApi.adminProductRetire(String(p.id), !p.is_active); load(); }
                          catch (e) { addToast(e instanceof Error ? e.message : String(e), 'error'); }
                        }}>
                        {p.is_active ? t('إيقاف', 'Retire') : t('إعادة', 'Restore')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {rateFor && (
        <div className="card p-5">
          <h3 className="mb-3 font-bold text-charcoal">{t('إضافة نسخة سعر جديدة', 'Add a new rate version')}</h3>
          <p className="mb-3 text-[11px] text-charcoal/55">
            {t('السعر السابق يُحفظ ويُعطَّل تلقائيًا. رابط المصدر الرسمي مطلوب.',
               'The previous rate is kept and deactivated automatically. An official source URL is required.')}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('نوع الإفصاح', 'Disclosure type')}>
              <select className={inputCls} value={String(rate.disclosure_type)} onChange={(e) => setRate({ ...rate, disclosure_type: e.target.value })}>
                <option value="exact_rate">{t('سعر تعاقدي دقيق', 'Exact contractual rate')}</option>
                <option value="starting_from">{t('يبدأ من', 'Starting from')}</option>
                <option value="representative_example">{t('مثال توضيحي', 'Representative example')}</option>
                <option value="quotation_required">{t('يتطلب عرض سعر', 'Quotation required')}</option>
              </select>
            </Field>
            <Field label={t('السعر التعاقدي %', 'Contractual rate %')} hint={t('مطلوب فقط عند اختيار «سعر تعاقدي دقيق»', 'Required only for "exact contractual rate"')}>
              <input type="number" step="0.01" className={inputCls} value={String(rate.contractual_rate_pct ?? '')} onChange={(e) => setRate({ ...rate, contractual_rate_pct: e.target.value === '' ? null : Number(e.target.value) })} />
            </Field>
            <Field label={t('النسبة السنوية المنشورة %', 'Published APR %')}>
              <input type="number" step="0.01" className={inputCls} value={String(rate.published_apr_pct ?? '')} onChange={(e) => setRate({ ...rate, published_apr_pct: e.target.value === '' ? null : Number(e.target.value) })} />
            </Field>
            <Field label={t('رابط المصدر الرسمي', 'Official source URL')}>
              <input className={inputCls} value={String(rate.source_url ?? '')} onChange={(e) => setRate({ ...rate, source_url: e.target.value })} />
            </Field>
            <Field label={t('تاريخ السريان', 'Effective from')}>
              <input type="date" className={inputCls} value={String(rate.effective_from ?? '')} onChange={(e) => setRate({ ...rate, effective_from: e.target.value })} />
            </Field>
            <Field label={t('تاريخ آخر تحقق', 'Last verified')}>
              <input type="date" className={inputCls} value={String(rate.last_verified_at ?? '')} onChange={(e) => setRate({ ...rate, last_verified_at: e.target.value })} />
            </Field>
          </div>
          <div className="mt-3 flex gap-2">
            <Button onClick={async () => {
              try {
                await financingApi.adminRateAdd({ ...rate, product_id: rateFor });
                addToast(t('تم إضافة السعر', 'Rate added'), 'success');
                setRateFor(null); load();
              } catch (e) { addToast(e instanceof Error ? e.message : String(e), 'error'); }
            }}>{t('حفظ', 'Save')}</Button>
            <Button variant="secondary" onClick={() => setRateFor(null)}>{t('إلغاء', 'Cancel')}</Button>
          </div>
        </div>
      )}

      <div className="card p-5">
        <h3 className="mb-3 font-bold text-charcoal">{t('الأسعار الحالية', 'Current rates')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-xs">
            <thead>
              <tr className="border-b border-sand/30 text-charcoal/50">
                <th className="p-2 text-start">{t('المنتج', 'Product')}</th>
                <th className="p-2 text-start">{t('نوع الإفصاح', 'Disclosure')}</th>
                <th className="p-2 text-end">{t('تعاقدي', 'Contractual')}</th>
                <th className="p-2 text-end">{t('النسبة السنوية', 'APR')}</th>
                <th className="p-2 text-start">{t('التحقق', 'Verified')}</th>
                <th className="p-2 text-start">{t('نشط', 'Active')}</th>
                <th className="p-2 text-start">{t('إجراء', 'Action')}</th>
              </tr>
            </thead>
            <tbody>
              {data.rates.map((r) => (
                <tr key={String(r.id)} className={`border-b border-sand/10 ${r.is_active ? '' : 'opacity-40'}`}>
                  <td className="p-2 text-charcoal/80">{productLabel(r.product_id)}</td>
                  <td className="p-2 text-charcoal/80">{String(r.disclosure_type)}</td>
                  <td className="p-2 text-end text-charcoal/70">{pctCell(r.contractual_rate_pct)}</td>
                  <td className="p-2 text-end text-charcoal/70">
                    {r.published_apr_pct !== null && r.published_apr_pct !== undefined
                      ? pctCell(r.published_apr_pct)
                      : r.starting_apr_pct !== null && r.starting_apr_pct !== undefined
                        ? `${pctCell(r.starting_apr_pct)}+`
                        : '—'}
                  </td>
                  <td className="p-2 text-charcoal/50">{String(r.last_verified_at)}</td>
                  <td className="p-2">{r.marked_stale === true ? t('قديم', 'stale') : r.is_active === true ? '✓' : '—'}</td>
                  <td className="p-2">
                    {r.is_active === true && r.marked_stale !== true && (
                      <button type="button" className="text-amber-600 hover:underline"
                        onClick={async () => {
                          try { await financingApi.adminRateStale(String(r.id)); load(); }
                          catch (e) { addToast(e instanceof Error ? e.message : String(e), 'error'); }
                        }}>
                        {t('تعليم كقديم', 'Mark stale')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-5">
        <h3 className="mb-3 font-bold text-charcoal">{t('القواعد النظامية المطبقة', 'Regulatory rules in force')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-xs">
            <thead>
              <tr className="border-b border-sand/30 text-charcoal/50">
                <th className="p-2 text-start">{t('القاعدة', 'Rule')}</th>
                <th className="p-2 text-start">{t('سارية من', 'Effective from')}</th>
                <th className="p-2 text-start">{t('آخر تحقق', 'Verified')}</th>
                <th className="p-2 text-start">{t('المصدر', 'Source')}</th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={String(r.id)} className="border-b border-sand/10">
                  <td className="p-2 font-medium text-charcoal">{String(isAr ? r.label_ar : r.label_en)}</td>
                  <td className="p-2 text-charcoal/60">{String(r.effective_from)}</td>
                  <td className="p-2 text-charcoal/60">{String(r.last_verified_at)}</td>
                  <td className="p-2 text-[11px]">
                    <a href={String(r.source_url)} target="_blank" rel="noreferrer" className="text-copper hover:underline">
                      {String(r.citation ?? r.source_url).slice(0, 70)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
