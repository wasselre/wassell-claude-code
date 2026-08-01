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
import { num, shortDate } from './lib/format';

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
}

export default function CalendarPage() {
  const { isAr } = useWorkspace();
  const navigate = useNavigate();

  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [view, setView] = useState<View>('month');
  const [filter, setFilter] = useState<Filter>('pub');
  const [data, setData] = useState<CalData | null>(null);
  const [campaigns, setCampaigns] = useState<MosCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // The grid always shows whole weeks, so the range fetched is the visible
  // grid rather than the calendar month — otherwise the leading/trailing
  // days lie. Week view fetches just its one row.
  const range = useMemo(() => {
    if (view === 'week') {
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
  }, [cursor, view]);

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
    () => Array.from({ length: view === 'week' ? 7 : 42 }, (_, i) => {
      const d = new Date(range.start);
      d.setDate(range.start.getDate() + i);
      return d;
    }),
    [range, view],
  );

  // Emptiness is judged on PUBLICATIONS only, and on the unfiltered set —
  // a week full of due dates but no publishing is still a gap in the rhythm.
  const emptyWeeks = useMemo(() => {
    if (view !== 'month') return new Set<number>();
    const set = new Set<number>();
    for (let w = 0; w < 6; w += 1) {
      const days = gridDays.slice(w * 7, w * 7 + 7);
      const inMonth = days.some((d) => d.getMonth() === cursor.getMonth());
      if (!inMonth) continue;
      const hasPub = days.some((d) => (chips.get(dayKey(d)) ?? []).some((c) => c.kind === 'publication'));
      if (!hasPub) set.add(w);
    }
    return set;
  }, [view, gridDays, chips, cursor]);

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

  const sub = view === 'week'
    ? isAr
      ? `${shortDate(range.start.toISOString(), true)} – ${shortDate(range.end.toISOString(), true)} · ${num(pubCount, true)} عملية نشر · ${activePhrase}`
      : `${shortDate(range.start.toISOString(), false)} – ${shortDate(range.end.toISOString(), false)} · ${pubCount} publications · ${activePhrase}`
    : isAr
      ? `${AR_MONTHS[cursor.getMonth()]} ${num(cursor.getFullYear(), true)} · ${num(pubCount, true)} عملية نشر · ${activePhrase}`
      : `${EN_MONTHS[cursor.getMonth()]} ${cursor.getFullYear()} · ${pubCount} publications · ${activePhrase}`;

  const move = (delta: number): void => {
    setCursor((c) => view === 'week'
      ? new Date(c.getFullYear(), c.getMonth(), c.getDate() + delta * 7)
      : new Date(c.getFullYear(), c.getMonth() + delta, 1));
  };

  const Prev = isAr ? IconForward : IconBack;
  const Next = isAr ? IconBack : IconForward;
  const todayKey = dayKey(new Date());

  const chipClass = (c: Chip): string =>
    `ev ${c.kind === 'publication' ? (c.platform ? PLATFORM_CLASS[c.platform] ?? '' : '') : 'due'}`;

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
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && !data && <Skeleton rows={6} />}

        {data && (
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

            {view !== 'list' ? (
              <div className="cal" style={{ marginTop: 14 }}>
                <div className="cal-h">
                  {(isAr ? AR_DAYS : EN_DAYS).map((d) => <div key={d}>{d}</div>)}
                </div>
                <div className={`cal-g${view === 'week' ? ' week' : ''}`}>
                  {gridDays.map((d, i) => {
                    const key = dayKey(d);
                    const dayChips = (chips.get(key) ?? []).filter(visibleChip);
                    const outside = view === 'month' && d.getMonth() !== cursor.getMonth();
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
            ) : (
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
