import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { useSv, SectionCard, PageHeader } from './components/shared';

export default function SettingsPage() {
  const { isAr, m, rows, users } = useSv();
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const record = rows(m.settings)[0] ?? null;
  const [d, setD] = useState<Record<string, unknown>>(() => ({ ...(record?.data ?? {}) }));
  const [saving, setSaving] = useState(false);
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    if (record && seededRef.current !== record.id) { seededRef.current = record.id; setD({ ...record.data }); }
  }, [record]);

  const set = (k: string, v: unknown) => setD((x) => ({ ...x, [k]: v }));

  if (!record) {
    return (
      <div className="mx-auto max-w-[900px] p-4 sm:p-6">
        <PageHeader title={isAr ? 'إعدادات تقييم المبيعات' : 'Sales Valuation Settings'} />
        <div className="card p-10 text-center text-charcoal/50">{isAr ? 'لا يوجد سجل إعدادات' : 'No settings record'}</div>
      </div>
    );
  }

  async function save() {
    if (!record) return;
    setSaving(true);
    const res = await saveRecord({ ...record, data: d, updated_at: new Date().toISOString() }, { expectedVersion: record.version ?? null });
    setSaving(false);
    if (res.status === 'conflict') { addToast(isAr ? 'تم التعديل من مستخدم آخر — حدّث الصفحة' : 'Edited elsewhere — reload', 'error'); return; }
    addToast(isAr ? 'تم حفظ الإعدادات' : 'Settings saved', 'success');
  }

  return (
    <div className="mx-auto max-w-[900px] p-4 sm:p-6 space-y-5">
      <PageHeader title={isAr ? 'إعدادات تقييم المبيعات' : 'Sales Valuation Settings'}
        subtitle={isAr ? 'التحكم في عملية التقييم والمراجعة' : 'Control the valuation operation'}
        right={<Button onClick={save} disabled={saving}>{saving ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ الإعدادات' : 'Save')}</Button>} />

      <SectionCard title={isAr ? 'تشغيل العملية' : 'Operation'}>
        <Toggle label={isAr ? 'مفعل' : 'Enabled'} hint={isAr ? 'تشغيل/إيقاف عملية التقييم بالكامل' : 'Turn the whole operation on/off'} checked={d.is_enabled !== false} onChange={(v) => set('is_enabled', v)} />
        <Toggle label={isAr ? 'مراجعة كل المتابعات' : 'Review all follow-ups'} hint={isAr ? 'إنشاء تقييم لكل متابعة مكتملة' : 'Create a review for every completed follow-up'} checked={Boolean(d.review_all_followups)} onChange={(v) => set('review_all_followups', v)} />
      </SectionCard>

      <SectionCard title={isAr ? 'قواعد اختيار المتابعات للمراجعة' : 'Selection Rules'}>
        <Toggle label={isAr ? 'مراجعة العملاء غير المهتمين' : 'Not interested'} checked={Boolean(d.review_not_interested)} onChange={(v) => set('review_not_interested', v)} />
        <Toggle label={isAr ? 'مراجعة العملاء المفقودين' : 'Lost clients'} checked={Boolean(d.review_lost_clients)} onChange={(v) => set('review_lost_clients', v)} />
        <Toggle label={isAr ? 'مراجعة طلبات العروض' : 'Offer requests'} checked={Boolean(d.review_offer_requests)} onChange={(v) => set('review_offer_requests', v)} />
        <Toggle label={isAr ? 'مراجعة الزيارات' : 'Visits'} checked={Boolean(d.review_visits)} onChange={(v) => set('review_visits', v)} />
        <Toggle label={isAr ? 'مراجعة المتابعات بدون خطوة تالية' : 'Missing next step'} checked={Boolean(d.review_missing_next_step)} onChange={(v) => set('review_missing_next_step', v)} />
        <Toggle label={isAr ? 'مراجعة مندوبي التدريب' : 'New reps'} checked={Boolean(d.review_new_reps)} onChange={(v) => set('review_new_reps', v)} />
      </SectionCard>

      <SectionCard title={isAr ? 'نسب العينات' : 'Sample Percentages'}>
        <div className="grid sm:grid-cols-2 gap-4">
          <NumberField label={isAr ? 'نسبة العينة العادية (%)' : 'Normal sample (%)'} value={d.normal_sample_percentage} onChange={(v) => set('normal_sample_percentage', v)} />
          <NumberField label={isAr ? 'نسبة عينة المندوب الجديد (%)' : 'New-rep sample (%)'} value={d.new_rep_sample_percentage} onChange={(v) => set('new_rep_sample_percentage', v)} />
        </div>
      </SectionCard>

      <SectionCard title={isAr ? 'الملخص اليومي' : 'Daily Summary'}>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-charcoal/60 mb-1">{isAr ? 'وقت إنشاء الملخص اليومي' : 'Daily summary time'}</label>
            <input type="time" className="form-input w-40" value={(d.daily_summary_time as string) ?? ''} onChange={(e) => set('daily_summary_time', e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-charcoal/60 mb-1">{isAr ? 'مدير المبيعات الافتراضي' : 'Default sales manager'}</label>
            <select className="form-input w-full" value={(d.default_sales_manager as string) ?? ''} onChange={(e) => set('default_sales_manager', e.target.value)}>
              <option value="">—</option>
              {users.map((u) => <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.email}</option>)}
            </select>
          </div>
        </div>
      </SectionCard>

      <SectionCard title={isAr ? 'شرح الأتمتة' : 'How the automation works'}>
        <ul className="space-y-1.5 text-sm text-charcoal/80 list-disc ps-5">
          <li>{isAr ? 'عند اكتمال المتابعة يتم إنشاء تقييم تلقائي.' : 'When a follow-up completes, a review is created automatically.'}</li>
          <li>{isAr ? 'عند وجود خطأ يتم احتساب الدرجة.' : 'When there is a mistake, the score is computed.'}</li>
          <li>{isAr ? 'عند الحاجة للتصحيح يتم إنشاء مهمة تصحيح.' : 'When correction is needed, a correction task is created.'}</li>
          <li>{isAr ? 'يتم إنشاء ملخص يومي للمندوب.' : 'A daily summary is created for each rep.'}</li>
          <li>{isAr ? 'الاعتراضات تعود للمدير للحسم.' : 'Disputes return to the manager for a final decision.'}</li>
        </ul>
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-copper/10 px-4 py-3 text-sm text-chocolate">
          <Info size={16} className="mt-0.5 flex-shrink-0" />
          <p className="font-semibold">{isAr
            ? 'هذه الأتمتة تعمل من جهة الخادم لضمان عدم فقدان أي متابعة، ولا تظهر كمسار مرئي في صفحة سير العمل.'
            : 'This automation runs server-side so no follow-up is ever missed, and it does not appear as a visible flow in the Workflows page.'}</p>
        </div>
      </SectionCard>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 py-1 cursor-pointer">
      <span>
        <span className="text-sm font-semibold text-charcoal">{label}</span>
        {hint && <span className="block text-xs text-charcoal/50">{hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-copper' : 'bg-charcoal/20'}`}>
        <span className={`inline-block h-5 w-5 mt-0.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-0.5' : 'translate-x-5'}`} />
      </button>
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: unknown; onChange: (v: number | '') => void }) {
  return (
    <div>
      <label className="block text-xs font-medium text-charcoal/60 mb-1">{label}</label>
      <input type="number" className="form-input w-32" value={String(value ?? '')} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
    </div>
  );
}
