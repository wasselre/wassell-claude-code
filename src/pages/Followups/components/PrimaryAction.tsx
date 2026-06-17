import { Phone, MessageCircle, User, Calendar } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { telUrl, whatsappUrl } from '@/lib/phone';
import type { PrimaryChannel } from '@/lib/salesProcess';

interface PrimaryActionProps {
  channel: PrimaryChannel;
  phones: string[];
  clientId: string | null;
  appointmentId: string | null;
}

/** The big call-to-action row — call / WhatsApp / open client / open appointment. */
export default function PrimaryAction({ channel, phones, clientId, appointmentId }: PrimaryActionProps) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const navigate = useNavigate();
  const phone = phones[0] ?? '';
  const tel = telUrl(phone);
  const wa = whatsappUrl(phone);

  const callBtn = 'flex flex-1 items-center justify-center gap-2 rounded-xl bg-copper px-4 py-3 text-base font-bold text-white transition hover:bg-terracotta disabled:opacity-40';
  const waBtn = 'flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#25D366] px-4 py-3 text-base font-bold text-white transition hover:opacity-90 disabled:opacity-40';
  const ghost = 'inline-flex items-center gap-2 rounded-xl border border-sand px-4 py-2.5 text-sm font-semibold text-charcoal transition hover:bg-cream';

  return (
    <section className="card p-5">
      <h2 className="mb-3 text-sm font-bold text-chocolate">{isAr ? 'ابدأ بالتواصل' : 'Start outreach'}</h2>
      <div className="flex gap-2">
        {channel === 'whatsapp' ? (
          <>
            <a className={wa ? waBtn : `${waBtn} pointer-events-none`} href={wa ?? undefined} target="_blank" rel="noreferrer">
              <MessageCircle size={18} /> {isAr ? 'فتح محادثة واتساب' : 'Open WhatsApp'}
            </a>
            <a className={tel ? callBtn : `${callBtn} pointer-events-none`} href={tel ?? undefined}>
              <Phone size={18} /> {isAr ? 'اتصال' : 'Call'}
            </a>
          </>
        ) : (
          <>
            <a className={tel ? callBtn : `${callBtn} pointer-events-none`} href={tel ?? undefined}>
              <Phone size={18} /> {isAr ? 'اتصال بالعميل' : 'Call Customer'}
            </a>
            <a className={wa ? waBtn : `${waBtn} pointer-events-none`} href={wa ?? undefined} target="_blank" rel="noreferrer">
              <MessageCircle size={18} /> {isAr ? 'واتساب' : 'WhatsApp'}
            </a>
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
            <button type="button" className={ghost} onClick={() => navigate(`/model/clients/${clientId}`)}>
              <User size={18} /> {isAr ? 'عرض العميل' : 'View Client'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
