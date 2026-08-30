/**
 * DemandMeter — the visual demand-vs-capacity report, shared by the Organic
 * coverage panel (/m/organic) and the Performance desk (/m/performance).
 *
 * One gauge per bucket. The bar is PRODUCTION (unique creatives to make) against
 * the production CAPACITY ceiling: green fill = the load, a faint segment = spare
 * headroom, a red segment = overflow past the ceiling, and a vertical line marks
 * the ceiling itself. A fan-out row underneath shows how that unique production
 * explodes into platform placements (the reuse factor). Capacity is compared to
 * PRODUCTION, never to distribution.
 */
import { num } from '../lib/format';
import type { DemandLine } from '../lib/coverage';

const ROLE_AR: Record<string, string> = {
  ceo: 'الرئيس التنفيذي', marketing_manager: 'مدير التسويق', ops_supervisor: 'مشرف العمليات',
  writer: 'الكاتب', montage: 'المونتاج',
};

export default function DemandMeter({ lines, isAr }: { lines: DemandLine[]; isAr: boolean }) {
  /** One-decimal number with Arabic digits when isAr. */
  const dec = (n: number): string => {
    const s = (Math.round(n * 10) / 10).toString();
    return isAr ? s.replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.charAt(Number(d))).replace('.', '٫') : s;
  };
  const bucketLabel = (b: string) => b === 'post' ? (isAr ? 'منشورات' : 'Posts') : (isAr ? 'فيديو' : 'Videos');
  const roleLabel = (k: string | null) => (k && isAr ? (ROLE_AR[k] ?? k) : (k ?? ''));

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
          ? (isAr ? 'لا طاقة إنتاج مُعدّة' : 'no capacity set')
          : over
            ? (isAr ? `تجاوز الطاقة بـ ${num(d.productionGapPerWeek, isAr)}/أسبوع` : `over capacity by ${d.productionGapPerWeek}/week`)
            : tight
              ? (isAr ? `على حدّ الطاقة · فائض ${num(headroom, isAr)}` : `at the edge · ${headroom} spare`)
              : (isAr ? `ضمن الطاقة · فائض ${num(headroom, isAr)}/أسبوع` : `within capacity · ${headroom}/week spare`);
        const reuse = prod > 0 ? d.distributionPerWeek / prod : 0;

        return (
          <div key={d.bucket} style={{ display: 'grid', gap: 7 }}>
            {/* header: bucket + the production/capacity ratio */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13 }}>{bucketLabel(d.bucket)}</b>
              <span style={{ fontSize: 11, color: 'var(--mute)' }}>
                {isAr ? 'إنتاج فريد / أسبوع' : 'unique production / week'}
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
                  title={isAr ? 'سقف الطاقة' : 'capacity ceiling'}
                  style={{ position: 'absolute', top: -3, bottom: -3, insetInlineStart: `${Math.min(100, capPct)}%`, width: 2, background: 'var(--ink)' }}
                />
              )}
            </div>

            {/* status + capacity detail */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 11.5 }}>
              <b style={{ color: statusColor }}>{statusText}</b>
              {!noCap && (
                <span style={{ color: 'var(--mute)' }}>
                  {isAr
                    ? `الطاقة ${num(cap, isAr)}/أسبوع · ${num(d.capacityPerWorkingDay, isAr)}/يوم عمل${d.bottleneckRole ? ` (اختناق: ${roleLabel(d.bottleneckRole)})` : ''}`
                    : `capacity ${cap}/week · ${d.capacityPerWorkingDay}/working-day${d.bottleneckRole ? ` (bottleneck: ${d.bottleneckRole})` : ''}`}
                </span>
              )}
              <span style={{ color: 'var(--mute)' }}>
                {isAr ? `متوسط ${dec(d.productionWorkingDayAvg)}/يوم عمل` : `avg ${dec(d.productionWorkingDayAvg)}/working-day`}
              </span>
            </div>

            {/* fan-out: unique production → platform placements (reuse) */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11.5, color: 'var(--mute)' }}>
              <span className="tag">{isAr ? 'النشر' : 'Distribution'}</span>
              <span>
                {isAr
                  ? `${num(prod, isAr)} فريدة → ${num(d.distributionPerWeek, isAr)} موضِعًا/أسبوع`
                  : `${prod} unique → ${d.distributionPerWeek} placements/week`}
              </span>
              {reuse > 1.05 && (
                <b style={{ color: 'var(--copper)' }}>
                  {isAr ? `×${dec(reuse)} إعادة استخدام` : `×${dec(reuse)} reuse`}
                </b>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
