/**
 * Calendar — design screen 13 (التقويم).
 *
 * A view, not a register — everything here lives elsewhere: publications,
 * task due dates, and campaign windows. The design's rules, kept literally:
 * campaigns are LANES above the grid, never events inside it; a scheduled
 * publication is a solid platform-tinted chip while a due date is a dotted
 * warning chip (one will happen, the other is only a promise); the week
 * starts on Sunday; and a week with nothing scheduled is FLAGGED with the
 * warning wash, never left blank — the gap nobody noticed is the most useful
 * signal a content calendar has.
 *
 * Below 760px the seven-column grid does not work at all (design screen 49):
 * the month becomes an AGENDA — a list of only the days that have something,
 * with the fully-empty week surfacing as a dashed warning row instead of
 * disappearing. An أجندة/شهر chip pair keeps the squeezed grid one tap away.
 * Desktop rendering is untouched.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MosCampaign, PLATFORM_CLASS, PLATFORM_LABELS, fetchCalendar, fetchCampaigns,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { LoadError, PageHead, Skeleton } from './components/kit';
import NewContentModal from './components/NewContentModal';
import { IconBack, IconForward, IconPlus } from './components/icons';
import { num, shortDate, toArabicDigits } from './lib/format';

/**
 * The shell's phone breakpoint (mobile-shell.css). No shared matchMedia hook
 * exists in the codebase, so each mobile-aware page carries this small one.
 */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const sync = (): void => setMobile(mq.matches);
    // Both signals: emulated viewports (devtools/webviews) can resize without
    // firing the media-query change event.
    mq.addEventListener('change', sync);
    window.addEventListener('resize', sync);
    return () => {
      mq.removeEventListener('change', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);
  return mobile;
}

// The mockup's week starts on Sunday and spells الإثنين with a hamza —
// transcribed, not "corrected".
const AR_DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

type View = 'month' | 'week' | 'list';
/** النشر = publications only · الاستحقاقات = due dates only · الكل = both. */
type Filter = 'pub' | 'due' | 'all';

type CalData = Awaited<ReturnType<typeof fetchCalendar>>;

interface Chip {
  key: string;
  when: number;
  label: string;
  platform: string | null;
  /** due and campaign_end share the mockup's dotted warning chip. */
  kind: 'publication' | 'due' | 'campaign_end';
  href: string;
  hint: string;
  /** Split parts for the phone agenda's bold «P-019 · خمسة أسباب» line (s49). */
  ref: string | null;
  title: string;
}

/** One agenda row on the phone: a day with items, or the empty-week warning. */
type AgendaEntry =
  | { kind: 'day'; day: Date; items: Chip[] }
  | { kind: 'gap'; start: Date; end: Date };

