/**
 * Per-person, per-day load: what is already on their plate, what this plan
 * would add, and what they can actually take.
 *
 * This is the table that stops a preview from lying. Every plan looks feasible
 * until you count the single marketing manager's approvals — which is exactly
 * why approvals are their own bucket here rather than being folded into the
 * designer's budget.
 *
 * A cell reads «موجود + مقترح / السعة». Red means the sum exceeds the cap on
 * that day; the plan can still be committed only because the server re-checks
 * capacity independently at commit time and refuses with `capacity_conflict`.
 */
import type { LoadCell } from '@/lib/marketingOS/scheduling';
import {
  bucketLabel, buildLoadTable, personName, pickText, type NamedPerson,
} from '../lib/planPresentation';
import { num, dayLabel } from '../lib/format';

export default function PlanLoadTable({
  load, people, isAr,
}: {
  load: LoadCell[];
  people: NamedPerson[];
  isAr: boolean;
}) {
  const table = buildLoadTable(load);

  if (table.rows.length === 0) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h"><h4>{isAr ? 'الحمل اليومي' : 'Daily load'}</h4></div>
        <div className="card-b" style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.9 }}>
          {isAr
            ? 'لا تضيف هذه الخطة أي عمل إلى أيام أحد — لا توجد مراحل مُسندة بعد.'
            : 'This plan adds no work to anyone’s days — no stages are assigned yet.'}
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-h">
        <h4>{isAr ? 'الحمل اليومي لكل شخص' : 'Daily load per person'}</h4>
        <span className="r">
          {table.overCells > 0
            ? (isAr
                ? `${num(table.overCells, true)} خانة تتجاوز السعة`
                : `${table.overCells} cell(s) over capacity`)
            : (isAr ? 'كل الأيام داخل السعة' : 'every day within capacity')}
        </span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{isAr ? 'الشخص' : 'Person'}</th>
              <th>{isAr ? 'النوع' : 'Bucket'}</th>
              {table.days.map((d) => (
                <th key={d} className="num">{dayLabel(d, isAr)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => {
              const byDay = new Map(row.cells.map((c) => [c.day, c]));
              return (
                <tr key={`${row.userId}|${row.bucket}`} className={row.anyOver ? 'hl' : undefined}>
                  <td className="ttl">{personName(row.userId, people, isAr)}</td>
                  <td>{pickText(bucketLabel(row.bucket), isAr)}</td>
                  {table.days.map((d) => {
                    const c = byDay.get(d);
                    if (!c) return <td key={d} className="num" style={{ color: 'var(--mute)' }}>—</td>;
                    return (
                      <td
                        key={d}
                        className="num"
                        style={c.over
                          ? { color: 'var(--late)', fontWeight: 700 }
                          : c.proposed > 0 ? { color: 'var(--ink)' } : { color: 'var(--mute)' }}
                        title={isAr
                          ? `موجود ${num(c.existing, true)} · مقترح ${num(c.proposed, true)} · السعة ${num(c.capacity, true)}`
                          : `existing ${c.existing} · proposed ${c.proposed} · capacity ${c.capacity}`}
                      >
                        {num(c.existing, isAr)}
                        {c.proposed > 0 && (
                          <span style={{ color: 'var(--copper)' }}>{`+${num(c.proposed, isAr)}`}</span>
                        )}
                        <span style={{ color: 'var(--mute)' }}>{`/${num(c.capacity, isAr)}`}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card-b" style={{ borderTop: '1px solid var(--line-soft)', fontSize: 11, color: 'var(--mute)', lineHeight: 1.9 }}>
        {isAr
          ? 'الخانة: الموجود + ما تضيفه هذه الخطة / السعة اليومية. الأحمر يعني تجاوزًا فعليًا — عالجه بتغيير المدى أو العدد أو الطاقة، لا بتجاهله.'
          : 'Each cell: existing + what this plan adds / the daily capacity. Red is a real overflow — fix it by changing the range, the count, or the capacity, not by ignoring it.'}
      </div>
    </div>
  );
}
