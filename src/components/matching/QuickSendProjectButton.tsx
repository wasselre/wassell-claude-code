import { Send, Loader2, CheckCircle2, RotateCcw } from 'lucide-react';
import { quickSendProject, useQuickSendState, type QuickSendState } from '@/lib/projects/quickSendProject';
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
 * «إرسال للعميل» that sends the project on click — no popup, no confirm
 * (see quickSendProject). The button itself shows sending → sent / failed.
 */
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
  const { icon, label } = quickSendContent(state, isAr, iconSize);
  const extra = state === 'sent' ? QUICK_SEND_SENT_CLS : state === 'failed' ? QUICK_SEND_FAILED_CLS : '';
  return (
    <button
      type="button"
      onClick={() => void quickSendProject({ projectId, projectName, clientRec, chatWid })}
      disabled={state === 'sending' || state === 'sent'}
      className={`${className} ${extra} disabled:cursor-default`}
      title={state === 'sent'
        ? (isAr ? 'أُرسلت رسالة المشروع لهذا العميل' : 'The project message was sent to this client')
        : (isAr ? 'إرسال رسالة المشروع للعميل عبر واتساب مباشرة' : 'Send the project message to the client on WhatsApp now')}
    >
      {icon}
      {label}
    </button>
  );
}
