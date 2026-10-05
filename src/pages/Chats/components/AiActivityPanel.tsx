import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot, Search, Building2, ListChecks, History, Brain, PenLine, RefreshCw, Loader2, ChevronDown, ChevronUp, AlertTriangle,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { dateTimeShort, money, num } from '@/pages/Marketing/lib/format';
import { useAiActivity, type AgentFoundProject, type AgentRun, type AgentRunSearch } from '../lib/aiActivity';
import { buildAiEvents, criteriaChips, readingChips, relaxedLabel, type AiEvent } from '../lib/aiActivityText';
import { usePrefFieldFormat } from '../lib/usePrefFieldFormat';
import AiChangesSection from './AiChangesSection';

/**
 * The chat's AI activity — shown where the reply box used to be, because the AI
 * answers client chats now (operator, 2026-10-05: "we are not replying anymore,
 * it's just an AI … cards summarizing this chat"). Cards, left to right:
 * summary · what it understood · its searches · what it found · what it did ·
 * what it changed on the client · the run log. «اكتب رداً» opens the composer.
 *
 * Data: GET /api/chat-ai-activity (wa_agent_runs + the AI's other tables).
 */

interface Props {
  clientId: string;
  chatWid: string;
  isAr: boolean;
  /** Changes when the thread grows — the cards re-load after a new message. */
  refreshKey: number;
  /** The client's saved preferences as chips (the header's chips) — what the
   *  agent reads before every reply (savedProfile.ts), shown under «ما فهمه». */
  profileChips: string[];
  onReply: () => void;
}

const TONE: Record<NonNullable<AiEvent['tone']>, string> = {
  ok: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-red-600', muted: 'text-charcoal/45',
};

function Card({ icon, title, children, wide }: { icon: ReactNode; title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`flex max-h-[150px] shrink-0 snap-start flex-col rounded-xl border border-sand/50 bg-white ${wide ? 'w-[300px]' : 'w-[230px]'}`}>
      <h4 className="flex items-center gap-1.5 border-b border-sand/30 px-2.5 py-1.5 text-[11px] font-bold text-chocolate">
        <span className="text-copper">{icon}</span>{title}
      </h4>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-1.5 text-[11px] leading-relaxed text-charcoal">{children}</div>
    </section>
  );
}

function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((c, i) => <span key={i} className="rounded-full bg-cream px-1.5 py-0.5 text-[10.5px] text-charcoal">{c}</span>)}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-[10.5px] text-charcoal/45">{text}</p>;
}

/** One search's result: what fit, else the closest alternatives, else nothing. */
function FoundBlock({ search, sent, isAr }: { search: AgentRunSearch; sent: ReadonlyMap<string, string>; isAr: boolean }) {
  const { t } = useTranslation();
  if (search.top.length) return <FoundList items={search.top} sent={sent} isAr={isAr} />;
  if (search.alternatives?.length) {
    return (
      <div className="space-y-1.5">
        {search.alternatives.map((a) => (
          <div key={a.without}>
            <p className="text-[10px] text-amber-700">{t(`chats.ai_act.alt_without_${a.without}`)}</p>
            <FoundList items={a.top} sent={sent} isAr={isAr} />
          </div>
        ))}
      </div>
    );
  }
  return <Empty text={t('chats.ai_act.nothing_found')} />;
}

