/**
 * Admin settings for sending unanswered requests to offices — the dedicated
 * WhatsApp line, the day it was paired (its age drives the warm-up ramp), the
 * sending hours, the re-contact gap and the ramp itself. Saved through the
 * admin-only `office_outreach_settings_save` RPC; defaults and their reasoning
 * live in supabase/migrations/2026-09-28_office_outreach.sql.
 */
import { useState } from 'react';
import { Loader2, AlertTriangle, Plus, Trash2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { outreachErrorText, saveOutreachSettings, type LineStatus, type RampStep } from '@/lib/officeOutreach/client';

interface Props {
  line: LineStatus | null;
  onClose: () => void;
  onSaved: (s: LineStatus) => void;
}

export default function OutreachSettingsModal({ line, onClose, onSaved }: Props) {
  const waDevices = useAppStore((s) => s.waDevices);
  const addToast = useAppStore((s) => s.addToast);
  const isAr = useAppStore((s) => s.language) === 'ar';
  const t = (ar: string, en: string) => (isAr ? ar : en);

  const [deviceId, setDeviceId] = useState(line?.device_id ?? '');
  const [startedOn, setStartedOn] = useState(line?.line_started_on ?? '');
  const [startHour, setStartHour] = useState(line?.send_start_hour ?? 9);
  const [endHour, setEndHour] = useState(line?.send_end_hour ?? 21);
  const [recontact, setRecontact] = useState(line?.recontact_days ?? 14);
  const [ramp, setRamp] = useState<RampStep[]>(line?.ramp ?? []);
  const [saving, setSaving] = useState(false);

  const chosen = waDevices.find((d) => d.device_id === deviceId);
  const isSalesLine = !!chosen?.is_default;
  const isOpsLine = !!chosen?.is_operations;
  const paused = !!line?.paused_until && Date.parse(line.paused_until) > Date.now();

  const save = async (extra: Record<string, unknown> = {}) => {
    const sorted = ramp.slice().sort((a, b) => a.from_day - b.from_day);
    if (sorted.some((s) => s.per_day < 0 || s.min_gap_s < 0 || s.max_gap_s < s.min_gap_s)) {
      addToast(t('راجع جدول التدرج: الحد الأدنى للفاصل يجب ألا يتجاوز الحد الأعلى.', 'Check the ramp: the minimum gap must not exceed the maximum.'), 'error');
      return;
    }
    setSaving(true);
    const res = await saveOutreachSettings({
      device_id: deviceId, line_started_on: startedOn,
      send_start_hour: startHour, send_end_hour: endHour, recontact_days: recontact,
      ramp: sorted, ...extra,
    });
    setSaving(false);
    if (res.error !== null) { addToast(outreachErrorText(res.error, isAr), 'error'); return; }
    addToast(t('حُفظت إعدادات الإرسال', 'Sending settings saved'), 'success');
    onSaved(res.data);
    onClose();
  };

  const setStep = (i: number, patch: Partial<RampStep>) => setRamp((r) => r.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const reply = line && line.sent_7d > 0 ? Math.round((line.replied_7d / line.sent_7d) * 100) : null;

  return (
    <Modal open onClose={onClose} title={t('إعدادات إرسال الطلبات للمكاتب', 'Office sending settings')} maxWidth="max-w-2xl">
      <div className="space-y-4 text-sm">
        {line && (
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-cream-light p-3 text-xs md:grid-cols-4">
            <div><div className="text-charcoal/50">{t('عمر الرقم', 'Line age')}</div><b>{line.line_age_days ?? '—'} {t('يوم', 'days')}</b></div>
            <div><div className="text-charcoal/50">{t('حد اليوم', "Today's cap")}</div><b>{line.per_day}</b></div>
            <div><div className="text-charcoal/50">{t('مجدول اليوم', 'Scheduled today')}</div><b>{line.today_scheduled}</b></div>
            <div><div className="text-charcoal/50">{t('نسبة الرد (7 أيام)', 'Reply rate (7d)')}</div><b>{reply === null ? '—' : `${reply}${isAr ? '٪' : '%'}`}</b></div>
          </div>
        )}

        {paused && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-700">
            <AlertTriangle size={14} />
            <span className="flex-1">
              {t(`الإرسال موقوف حتى ${new Date(line!.paused_until!).toLocaleString('ar-SA-u-nu-latn')} لأن واتساب ردّ بـ ${line!.pause_reason === 'whatsapp_475_cap' ? '475 (تجاوز الحد)' : '463 (قيد التواصل مع جهات جديدة)'}.`,
                 `Sending is paused until ${new Date(line!.paused_until!).toLocaleString('en-GB')} because WhatsApp answered ${line!.pause_reason === 'whatsapp_475_cap' ? '475 (cap reached)' : '463 (new-contact restriction)'}.`)}
            </span>
            <Button variant="secondary" className="px-3 py-1 text-xs" disabled={saving} onClick={() => void save({ resume: true })}>{t('استئناف الآن', 'Resume now')}</Button>
          </div>
        )}

        <div>
          <label className="mb-1 block text-xs font-semibold text-charcoal/60">{t('رقم الواتساب المخصص للمكاتب', 'Dedicated WhatsApp line for offices')}</label>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="form-input w-full">
            <option value="">{t('— لا يوجد (الإرسال متوقف) —', '— none (sending off) —')}</option>
            {waDevices.filter((d) => d.is_active).map((d) => (
              <option key={d.device_id} value={d.device_id}>{(isAr ? d.friendly_name_ar : d.friendly_name_en) ?? d.device_id} · {d.phone}</option>
            ))}
          </select>
          {isSalesLine && (
            <p className="mt-1 text-xs font-semibold text-red-600">{t('هذا رقم المبيعات الرئيسي — إذا قيّده واتساب يتوقف تواصل العملاء. استخدم رقماً مخصصاً.', 'This is the main sales line — if WhatsApp restricts it, customer messaging stops. Use a dedicated number.')}</p>
          )}
          {isOpsLine && (
            <p className="mt-1 text-xs text-amber-700">{t('هذا رقم العمليات — قيده يوقف التنبيهات الداخلية. يُفضّل رقم مخصص.', 'This is the operations line — a restriction would stop internal notifications. A dedicated number is better.')}</p>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">{t('تاريخ ربط الرقم', 'Line paired on')}</label>
            <input type="date" value={startedOn} onChange={(e) => setStartedOn(e.target.value)} className="form-input w-full" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">{t('ساعات الإرسال (الرياض)', 'Sending hours (Riyadh)')}</label>
            <div className="flex items-center gap-1">
              <input type="number" min={0} max={23} value={startHour} onChange={(e) => setStartHour(Number(e.target.value))} className="form-input w-16" />
              <span>–</span>
              <input type="number" min={1} max={24} value={endHour} onChange={(e) => setEndHour(Number(e.target.value))} className="form-input w-16" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">{t('لا يُراسل المكتب مرتين خلال (يوم)', 'Min days between requests to one office')}</label>
            <input type="number" min={0} value={recontact} onChange={(e) => setRecontact(Number(e.target.value))} className="form-input w-full" />
          </div>
        </div>

        <div>
          <div className="mb-1 text-xs font-semibold text-charcoal/60">{t('التدرج حسب عمر الرقم', 'Ramp by line age')}</div>
          <p className="mb-2 text-xs text-charcoal/50">{t('رقم جديد يحتاج تهيئة: لا إرسال أول الأيام، ثم يزيد العدد تدريجياً. الفاصل بين الرسائل عشوائي ضمن المدى.', 'A new number needs warming up: no sending the first days, then gradually more. The gap between messages is random within the range.')}</p>
          <table className="w-full text-xs">
            <thead><tr className="text-charcoal/50">
              <th className="p-1 text-start">{t('من اليوم', 'From day')}</th>
              <th className="p-1 text-start">{t('مكاتب/يوم', 'Offices/day')}</th>
              <th className="p-1 text-start">{t('أقل فاصل (دقيقة)', 'Min gap (min)')}</th>
              <th className="p-1 text-start">{t('أعلى فاصل (دقيقة)', 'Max gap (min)')}</th>
              <th />
            </tr></thead>
            <tbody>
              {ramp.map((s, i) => (
                <tr key={i}>
                  <td className="p-1"><input type="number" min={0} value={s.from_day} onChange={(e) => setStep(i, { from_day: Number(e.target.value) })} className="form-input w-16" /></td>
                  <td className="p-1"><input type="number" min={0} value={s.per_day} onChange={(e) => setStep(i, { per_day: Number(e.target.value) })} className="form-input w-16" /></td>
                  <td className="p-1"><input type="number" min={0} value={Math.round(s.min_gap_s / 60)} onChange={(e) => setStep(i, { min_gap_s: Number(e.target.value) * 60 })} className="form-input w-16" /></td>
                  <td className="p-1"><input type="number" min={0} value={Math.round(s.max_gap_s / 60)} onChange={(e) => setStep(i, { max_gap_s: Number(e.target.value) * 60 })} className="form-input w-16" /></td>
                  <td className="p-1"><button type="button" onClick={() => setRamp((r) => r.filter((_, j) => j !== i))} className="text-charcoal/40 hover:text-red-600" aria-label={t('حذف', 'Remove')}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={() => setRamp((r) => [...r, { from_day: (r[r.length - 1]?.from_day ?? 0) + 7, per_day: 10, min_gap_s: 600, max_gap_s: 1200 }])}
            className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-copper hover:underline"><Plus size={12} />{t('إضافة مرحلة', 'Add a step')}</button>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm">{t('إلغاء', 'Cancel')}</Button>
          <Button onClick={() => void save()} disabled={saving} className="px-4 py-2 text-sm">{saving && <Loader2 size={15} className="animate-spin" />}{t('حفظ', 'Save')}</Button>
        </div>
      </div>
    </Modal>
  );
}
