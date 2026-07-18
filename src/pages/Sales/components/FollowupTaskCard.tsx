import { Phone, MessageCircle, AlertTriangle, Clock } from 'lucide-react';
import type { FollowupTask } from '../lib/myWork';
import { telUrl, whatsappUrl } from '@/lib/phone';
import { getFollowUpTypeConfig, getOutcome } from '@/lib/salesProcess';

interface Props {
  task: FollowupTask;
  isAr: boolean;
  returnTo: string;
  navigate: (to: string) => void;
  /** Opens the in-app WhatsApp popup (existing thread or composer). */
  onWhatsApp: (clientId: string | null, phone: string | null) => void;
}

const FOLLOWUP_STATUS_LABELS: Record<string, { ar: string; en: string }> = {
  open: { ar: 'مفتوحة', en: 'Open' },
  in_progress: { ar: 'قيد التنفيذ', en: 'In progress' },
  scheduled: { ar: 'مجدولة', en: 'Scheduled' },
};

/** WhatsApp conversation sub-state → "what do I need to do" label. */
const WHATSAPP_STATE_LABELS: Record<string, { ar: string; en: string }> = {
  message_sent_waiting_response: { ar: 'بانتظار رد العميل', en: 'Waiting for reply' },
  no_response_expired: { ar: 'انتهى دون رد', en: 'No response' },
  replied: { ar: 'تم الرد', en: 'Replied' },
};

function fmt(iso: string | null, isAr: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * A single follow-up task in the My Tasks queue. The left action button is the
 * channel (Call vs WhatsApp); a colored accent + pills give fast scanning.
 */
export default function FollowupTaskCard({ task, isAr, returnTo, navigate, onWhatsApp }: Props) {
  const cfg = getFollowUpTypeConfig(task.typeKey);
  const typeLabel = cfg ? (isAr ? cfg.label_ar : cfg.label_en) : (task.typeKey ?? '');
  const objective = cfg ? (isAr ? cfg.objective_ar : cfg.objective_en) : '';
  const late = task.bucket === 'late';
  const isWhatsApp = task.channel === 'whatsapp';
  const tel = telUrl(task.phone);
  const wa = whatsappUrl(task.phone);

  const statusLabel = FOLLOWUP_STATUS_LABELS[task.followupStatus];
  const waState = task.whatsappState ? WHATSAPP_STATE_LABELS[task.whatsappState] : null;
  // Fresh task + the client already messaged us (webhook stamp) — that's the
  // salient fact, so it replaces the generic "message to send" chip.
  const earlyMessaged = isWhatsApp && !task.whatsappState && !!task.clientMessagedAt;
  const waNeedsSend = isWhatsApp && !task.whatsappState && !earlyMessaged; // no state yet → message to send
  const outcome = task.result ? getOutcome(task.result) : undefined;

  return (
    <li
      className="card overflow-hidden p-0"
      style={{ borderInlineStartWidth: 4, borderInlineStartColor: late ? '#B5462F' : isWhatsApp ? '#25D366' : '#B8734F' }}
    >
      <div className="flex flex-wrap items-stretch justify-between gap-3 p-4">
        {/* Channel action */}
        <div className="flex shrink-0 items-center">
          {isWhatsApp ? (
            task.clientId ? (
              <button
                type="button"
                onClick={() => onWhatsApp(task.clientId, task.phone)}
                className="inline-flex items-center gap-2 rounded-lg bg-[#25D366] px-4 py-2.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
              >
                <MessageCircle size={16} /> {isAr ? 'واتساب' : 'WhatsApp'}
              </button>
            ) : (
              wa && (
                <a href={wa} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-[#25D366] px-4 py-2.5 text-sm font-bold text-white transition-opacity hover:opacity-90">
                  <MessageCircle size={16} /> {isAr ? 'واتساب' : 'WhatsApp'}
                </a>
              )
            )
          ) : (
            tel && (
              <a href={tel} className="inline-flex items-center gap-2 rounded-lg bg-copper px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-terracotta">
                <Phone size={16} /> {isAr ? 'اتصال' : 'Call'}
              </a>
            )
          )}
        </div>

        {/* Details — opens the Follow-up Workspace */}
        <button
          type="button"
          onClick={() => navigate(`/model/followups/${task.followupId}?returnTo=${encodeURIComponent(returnTo)}`)}
          className="flex-1 text-start"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-chocolate">{task.clientName || (isAr ? 'عميل' : 'Client')}</span>
            <span dir="ltr" className="text-sm text-terracotta">{task.phone}</span>
            {late && (
              <span className="inline-flex items-center gap-1 rounded-full bg-terracotta px-2 py-0.5 text-xs font-bold text-white">
                <AlertTriangle size={11} /> {isAr ? 'متأخرة' : 'Overdue'}
              </span>
            )}
            {(task.priority === 'high' || task.priority === 'urgent') && (
              <span className="rounded-full bg-gold px-2 py-0.5 text-xs font-bold text-white">{task.priority}</span>
            )}
          </div>
          <div className="mt-1 text-sm text-charcoal">
            <span className="font-bold text-copper">{typeLabel}</span>
            {objective ? ` — ${objective}` : ''}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-charcoal/70">
            {task.scheduledISO && (
              <span className="inline-flex items-center gap-1">
                <Clock size={11} className={late ? 'text-[#B5462F]' : 'text-charcoal/40'} />
                {fmt(task.scheduledISO, isAr)}
              </span>
            )}
            {statusLabel && (
              <span className="rounded-full bg-sand/50 px-2 py-0.5 font-bold text-charcoal">
                {isAr ? statusLabel.ar : statusLabel.en}
              </span>
            )}
            {waNeedsSend && (
              <span className="rounded-full bg-[#25D366]/15 px-2 py-0.5 font-bold text-[#128C7E]">
                {isAr ? 'رسالة بحاجة للإرسال' : 'Message to send'}
              </span>
            )}
            {earlyMessaged && (
              <span className="rounded-full bg-[#10B981]/15 px-2 py-0.5 font-bold text-[#0f7a52]">
                {isAr ? 'العميل أرسل رسالة' : 'Client messaged'}
              </span>
            )}
            {waState && (
              <span className="rounded-full bg-[#25D366]/15 px-2 py-0.5 font-bold text-[#128C7E]">
                {isAr ? waState.ar : waState.en}
              </span>
            )}
            {outcome && (
              <span className="text-charcoal/60">
                {isAr ? 'النتيجة: ' : 'Result: '}
                {isAr ? outcome.label_ar : outcome.label_en}
              </span>
            )}
          </div>
        </button>
      </div>
    </li>
  );
}
