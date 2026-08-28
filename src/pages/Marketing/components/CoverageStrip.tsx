/**
 * The coverage strip on /m/calendar — target vs published vs planned for the
 * period the calendar is SHOWING (this week in week view, this month otherwise),
 * per platform (spec: docs/marketing-task-load-plan.md §9).
 *
 * Assists, never schedules: a short bucket says «ناقص كذا» and links nowhere —
 * organic placement stays a human act. The detailed version lives on the
 * Organic page (نبض المنصات). Hidden entirely when no targets are configured.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PerfCalendarData, fetchPerfCalendar } from '@/lib/marketingOS/client';
import { computeCoverage, periodWindow, ymd, type PeriodKind } from '../lib/coverage';
import { num } from '../lib/format';

export default function CoverageStrip({
  view, cursor, isAr,
}: {
  /** The calendar's current view — 'week' shows the week, anything else the month. */
  view: 'month' | 'week' | 'list';
  /** The day the calendar is centered on. */
  cursor: Date;
  isAr: boolean;
}) {
  const kind: PeriodKind = view === 'week' ? 'week' : 'month';
  const period = useMemo(() => periodWindow(kind, cursor), [kind, cursor]);
  const [data, setData] = useState<PerfCalendarData | null>(null);

  const from = ymd(period.start);
  const to = ymd(period.end);

  const load = useCallback(async () => {
    try {
      setData(await fetchPerfCalendar({ from, to }));
    } catch (e) {
      // The strip is an overlay on the calendar, not the calendar — a failure
      // is logged and the strip simply doesn't render.
      console.error('[coverage] load failed', e);
      setData(null);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  const cov = useMemo(() => (data ? computeCoverage(data, period) : null), [data, period]);

  if (!cov || cov.platforms.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-b" style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        <b style={{ fontSize: 12.5 }}>
          {kind === 'week'
            ? (isAr ? 'التغطية هذا الأسبوع' : 'Coverage this week')
            : (isAr ? 'التغطية هذا الشهر' : 'Coverage this month')}
        </b>
        {cov.platforms.map((r) => (
          <div key={r.platform} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="tag">{r.platform}</span>
            {r.cells.map((c) => (
              <span key={c.bucket} style={{ fontSize: 11.5, color: c.short > 0 ? 'var(--bad, #b3261e)' : 'var(--mute)' }}>
                {c.bucket === 'post' ? (isAr ? 'منشورات' : 'posts') : (isAr ? 'فيديو' : 'videos')}{' '}
                {num(c.published, isAr)}/{num(c.targetToDate, isAr)}
                {c.planned > 0 && ` (+${num(c.planned, isAr)} ${isAr ? 'مجدولة' : 'scheduled'})`}
                {c.short > 0 && (
                  <b style={{ marginInlineStart: 4 }}>
                    {isAr ? `ناقص ${num(c.short, isAr)}` : `${c.short} short`}
                  </b>
                )}
              </span>
            ))}
          </div>
        ))}
        <a href="/m/organic" style={{ fontSize: 11, color: 'var(--copper)', marginInlineStart: 'auto', textDecoration: 'none' }}>
          {isAr ? 'التفاصيل ←' : 'Details →'}
        </a>
      </div>
    </div>
  );
}
