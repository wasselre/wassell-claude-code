import { useState } from 'react';
import { MessageCircle, Phone, Copy, Check } from 'lucide-react';
import type { MessageDraftPayload } from '@/lib/matching/cards';

/**
 * Renders a ready-to-send message draft (emit_message) with a copy button.
 * WhatsApp / SMS / call-script. The draft is built only from real facts. Lives
 * inside the Sales Assistant chat.
 */
export default function MessageCard({ payload, isAr }: { payload: MessageDraftPayload; isAr: boolean }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(payload.message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (insecure context) — text is still visible.
      setCopied(false);
    }
  }

  const chan =
    payload.channel === 'call_script'
      ? { Icon: Phone, ar: 'نص مكالمة', en: 'Call script' }
      : payload.channel === 'sms'
        ? { Icon: MessageCircle, ar: 'رسالة نصية', en: 'SMS' }
        : { Icon: MessageCircle, ar: 'واتساب', en: 'WhatsApp' };
  const { Icon } = chan;

  return (
    <div className="mt-2 w-full max-w-[80%] self-start rounded-2xl border border-copper/30 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-copper/10 border-b border-copper/20">
        <Icon size={16} className="text-copper shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-charcoal">
            {L('مسودة رسالة', 'Message draft')} · {isAr ? chan.ar : chan.en}
          </div>
          {(payload.purpose || payload.to_name) && (
            <div className="text-xs text-charcoal/60 truncate">
              {[payload.to_name, payload.purpose].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 inline-flex items-center gap-1 text-[11px] text-charcoal/60 hover:text-copper transition-colors"
          title={L('نسخ', 'Copy')}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? L('تم النسخ', 'Copied') : L('نسخ', 'Copy')}
        </button>
      </div>
      <div className="p-3">
        <div className="text-sm text-charcoal whitespace-pre-wrap leading-relaxed bg-cream/30 rounded-lg p-3 border border-sand/40">
          {payload.message}
        </div>
        {payload.notes && <div className="text-xs text-charcoal/50 mt-1.5">💡 {payload.notes}</div>}
      </div>
    </div>
  );
}
