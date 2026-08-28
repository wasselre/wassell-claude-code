/**
 * The coverage strip on /m/calendar — target vs planned vs published for the
 * shown month, per platform (spec: docs/marketing-task-load-plan.md §9).
 *
 * Assists, never schedules: a short day says «انقص كذا» and links nowhere —
 * organic placement stays a human act. Hidden entirely when no targets are
 * configured or the cadence toggle is off.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PerfBucket, PerfCalendarData, fetchPerfCalendar,
} from '@/lib/marketingOS/client';
import { num } from '../lib/format';

const BUCKETS: readonly PerfBucket[] = ['post', 'video'];

export default function CoverageStrip({
  monthDate, isAr,
}: {
  /** The first day of the month the calendar is showing. */
  monthDate: Date;
  isAr: boolean;
}) {
  const month = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
  const [data, setData] = useState<PerfCalendarData | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchPerfCalendar(month));
    } catch (e) {
      // The strip is an overlay on the calendar, not the calendar — a failure
      // is logged and the strip simply doesn't render.
      console.error('[coverage] load failed', e);
      setData(null);
    }
  }, [month]);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    if (!data || data.targets.length === 0) return [];
    // Days elapsed in the shown month (for the month-to-date target).
    const now = new Date();
    const isCurrent = now.getFullYear() === monthDate.getFullYear() && now.getMonth() === monthDate.getMonth();
    const daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
    const elapsed = isCurrent ? now.getDate() : (now < monthDate ? 0 : daysInMonth);

    const platforms = Array.from(new Set(data.targets.filter((t) => t.active).map((t) => t.platform)));
    return platforms.map((platform) => {
      const cells = BUCKETS.map((bucket) => {
        // Every-day target (weekday overrides are refinements; the strip
        // reports on the base rate — the day cells carry the fine detail).
        const perDay = data.targets
          .filter((t) => t.platform === platform && t.bucket === bucket && t.active && t.weekday === null)
          .reduce((s, t) => s + t.per_day, 0);
        const published = data.publications
          .filter((p) => p.platform === platform && p.bucket === bucket && p.status === 'published').length;
        const planned = data.publications
          .filter((p) => p.platform === platform && p.bucket === bucket && p.status === 'scheduled').length;
        const targetToDate = perDay * elapsed;
        return { bucket, perDay, published, planned, targetToDate, short: Math.max(0, targetToDate - published - planned) };
      }).filter((c) => c.perDay > 0);
      return { platform, cells };
    }).filter((r) => r.cells.length > 0);
  }, [data, monthDate]);

  if (rows.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-b" style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        <b style={{ fontSize: 12.5 }}>{isAr ? 'التغطية هذا الشهر' : 'Coverage this month'}</b>
        {rows.map((r) => (
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
      </div>
    </div>
  );
}
