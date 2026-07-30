/**
 * Calendar — design screen 13.
 *
 * Two different things share the grid and are drawn differently on purpose:
 * a SCHEDULED publication is a solid chip (it will happen at that hour on that
 * platform), and a DUE DATE is a dotted chip (it is a promise about work, not
 * about a post). Conflating them is how a calendar starts lying.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PLATFORM_CLASS, PLATFORM_LABELS, fetchCalendar,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { LoadError, PageHead, Skeleton } from './components/kit';
import { IconBack, IconForward } from './components/icons';
import { num } from './lib/format';

const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Chip {
  key: string;
  contentId: string;
  label: string;
  platform: string | null;
  kind: 'publication' | 'due';
}

export default function CalendarPage() {
  const { isAr } = useWorkspace();
  const navigate = useNavigate();

  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [chips, setChips] = useState<Map<string, Chip[]>>(new Map());
  const [counts, setCounts] = useState({ scheduled: 0, due: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The grid always shows whole weeks, so the range fetched is the visible grid
  // rather than the calendar month — otherwise the leading/trailing days lie.
  const gridStart = useMemo(() => {
    const d = new Date(cursor);
    d.setDate(1 - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d;
  }, [cursor]);

  const gridDays = useMemo(
    () => Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      return d;
    }),
    [gridStart],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const from = gridDays[0];
      const last = gridDays[gridDays.length - 1];
      if (!from || !last) return;
      const to = new Date(last);
      to.setHours(23, 59, 59, 999);

      const res = await fetchCalendar(from.toISOString(), to.toISOString());
      const titles = new Map(res.titles.map((t) => [t.id, t]));
      const map = new Map<string, Chip[]>();
      const push = (day: string, chip: Chip): void => {
        const list = map.get(day) ?? [];
        list.push(chip);
        map.set(day, list);
      };

      for (const p of res.publications) {
        const when = p.published_at ?? p.scheduled_at;
        if (!when) continue;
        const t = titles.get(p.content_id);
        push(dayKey(new Date(when)), {
          key: `p-${p.id}`,
          contentId: p.content_id,
          label: `${t?.ref ?? ''} ${t?.title ?? ''}`.trim(),
          platform: p.platform,
          kind: 'publication',
        });
      }
      for (const d of res.due) {
        if (!d.due_at) continue;
        push(dayKey(new Date(d.due_at)), {
          key: `d-${d.id}`,
          contentId: d.id,
          label: `${d.ref ?? ''} ${d.title}`.trim(),
          platform: null,
          kind: 'due',
        });
      }
      setChips(map);
      setCounts({ scheduled: res.publications.length, due: res.due.length });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [gridDays]);

  useEffect(() => { void load(); }, [load]);

  const move = (delta: number): void => {
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
  };

  const Prev = isAr ? IconForward : IconBack;
  const Next = isAr ? IconBack : IconForward;
  const todayKey = dayKey(new Date());

  return (
    <>
      <PageHead
        title={isAr ? 'التقويم' : 'Calendar'}
        sub={isAr
          ? `${num(counts.scheduled, true)} منشورًا مجدولًا · ${num(counts.due, true)} استحقاق عمل`
          : `${counts.scheduled} scheduled posts · ${counts.due} work due dates`}
      >
        <div className="seg">
          <button type="button" onClick={() => move(-1)} aria-label={isAr ? 'الشهر السابق' : 'Previous month'}>
            <Prev style={{ width: 13, height: 13 }} />
          </button>
          <button
            type="button"
            className="on"
            onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
          >
            {(isAr ? AR_MONTHS : EN_MONTHS)[cursor.getMonth()]} {num(cursor.getFullYear(), isAr)}
          </button>
          <button type="button" onClick={() => move(1)} aria-label={isAr ? 'الشهر التالي' : 'Next month'}>
            <Next style={{ width: 13, height: 13 }} />
          </button>
        </div>
        <button type="button" className="btn" onClick={() => navigate('/m/content')}>
          {isAr ? 'عرض الجدول' : 'Table view'}
        </button>
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && chips.size === 0 && <Skeleton rows={6} />}

        <div className="cal">
          <div className="cal-h">
            {(isAr ? AR_DAYS : EN_DAYS).map((d) => <div key={d}>{d}</div>)}
          </div>
          <div className="cal-g">
            {gridDays.map((d) => {
              const key = dayKey(d);
              const dayChips = chips.get(key) ?? [];
              const outside = d.getMonth() !== cursor.getMonth();
              return (
                <div key={key} className={`cal-c${outside ? ' out' : ''}${key === todayKey ? ' today' : ''}`}>
                  <div className="d">{num(d.getDate(), isAr)}</div>
                  {dayChips.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      className={`ev ${c.kind === 'due' ? 'due' : (c.platform ? PLATFORM_CLASS[c.platform] ?? '' : '')}`}
                      onClick={() => navigate(`/m/content/${c.contentId}`)}
                      title={c.label}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.kind === 'due'
                          ? (isAr ? 'استحقاق · ' : 'due · ')
                          : `${(isAr ? PLATFORM_LABELS[c.platform ?? '']?.ar : PLATFORM_LABELS[c.platform ?? '']?.en) ?? ''} · `}
                        {c.label}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--mute)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="ev" style={{ width: 26, padding: 0, height: 12, margin: 0 }} />
            {isAr ? 'منشور مجدول — سيحدث فعلًا' : 'Scheduled post — it will happen'}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="ev due" style={{ width: 26, padding: 0, height: 12, margin: 0 }} />
            {isAr ? 'استحقاق عمل — وعد بخطوة، لا بمنشور' : 'Work due — a promise about a stage, not a post'}
          </span>
        </div>
      </div>
    </>
  );
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
