import { Link } from 'react-router-dom';
import { PhoneCall, Loader2, MessageCircle, AlertCircle, IdCard } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { useContactAdvertiser } from '@/lib/regaLookup/useContactAdvertiser';
import StartChatModal from '@/pages/Chats/components/StartChatModal';

interface Props {
  modelId: string;
  recordId: string;
}

/**
 * "التواصل مع المعلن" panel on a market_listings record form. Self-hides on every
 * other model. On click:
 *   • If the advertiser phone is already cached on the listing → opens an in-app
 *     WhatsApp chat straight away (no scrape).
 *   • Otherwise → enqueues a REGA lookup job (Browserbase reads the public REGA
 *     advertising-license registry off the listing's Aqar page), shows a spinner,
 *     and — when the Fly worker writes advertiser_phone via Realtime — opens the
 *     chat pre-filled with the Aqar listing link so the user can send a message.
 *
 * The lookup/open-chat flow lives in useContactAdvertiser (shared with the
 * compact Contact button on Project Finder cards and client option cards).
 */
export default function ContactAdvertiserPanel({ modelId, recordId }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const tr = (ar: string, en: string) => (isAr ? ar : en);

  const {
    advertiserPhone, advertiserName, advertiserId, pending, error,
    showChat, setShowChat, chatBody, startContact,
  } = useContactAdvertiser(recordId);

  const model = models.find((m) => m.id === modelId);
  if (model?.name !== 'market_listings') return null;

  return (
    <div className="mt-6 bg-white rounded-2xl border border-sand/30 p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PhoneCall size={16} className="text-copper" />
          <h3 className="font-bold text-charcoal text-sm">{tr('التواصل مع المعلن', 'Contact the advertiser')}</h3>
        </div>
        <Button variant="primary" onClick={startContact} disabled={pending}>
          {pending ? <Loader2 size={16} className="animate-spin" /> : advertiserPhone ? <MessageCircle size={16} /> : <PhoneCall size={16} />}
          {pending
            ? tr('جاري جلب الرقم…', 'Fetching number…')
            : advertiserPhone
              ? tr('مراسلة واتساب', 'WhatsApp')
              : tr('التواصل مع المعلن', 'Contact advertiser')}
        </Button>
      </div>

      {advertiserPhone ? (
        <p className="text-xs text-charcoal/60 mt-2">
          {advertiserName ? <span className="font-semibold">{advertiserName} — </span> : null}
          <span className="font-mono" dir="ltr">{advertiserPhone}</span>
          {' · '}
          {tr('من السجل الرسمي للهيئة العامة للعقار', 'from the official REGA registry')}
          {advertiserId ? (
            <>
              {' · '}
              <Link to={`/model/advertisers/${advertiserId}`} className="inline-flex items-center gap-1 text-copper hover:underline">
                <IdCard size={12} />
                {tr('عرض بطاقة المعلن', 'View advertiser record')}
              </Link>
            </>
          ) : null}
        </p>
      ) : pending ? (
        <p className="text-xs text-charcoal/50 mt-2">
          {tr(
            'جاري فتح الإعلان وقراءة رخصة الإعلان العقاري من الهيئة العامة للعقار لاستخراج رقم المعلن… قد يستغرق حتى دقيقة.',
            'Opening the listing and reading its REGA advertising license to extract the advertiser number… may take up to a minute.',
          )}
        </p>
      ) : (
        <p className="text-xs text-charcoal/50 mt-2">
          {tr(
            'جلب رقم جوال المعلن من رخصة الإعلان الرسمية (الهيئة العامة للعقار)، ثم فتح محادثة واتساب مع رابط الإعلان.',
            "Fetch the advertiser's mobile from the official REGA advertising license, then open a WhatsApp chat with the listing link.",
          )}
        </p>
      )}

      {error && (
        <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {showChat && advertiserPhone && (
        <StartChatModal
          initialPhone={advertiserPhone}
          initialBody={chatBody}
          onClose={() => setShowChat(false)}
        />
      )}
    </div>
  );
}
