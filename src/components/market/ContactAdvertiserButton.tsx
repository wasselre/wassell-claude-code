import { useEffect } from 'react';
import { PhoneCall, Loader2, MessageCircle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useContactAdvertiser } from '@/lib/regaLookup/useContactAdvertiser';
import StartChatModal from '@/pages/Chats/components/StartChatModal';

interface Props {
  /** market_listings record id. */
  listingId: string;
  isAr: boolean;
}

/**
 * Compact "التواصل مع المعلن" action for a market listing OUTSIDE its record
 * form — Project Finder cards and client option cards. Same flow as the
 * record-form panel (shared useContactAdvertiser): cached advertiser phone →
 * open the WhatsApp chat immediately; no phone yet → enqueue the REGA lookup,
 * spin, and auto-open the chat when the worker writes the phone. Lookup
 * failures surface as a toast — the card has no room for an inline error box.
 */
export default function ContactAdvertiserButton({ listingId, isAr }: Props) {
  const addToast = useAppStore((s) => s.addToast);
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const {
    advertiserPhone, pending, error, clearError,
    showChat, setShowChat, chatBody, startContact,
  } = useContactAdvertiser(listingId);

  useEffect(() => {
    if (!error) return;
    addToast(error, 'error');
    clearError();
  }, [error, addToast, clearError]);

  return (
    <>
      <button
        type="button"
        onClick={startContact}
        disabled={pending}
        className="inline-flex items-center gap-1 rounded-lg bg-copper px-2.5 py-1 text-[11px] font-bold text-white transition hover:bg-terracotta disabled:opacity-60"
        title={advertiserPhone
          ? L('فتح محادثة واتساب مع المعلن', 'Open a WhatsApp chat with the advertiser')
          : L('جلب رقم المعلن من رخصة الإعلان الرسمية ثم فتح محادثة واتساب', "Fetch the advertiser's number from the official REGA license, then open a WhatsApp chat")}
      >
        {pending ? <Loader2 size={12} className="animate-spin" /> : advertiserPhone ? <MessageCircle size={12} /> : <PhoneCall size={12} />}
        {pending
          ? L('جاري جلب الرقم…', 'Fetching number…')
          : advertiserPhone
            ? L('مراسلة المعلن', 'WhatsApp advertiser')
            : L('التواصل مع المعلن', 'Contact advertiser')}
      </button>

      {showChat && advertiserPhone && (
        <StartChatModal
          initialPhone={advertiserPhone}
          initialBody={chatBody}
          onClose={() => setShowChat(false)}
        />
      )}
    </>
  );
}
