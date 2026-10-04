import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot, User, Headset, Search, Send, CalendarCheck, LifeBuoy, HelpCircle, PenLine, ShieldQuestion, Flag, Globe, BellRing,
  MessageSquare, CalendarDays, Loader2, RefreshCw, type LucideIcon,
} from 'lucide-react';
import { dateTimeShort } from '@/pages/Marketing/lib/format';
import { useAiActivity } from '@/pages/Chats/lib/aiActivity';
import { buildAiEvents, type AiEvent, type AiEventKind } from '@/pages/Chats/lib/aiActivityText';
import { usePrefFieldFormat } from '@/pages/Chats/lib/usePrefFieldFormat';

/**
 * The client's AI timeline (operator, 2026-10-05: "a timeline showing us the AI
 * and the customer interactions together"). One list, newest first: the
 * customer's messages, the AI's replies, and everything the AI did — searches,
 * projects sent, visits booked, questions to a rep, handoffs, what it saved on
 * the client (and what it heard but left), follow-up results, portal
 * registrations, officer notices. Filter: everything / AI only / changes only.
 */

const ICON: Record<AiEventKind, LucideIcon> = {
  customer: User, ai_reply: Bot, rep: Headset, search: Search, sent: Send, booked: CalendarCheck,
  handoff: LifeBuoy, asked: HelpCircle, change: PenLine, kept: ShieldQuestion, outcome: Flag, portal: Globe,
  officer: BellRing, followup_msg: MessageSquare, booking: CalendarDays,
};

const TONE: Record<NonNullable<AiEvent['tone']>, string> = {
  ok: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-red-600', muted: 'text-charcoal/45',
};

type Filter = 'all' | 'ai' | 'changes';
const CHANGE_KINDS = new Set<AiEventKind>(['change', 'kept', 'outcome']);

export default function AiTimelineTab({ clientId, isAr }: { clientId: string; isAr: boolean }) {
  const { t } = useTranslation();
  const { fieldLabel, formatValue } = usePrefFieldFormat();
  const { data, error, loading, reload } = useAiActivity(clientId, null, 0);
  const [filter, setFilter] = useState<Filter>('all');

  const events = useMemo(
    () => (data ? buildAiEvents(data, t, isAr, fieldLabel, formatValue, { withMessages: true }) : []),
    [data, t, isAr, fieldLabel, formatValue],
  );
  const shown = events.filter((e) => (filter === 'all' ? true : filter === 'changes' ? CHANGE_KINDS.has(e.kind) : e.kind !== 'customer' && e.kind !== 'rep'));

  return (
    <div className="rounded-xl border border-sand/40 bg-white p-4" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-bold text-chocolate">
          <Bot size={15} className="text-copper" aria-hidden /> {t('clients.ai_timeline.title')}
        </h3>
        <div className="flex items-center gap-1">
          {(['all', 'ai', 'changes'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-full px-2.5 py-0.5 text-xs ${filter === f ? 'bg-copper text-white' : 'bg-cream text-charcoal hover:bg-sand/30'}`}
            >
              {t(`clients.ai_timeline.f_${f}`)}
            </button>
          ))}
          <button type="button" onClick={() => void reload()} className="rounded p-1 text-charcoal/50 hover:bg-cream" aria-label={t('chats.ai_act.refresh')}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-600">{t('chats.ai_act.load_failed', { msg: error })}</p>}
      {!data && !error && <div className="flex justify-center p-6"><Loader2 size={18} className="animate-spin text-charcoal/40" /></div>}
      {data && shown.length === 0 && <p className="py-6 text-center text-xs text-charcoal/50">{t('clients.ai_timeline.empty')}</p>}
      {data && data.messages.length >= 80 && filter !== 'changes' && (
        <p className="mb-2 text-[11px] text-charcoal/45">{t('clients.ai_timeline.messages_capped', { n: data.messages.length })}</p>
      )}

      <ol className="relative space-y-2 border-s border-sand/50 ps-4">
        {shown.map((e) => {
          const Icon = ICON[e.kind];
          const side = e.kind === 'customer' ? 'bg-sand/25' : e.kind === 'rep' ? 'bg-slate-100' : e.kind === 'ai_reply' ? 'bg-copper/10' : 'bg-white border border-sand/40';
          return (
            <li key={e.id} className="relative">
              <span className="absolute -start-[25px] top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-white ring-1 ring-sand">
                <Icon size={10} className={e.kind === 'customer' ? 'text-charcoal/60' : 'text-copper'} aria-hidden />
              </span>
              <div className={`rounded-lg px-2.5 py-1.5 text-xs ${side}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[10.5px] font-semibold text-charcoal/60">{t(`clients.ai_timeline.k_${e.kind}`)}</span>
                  <span className="shrink-0 text-[10px] text-charcoal/45">{dateTimeShort(e.at, isAr)}</span>
                </div>
                <p className={`whitespace-pre-wrap break-words ${e.tone ? TONE[e.tone] : 'text-charcoal'}`}>{e.text}</p>
                {e.detail && <p className="mt-0.5 break-words text-[10.5px] text-charcoal/50">{e.detail}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
