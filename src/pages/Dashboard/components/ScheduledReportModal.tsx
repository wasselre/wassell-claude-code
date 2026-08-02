import { useState, useEffect } from 'react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import type { ReportFrequency, ReportSourceType, ScheduledReport } from '@/types';

interface Props {
  open: boolean;
  onClose: () => void;
  existing?: ScheduledReport;
}

const FREQS: { value: ReportFrequency; ar: string; en: string }[] = [
  { value: 'daily', ar: 'يومي', en: 'Daily' },
  { value: 'weekly', ar: 'أسبوعي', en: 'Weekly' },
  { value: 'monthly', ar: 'شهري', en: 'Monthly' },
];
const DOW: { value: number; ar: string; en: string }[] = [
  { value: 0, ar: 'الأحد', en: 'Sun' }, { value: 1, ar: 'الإثنين', en: 'Mon' }, { value: 2, ar: 'الثلاثاء', en: 'Tue' },
  { value: 3, ar: 'الأربعاء', en: 'Wed' }, { value: 4, ar: 'الخميس', en: 'Thu' }, { value: 5, ar: 'الجمعة', en: 'Fri' }, { value: 6, ar: 'السبت', en: 'Sat' },
];

export default function ScheduledReportModal({ open, onClose, existing }: Props) {
  const { dashboards, metricDefinitions, language, saveScheduledReport, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [title, setTitle] = useState('');
  const [sourceType, setSourceType] = useState<ReportSourceType>('dashboard');
  const [dashboardId, setDashboardId] = useState('');
  const [widgetId, setWidgetId] = useState('');
  const [metricId, setMetricId] = useState('');
  const [frequency, setFrequency] = useState<ReportFrequency>('daily');
  const [hour, setHour] = useState(8);
  const [dow, setDow] = useState(0);
  const [dom, setDom] = useState(1);
  const [recipients, setRecipients] = useState('');
  const [reportLang, setReportLang] = useState<'ar' | 'en'>('ar');

  useEffect(() => {
    if (!open) return;
    if (existing) {
      setTitle(existing.title);
      setSourceType(existing.source_type);
      setDashboardId(existing.dashboard_id ?? '');
      setWidgetId(existing.widget_id ?? '');
      setMetricId(existing.metric_id ?? '');
      setFrequency(existing.frequency);
      setHour(existing.hour_of_day);
      setDow(existing.day_of_week ?? 0);
      setDom(existing.day_of_month ?? 1);
      setRecipients((existing.recipients ?? []).join(', '));
      setReportLang(existing.language === 'en' ? 'en' : 'ar');
    } else {
      setTitle(''); setSourceType('dashboard'); setDashboardId(''); setWidgetId(''); setMetricId('');
      setFrequency('daily'); setHour(8); setDow(0); setDom(1); setRecipients('');
      setReportLang(isAr ? 'ar' : 'en');
    }
  }, [open, existing]);

  const dash = dashboards.find((d) => d.id === dashboardId);
  const widgets = (dash?.widgets ?? []).filter((w) => w.type !== 'table');

  const valid =
    !!title.trim() &&
    ((sourceType === 'dashboard' && !!dashboardId) ||
      (sourceType === 'widget' && !!dashboardId && !!widgetId) ||
      (sourceType === 'metric' && !!metricId));

  const save = async () => {
    if (!valid) return;
    const emails = recipients.split(/[,\n;]+/).map((s) => s.trim()).filter((s) => s.includes('@'));
    let ownerAuthUid = existing?.owner_auth_uid ?? null;
    if (!ownerAuthUid && supabase) ownerAuthUid = (await supabase.auth.getUser()).data.user?.id ?? null;
    const now = new Date().toISOString();
    const report: ScheduledReport = {
      id: existing?.id ?? uuid(),
      title: title.trim(),
      owner_user_id: existing?.owner_user_id ?? ownerAuthUid,
      owner_auth_uid: ownerAuthUid,
      frequency,
      hour_of_day: hour,
      day_of_week: frequency === 'weekly' ? dow : null,
      day_of_month: frequency === 'monthly' ? dom : null,
      timezone: 'Asia/Riyadh',
      recipients: emails,
      delivery_channel: 'email',
      language: reportLang,
      source_type: sourceType,
      dashboard_id: sourceType === 'dashboard' || sourceType === 'widget' ? dashboardId : null,
      widget_id: sourceType === 'widget' ? widgetId : null,
      metric_id: sourceType === 'metric' ? metricId : null,
      query: existing?.query ?? null,
      status: existing?.status === 'paused' ? 'paused' : 'active',
      last_run_at: existing?.last_run_at ?? null,
      next_run_at: existing?.next_run_at ?? null, // the DB trigger fills/refreshes this
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    saveScheduledReport(report);
    if (emails.length === 0) addToast(isAr ? 'تم الحفظ (لا مستلمين — سيُحفظ كمسودة)' : 'Saved (no recipients — will store a draft)', 'info');
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={existing ? (isAr ? 'تعديل التقرير' : 'Edit report') : isAr ? 'تقرير مجدول جديد' : 'New scheduled report'} maxWidth="max-w-lg"
      footer={<><Button variant="ghost" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</Button><Button onClick={save} disabled={!valid}>{isAr ? 'حفظ' : 'Save'}</Button></>}>
      <div className="space-y-4">
        <Input label={isAr ? 'عنوان التقرير' : 'Report title'} value={title} onChange={(e) => setTitle(e.target.value)} dir={isAr ? 'rtl' : 'ltr'} required />

        <div>
          <label className="mb-1 block text-sm font-bold text-charcoal">{isAr ? 'المصدر' : 'Source'}</label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {(['dashboard', 'widget', 'metric'] as ReportSourceType[]).map((t) => (
              <button key={t} onClick={() => setSourceType(t)} className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${sourceType === t ? 'border-copper bg-copper/10 text-copper' : 'border-sand text-charcoal'}`}>
                {t === 'dashboard' ? (isAr ? 'لوحة كاملة' : 'Dashboard') : t === 'widget' ? (isAr ? 'عنصر واحد' : 'Widget') : isAr ? 'مقياس' : 'Metric'}
              </button>
            ))}
          </div>
          {(sourceType === 'dashboard' || sourceType === 'widget') && (
            <select value={dashboardId} onChange={(e) => { setDashboardId(e.target.value); setWidgetId(''); }} className="form-input mb-2 w-full text-sm">
              <option value="">— {isAr ? 'اختر لوحة' : 'Choose dashboard'} —</option>
              {dashboards.map((d) => <option key={d.id} value={d.id}>{isAr ? d.label_ar : d.label_en}</option>)}
            </select>
          )}
          {sourceType === 'widget' && dashboardId && (
            <select value={widgetId} onChange={(e) => setWidgetId(e.target.value)} className="form-input w-full text-sm">
              <option value="">— {isAr ? 'اختر عنصراً' : 'Choose widget'} —</option>
              {widgets.map((w) => <option key={w.id} value={w.id}>{isAr ? w.title_ar : w.title_en}</option>)}
            </select>
          )}
          {sourceType === 'metric' && (
            <select value={metricId} onChange={(e) => setMetricId(e.target.value)} className="form-input w-full text-sm">
              <option value="">— {isAr ? 'اختر مقياساً' : 'Choose metric'} —</option>
              {metricDefinitions.map((m) => <option key={m.id} value={m.id}>{isAr ? m.label_ar : m.label_en}</option>)}
            </select>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-bold text-charcoal">{isAr ? 'الجدولة (توقيت الرياض)' : 'Schedule (Riyadh time)'}</label>
          <div className="flex flex-wrap items-center gap-2">
            {FREQS.map((f) => (
              <button key={f.value} onClick={() => setFrequency(f.value)} className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${frequency === f.value ? 'border-copper bg-copper/10 text-copper' : 'border-sand text-charcoal'}`}>{isAr ? f.ar : f.en}</button>
            ))}
            <span className="text-xs text-charcoal/60">{isAr ? 'الساعة' : 'at'}</span>
            <select value={hour} onChange={(e) => setHour(Number(e.target.value))} className="form-input w-20 py-1 text-sm">
              {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>)}
            </select>
            {frequency === 'weekly' && (
              <select value={dow} onChange={(e) => setDow(Number(e.target.value))} className="form-input py-1 text-sm">
                {DOW.map((d) => <option key={d.value} value={d.value}>{isAr ? d.ar : d.en}</option>)}
              </select>
            )}
            {frequency === 'monthly' && (
              <select value={dom} onChange={(e) => setDom(Number(e.target.value))} className="form-input w-20 py-1 text-sm">
                {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
              </select>
            )}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-bold text-charcoal">{isAr ? 'لغة التقرير' : 'Report language'}</label>
          <div className="flex gap-1.5">
            {([['ar', 'العربية', 'Arabic'], ['en', 'الإنجليزية', 'English']] as const).map(([v, ar, en]) => (
              <button key={v} onClick={() => setReportLang(v)} className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${reportLang === v ? 'border-copper bg-copper/10 text-copper' : 'border-sand text-charcoal'}`}>
                {isAr ? ar : en}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-bold text-charcoal">{isAr ? 'المستلمون (بريد إلكتروني، مفصول بفواصل)' : 'Recipients (emails, comma-separated)'}</label>
          <textarea value={recipients} onChange={(e) => setRecipients(e.target.value)} rows={2} dir="ltr" className="form-input w-full text-sm" placeholder="a@wassel.re, b@wassel.re" />
        </div>
      </div>
    </Modal>
  );
}
