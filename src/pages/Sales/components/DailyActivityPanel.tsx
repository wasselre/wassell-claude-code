import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, CalendarCheck, CalendarDays, MapPin, MessageCircle, Phone, PhoneMissed, Sparkles, Timer, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { getOutcome, getFollowUpTypeConfig } from '@/lib/salesProcess';
import type { AppRecord } from '@/types';
import {
  computeDailyActivity, matchesFilter, riyadhDay, riyadhDayRange,
  INTERESTED, NOT_REACHED, NO_REPLY, type ActivityFilter, type ActivityResult, type ActivityBooking, type Tally,
} from '../lib/dailyActivity';

/**
 * Overview → «نشاط المبيعات»: what happened on a day (default yesterday) —
 * calls and their results, answer rate, WhatsApp follow-ups and their results,
 * interested clients, appointments booked, visits held — per rep, with every
 * figure clickable into the detailed list behind it (operator, 2026-10-05).
 */

type Period = 'yesterday' | 'today' | 'week' | 'day';

const TONE: Record<string, string> = {
  positive: 'bg-[#10B981]/15 text-[#0F7A55]',
  negative: 'bg-terracotta/10 text-terracotta',
  neutral: 'bg-sand/40 text-charcoal',
};

function sameFilter(a: ActivityFilter, b: ActivityFilter): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function DailyActivityPanel() {
  const { models, records, users, language } = useAppStore();
  const isAr = language === 'ar';
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const navigate = useNavigate();

  const [period, setPeriod] = useState<Period>('yesterday');
  const [pickedDay, setPickedDay] = useState<string>(riyadhDay(-1));
  const [repFilter, setRepFilter] = useState<string>('');
  const [filter, setFilter] = useState<ActivityFilter>({ kind: 'all' });

  const range = useMemo(() => {
    if (period === 'today') return riyadhDayRange(riyadhDay(0));
    if (period === 'week') return riyadhDayRange(riyadhDay(-6), 7);
    if (period === 'day') return riyadhDayRange(pickedDay);
    return riyadhDayRange(riyadhDay(-1));
  }, [period, pickedDay]);

  const rowsOf = (name: string): AppRecord[] => {
    const m = models.find((x) => x.name === name);
    return m ? records[m.id] ?? [] : [];
  };
  const followups = rowsOf('followups');
  const appointments = rowsOf('appointments');
  const visits = rowsOf('visits');
  const clients = rowsOf('clients');
  const ourProjects = rowsOf('our_projects');
  const allProjects = rowsOf('all_projects');

  const all = useMemo(
    () => computeDailyActivity(followups, appointments, visits, range),
    [followups, appointments, visits, range],
  );
  // The rep filter narrows everything, including the totals.
  const a = useMemo(() => {
    if (!repFilter) return all;
    const ids = (xs: Array<{ id: string; repId: string | null }>) => new Set(xs.filter((x) => (x.repId ?? '') === repFilter).map((x) => x.id));
    const f = ids(all.results); const ap = ids(all.appointments); const v = ids(all.visits);
    return computeDailyActivity(
      followups.filter((r) => f.has(r.id)), appointments.filter((r) => ap.has(r.id)), visits.filter((r) => v.has(r.id)), range,
    );
  }, [all, repFilter, followups, appointments, visits, range]);

  const clientName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of clients) {
      const n = (c.data as Record<string, unknown>).client_name;
      if (typeof n === 'string' && n.trim()) m.set(c.id, n);
    }
    return (id: string | null) => (id ? m.get(id) ?? L('عميل', 'Client') : '—');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, isAr]);
  const projectName = (id: string | null): string | null => {
    if (!id) return null;
    const our = ourProjects.find((r) => r.id === id);
    const masterId = our ? (our.data as Record<string, unknown>).project : id;
    const master = allProjects.find((r) => r.id === (Array.isArray(masterId) ? masterId[0] : masterId));
    const n = (master?.data as Record<string, unknown> | undefined)?.project_name ?? (our?.data as Record<string, unknown> | undefined)?.project_name;
    return typeof n === 'string' ? n : null;
  };
  const repName = (id: string | null) => {
    if (!id) return L('بدون مسؤول', 'Unassigned');
    const u = users.find((x) => x.id === id);
    return u ? ((isAr ? u.name_ar : u.name_en) || u.email || id.slice(0, 6)) : id.slice(0, 6);
  };
  const outcome = (v: string) => getOutcome(v);
  const outcomeLabel = (v: string) => { const o = outcome(v); return o ? L(o.label_ar, o.label_en) : v; };
  const typeLabel = (t: string) => { const c = getFollowUpTypeConfig(t); return c ? L(c.label_ar, c.label_en) : t; };
  const fmtTime = (iso: string) => new Date(iso).toLocaleString(isAr ? 'ar-SA-u-nu-latn' : 'en-GB', {
    timeZone: 'Asia/Riyadh', ...(period === 'week' ? { weekday: 'short' as const } : {}), hour: '2-digit', minute: '2-digit',
  });
  const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);

  const toggle = (f: ActivityFilter) => setFilter((cur) => (sameFilter(cur, f) ? { kind: 'all' } : f));

  const shownResults = a.results.filter((r) => matchesFilter(r, filter));
  const shownBookings: ActivityBooking[] = filter.kind === 'appointments' ? a.appointments : filter.kind === 'visits' ? a.visits : [];
  const showingBookings = filter.kind === 'appointments' || filter.kind === 'visits';

  const filterLabel = (): string => {
    switch (filter.kind) {
      case 'channel': return filter.channel === 'call' ? L('المكالمات', 'Calls') : L('متابعات واتساب', 'WhatsApp follow-ups');
      case 'answered': return L('مكالمات تم الرد عليها', 'Answered calls');
      case 'not_answered': return L('مكالمات بلا رد', 'Unanswered calls');
      case 'interested': return L('مهتمون', 'Interested');
      case 'result': return `${filter.channel === 'call' ? L('مكالمات', 'Calls') : L('واتساب', 'WhatsApp')} · ${outcomeLabel(filter.result)}`;
      case 'appointments': return L('مواعيد محجوزة', 'Appointments booked');
      case 'visits': return L('زيارات', 'Visits');
      default: return L('كل النتائج', 'All results');
    }
  };

  const repOptions = all.reps.map((r) => r.repId ?? '').filter((v, i, arr) => arr.indexOf(v) === i);

  return (
    <section className="card mb-6 rounded-2xl p-5">
      {/* Period + rep */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="me-auto text-base font-bold text-chocolate">{L('نشاط المبيعات', 'Sales activity')}</h2>
        {([['yesterday', L('أمس', 'Yesterday')], ['today', L('اليوم', 'Today')], ['week', L('آخر ٧ أيام', 'Last 7 days')]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setPeriod(k)}
            className={`rounded-full px-3 py-1 text-xs font-bold ${period === k ? 'bg-copper text-white' : 'bg-cream text-charcoal hover:bg-sand/40'}`}>
            {label}
          </button>
        ))}
        <input type="date" value={pickedDay} max={riyadhDay(0)} dir="ltr"
          onChange={(e) => { if (e.target.value) { setPickedDay(e.target.value); setPeriod('day'); } }}
          className={`form-input !w-auto !py-1 text-xs ${period === 'day' ? 'ring-2 ring-copper' : ''}`} aria-label={L('يوم محدد', 'Pick a day')} />
        <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)} className="form-input !w-auto !py-1 text-xs" aria-label={L('المندوب', 'Rep')}>
          <option value="">{L('كل المندوبين', 'All reps')}</option>
          {repOptions.map((id) => <option key={id || 'none'} value={id}>{repName(id || null)}</option>)}
        </select>
      </div>

      {/* Headline figures — each one filters the list below */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Tile icon={<Phone size={16} />} label={L('مكالمات', 'Calls')} value={a.calls} sub={L(`تم الرد ${a.answered}`, `${a.answered} answered`)}
          on={sameFilter(filter, { kind: 'channel', channel: 'call' })} onClick={() => toggle({ kind: 'channel', channel: 'call' })} />
        <Tile icon={<Timer size={16} />} label={L('نسبة الرد', 'Answer rate')} value={pct(a.answerRate)} tone={a.answerRate !== null && a.answerRate < 0.4 ? 'bad' : 'good'}
          sub={L(`${a.answered} من ${a.calls}`, `${a.answered} of ${a.calls}`)}
          on={sameFilter(filter, { kind: 'answered' })} onClick={() => toggle({ kind: 'answered' })} />
        <Tile icon={<PhoneMissed size={16} />} label={L('بلا رد', 'Not reached')} value={a.calls - a.answered} tone="bad"
          on={sameFilter(filter, { kind: 'not_answered' })} onClick={() => toggle({ kind: 'not_answered' })} />
        <Tile icon={<MessageCircle size={16} />} label={L('متابعات واتساب', 'WhatsApp')} value={a.whatsapp} sub={L(`ردّ ${a.replied}`, `${a.replied} replied`)}
          on={sameFilter(filter, { kind: 'channel', channel: 'whatsapp' })} onClick={() => toggle({ kind: 'channel', channel: 'whatsapp' })} />
        <Tile icon={<Sparkles size={16} />} label={L('مهتم', 'Interested')} value={a.interested} tone="good"
          on={sameFilter(filter, { kind: 'interested' })} onClick={() => toggle({ kind: 'interested' })} />
        <Tile icon={<CalendarCheck size={16} />} label={L('مواعيد محجوزة', 'Appointments')} value={a.appointments.length} tone="good"
          on={filter.kind === 'appointments'} onClick={() => toggle({ kind: 'appointments' })} />
        <Tile icon={<MapPin size={16} />} label={L('زيارات', 'Visits')} value={a.visits.length} tone="good"
          on={filter.kind === 'visits'} onClick={() => toggle({ kind: 'visits' })} />
      </div>

      {/* Results breakdown */}
      <div className="mb-4 grid gap-3 md:grid-cols-2">
        <ResultList title={L('نتائج المكالمات', 'Call results')} items={a.callResults} total={a.calls} isAr={isAr}
          label={outcomeLabel} toneOf={(k) => (NOT_REACHED.has(k) ? 'negative' : outcome(k)?.tone ?? 'neutral')}
          active={(k) => sameFilter(filter, { kind: 'result', channel: 'call', result: k })}
          onPick={(k) => toggle({ kind: 'result', channel: 'call', result: k })} />
        <ResultList title={L('نتائج متابعات واتساب', 'WhatsApp results')} items={a.whatsappResults} total={a.whatsapp} isAr={isAr}
          label={outcomeLabel} toneOf={(k) => (NO_REPLY.has(k) ? 'negative' : outcome(k)?.tone ?? 'neutral')}
          active={(k) => sameFilter(filter, { kind: 'result', channel: 'whatsapp', result: k })}
          onPick={(k) => toggle({ kind: 'result', channel: 'whatsapp', result: k })} />
      </div>

      {/* Per rep */}
      {a.reps.length > 0 && (
        <div className="mb-4 overflow-x-auto rounded-xl border border-sand/50">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-cream/70 text-xs text-charcoal/70">
              <tr>
                {[L('المندوب', 'Rep'), L('مكالمات', 'Calls'), L('تم الرد', 'Answered'), L('نسبة الرد', 'Answer rate'),
                  L('واتساب', 'WhatsApp'), L('ردّ', 'Replied'), L('مهتم', 'Interested'), L('مواعيد', 'Appointments'), L('زيارات', 'Visits')]
                  .map((h) => <th key={h} className="px-3 py-2 text-start font-semibold">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {a.reps.map((r) => (
                <tr key={r.repId ?? 'none'} className="border-t border-sand/40">
                  <td className="px-3 py-2 font-semibold text-chocolate">{repName(r.repId)}</td>
                  <td className="px-3 py-2">{r.calls}</td>
                  <td className="px-3 py-2">{r.answered}</td>
                  <td className="px-3 py-2">{pct(r.calls ? r.answered / r.calls : null)}</td>
                  <td className="px-3 py-2">{r.whatsapp}</td>
                  <td className="px-3 py-2">{r.replied}</td>
                  <td className="px-3 py-2">{r.interested}</td>
                  <td className="px-3 py-2">{r.appointments}</td>
                  <td className="px-3 py-2">{r.visits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The detail behind the figure */}
      <div className="rounded-xl border border-sand/50">
        <div className="flex items-center gap-2 border-b border-sand/40 bg-cream/50 px-3 py-2 text-sm">
          <span className="font-bold text-chocolate">{filterLabel()}</span>
          <span className="text-charcoal/50">({showingBookings ? shownBookings.length : shownResults.length})</span>
          {filter.kind !== 'all' && (
            <button type="button" onClick={() => setFilter({ kind: 'all' })} className="ms-auto inline-flex items-center gap-1 text-xs text-charcoal/60 hover:text-terracotta">
              <X size={12} /> {L('إظهار الكل', 'Show all')}
            </button>
          )}
        </div>
        <ul className="max-h-[520px] divide-y divide-sand/30 overflow-y-auto">
          {showingBookings ? (
            shownBookings.length === 0 ? <Empty isAr={isAr} /> : shownBookings.map((b) => (
              <li key={b.id}>
                <button type="button" onClick={() => navigate(`/model/clients/${b.clientId}`)} disabled={!b.clientId}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-start text-sm hover:bg-cream">
                  <span className="w-16 shrink-0 text-xs text-charcoal/55" dir="ltr">{fmtTime(b.at)}</span>
                  <span className="font-semibold text-chocolate">{clientName(b.clientId)}</span>
                  <span className="inline-flex items-center gap-1 text-xs text-charcoal/70">
                    <CalendarDays size={12} /> {b.kind === 'appointment' ? L('موعد', 'Appointment') : L('زيارة', 'Visit')}
                    {projectName(b.projectId) ? ` · ${projectName(b.projectId)}` : ''}
                  </span>
                  {b.byAi && <AiBadge isAr={isAr} />}
                  <span className="ms-auto text-xs text-charcoal/55">{repName(b.repId)}</span>
                </button>
              </li>
            ))
          ) : shownResults.length === 0 ? <Empty isAr={isAr} /> : shownResults.map((r: ActivityResult) => {
            const o = outcome(r.result);
            const tone = (r.channel === 'call' && NOT_REACHED.has(r.result)) || (r.channel === 'whatsapp' && NO_REPLY.has(r.result)) ? 'negative' : o?.tone ?? 'neutral';
            return (
              <li key={r.id}>
                <button type="button" onClick={() => navigate(`/model/clients/${r.clientId}`)} disabled={!r.clientId}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-start text-sm hover:bg-cream">
                  <span className="w-16 shrink-0 text-xs text-charcoal/55" dir="ltr">{fmtTime(r.at)}</span>
                  {r.channel === 'call' ? <Phone size={13} className="text-copper" /> : <MessageCircle size={13} className="text-[#25D366]" />}
                  <span className="font-semibold text-chocolate">{clientName(r.clientId)}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${TONE[tone]}`}>{outcomeLabel(r.result)}</span>
                  {INTERESTED.has(r.result) && <Sparkles size={12} className="text-gold" />}
                  <span className="text-xs text-charcoal/55">{typeLabel(r.typeKey)}</span>
                  {r.byAi && <AiBadge isAr={isAr} />}
                  {r.auto && <span className="rounded bg-sand/40 px-1.5 text-[10px] text-charcoal/60">{L('تلقائي — لم يرد', 'auto — no reply')}</span>}
                  <span className="ms-auto text-xs text-charcoal/55">{repName(r.repId)}</span>
                  {r.notes && <span className="basis-full truncate ps-[4.75rem] text-xs text-charcoal/60" dir="auto">{r.notes}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function Tile({ icon, label, value, sub, tone = 'neutral', on, onClick }: {
  icon: ReactNode; label: string; value: number | string; sub?: string; tone?: 'good' | 'bad' | 'neutral'; on: boolean; onClick: () => void;
}) {
  const color = tone === 'good' ? 'text-[#0F7A55]' : tone === 'bad' ? 'text-terracotta' : 'text-chocolate';
  return (
    <button type="button" onClick={onClick}
      className={`rounded-xl border p-3 text-start transition ${on ? 'border-copper bg-copper/10 ring-2 ring-copper/30' : 'border-sand/50 bg-white hover:border-copper/40'}`}>
      <span className="flex items-center gap-1.5 text-xs text-charcoal/60"><span className="text-copper">{icon}</span>{label}</span>
      <span className={`mt-1 block text-2xl font-bold ${color}`} dir="ltr">{value}</span>
      {sub && <span className="block text-[11px] text-charcoal/55">{sub}</span>}
    </button>
  );
}

function ResultList({ title, items, total, isAr, label, toneOf, active, onPick }: {
  title: string; items: Tally[]; total: number; isAr: boolean;
  label: (k: string) => string; toneOf: (k: string) => string;
  active: (k: string) => boolean; onPick: (k: string) => void;
}) {
  return (
    <div className="rounded-xl border border-sand/50 p-3">
      <h3 className="mb-2 text-sm font-bold text-chocolate">{title} <span className="font-normal text-charcoal/50">({total})</span></h3>
      {items.length === 0 ? (
        <p className="text-xs text-charcoal/50">{isAr ? 'لا شيء في هذه الفترة.' : 'Nothing in this period.'}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((it) => {
            const tone = toneOf(it.key);
            const bar = tone === 'positive' ? 'bg-[#10B981]' : tone === 'negative' ? 'bg-terracotta' : 'bg-gold';
            return (
              <li key={it.key}>
                <button type="button" onClick={() => onPick(it.key)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-start text-xs ${active(it.key) ? 'bg-copper/10 ring-1 ring-copper' : 'hover:bg-cream'}`}>
                  <span className="w-36 shrink-0 truncate text-charcoal">{label(it.key)}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-sand/30">
                    <span className={`block h-full ${bar}`} style={{ width: `${total ? (it.count / total) * 100 : 0}%` }} />
                  </span>
                  <span className="w-12 shrink-0 text-end font-bold text-chocolate" dir="ltr">
                    {it.count} <span className="font-normal text-charcoal/45">{total ? `${Math.round((it.count / total) * 100)}%` : ''}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AiBadge({ isAr }: { isAr: boolean }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-copper/10 px-1.5 text-[10px] font-bold text-copper">
      <Bot size={10} /> {isAr ? 'بالذكاء الاصطناعي' : 'by AI'}
    </span>
  );
}

function Empty({ isAr }: { isAr: boolean }) {
  return <li className="px-3 py-6 text-center text-sm text-charcoal/50">{isAr ? 'لا شيء في هذه الفترة.' : 'Nothing in this period.'}</li>;
}