function FoundList({ items, sent, isAr }: { items: AgentFoundProject[]; sent: ReadonlyMap<string, string>; isAr: boolean }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-1">
      {items.map((p) => (
        <li key={p.id} className="flex items-baseline justify-between gap-1">
          <span className="min-w-0 truncate">
            {p.name}{p.district && <span className="text-charcoal/50"> · {p.district}</span>}
          </span>
          <span className="shrink-0 text-[10px]">
            {sent.has(p.id)
              ? <span className="text-emerald-700">{t('chats.ai_act.sent_badge')}</span>
              : p.price_from != null && <span className="text-charcoal/50">{t('chats.ai_act.from_price', { v: money(p.price_from, isAr) })}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RunRow({ run, isAr }: { run: AgentRun; isAr: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const bad = run.guard_problems.length > 0 || run.reply_failed || run.reply_sent === false;
  return (
    <li className="border-b border-sand/20 py-1 last:border-0">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-1 text-start">
        <span className="min-w-0 truncate">
          <span className="text-charcoal/50">{dateTimeShort(run.created_at, isAr)}</span>
          {' · '}{t(`chats.ai_act.kind_${run.kind}`)}
          {run.ms != null && <span className="text-charcoal/45"> · {t('chats.ai_act.seconds', { n: num(Math.round(run.ms / 1000), isAr) })}</span>}
          {bad && <AlertTriangle size={10} className="ms-1 inline text-amber-600" aria-hidden />}
        </span>
        {open ? <ChevronUp size={11} className="shrink-0" /> : <ChevronDown size={11} className="shrink-0" />}
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 text-[10.5px]">
          {run.customer_text && <p><span className="text-charcoal/50">{t('chats.ai_act.run_customer')}</span> {run.customer_text}</p>}
          {run.reply && <p><span className="text-charcoal/50">{t('chats.ai_act.run_reply')}</span> {run.reply}{run.reply_sent === false && <span className="text-red-600"> ({t('chats.ai_act.not_sent')})</span>}</p>}
          {run.guard_problems.length > 0 && <p className="text-amber-700">{t('chats.ai_act.run_guard', { list: run.guard_problems.join('، ') })}</p>}
          {run.tool_trace.length > 0 && (
            <ul className="list-inside list-disc text-charcoal/60" dir="ltr">
              {run.tool_trace.map((l, i) => <li key={i} className="break-all">{l}</li>)}
            </ul>
          )}
          {run.model && <p className="text-charcoal/40" dir="ltr">{run.model}</p>}
        </div>
      )}
    </li>
  );
}

const OPEN_KEY = 'wassel.chat.aiCardsOpen';

/** Open by default only on tall screens, so the thread keeps its room on a laptop; the choice is remembered per browser. */
function initialOpen(): boolean {
  try {
    const v = localStorage.getItem(OPEN_KEY);
    if (v === '1' || v === '0') return v === '1';
  } catch (err) {
    // Blocked storage (private window) only loses the remembered choice.
    console.error('[AiActivityPanel] reading the open state failed:', err);
  }
  return window.innerHeight >= 900;
}

export default function AiActivityPanel({ clientId, chatWid, isAr, refreshKey, profileChips, onReply }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(initialOpen);
  const toggle = () => {
    setOpen((v) => {
      try { localStorage.setItem(OPEN_KEY, v ? '0' : '1'); } catch (err) { console.error('[AiActivityPanel] saving the open state failed:', err); }
      return !v;
    });
  };
  const { fieldLabel, formatValue } = usePrefFieldFormat();
  const { data, error, loading, reload } = useAiActivity(clientId, chatWid, refreshKey);

  const latestReading = data?.runs.find((r) => r.reading && readingChips(r.reading, t, isAr).length > 0) ?? null;
  // Newest first: runs come newest first, a run's own searches oldest first.
  const searches = useMemo(() => (data?.runs ?? []).flatMap((r) => [...r.searches].reverse().map((s) => ({ s, at: r.created_at }))), [data]);
  // A client with several profiles: the newest search for each profile the
  // agent searched recently, so each wish shows what was found for it.
  const foundByProfile = useMemo(() => {
    const recent = searches.slice(0, 20);
    if (!recent.some(({ s }) => s.profile_id)) return [];
    const seen = new Set<string>();
    return recent.filter(({ s }) => {
      const k = s.profile_id ?? '';
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [searches]);
  const sent = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of data?.runs ?? []) {
      if (r.actions?.sent_project) out.set(r.actions.sent_project.id, r.actions.sent_project.name);
    }
    return out;
  }, [data]);
  const done = useMemo(
    () => (data ? buildAiEvents(data, t, isAr, fieldLabel, formatValue, { withMessages: false }).filter((e) => !['ai_reply', 'search', 'change', 'kept', 'booking'].includes(e.kind)) : []),
    [data, t, isAr, fieldLabel, formatValue],
  );

  const s = data?.stats;
  const visits = (data?.runs ?? []).filter((r) => r.actions?.booked).length;

  return (
    <div className="border-t border-sand/30 bg-cream/40 md:mt-3 md:rounded-2xl md:border" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-2 px-3 pt-2">
        <button type="button" onClick={toggle} className="flex min-w-0 items-center gap-1.5 py-2 md:py-0 text-start text-xs font-bold text-chocolate" aria-expanded={open}>
          <Bot size={14} className="shrink-0 text-copper" aria-hidden />
          <span className="truncate">{t('chats.ai_act.title')}</span>
          {!open && data && (
            <span className="truncate font-normal text-charcoal/55">
              {' · '}{t('chats.ai_act.collapsed_line', { replies: num(s?.ai ?? 0, isAr), runs: num(data.runs.length, isAr), sent: num(sent.size, isAr) })}
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => void reload()} className="rounded p-2.5 md:p-1 text-charcoal/50 hover:bg-cream" aria-label={t('chats.ai_act.refresh')} title={t('chats.ai_act.refresh')}>
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
          <Button variant="secondary" className="!px-4 !py-2.5 md:!px-3 md:!py-1 !text-xs" onClick={onReply}>
            <PenLine size={13} aria-hidden /> {t('chats.ai_act.write_reply')}
          </Button>
          {/* Same fold button as the chat's top section (ChatDetail), so the
              two sections hide the same way. */}
          <button
            type="button"
            onClick={toggle}
            className="inline-flex shrink-0 items-center justify-center rounded-lg p-2.5 md:p-1.5 text-charcoal/50 transition-colors hover:bg-cream hover:text-copper"
            aria-expanded={open}
            aria-label={t(open ? 'chats.ai_act.hide' : 'chats.ai_act.show')}
            title={t(open ? 'chats.ai_act.hide' : 'chats.ai_act.show')}
          >
            {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
        </div>
      </div>

      {open && error && !data && <p className="px-3 py-2 text-[11px] text-red-600">{t('chats.ai_act.load_failed', { msg: error })}</p>}
      {open && !data && !error && <div className="flex justify-center p-4"><Loader2 size={16} className="animate-spin text-charcoal/40" /></div>}

      {!open && <div className="pb-2" />}
      {open && data && (
        <div className="flex snap-x gap-2 overflow-x-auto px-3 pb-3 pt-2">
          <Card icon={<Bot size={12} />} title={t('chats.ai_act.card_summary')}>
            <ul className="space-y-0.5">
              <li>{t('chats.ai_act.s_ai_replies', { n: num(s?.ai ?? 0, isAr) })}</li>
              <li>{t('chats.ai_act.s_customer', { n: num(s?.customer ?? 0, isAr) })}</li>
              {(s?.rep ?? 0) > 0 && <li>{t('chats.ai_act.s_rep', { n: num(s?.rep ?? 0, isAr) })}</li>}
              <li>{t('chats.ai_act.s_runs', { n: num(data.runs.length, isAr) })}</li>
              <li>{t('chats.ai_act.s_sent', { n: num(sent.size, isAr) })}</li>
              {visits > 0 && <li>{t('chats.ai_act.s_visits', { n: num(visits, isAr) })}</li>}
              {s?.last_ai_at && <li className="text-charcoal/50">{t('chats.ai_act.s_last_ai', { when: dateTimeShort(s.last_ai_at, isAr) })}</li>}
            </ul>
          </Card>

          <Card icon={<Brain size={12} />} title={t('chats.ai_act.card_reading')}>
            {latestReading && (
              <div className="mb-1.5">
                <p className="mb-0.5 text-[10px] font-semibold text-charcoal/50">{t('chats.ai_act.from_last_reply', { when: dateTimeShort(latestReading.created_at, isAr) })}</p>
                <Chips items={readingChips(latestReading.reading, t, isAr)} />
              </div>
            )}
            {profileChips.length > 0 && (
              <div>
                <p className="mb-0.5 text-[10px] font-semibold text-charcoal/50">{t('chats.ai_act.from_profile')}</p>
                <Chips items={profileChips} />
              </div>
            )}
            {!latestReading && profileChips.length === 0 && <Empty text={t('chats.ai_act.no_reading')} />}
          </Card>

          <Card icon={<Search size={12} />} title={t('chats.ai_act.card_searches')} wide>
            {searches.length ? (
              <ul className="space-y-1.5">
                {searches.slice(0, 6).map(({ s: q, at }, i) => (
                  <li key={i}>
                    <Chips items={criteriaChips(q, t, isAr)} />
                    <p className={`mt-0.5 text-[10.5px] ${q.total === 0 ? 'text-amber-700' : 'text-charcoal/60'}`}>
                      {t('chats.ai_act.found_n', { n: num(q.total, isAr) })}
                      {relaxedLabel(q.relaxed, t) && ` · ${relaxedLabel(q.relaxed, t)}`}
                      {' · '}{dateTimeShort(at, isAr)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : <Empty text={t('chats.ai_act.no_searches')} />}
          </Card>

          <Card icon={<Building2 size={12} />} title={t('chats.ai_act.card_found')}>
            {foundByProfile.length > 1 ? (
              <div className="space-y-2">
                {foundByProfile.map(({ s: q }) => (
                  <div key={q.profile_id ?? ''}>
                    <p className="mb-0.5 text-[10.5px] font-semibold text-chocolate">{q.profile_name ?? t('chats.ai_act.no_profile')}</p>
                    <FoundBlock search={q} sent={sent} isAr={isAr} />
                  </div>
                ))}
              </div>
            ) : searches[0] ? <FoundBlock search={searches[0].s} sent={sent} isAr={isAr} /> : <Empty text={t('chats.ai_act.nothing_found')} />}
          </Card>

          <Card icon={<ListChecks size={12} />} title={t('chats.ai_act.card_done')} wide>
            {done.length ? (
              <ul className="space-y-1">
                {done.slice(0, 12).map((e) => (
                  <li key={e.id}>
                    <span className={e.tone ? TONE[e.tone] : ''}>{e.text}</span>
                    <span className="text-charcoal/40"> · {dateTimeShort(e.at, isAr)}</span>
                    {e.detail && <p className="truncate text-[10px] text-charcoal/50" title={e.detail}>{e.detail}</p>}
                  </li>
                ))}
              </ul>
            ) : <Empty text={t('chats.ai_act.nothing_done')} />}
          </Card>

          <Card icon={<PenLine size={12} />} title={t('chats.ai_act.card_changed')} wide>
            {data.changes.length ? <AiChangesSection clientId={clientId} refreshKey={String(refreshKey)} isAr={isAr} bare /> : <Empty text={t('chats.ai_act.nothing_changed')} />}
          </Card>

          <Card icon={<History size={12} />} title={t('chats.ai_act.card_runs')} wide>
            {data.runs.length ? (
              <ul>{data.runs.slice(0, 20).map((r) => <RunRow key={r.id} run={r} isAr={isAr} />)}</ul>
            ) : <Empty text={t('chats.ai_act.no_runs')} />}
          </Card>
        </div>
      )}
    </div>
  );
}