export default function CalendarPage() {
  const { isAr } = useWorkspace();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [view, setView] = useState<View>('month');
  // The phone's own أجندة/شهر switch (s49) — independent of the desktop seg.
  const [mView, setMView] = useState<'agenda' | 'month'>('agenda');
  const [filter, setFilter] = useState<Filter>('pub');
  const [data, setData] = useState<CalData | null>(null);
  const [campaigns, setCampaigns] = useState<MosCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // The phone always works on the month range — the agenda is the month's
  // agenda — while the desktop keeps its month/week/list seg untouched.
  const effView: View = isMobile ? 'month' : view;

  // The grid always shows whole weeks, so the range fetched is the visible
  // grid rather than the calendar month — otherwise the leading/trailing
  // days lie. Week view fetches just its one row.
  const range = useMemo(() => {
    if (effView === 'week') {
      const start = sundayOf(cursor);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    const start = sundayOf(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
    const end = new Date(start);
    end.setDate(end.getDate() + 41);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }, [cursor, effView]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cal, camps] = await Promise.all([
        fetchCalendar(range.start.toISOString(), range.end.toISOString()),
        fetchCampaigns(),
      ]);
      setData(cal);
      setCampaigns(camps.campaigns);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { void load(); }, [load]);

  /* ── chips: publications, task due dates, campaign end dates ────────── */

  const chips = useMemo(() => {
    const map = new Map<string, Chip[]>();
    const push = (when: Date, chip: Omit<Chip, 'when'>): void => {
      const key = dayKey(when);
      const list = map.get(key) ?? [];
      list.push({ ...chip, when: when.getTime() });
      map.set(key, list);
    };

    if (data) {
      const titles = new Map(data.titles.map((t) => [t.id, t]));
      for (const p of data.publications) {
        if (p.status === 'cancelled') continue;
        const when = p.published_at ?? p.scheduled_at;
        if (!when) continue;
        const t = titles.get(p.content_id);
        const platform = isAr
          ? PLATFORM_LABELS[p.platform]?.ar ?? p.platform
          : PLATFORM_LABELS[p.platform]?.en ?? p.platform;
        push(new Date(when), {
          key: `p-${p.id}`,
          label: `${platform} · ${t?.ref ?? t?.title ?? ''}`.trim(),
          platform: p.platform,
          kind: 'publication',
          href: `/m/content/${p.content_id}`,
          hint: t?.title ?? '',
          ref: t?.ref ?? null,
          title: t?.title ?? '',
        });
      }
      for (const d of data.due) {
        if (!d.due_at) continue;
        push(new Date(d.due_at), {
          key: `d-${d.id}`,
          label: `${isAr ? 'استحقاق' : 'Due'} · ${d.title}${d.ref ? ` ${d.ref}` : ''}`,
          platform: null,
          kind: 'due',
          href: `/m/content/${d.id}`,
          hint: d.title,
          ref: d.ref ?? null,
          title: d.title,
        });
      }
    }
    // A campaign's last day is a promise about work, so it wears the same
    // dotted chip as a due date — the mockup's «نهاية الحملة».
    for (const c of campaigns) {
      if (!c.ends_on || c.status === 'cancelled') continue;
      const end = new Date(c.ends_on);
      if (end < range.start || end > range.end) continue;
      push(end, {
        key: `ce-${c.id}`,
        label: isAr ? 'نهاية الحملة' : 'Campaign end',
        platform: null,
        kind: 'campaign_end',
        href: `/m/campaigns/${c.id}`,
        hint: c.name,
        ref: c.ref ?? null,
        title: c.name,
      });
    }
    return map;
  }, [data, campaigns, isAr, range]);

  const visibleChip = useCallback(
    (c: Chip): boolean =>
      filter === 'all' ? true : filter === 'pub' ? c.kind === 'publication' : c.kind !== 'publication',
    [filter],
  );

  /* ── campaign lanes above the grid ──────────────────────────────────── */

  const lanes = useMemo(() => campaigns
    .filter((c) => c.status === 'active' && overlaps(c.starts_on, c.ends_on, range.start, range.end))
    .map((c) => {
      const rangeText = laneRange(c, isAr);
      const kindText = c.kind === 'paid'
        ? (isAr ? 'مدفوعة' : 'paid')
        : (isAr ? 'عضوية' : 'organic');
      let pct = 0;
      let right: string;
      if (c.kind === 'paid') {
        const budget = c.budget_total ?? 0;
        const spend = c.total_spend ?? 0;
        pct = budget > 0 ? Math.min(100, Math.round((spend / budget) * 100)) : 0;
        right = `${num(c.total_spend ?? 0, isAr)} / ${num(c.budget_total, isAr)} ${isAr ? 'ريال' : 'SAR'}`;
      } else {
        // No per-campaign publish counter exists in the API, so the organic
        // bar shows how much of the campaign's window has elapsed — never a
        // fabricated «نُشرت» count.
        const s = c.starts_on ? new Date(c.starts_on).getTime() : null;
        const e = c.ends_on ? new Date(c.ends_on).getTime() : null;
        pct = s && e && e > s
          ? Math.max(0, Math.min(100, Math.round(((Date.now() - s) / (e - s)) * 100)))
          : 0;
        right = isAr
          ? `${num(c.content_count, true)} عنصر`
          : `${c.content_count} item${c.content_count === 1 ? '' : 's'}`;
      }
      return { c, mid: `${rangeText} · ${kindText}`, pct, right };
    }), [campaigns, range, isAr]);

  /* ── the month grid, and which of its weeks are empty ───────────────── */

  const gridDays = useMemo(
    () => Array.from({ length: effView === 'week' ? 7 : 42 }, (_, i) => {
      const d = new Date(range.start);
      d.setDate(range.start.getDate() + i);
      return d;
    }),
    [range, effView],
  );

  // Emptiness is judged on PUBLICATIONS only, and on the unfiltered set —
  // a week full of due dates but no publishing is still a gap in the rhythm.
  const emptyWeeks = useMemo(() => {
    if (effView !== 'month') return new Set<number>();
    const set = new Set<number>();
    for (let w = 0; w < 6; w += 1) {
      const days = gridDays.slice(w * 7, w * 7 + 7);
      const inMonth = days.some((d) => d.getMonth() === cursor.getMonth());
      if (!inMonth) continue;
      const hasPub = days.some((d) => (chips.get(dayKey(d)) ?? []).some((c) => c.kind === 'publication'));
      if (!hasPub) set.add(w);
    }
    return set;
  }, [effView, gridDays, chips, cursor]);

  /* ── s49 phone1: the agenda — days with items, gaps as warnings ─────── */

  // «الأيام الفارغة تختفي بدل أن تشغل مربعات — عدا الأسبوع الخالي كليًا».
  const agenda = useMemo<AgendaEntry[]>(() => {
    if (!isMobile) return [];
    const out: AgendaEntry[] = [];
    for (let w = 0; w < gridDays.length / 7; w += 1) {
      const days = gridDays.slice(w * 7, w * 7 + 7);
      if (!days.some((d) => d.getMonth() === cursor.getMonth())) continue;
      if (emptyWeeks.has(w)) {
        const start = days[0];
        const end = days[6];
        if (start && end) out.push({ kind: 'gap', start, end });
        continue;
      }
      for (const d of days) {
        if (d.getMonth() !== cursor.getMonth()) continue;
        const items = (chips.get(dayKey(d)) ?? [])
          .filter(visibleChip)
          .sort((a, b) => a.when - b.when);
        if (items.length > 0) out.push({ kind: 'day', day: d, items });
      }
    }
    return out;
  }, [isMobile, gridDays, emptyWeeks, chips, visibleChip, cursor]);

  // «٧:٠٠ م» — hour + the short ص/م suffix, agenda's own time shape.
  const timeOf = (ts: number): string => {
    const d = new Date(ts);
    const h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, '0');
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const suffix = isAr ? (h < 12 ? 'ص' : 'م') : h < 12 ? 'am' : 'pm';
    return `${num(h12, isAr)}:${isAr ? toArabicDigits(m) : m} ${suffix}`;
  };

  // «عنصر واحد» / «عنصران» — the day header's count, in the mock's duals.
  const countPhrase = (n: number): string => {
    if (!isAr) return `${n} item${n === 1 ? '' : 's'}`;
    if (n === 1) return 'عنصر واحد';
    if (n === 2) return 'عنصران';
    if (n <= 10) return `${num(n, true)} عناصر`;
    return `${num(n, true)} عنصرًا`;
  };

  // «أسبوع ٢٣ – ٢٩ أغسطس» — the empty-week warning's title.
  const weekLabel = (s: Date, e: Date): string => {
    const months = isAr ? AR_MONTHS : EN_MONTHS;
    if (s.getMonth() === e.getMonth()) {
      return isAr
        ? `أسبوع ${num(s.getDate(), true)} – ${num(e.getDate(), true)} ${months[s.getMonth()]}`
        : `Week of ${months[s.getMonth()]} ${s.getDate()} – ${e.getDate()}`;
    }
    return isAr
      ? `أسبوع ${num(s.getDate(), true)} ${months[s.getMonth()]} – ${num(e.getDate(), true)} ${months[e.getMonth()]}`
      : `Week of ${months[s.getMonth()]} ${s.getDate()} – ${months[e.getMonth()]} ${e.getDate()}`;
  };

  // The agenda card's grey top line: «٧:٠٠ م · انستقرام» for a publication,
  // the dotted-warning kinds name themselves.
  const agendaTopLine = (c: Chip): string => {
    if (c.kind === 'publication') {
      const p = c.platform
        ? (isAr ? PLATFORM_LABELS[c.platform]?.ar : PLATFORM_LABELS[c.platform]?.en) ?? c.platform
        : '';
      return `${timeOf(c.when)} · ${p}`;
    }
    if (c.kind === 'due') return isAr ? 'استحقاق' : 'Due date';
    return isAr ? 'نهاية الحملة' : 'Campaign end';
  };

  const firstEmptyWeek = useMemo(() => {
    const first = [...emptyWeeks].sort((a, b) => a - b)[0];
    return first === undefined ? null : gridDays[first * 7] ?? null;
  }, [emptyWeeks, gridDays]);

  /* ── list view: everything in the visible range, chronologically ────── */

  const listEntries = useMemo(() => {
    const out: Array<{ day: Date; chip: Chip }> = [];
    for (const d of gridDays) {
      for (const chip of chips.get(dayKey(d)) ?? []) {
        if (visibleChip(chip)) out.push({ day: d, chip });
      }
    }
    return out.sort((a, b) => a.chip.when - b.chip.when);
  }, [gridDays, chips, visibleChip]);

  /* ── header ─────────────────────────────────────────────────────────── */

  const pubCount = useMemo(() => {
    let n = 0;
    for (const list of chips.values()) n += list.filter((c) => c.kind === 'publication').length;
    return n;
  }, [chips]);

  const activePhrase = isAr
    ? lanes.length === 0 ? 'لا حملات جارية'
      : lanes.length === 1 ? 'حملة جارية'
      : lanes.length === 2 ? 'حملتان جاريتان'
      : `${num(lanes.length, true)} حملات جارية`
    : `${lanes.length} active campaign${lanes.length === 1 ? '' : 's'}`;

  // s49's phone header stops at the publish count: «أغسطس ٢٠٢٦ · ١٨ عملية نشر».
  // The year goes through toArabicDigits, not num() — «٢٠٢٦» carries no
  // thousands separator.
  const sub = isMobile
    ? isAr
      ? `${AR_MONTHS[cursor.getMonth()]} ${toArabicDigits(String(cursor.getFullYear()))} · ${num(pubCount, true)} عملية نشر`
      : `${EN_MONTHS[cursor.getMonth()]} ${cursor.getFullYear()} · ${pubCount} publications`
    : effView === 'week'
      ? isAr
        ? `${shortDate(range.start.toISOString(), true)} – ${shortDate(range.end.toISOString(), true)} · ${num(pubCount, true)} عملية نشر · ${activePhrase}`
        : `${shortDate(range.start.toISOString(), false)} – ${shortDate(range.end.toISOString(), false)} · ${pubCount} publications · ${activePhrase}`
      : isAr
        ? `${AR_MONTHS[cursor.getMonth()]} ${num(cursor.getFullYear(), true)} · ${num(pubCount, true)} عملية نشر · ${activePhrase}`
        : `${EN_MONTHS[cursor.getMonth()]} ${cursor.getFullYear()} · ${pubCount} publications · ${activePhrase}`;

  const move = (delta: number): void => {
    setCursor((c) => effView === 'week'
      ? new Date(c.getFullYear(), c.getMonth(), c.getDate() + delta * 7)
      : new Date(c.getFullYear(), c.getMonth() + delta, 1));
  };

  const Prev = isAr ? IconForward : IconBack;
  const Next = isAr ? IconBack : IconForward;
  const todayKey = dayKey(new Date());

  const chipClass = (c: Chip): string =>
    `ev ${c.kind === 'publication' ? (c.platform ? PLATFORM_CLASS[c.platform] ?? '' : '') : 'due'}`;

  // The month grid — shared between the desktop month/week views and the
  // phone's «شهر» chip, so the two can never drift apart.
  const gridEl = (
    <div className="cal" style={{ marginTop: 14 }}>
      <div className="cal-h">
        {(isAr ? AR_DAYS : EN_DAYS).map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className={`cal-g${effView === 'week' ? ' week' : ''}`}>
        {gridDays.map((d, i) => {
          const key = dayKey(d);
          const dayChips = (chips.get(key) ?? []).filter(visibleChip);
          const outside = effView === 'month' && d.getMonth() !== cursor.getMonth();
          const emptyWeek = emptyWeeks.has(Math.floor(i / 7));
          return (
            <div
              key={key}
              className={`cal-c${outside ? ' out' : ''}${key === todayKey ? ' today' : ''}`}
              style={emptyWeek ? { background: 'color-mix(in srgb,var(--late) 5%,transparent)' } : undefined}
            >
              <div className="d">{num(d.getDate(), isAr)}</div>
              {dayChips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={chipClass(c)}
                  onClick={() => navigate(c.href)}
                  title={c.hint}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.label}
                  </span>
                </button>
              ))}
              {emptyWeek && i % 7 === 3 && (
                <div style={{ fontSize: 10, color: 'var(--late)', fontWeight: 700, paddingTop: 14 }}>
                  {isAr ? <>لا شيء مخطط<br />هذا الأسبوع</> : <>Nothing planned<br />this week</>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <>
      <PageHead title={isAr ? 'التقويم' : 'Calendar'} sub={sub}>
        <div className="seg">
          <button type="button" onClick={() => move(-1)} aria-label={isAr ? 'السابق' : 'Previous'}>
            <Prev style={{ width: 13, height: 13 }} />
          </button>
          <button
            type="button"
            className="on"
            onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
          >
            {(isAr ? AR_MONTHS : EN_MONTHS)[cursor.getMonth()]} {num(cursor.getFullYear(), isAr)}
          </button>
          <button type="button" onClick={() => move(1)} aria-label={isAr ? 'التالي' : 'Next'}>
            <Next style={{ width: 13, height: 13 }} />
          </button>
        </div>
        {!isMobile && (
          <>
            <div className="seg">
              {(['month', 'week', 'list'] as const).map((v) => (
                <button key={v} type="button" className={view === v ? 'on' : ''} onClick={() => setView(v)}>
                  {isAr
                    ? { month: 'شهر', week: 'أسبوع', list: 'قائمة' }[v]
                    : { month: 'Month', week: 'Week', list: 'List' }[v]}
                </button>
              ))}
            </div>
            <div className="seg">
              {(['pub', 'due', 'all'] as const).map((f) => (
                <button key={f} type="button" className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                  {isAr
                    ? { pub: 'النشر', due: 'الاستحقاقات', all: 'الكل' }[f]
                    : { pub: 'Publishing', due: 'Due dates', all: 'All' }[f]}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
              <IconPlus />
              {isAr ? 'محتوى جديد' : 'New content'}
            </button>
          </>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && !data && <Skeleton rows={6} />}

        {data && isMobile && (
          <>
            {/* s49's أجندة/شهر switch — two equal thumb chips. */}
            <div className="m1-seg2">
              <button
                type="button"
                className={`fbtn${mView === 'agenda' ? ' on' : ''}`}
                onClick={() => setMView('agenda')}
              >
                {isAr ? 'أجندة' : 'Agenda'}
              </button>
              <button
                type="button"
                className={`fbtn${mView === 'month' ? ' on' : ''}`}
                onClick={() => setMView('month')}
              >
                {isAr ? 'شهر' : 'Month'}
              </button>
            </div>

            {mView === 'month' ? gridEl : (
              <>
                {agenda.length === 0 && (
                  <div style={{ padding: '26px 8px', textAlign: 'center', color: 'var(--mute)', fontSize: 12.5 }}>
                    {isAr ? 'لا شيء في هذا الشهر بهذا المرشح.' : 'Nothing in this month for this filter.'}
                  </div>
                )}
                {agenda.map((entry) => (entry.kind === 'gap' ? (
                  <div key={`gap-${dayKey(entry.start)}`} className="m1-emptyweek">
                    <div className="t">{weekLabel(entry.start, entry.end)}</div>
                    <div className="s">
                      {isAr ? 'لا شيء مجدول للنشر هذا الأسبوع' : 'Nothing is scheduled to publish this week'}
                    </div>
                  </div>
                ) : (
                  <div key={dayKey(entry.day)}>
                    <div className="m1-dayhead">
                      <span className="d">
                        {(isAr ? AR_DAYS : EN_DAYS)[entry.day.getDay()]}
                        {' '}
                        {num(entry.day.getDate(), isAr)}
                        {' '}
                        {(isAr ? AR_MONTHS : EN_MONTHS)[entry.day.getMonth()]}
                      </span>
                      <span className="n">{countPhrase(entry.items.length)}</span>
                    </div>
                    {entry.items.map((c) => (
                      <button
                        key={c.key}
                        type="button"
                        className="m1-card m1-agcard"
                        onClick={() => navigate(c.href)}
                      >
                        <div className="top">
                          <span
                            className={`m1-dot ${c.kind === 'publication'
                              ? (c.platform ? PLATFORM_CLASS[c.platform] ?? '' : '')
                              : 'due'}`}
                          />
                          <span>{agendaTopLine(c)}</span>
                        </div>
                        <div className="t2">
                          {c.ref && (
                            <>
                              <span className="ltr">{c.ref}</span>
                              {' · '}
                            </>
                          )}
                          {c.title}
                        </div>
                      </button>
                    ))}
                  </div>
                )))}
              </>
            )}
          </>
        )}

        {data && !isMobile && (
          <>
            {/* Campaign durations are LANES above the grid, not events in it. */}
            {lanes.map((l) => (
              <div
                key={l.c.id}
                className="lane"
                style={l.c.kind === 'organic' ? {
                  background: 'color-mix(in srgb,var(--copper) 10%,transparent)',
                  borderColor: 'color-mix(in srgb,var(--copper) 32%,transparent)',
                } : undefined}
              >
                <span style={{ fontWeight: 700 }}>{l.c.name}</span>
                <span style={{ color: 'var(--mute)' }}>{l.mid}</span>
                <div className="bar2"><i style={{ width: `${l.pct}%` }} /></div>
                <span style={{ color: 'var(--mute)' }}>{l.right}</span>
              </div>
            ))}

            {view !== 'list' ? gridEl : (
              <div className="card" style={{ marginTop: 14 }}>
                {listEntries.length === 0 && (
                  <div style={{ padding: '26px 16px', textAlign: 'center', color: 'var(--mute)', fontSize: 12.5 }}>
                    {isAr ? 'لا شيء في هذه الفترة بهذا المرشح.' : 'Nothing in this period for this filter.'}
                  </div>
                )}
                {listEntries.map(({ day, chip }) => (
                  <button key={chip.key} type="button" className="lrow" onClick={() => navigate(chip.href)}>
                    <span className="lr-d">
                      {(isAr ? AR_DAYS : EN_DAYS)[day.getDay()]} · {num(day.getDate(), isAr)} {(isAr ? AR_MONTHS : EN_MONTHS)[day.getMonth()]}
                    </span>
                    <span className={chipClass(chip)} style={{ flex: 'none', margin: 0 }}>{chip.label}</span>
                    <span className="lr-t">{chip.hint}</span>
                  </button>
                ))}
              </div>
            )}

            {/* The legend, exactly as mocked. */}
            <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 11.5, color: 'var(--mute)', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <span style={{ width: 9, height: 9, background: '#C13584', borderRadius: 2 }} />
                {isAr ? 'انستقرام' : 'Instagram'}
              </span>
              <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <span style={{ width: 9, height: 9, background: 'var(--ink)', borderRadius: 2 }} />
                {isAr ? 'تيك توك' : 'TikTok'}
              </span>
              <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <span style={{ width: 9, height: 9, background: '#C8B400', borderRadius: 2 }} />
                {isAr ? 'سناب شات' : 'Snapchat'}
              </span>
              <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <span style={{ width: 9, height: 9, border: '1.5px dotted var(--late)', borderRadius: 2 }} />
                {isAr ? 'استحقاق' : 'Due date'}
              </span>
              {firstEmptyWeek && (
                <span style={{ marginInlineStart: 'auto' }}>
                  {isAr
                    ? `أسبوع ${num(firstEmptyWeek.getDate(), true)} ${AR_MONTHS[firstEmptyWeek.getMonth()]} مُعلَّم لأنه بلا أي عملية نشر مجدولة.`
                    : `Week of ${EN_MONTHS[firstEmptyWeek.getMonth()]} ${firstEmptyWeek.getDate()} is flagged because it has no scheduled publishing.`}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {creating && (
        <NewContentModal
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/m/content/${id}`)}
        />
      )}
    </>
  );
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The Sunday starting `d`'s week — the mockup's week starts on الأحد. */
function sundayOf(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

function overlaps(startsOn: string | null, endsOn: string | null, start: Date, end: Date): boolean {
  const s = startsOn ? new Date(startsOn) : null;
  const e = endsOn ? new Date(endsOn) : s;
  if (!s || !e) return false;
  return s <= end && e >= start;
}

/** «١ – ٣١ أغسطس» when the campaign sits inside one month, a range otherwise. */
function laneRange(c: MosCampaign, isAr: boolean): string {
  const s = c.starts_on ? new Date(c.starts_on) : null;
  const e = c.ends_on ? new Date(c.ends_on) : s;
  if (!s || !e) return '';
  if (s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth()) {
    return `${num(s.getDate(), isAr)} – ${num(e.getDate(), isAr)} ${(isAr ? AR_MONTHS : EN_MONTHS)[s.getMonth()]}`;
  }
  return `${shortDate(c.starts_on, isAr)} – ${shortDate(c.ends_on, isAr)}`;
}
