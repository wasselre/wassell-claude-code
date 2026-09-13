/**
 * The paid refresh forecast — the production calendar, fixed at plan time.
 *
 * Two calendars, deliberately separate (plan §7.1): this one says WHEN
 * replacement creatives must be produced and by when they must be ready, and it
 * does not depend on performance at all. The other calendar — which creative
 * stays and which is replaced — is decided near each refresh date and never
 * delays production. That is why `production start` for the first refresh can
 * fall BEFORE the campaign even launches: you never need to know the winner to
 * start building its replacements.
 */
import type { PlannedCycle, PlanTotals } from '@/lib/marketingOS/scheduling';
import { PLATFORM_LABELS } from '@/lib/marketingOS/client';
import {
  buildRefreshRows, creativeTotalsText, pickText,
} from '../lib/planPresentation';
import { num, shortDate } from '../lib/format';

export default function RefreshForecastCard({
  cycles, totals, rangeEnd, platform, fifthPolicy, isAr,
}: {
  cycles: PlannedCycle[];
  totals: PlanTotals['creatives'];
  rangeEnd: string;
  platform: string;
  fifthPolicy: 'A' | 'B';
  isAr: boolean;
}) {
  if (cycles.length === 0) return null;
  const rows = buildRefreshRows(cycles, rangeEnd);
  const label = PLATFORM_LABELS[platform];
  const platformLabel = label ? (isAr ? label.ar : label.en) : platform;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-h">
        <h4>{isAr ? `تحديثات التصاميم — ${platformLabel}` : `Creative refreshes — ${platformLabel}`}</h4>
        <span className="r">
          {isAr
            ? `سياسة الخامس: ${fifthPolicy === 'A' ? 'أ — الاستبدال الكامل متاح دائمًا' : 'ب — أربعة مضمونة'}`
            : `Fifth policy: ${fifthPolicy === 'A' ? 'A — replace-all always available' : 'B — four guaranteed'}`}
        </span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{isAr ? 'الدورة' : 'Cycle'}</th>
              <th>{isAr ? 'تاريخ التحديث' : 'Refresh on'}</th>
              <th className="num">{isAr ? 'المتبقي' : 'Days left'}</th>
              <th>{isAr ? 'جاهز بحلول' : 'Ready by'}</th>
              <th>{isAr ? 'يبدأ الإنتاج' : 'Production starts'}</th>
              <th>{isAr ? 'موعد القرار' : 'Decision due'}</th>
              <th className="num">{isAr ? 'تصاميم' : 'Produced'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.executionKey}|${r.round}`}>
                <td className="ttl" style={r.skipped ? { color: 'var(--mute)' } : undefined}>
                  {/* thumb slot — the cycle's creatives get thumbnails once produced */}
                  {pickText(r.label, isAr)}
                </td>
                <td className="ltr">{shortDate(r.refreshOn, isAr)}</td>
                <td className="num">{r.daysLeft === null ? '—' : num(r.daysLeft, isAr)}</td>
                <td className="ltr">{r.readyBy ? shortDate(r.readyBy, isAr) : '—'}</td>
                <td className="ltr">{r.productionStartOn ? shortDate(r.productionStartOn, isAr) : '—'}</td>
                <td className="ltr">{r.decisionDueOn ? shortDate(r.decisionDueOn, isAr) : '—'}</td>
                <td className="num" style={r.skipped ? { color: 'var(--mute)' } : { fontWeight: 700 }}>
                  {num(r.produced, isAr)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-b" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
          {creativeTotalsText(totals, isAr)}
        </div>
        <ul style={{ margin: '9px 0 0', paddingInlineStart: 18, fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.9 }}>
          {rows.filter((r) => r.skipped || r.bankedSpareSlotId || r.round === 0).map((r) => (
            <li key={`note-${r.round}`}>
              <b style={{ color: 'var(--ink)' }}>{pickText(r.label, isAr)}</b>
              {' — '}
              {pickText(r.note, isAr)}
            </li>
          ))}
          <li>
            {isAr
              ? 'الإنتاج مثبَّت الآن؛ قرار «مَن يبقى ومَن يُستبدل» يُتخذ قرب كل تاريخ تحديث من الأرقام، ولا يؤخّر الإنتاج.'
              : 'Production is fixed now; the keep-or-replace decision is taken near each refresh date from the numbers, and never delays production.'}
          </li>
        </ul>
      </div>
    </div>
  );
}
