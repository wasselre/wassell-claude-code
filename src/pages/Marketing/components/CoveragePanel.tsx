/**
 * Coverage & cadence — the detailed demand-vs-supply report on /m/organic.
 *
 * Demand  = the posting-cadence targets (what we WANT out, per platform × bucket).
 * Supply  = what we actually publish + what's scheduled, plus the team's
 *           production capacity (the slowest producer stage = finished-piece rate).
 *
 * The thin one-line version lives on the calendar; this is the place to see WHY
 * a platform is behind: the pace bar, the published/planned split, and whether
 * the plan is even producible given the load config. Reporting only — it never
 * schedules anything (organic placement stays a human act).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PLATFORM_LABELS, PerfCalendarData, fetchPerfCalendar } from '@/lib/marketingOS/client';
import {
  CoverageCell, computeCoverage, periodWindow, ymd, type PeriodKind,
} from '../lib/coverage';
import { num } from '../lib/format';

const PLATFORM_COLORS: Record<string, string> = {
  instagram: '#C13584', tiktok: 'var(--ink)', snapchat: '#C8B400', x: 'var(--ink)', youtube: '#C4302B',
};

/* One stacked pace bar: published (solid) + planned (light) against the whole
   window's target, with a marker at where you SHOULD be by today. */
function PaceBar({ cell }: { cell: CoverageCell }) {
  const full = cell.fullTarget || 1;
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / full) * 100))}%`;
  const pacePct = Math.max(0, Math.min(100, (cell.targetToDate / full) * 100));
  return (
    <div
      style={{
        position: 'relative', height: 12, borderRadius: 999,
        background: 'var(--sand-2)', border: '1px solid var(--line)',
        display: 'flex', overflow: 'hidden',
      }}
    >
      <div style={{ width: pct(cell.published), background: 'var(--copper)' }} />
      <div style={{ width: pct(cell.planned), background: 'color-mix(in srgb, var(--copper) 38%, transparent)' }} />
      {/* pace marker — "where you should be by today" */}
      {cell.targetToDate > 0 && cell.targetToDate < cell.fullTarget && (
        <div
          title="pace"
          style={{
            position: 'absolute', top: -2, bottom: -2, insetInlineStart: `${pacePct}%`,
            width: 2, background: 'var(--ink)', opacity: 0.55,
          }}
        />
      )}
    </div>
  );
}

export default function CoveragePanel({ isAr }: { isAr: boolean }) {
  const [kind, setKind] = useState<PeriodKind>('week');
  const [data, setData] = useState<PerfCalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const period = useMemo(() => periodWindow(kind, new Date()), [kind]);
  const from = ymd(period.start);
  const to = ymd(period.end);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await fetchPerfCalendar({ from, to }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  const cov = useMemo(() => (data ? computeCoverage(data, period) : null), [data, period]);

  // Nothing to report until cadence targets exist — stay silent (like the strip).
  if (!error && (!cov || cov.platforms.length === 0)) return null;

  const label = (p: string) => (isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p;
  const bucketLabel = (b: string) => b === 'post' ? (isAr ? 'منشورات' : 'Posts') : (isAr ? 'فيديو' : 'Videos');

  const overall = cov?.overall;
  const overallPct = overall && overall.fullTarget > 0
    ? Math.round(((overall.published + overall.planned) / overall.fullTarget) * 100) : 0;
  const donePct = overall && overall.fullTarget > 0
    ? Math.round((overall.published / overall.fullTarget) * 100) : 0;

  const status = (c: CoverageCell): { text: string; tone: 'go' | 'mute' | 'late' } => {
    if (c.published >= c.fullTarget) return { text: isAr ? 'مكتمل' : 'Complete', tone: 'go' };
    if (c.published + c.planned >= c.targetToDate) return { text: isAr ? 'على المسار' : 'On track', tone: 'go' };
    return { text: isAr ? `ناقص ${num(c.short, isAr)}` : `${c.short} behind`, tone: 'late' };
  };
  const toneColor = (t: 'go' | 'mute' | 'late') =>
    t === 'go' ? 'var(--go)' : t === 'late' ? 'var(--late)' : 'var(--mute)';

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-h" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0 }}>{isAr ? 'التغطية والإيقاع' : 'Coverage & cadence'}</h4>
        {cov && (
          <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
            {isAr
              ? `يوم ${num(cov.daysElapsed, true)} من ${num(cov.daysTotal, true)}`
              : `day ${cov.daysElapsed} of ${cov.daysTotal}`}
          </span>
        )}
        <div className="seg" style={{ marginInlineStart: 'auto' }}>
          <button type="button" className={kind === 'week' ? 'on' : ''} onClick={() => setKind('week')}>
            {isAr ? 'الأسبوع' : 'Week'}
          </button>
          <button type="button" className={kind === 'month' ? 'on' : ''} onClick={() => setKind('month')}>
            {isAr ? 'الشهر' : 'Month'}
          </button>
        </div>
      </div>

      <div className="card-b" style={{ display: 'grid', gap: 18 }}>
        {error && (
          <div className="notice bad" role="alert" style={{ margin: 0 }}>
            {isAr ? 'تعذّر تحميل التغطية.' : 'Could not load coverage.'} {error}
          </div>
        )}

        {overall && overall.fullTarget > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13 }}>{isAr ? 'الإجمالي عبر المنصات' : 'Across all platforms'}</b>
              <span style={{ fontSize: 12, color: 'var(--mute)' }}>
                {isAr
                  ? `${num(overall.published, true)} منشور + ${num(overall.planned, true)} مجدول من هدف ${num(overall.fullTarget, true)}`
                  : `${overall.published} published + ${overall.planned} scheduled of ${overall.fullTarget} target`}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <PaceBar cell={{ ...overall, bucket: 'post' }} />
              </div>
              <b style={{ fontSize: 20, fontFamily: 'var(--serif)', minWidth: 56, textAlign: 'end',
                color: overall.short > 0 ? 'var(--late)' : 'var(--go)' }}>
                {num(overallPct, isAr)}%
              </b>
            </div>
            <div style={{ fontSize: 11.5, color: overall.short > 0 ? 'var(--late)' : 'var(--mute)' }}>
              {overall.short > 0
                ? (isAr ? `متأخر عن الإيقاع بـ ${num(overall.short, isAr)} قطعة` : `${overall.short} pieces behind pace`)
                : (isAr ? 'على المسار — النشر يواكب الخطة' : 'On pace with the plan')}
              {' · '}
              {isAr ? `منشور فعليًا ${num(donePct, isAr)}%` : `${donePct}% already published`}
            </div>
          </div>
        )}

        {/* ── per-platform pace bars ─────────────────────────────── */}
        <div style={{ display: 'grid', gap: 16 }}>
          {cov?.platforms.map((r) => (
            <div key={r.platform} style={{ display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700 }}>
                <span className="pdot" style={{ background: PLATFORM_COLORS[r.platform] ?? 'var(--copper)' }} />
                {label(r.platform)}
              </div>
              {r.cells.map((c) => {
                const s = status(c);
                return (
                  <div key={c.bucket} style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 120px) 1fr auto', gap: 12, alignItems: 'center' }}>
                    <div style={{ fontSize: 12.5 }}>
                      {bucketLabel(c.bucket)}
                      <div style={{ fontSize: 10.5, color: 'var(--mute)' }}>
                        {isAr ? `الهدف ${num(c.fullTarget, true)}` : `target ${c.fullTarget}`}
                      </div>
                    </div>
                    <PaceBar cell={c} />
                    <div style={{ textAlign: 'end', minWidth: 92 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700 }}>
                        {num(c.published, isAr)}
                        {c.planned > 0 && <span style={{ color: 'var(--mute)', fontWeight: 400 }}> +{num(c.planned, isAr)}</span>}
                        <span style={{ color: 'var(--mute)', fontWeight: 400 }}> / {num(c.fullTarget, isAr)}</span>
                      </div>
                      <div style={{ fontSize: 10.5, fontWeight: 700, color: toneColor(s.tone) }}>{s.text}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* ── demand vs production capacity ──────────────────────── */}
        {cov && cov.capacity.length > 0 && (
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14, display: 'grid', gap: 8 }}>
            <b style={{ fontSize: 12.5 }}>{isAr ? 'الطلب مقابل طاقة الإنتاج' : 'Demand vs production capacity'}</b>
            {cov.capacity.map((c) => (
              <div key={c.bucket} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
                <span className="tag">{bucketLabel(c.bucket)}</span>
                <span style={{ color: 'var(--mute)' }}>
                  {isAr
                    ? `الطلب ${num(c.demandPerDay, true)}/يوم`
                    : `demand ${c.demandPerDay}/day`}
                </span>
                <span style={{ color: 'var(--mute)' }}>·</span>
                <span style={{ color: c.short ? 'var(--late)' : 'var(--go)' }}>
                  {c.bottleneckPerDay > 0
                    ? (isAr
                      ? `طاقة ${num(c.bottleneckPerDay, true)}/يوم${c.bottleneckRole ? ` (اختناق: ${c.bottleneckRole})` : ''}`
                      : `capacity ${c.bottleneckPerDay}/day${c.bottleneckRole ? ` (bottleneck: ${c.bottleneckRole})` : ''}`)
                    : (isAr ? 'لا طاقة إنتاج مُعدّة' : 'no production capacity set')}
                </span>
                {c.short && (
                  <b style={{ color: 'var(--late)' }}>
                    {isAr
                      ? `عجز هيكلي ${num(c.demandPerDay - c.bottleneckPerDay, true)}/يوم`
                      : `structural gap ${c.demandPerDay - c.bottleneckPerDay}/day`}
                  </b>
                )}
              </div>
            ))}
            <div style={{ fontSize: 10.5, color: 'var(--mute)' }}>
              {isAr
                ? 'الطاقة = أبطأ مرحلة إنتاج (كل قطعة تمرّ بكل المراحل، والأبطأ يحدّد السرعة). تُضبط من الإعدادات ← طاقة العمل.'
                : 'Capacity = the slowest production stage (a piece passes every stage; the slowest sets the rate). Set it in Settings → Load & SLA.'}
            </div>
          </div>
        )}

        <div style={{ fontSize: 10.5, color: 'var(--mute)' }}>
          {isAr
            ? '▓ منشور · ▒ مجدول · الخط العمودي = أين يجب أن نكون اليوم. تقرير فقط — لا ينشر بالنيابة عنك.'
            : '▓ published · ▒ scheduled · the vertical line = where we should be today. Reporting only — never auto-posts.'}
        </div>
      </div>
    </div>
  );
}
