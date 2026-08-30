/**
 * DemandMeter — the visual demand-vs-capacity report, shared by the Organic
 * coverage panel (/m/organic) and the Performance desk (/m/performance).
 *
 * One gauge per bucket: PRODUCTION (unique creatives to make) against the
 * production CAPACITY ceiling. Green fill = the load, a faint segment = spare
 * headroom, red = overflow past the ceiling, a vertical line marks the ceiling.
 * Just the bar, the number, and a one-line status — no prose.
 */
import { num } from '../lib/format';
import type { DemandLine } from '../lib/coverage';

export default function DemandMeter({ lines, isAr }: { lines: DemandLine[]; isAr: boolean }) {
  const bucketLabel = (b: string) => b === 'post' ? (isAr ? 'منشورات' : 'Posts') : (isAr ? 'فيديو' : 'Videos');

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {lines.map((d) => {
        const cap = d.capacityPerWeek;
        const prod = d.productionPerWeek;
        const scale = Math.max(cap, prod, 1);
        const prodPct = (prod / scale) * 100;
        const capPct = (cap / scale) * 100;
        const over = prod > cap && cap > 0;
        const noCap = cap <= 0;
        const headroom = Math.max(0, cap - prod);
        const tight = !over && !noCap && headroom <= cap * 0.2;

        const statusColor = over ? 'var(--late)' : noCap ? 'var(--mute)' : tight ? 'var(--gold, #C09B5F)' : 'var(--go)';
        const statusText = noCap
          ? (isAr ? 'لم نحدّد طاقة الفريق بعد' : 'no capacity set')
          : over
            ? (isAr ? `فوق طاقتنا بـ ${num(d.productionGapPerWeek, isAr)}` : `over capacity by ${d.productionGapPerWeek}`)
            : tight
              ? (isAr ? `على الحدّ — يتبقّى ${num(headroom, isAr)} فقط` : `at the edge — only ${headroom} to spare`)
              : (isAr ? `مريح — يتبقّى ${num(headroom, isAr)}` : `comfortable — ${headroom} to spare`);

        return (
          <div key={d.bucket} style={{ display: 'grid', gap: 7 }}>
            {/* header: bucket + the production/capacity number */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13 }}>{bucketLabel(d.bucket)}</b>
              <span style={{ fontSize: 11, color: 'var(--mute)' }}>
                {isAr ? 'المطلوب صناعته أسبوعيًا' : 'to make this week'}
              </span>
              <span style={{ marginInlineStart: 'auto', fontFamily: 'var(--serif)', fontSize: 18, color: statusColor }}>
                {num(prod, isAr)}
                <span style={{ fontSize: 12, color: 'var(--mute)' }}> / {noCap ? '—' : num(cap, isAr)}</span>
              </span>
            </div>

            {/* the capacity gauge */}
            <div style={{
              position: 'relative', height: 16, borderRadius: 999,
              background: 'var(--sand-2)', border: '1px solid var(--line)', display: 'flex', overflow: 'hidden',
            }}>
              <div style={{ width: `${Math.max(0, Math.min(prodPct, capPct || prodPct))}%`, background: 'var(--go)' }} />
              {over
                ? <div style={{ width: `${prodPct - capPct}%`, background: 'var(--late)' }} />
                : <div style={{ width: `${Math.max(0, capPct - prodPct)}%`, background: 'color-mix(in srgb, var(--go) 16%, transparent)' }} />}
              {!noCap && (
                <div
                  style={{ position: 'absolute', top: -3, bottom: -3, insetInlineStart: `${Math.min(100, capPct)}%`, width: 2, background: 'var(--ink)' }}
                />
              )}
            </div>

            {/* one-line status */}
            <b style={{ fontSize: 11.5, color: statusColor }}>{statusText}</b>
          </div>
        );
      })}
    </div>
  );
}
