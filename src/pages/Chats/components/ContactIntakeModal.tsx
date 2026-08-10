import { useState } from 'react';
import { v4 as uuid } from 'uuid';
import { X, Loader2, Contact } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { matchRecordByPhone, phoneFieldSlugs } from '@/lib/haberchat/normalize';

/**
 * "Add new contact" from an UNLINKED WhatsApp chat (2026-08-10).
 *
 * The counterpart to LeadIntakeModal: that one is for a PROSPECT (creates a
 * client and starts the sales follow-up machinery). This one is for everybody
 * else — a supplier, a government contact, a friend of the office — someone we
 * just want the name and number of. It deliberately creates NO follow-up, no
 * task, and no sales-process state: a contact is an address-book entry, not a
 * lead.
 *
 * The chat is linked back by live phone matching (same as advertisers), so
 * nothing is written onto the chat record here.
 */
export default function ContactIntakeModal({
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
  const [company, setCompany] = useState('');
  const [position, setPosition] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const contactsModel = models.find((m) => m.name === 'contacts') ?? null;

  // Same number already in the address book? Say so up front rather than
  // letting the rep create a second card for the same person.
  const existing = contactsModel
    ? matchRecordByPhone(phoneVal, records[contactsModel.id] ?? [], phoneFieldSlugs(contactsModel))
    : null;
  const existingName = existing ? ((existing.data as Record<string, unknown>).name as string | null) ?? null : null;

  const save = async () => {
    if (!contactsModel) {
      addToast(isAr ? 'نموذج جهات الاتصال غير متاح' : 'The Contacts model is unavailable', 'error');
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
      model_id: contactsModel.id,
      data: {
        name: name.trim(),
        phone: phoneVal.trim(),
        company: company.trim() || null,
        position: position.trim() || null,
        notes: notes.trim() || null,
      },
      created_at: now,
      updated_at: now,
    });
    setSaving(false);
    if (res.status === 'conflict') {
      addToast(isAr ? 'تعذر حفظ جهة الاتصال — حاول مجددًا' : 'Could not save the contact — try again', 'error');
      return;
    }
    addToast(isAr ? 'تمت إضافة جهة الاتصال' : 'Contact added', 'success');
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
            <Contact size={18} className="text-copper" />
            {isAr ? 'إضافة جهة اتصال جديدة' : 'Add a new contact'}
          </h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream hover:text-charcoal">
            <X size={18} />
          </button>
        </div>

        <p className="mb-4 text-sm text-charcoal/70">
          {isAr
            ? 'لحفظ الاسم والرقم فقط — لشخص ليس عميلاً ولا مكتب عقاري. لن تُنشأ أي مهمة متابعة.'
            : 'Just a name and a number — for someone who is neither a client nor a real-estate office. No follow-up task is created.'}
        </p>

        {existing && (
          <p className="mb-3 rounded-lg bg-gold/15 px-3 py-2 text-xs font-medium text-chocolate">
            {isAr
              ? `هذا الرقم محفوظ بالفعل باسم «${existingName ?? 'بدون اسم'}» — الحفظ سينشئ بطاقة ثانية.`
              : `This number is already saved as "${existingName ?? 'unnamed'}" — saving will create a second card.`}
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
        <div className="mb-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-charcoal/70">
              {isAr ? 'الجهة / الشركة' : 'Company'}
            </span>
            <input
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="w-full rounded-lg border border-sand bg-cream/40 px-3 py-2 text-sm focus:border-copper focus:outline-none"
              placeholder={isAr ? 'اختياري' : 'Optional'}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-bold text-charcoal/70">{isAr ? 'المنصب' : 'Position'}</span>
            <input
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              className="w-full rounded-lg border border-sand bg-cream/40 px-3 py-2 text-sm focus:border-copper focus:outline-none"
              placeholder={isAr ? 'اختياري' : 'Optional'}
            />
          </label>
        </div>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs font-bold text-charcoal/70">{isAr ? 'ملاحظات' : 'Notes'}</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-lg border border-sand bg-cream/40 px-3 py-2 text-sm focus:border-copper focus:outline-none"
            placeholder={isAr ? 'اختياري — من هو ولماذا نحفظ رقمه' : 'Optional — who they are and why we keep the number'}
          />
        </label>

        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-copper px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-terracotta disabled:opacity-60"
        >
          {saving && <Loader2 size={15} className="animate-spin" />}
          {isAr ? 'حفظ جهة الاتصال' : 'Save contact'}
        </button>
      </div>
    </div>
  );
}
