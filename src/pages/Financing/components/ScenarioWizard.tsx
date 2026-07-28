/**
 * The six-step financing questionnaire.
 *
 * DESIGN DECISIONS WORTH KNOWING:
 *
 *  - Draft-safe by default. Every step's "next" persists, so a rep interrupted
 *    mid-call does not lose the customer's figures.
 *  - Prefilled from the CRM. Name, phone and budget already exist on the client
 *    record; asking for them again is how a questionnaire earns a reputation
 *    for wasting a rep's time.
 *  - No national ID field anywhere. An indicative estimate does not need one,
 *    and collecting it "just in case" is the kind of unnecessary PII the PDPL
 *    posture in this module explicitly avoids.
 *  - Declared vs verified income are SEPARATE inputs, because the engine treats
 *    them differently and a single "income" box would erase that.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { DOC_STATUS_LABEL, INCOME_LABEL, OBLIGATION_LABEL, financingApi, formatSar } from '@/lib/financing/client';

type StepId = 'profile' | 'income' | 'obligations' | 'support' | 'property' | 'preferences';

const STEPS: Array<{ id: StepId; ar: string; en: string }> = [
  { id: 'profile', ar: 'بيانات العميل', en: 'Customer profile' },
  { id: 'income', ar: 'الدخل', en: 'Income' },
  { id: 'obligations', ar: 'الالتزامات', en: 'Obligations' },
  { id: 'support', ar: 'الدعم والمسكن الأول', en: 'Support & first home' },
  { id: 'property', ar: 'العقار', en: 'Property' },
  { id: 'preferences', ar: 'تفضيلات التمويل', en: 'Financing preferences' },
];

type Row = Record<string, unknown>;

interface WizardProps {
  scenarioId: string | null;
  initial?: {
    scenario?: Row;
    applicants?: Row[];
    incomes?: Row[];
    obligations?: Row[];
    support?: Row | null;
    property?: Row | null;
    preferences?: Row | null;
  };
  /** Pre-seed from a CRM record so the rep never re-types known data. */
  prefill?: { client_record_id?: string; project_record_id?: string; unit_record_id?: string; property_price?: number; title?: string };
  onSaved: (scenarioId: string) => void;
  onCalculated: (scenarioId: string) => void;
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold text-charcoal/70">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-charcoal/45">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full rounded-lg border border-sand/40 bg-white px-3 py-2 text-sm text-charcoal outline-none focus:border-copper focus:ring-2 focus:ring-copper/20';

