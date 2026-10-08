import { useState } from 'react';
import { Send, Loader2, CheckCircle2, RotateCcw, X } from 'lucide-react';
import { quickSendProject, sendLanguageFor, useQuickSendState, type QuickSendState } from '@/lib/projects/quickSendProject';
import type { AppRecord } from '@/types';

/** Icon + label for a one-click project send button in each state. */
export function quickSendContent(state: QuickSendState, isAr: boolean, iconSize: number) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  switch (state) {
    case 'sending':
      return { icon: <Loader2 size={iconSize} className="animate-spin" />, label: L('جارٍ الإرسال…', 'Sending…') };
    case 'sent':
      return { icon: <CheckCircle2 size={iconSize} />, label: L('تم الإرسال', 'Sent') };
    case 'failed':
      return { icon: <RotateCcw size={iconSize} />, label: L('فشل — أعد المحاولة', 'Failed — retry') };
    default:
      return { icon: <Send size={iconSize} />, label: L('إرسال للعميل', 'Send to client') };
  }
}

/** Classes that override the idle look once the button has a result. */
export const QUICK_SEND_SENT_CLS = '!bg-green-100 !text-green-700 border border-green-200';
export const QUICK_SEND_FAILED_CLS = '!bg-red-50 !text-red-700 border border-red-200';

/**
 * The send control: «إرسال للعميل» → on click it turns, in place, into the
 * language choice (العربية | English | ✕) — no popup — and picking one sends.
 * The button then shows sending → sent / failed. `preferred` (the client's
 * preferred language) is listed first.
 */
export function QuickSendControl({
  state, isAr, className, iconSize = 12, preferred, onSend,
}: {
  state: QuickSendState;
  isAr: boolean;
  /** The idle look (each surface keeps its own button style). */
  className: string;
  iconSize?: number;
  preferred?: 'ar' | 'en';
  onSend: (lang: 'ar' | 'en') => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [choosing, setChoosing] = useState(false);
  const busy = state === 'sending' || state === 'sent';

  if (choosing && !busy) {
    const langs: Array<'ar' | 'en'> = preferred === 'en' ? ['en', 'ar'] : ['ar', 'en'];
    return (
      <span
        className="inline-flex items-center gap-1"
        role="group"
        aria-label={L('لغة الرسالة', 'Message language')}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setChoosing(false); } }}
      >
        {langs.map((lang, i) => (
          <button
            key={lang}
            type="button"
            autoFocus={i === 0}
            onClick={() => { setChoosing(false); onSend(lang); }}
            className={className}
            title={lang === 'ar' ? L('إرسال بالعربية', 'Send in Arabic') : L('إرسال بالإنجليزية', 'Send in English')}
          >
            {lang === 'ar' ? L('العربية', 'Arabic') : L('الإنجليزية', 'English')}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setChoosing(false)}
          className="rounded-md p-1 text-charcoal/50 transition hover:bg-cream hover:text-charcoal"
          aria-label={L('إلغاء', 'Cancel')}
          title={L('إلغاء', 'Cancel')}
        >
          <X size={iconSize} />
        </button>
      </span>
    );
  }

  const { icon, label } = quickSendContent(state, isAr, iconSize);
  const extra = state === 'sent' ? QUICK_SEND_SENT_CLS : state === 'failed' ? QUICK_SEND_FAILED_CLS : '';
  return (
    <button
      type="button"
      onClick={() => setChoosing(true)}
      disabled={busy}
      className={`${className} ${extra} disabled:cursor-default`}
      title={state === 'sent'
        ? L('أُرسلت رسالة المشروع لهذا العميل', 'The project message was sent to this client')
        : L('إرسال رسالة المشروع للعميل عبر واتساب — اختر اللغة', 'Send the project message to the client on WhatsApp — pick the language')}
    >
      {icon}
      {label}
    </button>
  );
}

/** «إرسال للعميل» for one project + client — see QuickSendControl / quickSendProject. */
export default function QuickSendProjectButton({
  projectId, projectName, clientRec, chatWid, isAr, className, iconSize = 12,
}: {
  projectId: string;
  projectName: string;
  clientRec: AppRecord | null | undefined;
  /** Send into this open conversation instead of the client's own number. */
  chatWid?: string | null;
  isAr: boolean;
  /** The idle look (each surface keeps its own button style). */
  className: string;
  iconSize?: number;
}) {
  const state = useQuickSendState(clientRec?.id, projectId);
  return (
    <QuickSendControl
      state={state}
      isAr={isAr}
      className={className}
      iconSize={iconSize}
      preferred={clientRec ? sendLanguageFor(clientRec, isAr) : undefined}
      onSend={(lang) => void quickSendProject({ projectId, projectName, clientRec, chatWid, lang })}
    />
  );
}
