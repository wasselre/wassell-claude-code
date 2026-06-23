import { Phone, MessageCircle, User, Calendar } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { telUrl } from '@/lib/phone';
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

/** The big call-to-action row — call / WhatsApp / open client / open appointment. */
export default function PrimaryAction({ channel, phones, clientId, appointmentId, onWhatsApp, onViewClient }: PrimaryActionProps) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const navigate = useNavigate();
  const phone = phones[0] ?? '';
  const tel = telUrl(phone);
  // WhatsApp now opens the in-app composer (no wa.me hand-off); it needs a
  // client or a phone to connect the conversation to.
  const canChat = !!(clientId || phone);

  const callBtn = 'flex flex-1 items-center justify-center gap-2 rounded-xl bg-copper px-4 py-3 text-base font-bold text-white transition hover:bg-terracotta disabled:opacity-40';
  const waBtn = 'flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#25D366] px-4 py-3 text-base font-bold text-white transition hover:opacity-90 disabled:opacity-40';
  const ghost = 'inline-flex items-center gap-2 rounded-xl border border-sand px-4 py-2.5 text-sm font-semibold text-charcoal transition hover:bg-cream';

  const whatsappButton = (label: string) => (
    <button
      type="button"
      onClick={onWhatsApp}
      disabled={!canChat}
      className={canChat ? waBtn : `${waBtn} cursor-not-allowed opacity-40`}
    >
      <MessageCircle size={18} /> {label}
    </button>
  );
  const callButton = (label: string) => (
    <a className={tel ? callBtn : `${callBtn} pointer-events-none`} href={tel ?? undefined}>
      <Phone size={18} /> {label}
    </a>
  );

  return (
    <section className="card p-5">
      <h2 className="mb-3 text-sm font-bold text-chocolate">{isAr ? 'ابدأ بالتواصل' : 'Start outreach'}</h2>
      <div className="flex gap-2">
        {channel === 'whatsapp' ? (
          <>
            {whatsappButton(isAr ? 'فتح محادثة واتساب' : 'Open WhatsApp')}
            {callButton(isAr ? 'اتصال' : 'Call')}
          </>
        ) : (
          <>
            {callButton(isAr ? 'اتصال بالعميل' : 'Call Customer')}
            {whatsappButton(isAr ? 'واتساب' : 'WhatsApp')}
          </>
        )}
      </div>
      {(appointmentId || clientId) && (
        <div className="mt-2 flex flex-wrap gap-2">
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
