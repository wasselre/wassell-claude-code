import { useState } from 'react';
import { Copy, Check, MessageCircle, User, Calendar } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import type { PrimaryChannel } from '@/lib/salesProcess';

interface PrimaryActionProps {
  channel: PrimaryChannel;
  phones: string[];
  clientId: string | null;
  appointmentId: string | null;
  /** Open WhatsApp for this client: the existing conversation thread in a popup
   *  if one exists, otherwise the in-app "Start new chat" composer. */
  onWhatsApp: () => void;
  /** Open the client preview modal (which carries an "open full page" button). */
  onViewClient: () => void;
}

/** The contact row. Calls are placed OUTSIDE the app (copy the number → paste into
 *  Hatif), so there is no in-app "call" button — just Copy Number + WhatsApp. */
export default function PrimaryAction({ channel, phones, clientId, appointmentId, onWhatsApp, onViewClient }: PrimaryActionProps) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const phone = phones[0] ?? '';
  const canChat = !!(clientId || phone);

  const copyNumber = async () => {
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the number stays visible to copy manually */ }
  };

  const copyBtn = 'flex flex-1 items-center justify-center gap-2 rounded-xl bg-copper px-4 py-3 text-base font-bold text-white transition hover:bg-terracotta disabled:opacity-40';
  const waBtn = 'flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#25D366] px-4 py-3 text-base font-bold text-white transition hover:opacity-90 disabled:opacity-40';
  const ghost = 'inline-flex items-center gap-2 rounded-xl border border-sand px-4 py-2.5 text-sm font-semibold text-charcoal transition hover:bg-cream';

  const whatsappButton = (label: string) => (
    <button type="button" onClick={onWhatsApp} disabled={!canChat} className={canChat ? waBtn : `${waBtn} cursor-not-allowed opacity-40`}>
      <MessageCircle size={18} /> {label}
    </button>
  );
  const copyButton = () => (
    <button type="button" onClick={() => void copyNumber()} disabled={!phone} className={copyBtn}>
      {copied ? <Check size={18} /> : <Copy size={18} />}
      {copied ? (isAr ? 'تم نسخ الرقم' : 'Number copied') : (isAr ? 'نسخ رقم العميل' : 'Copy number')}
    </button>
  );

  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-chocolate">{isAr ? 'ابدأ بالتواصل' : 'Start outreach'}</h2>
        {phone ? <span dir="ltr" className="text-sm font-semibold text-charcoal/70">{phone}</span> : null}
      </div>
      <div className="flex gap-2">
        {channel === 'whatsapp' ? (
          <>
            {whatsappButton(isAr ? 'فتح محادثة واتساب' : 'Open WhatsApp')}
            {copyButton()}
          </>
        ) : (
          <>
            {copyButton()}
            {whatsappButton(isAr ? 'واتساب' : 'WhatsApp')}
          </>
        )}
      </div>
      {isAr ? (
        <p className="mt-2 text-xs text-charcoal/50">انسخ الرقم واتصل عبر هاتف.</p>
      ) : (
        <p className="mt-2 text-xs text-charcoal/50">Copy the number and dial from Hatif.</p>
      )}
      {(appointmentId || clientId) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {appointmentId && (
            <button type="button" className={ghost} onClick={() => navigate(`/model/appointments/${appointmentId}`)}>
              <Calendar size={18} /> {isAr ? 'فتح الموعد' : 'Open Appointment'}
            </button>
          )}
          {clientId && (
            <button type="button" className={ghost} onClick={onViewClient}>
              <User size={18} /> {isAr ? 'عرض العميل' : 'View Client'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
