import { useEffect, useRef, useState } from 'react';
import { PhoneCall, Loader2, MessageCircle, AlertCircle } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { enqueueRegaLookup } from '@/lib/regaLookup/client';
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
 * The worker owns all record writes (advertiser_phone / rega_lookup_status /
 * rega_lookup_at); this component only READS the store record (kept fresh by the
 * app's Realtime subscription) and never writes it during a job.
 */
export default function ContactAdvertiserPanel({ modelId, recordId }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const tr = (ar: string, en: string) => (isAr ? ar : en);

  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showChat, setShowChat] = useState(false);
  // The listing's rega_lookup_at BEFORE this run — a fresh terminal result is
  // detected by this server-authored timestamp CHANGING (no client/server clock
  // comparison). Only terminal outcomes write rega_lookup_at.
  const prevRegaAtRef = useRef<string | null>(null);

  const model = models.find((m) => m.id === modelId);
  const listing = (records[modelId] ?? []).find((r) => r.id === recordId);
  const data = (listing?.data ?? {}) as Record<string, unknown>;

  const advertiserPhone = typeof data.advertiser_phone === 'string' ? data.advertiser_phone.trim() : '';
  const advertiserName = typeof data.advertiser_name === 'string' ? data.advertiser_name : '';
  const status = typeof data.rega_lookup_status === 'string' ? data.rega_lookup_status : '';
  const regaError = typeof data.rega_lookup_error === 'string' ? data.rega_lookup_error : '';
  const regaAt = typeof data.rega_lookup_at === 'string' ? data.rega_lookup_at : null;
  const sourceUrl = typeof data.source_url === 'string' ? data.source_url : '';
  const externalId = typeof data.external_id === 'string' ? data.external_id : String(data.external_id ?? '');

  const aqarLink = sourceUrl || (externalId ? `https://sa.aqar.fm/ad/${externalId}/ar` : '');
  const chatBody = aqarLink
    ? tr(`السلام عليكم، بخصوص إعلانكم على عقار:\n${aqarLink}`, `Hello, regarding your Aqar listing:\n${aqarLink}`)
    : '';

  // Watch for a fresh terminal result while a lookup is in flight.
  useEffect(() => {
    if (!pending) return;
    if (advertiserPhone && status === 'done') {
      setPending(false);
      setShowChat(true);
      return;
    }
    if ((status === 'no_license' || status === 'failed') && regaAt && regaAt !== prevRegaAtRef.current) {
      setPending(false);
      setLocalError(regaError || tr('تعذّر جلب رقم المعلن.', 'Could not fetch the advertiser phone.'));
    }
  }, [pending, advertiserPhone, status, regaAt, regaError, tr]);

  if (model?.name !== 'market_listings') return null;

  const startLookup = async () => {
    setLocalError(null);
    // Cached — skip the scrape and open the chat immediately.
    if (advertiserPhone) {
      setShowChat(true);
      return;
    }
    prevRegaAtRef.current = regaAt;
    setPending(true);
    try {
      await enqueueRegaLookup(recordId);
    } catch (err) {
      setPending(false);
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="mt-6 bg-white rounded-2xl border border-sand/30 p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PhoneCall size={16} className="text-copper" />
          <h3 className="font-bold text-charcoal text-sm">{tr('التواصل مع المعلن', 'Contact the advertiser')}</h3>
        </div>
        <Button variant="primary" onClick={startLookup} disabled={pending}>
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

      {localError && (
        <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{localError}</span>
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
