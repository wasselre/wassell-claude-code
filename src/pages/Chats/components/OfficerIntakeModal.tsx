import { useState } from 'react';
import { v4 as uuid } from 'uuid';
import { X, Loader2, UserCheck } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { matchRecordByPhone, phoneFieldSlugs } from '@/lib/haberchat/normalize';

/**
 * "Add as project officer" from an UNLINKED WhatsApp chat (2026-09-02).
 *
 * The counterpart to LeadIntakeModal (a prospect) and ContactIntakeModal (a
 * plain address-book entry). This one is for a PROJECT OFFICER — a developer's
 * or marketer's coordinator we message about client visits (the phone on the
 * receiving end of "Notify officer"). It creates a `project_officers` record
 * with just the name + number; the developer / marketer / projects coverage
 * that makes the officer resolvable for a project is filled in later on the
 * officer's own record page (open it from the «مسؤول مشروع» chip in the chat).
 *
 * Like contacts and advertisers, the chat is linked back by live phone matching
 * — nothing is written onto the chat record here.
 */
export default function OfficerIntakeModal({
  phone,
  suggestedName,
  onClose,
}: {
  phone: string;
  suggestedName: string;
  onClose: () => void;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const [name, setName] = useState(suggestedName);
  const [phoneVal, setPhoneVal] = useState(phone);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const officersModel = models.find((m) => m.name === 'project_officers') ?? null;

  // Same number already an officer? Say so up front rather than creating a
  // duplicate officer card for the same person.
  const existing = officersModel
    ? matchRecordByPhone(phoneVal, records[officersModel.id] ?? [], phoneFieldSlugs(officersModel))
    : null;
  const existingName = existing ? ((existing.data as Record<string, unknown>).name as string | null) ?? null : null;

  const save = async () => {
    if (!officersModel) {
      addToast(isAr ? 'نموذج مسؤولي المشاريع غير متاح' : 'The Project Officers model is unavailable', 'error');
      return;
    }
    if (!name.trim() || !phoneVal.trim()) {
      addToast(isAr ? 'الاسم ورقم الجوال مطلوبان' : 'Name and phone are required', 'error');
      return;
    }
    setSaving(true);
    const now = new Date().toISOString();
    const res = await saveRecord({
      id: uuid(),
      model_id: officersModel.id,
      data: {
        name: name.trim(),
        phone: phoneVal.trim(),
        notes: notes.trim() || null,
        is_active: true,
      },
      created_at: now,
      updated_at: now,
    });
    setSaving(false);
    if (res.status === 'conflict') {
      addToast(isAr ? 'تعذر حفظ المسؤول — حاول مجددًا' : 'Could not save the officer — try again', 'error');
      return;
    }
    addToast(isAr ? 'تمت إضافة مسؤول المشروع' : 'Project officer added', 'success');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        dir={isAr ? 'rtl' : 'ltr'}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold text-chocolate">
            <UserCheck size={18} className="text-copper" />
            {isAr ? 'إضافة كمسؤول مشروع' : 'Add as a project officer'}
          </h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream hover:text-charcoal">
            <X size={18} />
          </button>
        </div>

        <p className="mb-4 text-sm text-charcoal/70">
          {isAr
            ? 'لمسؤول من مطوّر أو مسوّق ننسّق معه زيارات العملاء. سيُحفظ الاسم والرقم الآن؛ المطوّر/المسوّق والمشاريع تُضاف لاحقًا من بطاقة المسؤول.'
            : 'For a developer’s or marketer’s coordinator we arrange client visits with. Saves the name and number now; link the developer/marketer and projects later from the officer’s record.'}
        </p>

        {existing && (
          <p className="mb-3 rounded-lg bg-gold/15 px-3 py-2 text-xs font-medium text-chocolate">
            {isAr
              ? `هذا الرقم محفوظ بالفعل كمسؤول باسم «${existingName ?? 'بدون اسم'}» — الحفظ سينشئ بطاقة ثانية.`
              : `This number is already an officer named "${existingName ?? 'unnamed'}" — saving will create a second card.`}
          </p>
        )}

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-bold text-charcoal/70">{isAr ? 'الاسم' : 'Name'}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-sand bg-cream/40 px-3 py-2 text-sm focus:border-copper focus:outline-none"
            placeholder={isAr ? 'الاسم' : 'Name'}
          />
        </label>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-bold text-charcoal/70">{isAr ? 'رقم الجوال' : 'Phone'}</span>
          <input
            value={phoneVal}
            onChange={(e) => setPhoneVal(e.target.value)}
            dir="ltr"
            className="w-full rounded-lg border border-sand bg-cream/40 px-3 py-2 text-sm font-mono focus:border-copper focus:outline-none"
          />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-bold text-charcoal/70">{isAr ? 'ملاحظات' : 'Notes'}</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-lg border border-sand bg-cream/40 px-3 py-2 text-sm focus:border-copper focus:outline-none"
            placeholder={isAr ? 'اختياري — أي مشروع/مطوّر يتبع له' : 'Optional — which project/developer they belong to'}
          />
        </label>

        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-copper px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-terracotta disabled:opacity-60"
        >
          {saving && <Loader2 size={15} className="animate-spin" />}
          {isAr ? 'حفظ المسؤول' : 'Save officer'}
        </button>
      </div>
    </div>
  );
}