export default function ScenarioWizard({ scenarioId, initial, prefill, onSaved, onCalculated }: WizardProps) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const addToast = useAppStore((s) => s.addToast);
  const t = (ar: string, en: string) => (isAr ? ar : en);

  const [stepIndex, setStepIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [id, setId] = useState<string | null>(scenarioId);

  const [scenario, setScenario] = useState<Row>(() => ({
    title: prefill?.title ?? '',
    client_record_id: prefill?.client_record_id ?? null,
    project_record_id: prefill?.project_record_id ?? null,
    unit_record_id: prefill?.unit_record_id ?? null,
    ...(initial?.scenario ?? {}),
  }));
  const [applicants, setApplicants] = useState<Row[]>(
    () => initial?.applicants?.length ? initial.applicants : [{ applicant_role: 'primary', nationality_type: 'saudi', employment_type: 'employee' }],
  );
  const [incomes, setIncomes] = useState<Row[]>(
    () => initial?.incomes?.length ? initial.incomes : [{ income_type: 'basic_salary', frequency: 'monthly', documentation_status: 'self_declared', is_fixed: true }],
  );
  const [obligations, setObligations] = useState<Row[]>(() => initial?.obligations ?? []);
  const [support, setSupport] = useState<Row>(() => initial?.support ?? { support_status: 'unknown', financing_kind: 'unknown' });
  const [property, setProperty] = useState<Row>(
    () => initial?.property ?? {
      source_kind: prefill?.unit_record_id ? 'unit' : prefill?.project_record_id ? 'project' : 'manual',
      project_record_id: prefill?.project_record_id ?? null,
      unit_record_id: prefill?.unit_record_id ?? null,
      property_price: prefill?.property_price ?? null,
    },
  );
  const [preferences, setPreferences] = useState<Row>(
    () => initial?.preferences ?? { preferred_term_months: 240, rate_preference: 'no_preference', priority: 'lowest_monthly' },
  );

  useEffect(() => setId(scenarioId), [scenarioId]);

  const step = STEPS[stepIndex]!;

  const payload = useMemo(
    () => ({ scenario_id: id, scenario, applicants, incomes, obligations, support, property, preferences }),
    [id, scenario, applicants, incomes, obligations, support, property, preferences],
  );

  async function save(): Promise<string | null> {
    setSaving(true);
    try {
      const res = await financingApi.scenarioSave(payload);
      setId(res.scenario_id);
      onSaved(res.scenario_id);
      return res.scenario_id;
    } catch (err) {
      // Loud by design: a silently-failed save loses a customer's whole intake.
      addToast(err instanceof Error ? err.message : String(err), 'error');
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function next() {
    const saved = await save();
    if (saved && stepIndex < STEPS.length - 1) setStepIndex((i) => i + 1);
  }

  async function calculate() {
    const saved = await save();
    if (!saved) return;
    setCalculating(true);
    try {
      await financingApi.calculate(saved, 'full');
      onCalculated(saved);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setCalculating(false);
    }
  }

  const patchRow = (list: Row[], setList: (r: Row[]) => void, index: number, patch: Row) =>
    setList(list.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const num = (v: string): number | null => (v === '' ? null : Number(v));

  return (
    <div className="space-y-4" dir={isAr ? 'rtl' : 'ltr'}>
      {/* Progress */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStepIndex(i)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold transition-colors ${
                i === stepIndex
                  ? 'bg-copper text-white'
                  : i < stepIndex
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-charcoal/5 text-charcoal/50'
              }`}
            >
              {i < stepIndex ? <Check size={12} /> : <span>{i + 1}</span>}
              {isAr ? s.ar : s.en}
            </button>
          ))}
        </div>
      </div>

      <div className="card p-5">
        {/* ── Step 1: profile ────────────────────────────────────────── */}
        {step.id === 'profile' && (
          <div className="space-y-4">
            <Field label={t('عنوان السيناريو', 'Scenario title')}>
              <input
                className={inputCls}
                value={String(scenario.title ?? '')}
                onChange={(e) => setScenario({ ...scenario, title: e.target.value })}
                placeholder={t('مثال: شقة الياسمين — 20 سنة', 'e.g. Al Yasmin apartment — 20 years')}
              />
            </Field>

            {applicants.map((a, idx) => (
              <div key={idx} className="rounded-xl border border-sand/30 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-bold text-charcoal">
                    {a.applicant_role === 'co_borrower' ? t('المقترض المشارك', 'Co-borrower') : t('المتقدم الرئيسي', 'Primary applicant')}
                  </span>
                  {a.applicant_role === 'co_borrower' && (
                    <button type="button" onClick={() => setApplicants(applicants.filter((_, i) => i !== idx))} className="text-red-500">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label={t('الجنسية', 'Nationality')}>
                    <select className={inputCls} value={String(a.nationality_type ?? '')} onChange={(e) => patchRow(applicants, setApplicants, idx, { nationality_type: e.target.value || null })}>
                      <option value="">{t('غير محدد', 'Not stated')}</option>
                      <option value="saudi">{t('مواطن سعودي', 'Saudi citizen')}</option>
                      <option value="resident">{t('مقيم', 'Resident')}</option>
                    </select>
                  </Field>
                  <Field label={t('تاريخ الميلاد', 'Date of birth')}>
                    <input type="date" className={inputCls} value={String(a.date_of_birth ?? '')} onChange={(e) => patchRow(applicants, setApplicants, idx, { date_of_birth: e.target.value || null })} />
                  </Field>
                  <Field label={t('مدينة الإقامة', 'City of residence')}>
                    <input className={inputCls} value={String(a.city_of_residence ?? '')} onChange={(e) => patchRow(applicants, setApplicants, idx, { city_of_residence: e.target.value || null })} />
                  </Field>
                  <Field label={t('نوع التوظيف', 'Employment type')}>
                    <select className={inputCls} value={String(a.employment_type ?? '')} onChange={(e) => patchRow(applicants, setApplicants, idx, { employment_type: e.target.value || null })}>
                      <option value="">{t('غير محدد', 'Not stated')}</option>
                      <option value="employee">{t('موظف', 'Employee')}</option>
                      <option value="military">{t('عسكري', 'Military')}</option>
                      <option value="retiree">{t('متقاعد', 'Retiree')}</option>
                      <option value="self_employed">{t('عمل حر', 'Self-employed')}</option>
                      <option value="business_owner">{t('صاحب عمل', 'Business owner')}</option>
                    </select>
                  </Field>
                  <Field label={t('قطاع جهة العمل', 'Employer sector')}>
                    <select className={inputCls} value={String(a.employer_sector ?? '')} onChange={(e) => patchRow(applicants, setApplicants, idx, { employer_sector: e.target.value || null })}>
                      <option value="">{t('غير محدد', 'Not stated')}</option>
                      <option value="government">{t('حكومي', 'Government')}</option>
                      <option value="semi_government">{t('شبه حكومي', 'Semi-government')}</option>
                      <option value="military">{t('عسكري', 'Military')}</option>
                      <option value="private">{t('قطاع خاص', 'Private')}</option>
                    </select>
                  </Field>
                  <Field label={t('جهة العمل', 'Employer name')}>
                    <input className={inputCls} value={String(a.employer_name ?? '')} onChange={(e) => patchRow(applicants, setApplicants, idx, { employer_name: e.target.value || null })} />
                  </Field>
                  <Field label={t('مدة الخدمة (بالأشهر)', 'Length of service (months)')}>
                    <input type="number" min={0} className={inputCls} value={String(a.service_months ?? '')} onChange={(e) => patchRow(applicants, setApplicants, idx, { service_months: num(e.target.value) })} />
                  </Field>
                  <Field label={t('بنك تحويل الراتب الحالي', 'Current salary-transfer bank')}>
                    <input className={inputCls} value={String(a.salary_transfer_bank_name ?? '')} onChange={(e) => patchRow(applicants, setApplicants, idx, { salary_transfer_bank_name: e.target.value || null })} />
                  </Field>
                  <Field
                    label={t('هل يوافق على تحويل الراتب؟', 'Willing to transfer salary?')}
                    hint={t('يؤثر على الحد الأدنى للراتب المطلوب لدى بعض البنوك', 'Changes the minimum-salary threshold at several banks')}
                  >
                    <select
                      className={inputCls}
                      value={a.willing_to_transfer_salary === true ? 'yes' : a.willing_to_transfer_salary === false ? 'no' : ''}
                      onChange={(e) => patchRow(applicants, setApplicants, idx, { willing_to_transfer_salary: e.target.value === '' ? null : e.target.value === 'yes' })}
                    >
                      <option value="">{t('غير محدد', 'Not stated')}</option>
                      <option value="yes">{t('نعم', 'Yes')}</option>
                      <option value="no">{t('لا', 'No')}</option>
                    </select>
                  </Field>
                  {a.employment_type === 'retiree' && (
                    <Field label={t('تاريخ التقاعد', 'Retirement date')}>
                      <input type="date" className={inputCls} value={String(a.retirement_date ?? '')} onChange={(e) => patchRow(applicants, setApplicants, idx, { retirement_date: e.target.value || null })} />
                    </Field>
                  )}
                  {a.employment_type === 'military' && (
                    <Field label={t('الرتبة العسكرية', 'Military rank')}>
                      <input className={inputCls} value={String(a.military_rank ?? '')} onChange={(e) => patchRow(applicants, setApplicants, idx, { military_rank: e.target.value || null })} />
                    </Field>
                  )}
                </div>
              </div>
            ))}

            {applicants.length < 2 && (
              <Button variant="secondary" onClick={() => setApplicants([...applicants, { applicant_role: 'co_borrower', nationality_type: 'saudi', employment_type: 'employee' }])}>
                <Plus size={14} /> {t('إضافة مقترض مشارك', 'Add co-borrower')}
              </Button>
            )}
          </div>
        )}

        {/* ── Step 2: income ─────────────────────────────────────────── */}
        {step.id === 'income' && (
          <div className="space-y-3">
            <p className="text-xs text-charcoal/55">
              {t(
                'يفرّق النظام بين الدخل المُقر والدخل الموثق. الدخل غير الموثق يُعرض لكنه قد لا يُحتسب وفق قواعد البنك المركزي.',
                'Declared and verified income are recorded separately. Undocumented income is shown but may not count under SAMA’s rules.',
              )}
            </p>
            {incomes.map((inc, idx) => (
              <div key={idx} className="grid grid-cols-1 gap-3 rounded-xl border border-sand/30 p-3 sm:grid-cols-2 lg:grid-cols-5">
                <Field label={t('النوع', 'Type')}>
                  <select className={inputCls} value={String(inc.income_type ?? '')} onChange={(e) => patchRow(incomes, setIncomes, idx, { income_type: e.target.value })}>
                    {Object.entries(INCOME_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{isAr ? v.ar : v.en}</option>
                    ))}
                  </select>
                </Field>
                <Field label={t('المبلغ المُقر', 'Declared amount')}>
                  <input type="number" min={0} className={inputCls} value={String(inc.declared_monthly_amount ?? '')} onChange={(e) => patchRow(incomes, setIncomes, idx, { declared_monthly_amount: num(e.target.value) })} />
                </Field>
                <Field label={t('المبلغ الموثق', 'Verified amount')}>
                  <input type="number" min={0} className={inputCls} value={String(inc.verified_monthly_amount ?? '')} onChange={(e) => patchRow(incomes, setIncomes, idx, { verified_monthly_amount: num(e.target.value) })} />
                </Field>
                <Field label={t('التوثيق', 'Documentation')}>
                  <select className={inputCls} value={String(inc.documentation_status ?? 'self_declared')} onChange={(e) => patchRow(incomes, setIncomes, idx, { documentation_status: e.target.value })}>
                    {Object.entries(DOC_STATUS_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{isAr ? v.ar : v.en}</option>
                    ))}
                  </select>
                </Field>
                <div className="flex items-end gap-2">
                  <Field label={t('التكرار', 'Frequency')}>
                    <select className={inputCls} value={String(inc.frequency ?? 'monthly')} onChange={(e) => patchRow(incomes, setIncomes, idx, { frequency: e.target.value })}>
                      <option value="monthly">{t('شهري', 'Monthly')}</option>
                      <option value="quarterly">{t('ربع سنوي', 'Quarterly')}</option>
                      <option value="semi_annual">{t('نصف سنوي', 'Semi-annual')}</option>
                      <option value="annual">{t('سنوي', 'Annual')}</option>
                      <option value="irregular">{t('غير منتظم', 'Irregular')}</option>
                    </select>
                  </Field>
                  <button type="button" onClick={() => setIncomes(incomes.filter((_, i) => i !== idx))} className="mb-2 text-red-500">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
            <Button variant="secondary" onClick={() => setIncomes([...incomes, { income_type: 'other_allowance', frequency: 'monthly', documentation_status: 'self_declared', is_fixed: true }])}>
              <Plus size={14} /> {t('إضافة مصدر دخل', 'Add income source')}
            </Button>
          </div>
        )}

        {/* ── Step 3: obligations ────────────────────────────────────── */}
        {step.id === 'obligations' && (
          <div className="space-y-3">
            <p className="text-xs text-charcoal/55">
              {t(
                'للبطاقات الائتمانية يُحتسب الالتزام كنسبة من حد البطاقة وليس من الرصيد — لذا حد البطاقة مطلوب.',
                'A credit card is charged as a percentage of its LIMIT, not its balance — so the limit is what matters.',
              )}
            </p>
            {obligations.map((ob, idx) => (
              <div key={idx} className="grid grid-cols-1 gap-3 rounded-xl border border-sand/30 p-3 sm:grid-cols-2 lg:grid-cols-5">
                <Field label={t('النوع', 'Type')}>
                  <select className={inputCls} value={String(ob.obligation_type ?? '')} onChange={(e) => patchRow(obligations, setObligations, idx, { obligation_type: e.target.value })}>
                    {Object.entries(OBLIGATION_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{isAr ? v.ar : v.en}</option>
                    ))}
                  </select>
                </Field>
                <Field label={t('الجهة', 'Provider')}>
                  <input className={inputCls} value={String(ob.provider_name ?? '')} onChange={(e) => patchRow(obligations, setObligations, idx, { provider_name: e.target.value || null })} />
                </Field>
                {ob.obligation_type === 'credit_card' ? (
                  <Field label={t('حد البطاقة', 'Card limit')}>
                    <input type="number" min={0} className={inputCls} value={String(ob.card_limit ?? '')} onChange={(e) => patchRow(obligations, setObligations, idx, { card_limit: num(e.target.value) })} />
                  </Field>
                ) : (
                  <Field label={t('القسط الشهري', 'Monthly payment')}>
                    <input type="number" min={0} className={inputCls} value={String(ob.monthly_payment ?? '')} onChange={(e) => patchRow(obligations, setObligations, idx, { monthly_payment: num(e.target.value) })} />
                  </Field>
                )}
                <Field label={t('تاريخ الانتهاء', 'End date')} hint={t('يُنتج سيناريو ثانيًا بعد الانتهاء', 'Produces a second "after it ends" scenario')}>
                  <input type="date" className={inputCls} value={String(ob.end_date ?? '')} onChange={(e) => patchRow(obligations, setObligations, idx, { end_date: e.target.value || null })} />
                </Field>
                <div className="flex items-end justify-between gap-2">
                  <label className="mb-2 flex items-center gap-1.5 text-xs text-charcoal/70">
                    <input
                      type="checkbox"
                      className="accent-copper"
                      checked={ob.will_be_settled_before_financing === true}
                      onChange={(e) => patchRow(obligations, setObligations, idx, { will_be_settled_before_financing: e.target.checked })}
                    />
                    {t('سيُسدد قبل التمويل', 'Settled before financing')}
                  </label>
                  <button type="button" onClick={() => setObligations(obligations.filter((_, i) => i !== idx))} className="mb-2 text-red-500">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
            <Button variant="secondary" onClick={() => setObligations([...obligations, { obligation_type: 'personal_finance', verification_status: 'self_declared', will_be_settled_before_financing: false }])}>
              <Plus size={14} /> {t('إضافة التزام', 'Add obligation')}
            </Button>
          </div>
        )}

        {/* ── Step 4: support ────────────────────────────────────────── */}
        {step.id === 'support' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('هل هو المسكن الأول؟', 'Is this the first home?')} hint={t('يرفع سقف التمويل إلى 90% للمواطنين', 'Raises the LTV ceiling to 90% for citizens')}>
              <select className={inputCls} value={support.is_first_home === true ? 'yes' : support.is_first_home === false ? 'no' : ''} onChange={(e) => setSupport({ ...support, is_first_home: e.target.value === '' ? null : e.target.value === 'yes' })}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                <option value="yes">{t('نعم', 'Yes')}</option>
                <option value="no">{t('لا', 'No')}</option>
              </select>
            </Field>
            <Field label={t('مؤهل لدعم سكني؟', 'Eligible for Sakani support?')}>
              <select className={inputCls} value={support.sakani_eligible === true ? 'yes' : support.sakani_eligible === false ? 'no' : ''} onChange={(e) => setSupport({ ...support, sakani_eligible: e.target.value === '' ? null : e.target.value === 'yes' })}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                <option value="yes">{t('نعم', 'Yes')}</option>
                <option value="no">{t('لا', 'No')}</option>
              </select>
            </Field>
            <Field label={t('مؤهل لصندوق التنمية العقارية؟', 'Eligible for REDF?')}>
              <select className={inputCls} value={support.redf_eligible === true ? 'yes' : support.redf_eligible === false ? 'no' : ''} onChange={(e) => setSupport({ ...support, redf_eligible: e.target.value === '' ? null : e.target.value === 'yes' })}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                <option value="yes">{t('نعم', 'Yes')}</option>
                <option value="no">{t('لا', 'No')}</option>
              </select>
            </Field>
            <Field label={t('حالة الدعم', 'Support status')} hint={t('"مؤكد" تعني الاطلاع على شهادة الأهلية', '"Confirmed" means the eligibility certificate was seen')}>
              <select className={inputCls} value={String(support.support_status ?? 'unknown')} onChange={(e) => setSupport({ ...support, support_status: e.target.value })}>
                <option value="unknown">{t('غير معروف', 'Unknown')}</option>
                <option value="self_declared">{t('إقرار العميل', 'Self-declared')}</option>
                <option value="confirmed">{t('مؤكد بشهادة', 'Confirmed by certificate')}</option>
                <option value="not_eligible">{t('غير مؤهل', 'Not eligible')}</option>
              </select>
            </Field>
            <Field label={t('نوع التمويل', 'Financing kind')}>
              <select className={inputCls} value={String(support.financing_kind ?? 'unknown')} onChange={(e) => setSupport({ ...support, financing_kind: e.target.value })}>
                <option value="unknown">{t('غير محدد', 'Not stated')}</option>
                <option value="supported">{t('مدعوم', 'Supported')}</option>
                <option value="unsupported">{t('غير مدعوم', 'Unsupported')}</option>
              </select>
            </Field>
            <Field label={t('سبق استخدام إعفاء ضريبة المسكن الأول؟', 'Already used the first-home tax relief?')}>
              <select className={inputCls} value={support.previously_used_first_home_tax_support === true ? 'yes' : support.previously_used_first_home_tax_support === false ? 'no' : ''} onChange={(e) => setSupport({ ...support, previously_used_first_home_tax_support: e.target.value === '' ? null : e.target.value === 'yes' })}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                <option value="yes">{t('نعم', 'Yes')}</option>
                <option value="no">{t('لا', 'No')}</option>
              </select>
            </Field>
          </div>
        )}

        {/* ── Step 5: property ───────────────────────────────────────── */}
        {step.id === 'property' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('سعر العقار', 'Property price')}>
              <input type="number" min={0} className={inputCls} value={String(property.property_price ?? '')} onChange={(e) => setProperty({ ...property, property_price: num(e.target.value) })} />
            </Field>
            <Field label={t('نوع العقار', 'Property type')}>
              <select className={inputCls} value={String(property.property_type ?? '')} onChange={(e) => setProperty({ ...property, property_type: e.target.value || null })}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                <option value="apartment">{t('شقة', 'Apartment')}</option>
                <option value="villa">{t('فيلا', 'Villa')}</option>
                <option value="townhouse">{t('تاون هاوس', 'Townhouse')}</option>
                <option value="duplex">{t('دبلكس', 'Duplex')}</option>
                <option value="floor">{t('دور', 'Floor')}</option>
                <option value="land">{t('أرض', 'Land')}</option>
              </select>
            </Field>
            <Field label={t('حالة العقار', 'Property status')}>
              <select className={inputCls} value={String(property.property_status ?? '')} onChange={(e) => setProperty({ ...property, property_status: e.target.value || null })}>
                <option value="">{t('غير محدد', 'Not stated')}</option>
                <option value="completed">{t('جاهز', 'Completed')}</option>
                <option value="off_plan">{t('على الخارطة', 'Off-plan')}</option>
                <option value="self_build">{t('بناء ذاتي', 'Self-build')}</option>
                <option value="land_and_construction">{t('أرض وبناء', 'Land and construction')}</option>
                <option value="refinance">{t('إعادة تمويل', 'Refinance')}</option>
              </select>
            </Field>
            <Field label={t('المدينة', 'City')}>
              <input className={inputCls} value={String(property.city ?? '')} onChange={(e) => setProperty({ ...property, city: e.target.value || null })} />
            </Field>
            <Field label={t('الحي', 'District')}>
              <input className={inputCls} value={String(property.district ?? '')} onChange={(e) => setProperty({ ...property, district: e.target.value || null })} />
            </Field>
            <Field label={t('النقد المتاح لدى العميل', 'Customer’s available cash')}>
              <input type="number" min={0} className={inputCls} value={String(property.available_cash ?? '')} onChange={(e) => setProperty({ ...property, available_cash: num(e.target.value) })} />
            </Field>
            <Field label={t('الدفعة الأولى المرغوبة', 'Desired down payment')}>
              <input type="number" min={0} className={inputCls} value={String(property.desired_down_payment ?? '')} onChange={(e) => setProperty({ ...property, desired_down_payment: num(e.target.value) })} />
            </Field>
            <Field label={t('التقييم المتوقع', 'Expected valuation')} hint={t('إن قلّ عن سعر البيع، يتحمل العميل الفرق نقدًا', 'If below the sale price, the customer covers the gap in cash')}>
              <input type="number" min={0} className={inputCls} value={String(property.expected_valuation ?? '')} onChange={(e) => setProperty({ ...property, expected_valuation: num(e.target.value) })} />
            </Field>
            <Field label={t('مصاريف إضافية', 'Additional expenses')}>
              <input type="number" min={0} className={inputCls} value={String(property.additional_expenses ?? '')} onChange={(e) => setProperty({ ...property, additional_expenses: num(e.target.value) })} />
            </Field>
          </div>
        )}

        {/* ── Step 6: preferences ────────────────────────────────────── */}
        {step.id === 'preferences' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('المدة المفضلة (بالأشهر)', 'Preferred term (months)')}>
              <input type="number" min={12} max={360} className={inputCls} value={String(preferences.preferred_term_months ?? '')} onChange={(e) => setPreferences({ ...preferences, preferred_term_months: num(e.target.value) })} />
            </Field>
            <Field label={t('نوع السعر', 'Rate type')}>
              <select className={inputCls} value={String(preferences.rate_preference ?? 'no_preference')} onChange={(e) => setPreferences({ ...preferences, rate_preference: e.target.value })}>
                <option value="no_preference">{t('لا تفضيل', 'No preference')}</option>
                <option value="fixed">{t('ثابت', 'Fixed')}</option>
                <option value="variable">{t('متغير', 'Variable')}</option>
              </select>
            </Field>
            <Field label={t('الصيغة الشرعية', 'Islamic structure')}>
              <select className={inputCls} value={String(preferences.structure_preference ?? 'unsure')} onChange={(e) => setPreferences({ ...preferences, structure_preference: e.target.value })}>
                <option value="unsure">{t('غير متأكد', 'Unsure')}</option>
                <option value="murabaha">{t('مرابحة', 'Murabaha')}</option>
                <option value="ijara">{t('إجارة', 'Ijara')}</option>
              </select>
            </Field>
            <Field label={t('أقصى قسط مقبول', 'Max acceptable installment')}>
              <input type="number" min={0} className={inputCls} value={String(preferences.max_acceptable_installment ?? '')} onChange={(e) => setPreferences({ ...preferences, max_acceptable_installment: num(e.target.value) })} />
            </Field>
            <Field label={t('الأولوية', 'Priority')}>
              <select className={inputCls} value={String(preferences.priority ?? 'lowest_monthly')} onChange={(e) => setPreferences({ ...preferences, priority: e.target.value })}>
                <option value="lowest_monthly">{t('أقل قسط شهري', 'Lowest monthly payment')}</option>
                <option value="lowest_total_cost">{t('أقل تكلفة إجمالية', 'Lowest total cost')}</option>
                <option value="lowest_upfront">{t('أقل نقد مقدم', 'Lowest upfront cash')}</option>
                <option value="shortest_term">{t('أقصر مدة', 'Shortest term')}</option>
              </select>
            </Field>
            <Field label={t('تاريخ بدء التمويل المخطط', 'Planned financing start')}>
              <input type="date" className={inputCls} value={String(preferences.planned_start_date ?? '')} onChange={(e) => setPreferences({ ...preferences, planned_start_date: e.target.value || null })} />
            </Field>
          </div>
        )}
      </div>

      {/* Nav */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="secondary" disabled={stepIndex === 0} onClick={() => setStepIndex((i) => Math.max(0, i - 1))}>
          {isAr ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          {t('السابق', 'Back')}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            {t('حفظ المسودة', 'Save draft')}
          </Button>
          {stepIndex < STEPS.length - 1 ? (
            <Button onClick={next} disabled={saving}>
              {t('التالي', 'Next')}
              {isAr ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
            </Button>
          ) : (
            <Button onClick={calculate} disabled={calculating || saving}>
              {calculating ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              {t('احتساب النتيجة', 'Calculate')}
            </Button>
          )}
        </div>
      </div>

      {property.property_price ? (
        <p className="text-center text-xs text-charcoal/45">
          {t('سعر العقار', 'Property price')}: {formatSar(Number(property.property_price), isAr)}
        </p>
      ) : null}
    </div>
  );
}
