import { useState } from 'react';
import { v4 as uuid } from 'uuid';
import { X, Loader2, UserPlus, Phone, MessageCircle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

/**
 * Assisted lead capture (2026-07-21 — sales-process improvement plan,
 * Workstream E). Shown from an UNLINKED chat: the rep judged this number is a
 * real prospect, so the system does the rest:
 *
 *  1. Approve → create the client (name + phone prefilled from the chat).
 *     The existing "First Follow-up" workflow fires on create and makes the
 *     booking-call task; the store's relink sweep attaches this chat.
 *  2. Choose the first follow-up channel:
 *     - "Call now"        → the booking-call task is pulled to NOW (hot).
 *     - "Keep in WhatsApp" → the booking-call task is cancelled and a
 *       WhatsApp task is created in the "your turn" state (they messaged us,
 *       we owe the reply) — it surfaces at the top of Actions.
 */
export default function LeadIntakeModal({
  phone,
  suggestedName,
  lastInboundAt,
  onClose,
}: {
  phone: string;
  suggestedName: string;
  lastInboundAt: string | null;
  onClose: () => void;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);
  const currentUserId = useAppStore((s) => s.currentUserId);

  const [step, setStep] = useState<'form' | 'channel'>('form');
  const [name, setName] = useState(suggestedName);
  const [phoneVal, setPhoneVal] = useState(phone);
  const [saving, setSaving] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);

  const clientsModel = models.find((m) => m.name === 'clients');
  const followupsModel = models.find((m) => m.name === 'followups');

  const createClient = async () => {
    if (!clientsModel) return;
    if (!name.trim() || !phoneVal.trim()) {
      addToast(isAr ? 'الاسم ورقم الجوال مطلوبان' : 'Name and phone are required', 'error');
      return;
    }
    setSaving(true);
    const id = uuid();
    const now = new Date().toISOString();
    const res = await saveRecord({
      id,
      model_id: clientsModel.id,
      data: {
        client_name: name.trim(),
        phone_number: phoneVal.trim(),
        client_stage: 'جديد',
      },
      created_at: now,
      updated_at: now,
    });
    setSaving(false);
    if (res.status === 'conflict') {
      addToast(isAr ? 'تعذر إنشاء العميل — حاول مجددًا' : 'Could not create the client — try again', 'error');
      return;
    }
    setClientId(id);
    setStep('channel');
    addToast(isAr ? 'تم إنشاء العميل وربط المحادثة' : 'Client created and chat linked', 'success');
  };

  /** The booking-call task the First-Follow-up workflow just created. */
  const findBookingTask = (cid: string) => {
    if (!followupsModel) return null;
    const rows = useAppStore.getState().records[followupsModel.id] ?? [];
    return rows.find((r) => {
      const d = r.data as Record<string, unknown>;
      const cidOf = Array.isArray(d.client_id) ? d.client_id[0] : d.client_id;
      if (cidOf !== cid) return false;
      const type = Array.isArray(d.followup_type) ? d.followup_type[0] : d.followup_type;
      if (type !== 'appointment_booking_call') return false;
      const st = typeof d.followup_status === 'string' && d.followup_status ? d.followup_status : 'open';
      return st === 'open' || st === 'in_progress';
    }) ?? null;
  };

  const chooseCall = async () => {
    if (!clientId || !followupsModel) { onClose(); return; }
    setSaving(true);
    const nowISO = new Date().toISOString();
    const task = findBookingTask(clientId);
    if (task) {
      // Pull the workflow-created booking call to NOW → hot-lead tier.
      await saveRecord(
        { ...task, data: { ...task.data, scheduled_datetime: nowISO }, updated_at: nowISO },
        { expectedVersion: task.version ?? null },
      );
    } else {
      // Workflow didn't produce one (disabled?) — create it so the lead
      // can't fall through the cracks.
      await saveRecord({
        id: uuid(),
        model_id: followupsModel.id,
        data: {
          client_id: clientId,
          sales_rep: currentUserId,
          followup_type: ['appointment_booking_call'],
          followup_status: 'open',
          followup_number: 1,
          scheduled_datetime: nowISO,
          creation_source: 'lead_intake',
        },
        created_at: nowISO,
        updated_at: nowISO,
      });
    }
    setSaving(false);
    addToast(isAr ? '🔥 مهمة اتصال الآن — في أعلى قائمتك' : '🔥 Call-now task is at the top of your list', 'success');
    onClose();
  };

  const chooseWhatsApp = async () => {
    if (!clientId || !followupsModel) { onClose(); return; }
    setSaving(true);
    const nowISO = new Date().toISOString();
    // The booking call is superseded by the rep's channel choice…
    const task = findBookingTask(clientId);
    if (task) {
      await saveRecord(
        {
          ...task,
          data: {
            ...task.data,
            followup_status: 'cancelled',
            cancel_reason: 'lead_intake_whatsapp',
            cancelled_at: nowISO,
          },
          updated_at: nowISO,
        },
        { expectedVersion: task.version ?? null },
      );
    }
    // …replaced by a WhatsApp task in the "your turn" state (they wrote first).
    await saveRecord({
      id: uuid(),
      model_id: followupsModel.id,
      data: {
        client_id: clientId,
        sales_rep: currentUserId,
        followup_type: ['whatsapp_follow_up'],
        followup_status: 'open',
        whatsapp_state: 'replied',
        client_messaged_at: lastInboundAt ?? nowISO,
        whatsapp_attempt_number: 1,
        followup_number: 1,
        scheduled_datetime: nowISO,
        creation_source: 'lead_intake',
      },
      created_at: nowISO,
      updated_at: nowISO,
    });
    setSaving(false);
    addToast(isAr ? 'متابعة واتساب جاهزة — رد على العميل' : 'WhatsApp follow-up ready — reply to the client', 'success');
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
            <UserPlus size={18} className="text-copper" />
            {step === 'form'
              ? isAr ? 'إنشاء عميل من هذه المحادثة' : 'Create a client from this chat'
              : isAr ? 'كيف نبدأ المتابعة؟' : 'How should the follow-up start?'}
          </h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream hover:text-charcoal">
            <X size={18} />
          </button>
        </div>

        {step === 'form' ? (
          <>
            <label className="mb-3 block">
              <span className="mb-1 block text-xs font-bold text-charcoal/70">{isAr ? 'اسم العميل' : 'Client name'}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-sand bg-cream/40 px-3 py-2 text-sm focus:border-copper focus:outline-none"
                placeholder={isAr ? 'الاسم' : 'Name'}
              />
            </label>
            <label className="mb-4 block">
              <span className="mb-1 block text-xs font-bold text-charcoal/70">{isAr ? 'رقم الجوال' : 'Phone'}</span>
              <input
                value={phoneVal}
                onChange={(e) => setPhoneVal(e.target.value)}
                dir="ltr"
                className="w-full rounded-lg border border-sand bg-cream/40 px-3 py-2 text-sm font-mono focus:border-copper focus:outline-none"
              />
            </label>
            <button
              type="button"
              disabled={saving}
              onClick={createClient}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-copper px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-terracotta disabled:opacity-60"
            >
              {saving && <Loader2 size={15} className="animate-spin" />}
              {isAr ? 'إنشاء العميل وربط المحادثة' : 'Create client & link this chat'}
            </button>
          </>
        ) : (
          <>
            <p className="mb-4 text-sm text-charcoal/70">
              {isAr
                ? 'تم إنشاء العميل. اختر الخطوة الأولى — يمكن دائمًا التغيير لاحقًا.'
                : 'Client created. Pick the first step — you can always change later.'}
            </p>
            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                disabled={saving}
                onClick={chooseCall}
                className="flex items-center gap-3 rounded-xl border-2 border-copper/30 bg-copper/5 p-3.5 text-start transition-colors hover:border-copper disabled:opacity-60"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-copper text-white"><Phone size={18} /></span>
                <span>
                  <span className="block text-sm font-bold text-chocolate">{isAr ? 'اتصال الآن' : 'Call now'}</span>
                  <span className="block text-xs text-charcoal/60">{isAr ? 'مهمة اتصال فورية بعدّاد ٥ دقائق (عميل حار)' : 'Immediate call task with the 5-minute hot-lead timer'}</span>
                </span>
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={chooseWhatsApp}
                className="flex items-center gap-3 rounded-xl border-2 border-[#25D366]/40 bg-[#25D366]/5 p-3.5 text-start transition-colors hover:border-[#25D366] disabled:opacity-60"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#25D366] text-white"><MessageCircle size={18} /></span>
                <span>
                  <span className="block text-sm font-bold text-chocolate">{isAr ? 'المتابعة عبر واتساب' : 'Keep it in WhatsApp'}</span>
                  <span className="block text-xs text-charcoal/60">{isAr ? 'مهمة واتساب «دورك» — رد على رسالته من هنا' : 'A "your turn" WhatsApp task — reply right from this chat'}</span>
                </span>
              </button>
            </div>
            {saving && <p className="mt-3 flex items-center gap-2 text-xs text-charcoal/50"><Loader2 size={13} className="animate-spin" /> {isAr ? 'جارٍ الحفظ…' : 'Saving…'}</p>}
          </>
        )}
      </div>
    </div>
  );
}
