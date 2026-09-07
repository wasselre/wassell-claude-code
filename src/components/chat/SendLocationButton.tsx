import { useEffect, useState } from 'react';
import { Check, Loader2, MapPin, Send, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

/**
 * «إرسال الموقع» — send a map link as ONE plain-text WhatsApp message into a
 * conversation. Shared by the Projects & Units browser's project card and the
 * unit drawer, so both surfaces behave identically.
 *
 * Two taps on purpose (tap → «تأكيد الإرسال إلى <name>» + cancel → send) so a
 * stray click in a busy sheet never messages a client. Goes through the
 * store's `sendChatMessage`, so it gets the optimistic bubble, the per-
 * conversation send lane (waits behind an in-flight gallery), and the store's
 * own failed-bubble + toast on error.
 *
 * `link` null → the button renders DISABLED with a tooltip saying there is no
 * saved location (never hidden — the rep should see why it's unavailable).
 */
interface Props {
  chatWid: string;
  clientName?: string | null;
  /** The resolved map link, or null when the record has no location. */
  link: string | null;
  /** The full message body to send (label line + link). */
  message: string;
  isAr: boolean;
  /** `xs` matches the browser's compact action chips; `sm` the drawer's Buttons. */
  size?: 'xs' | 'sm';
  /** Resets the confirm state when the subject changes (project / unit id). */
  subjectKey: string;
}

type State = 'idle' | 'confirm' | 'sending' | 'sent';

export default function SendLocationButton({ chatWid, clientName, link, message, isAr, size = 'xs', subjectKey }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const sendChatMessage = useAppStore((s) => s.sendChatMessage);
  const addToast = useAppStore((s) => s.addToast);
  const [state, setState] = useState<State>('idle');

  useEffect(() => { setState('idle'); }, [subjectKey]);
  useEffect(() => {
    if (state !== 'sent') return;
    const t = window.setTimeout(() => setState('idle'), 3000);
    return () => window.clearTimeout(t);
  }, [state]);

  const send = async () => {
    if (!link) return;
    setState('sending');
    try {
      await sendChatMessage(chatWid, { body: message });
      setState('sent');
    } catch (err) {
      // sendChatMessage normally reports its own failure (failed bubble +
      // toast); this covers the pre-bubble throws (identity not resolved).
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[SendLocationButton] send location failed', err);
      addToast(L(`تعذّر إرسال الموقع — ${msg}`, `Couldn't send the location — ${msg}`), 'error');
      setState('idle');
    }
  };

  const pad = size === 'xs' ? 'px-3 py-1.5 text-xs' : 'px-3 py-1.5 text-sm';
  const icon = size === 'xs' ? 13 : 14;

  if (state === 'confirm') {
    return (
      <span className="inline-flex items-center gap-1 rounded-lg border border-copper/40 bg-copper/5 p-0.5">
        <button
          type="button"
          onClick={() => void send()}
          className={`inline-flex items-center gap-1.5 rounded-md bg-copper font-bold text-white transition-colors hover:bg-terracotta ${size === 'xs' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1 text-sm'}`}
        >
          <Send size={icon - 1} />
          {clientName
            ? L(`تأكيد الإرسال إلى ${clientName}`, `Send to ${clientName}`)
            : L('تأكيد إرسال الموقع', 'Confirm send')}
        </button>
        <button
          type="button"
          onClick={() => setState('idle')}
          className="rounded-md p-1 text-charcoal/50 transition-colors hover:bg-cream hover:text-charcoal"
          aria-label={L('إلغاء', 'Cancel')}
        >
          <X size={icon} />
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setState('confirm')}
      disabled={!link || state !== 'idle'}
      title={!link ? L('لا يوجد موقع محفوظ', 'No saved location') : link}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-copper/30 bg-copper/5 font-medium text-copper transition-colors hover:bg-copper/10 disabled:cursor-not-allowed disabled:opacity-60 ${pad}`}
    >
      {state === 'sending' ? <Loader2 size={icon} className="animate-spin" /> : state === 'sent' ? <Check size={icon} /> : <MapPin size={icon} />}
      {state === 'sent'
        ? L('تم إرسال الموقع', 'Location sent')
        : state === 'sending'
          ? L('جارٍ الإرسال…', 'Sending…')
          : L('إرسال الموقع', 'Send location')}
    </button>
  );
}
