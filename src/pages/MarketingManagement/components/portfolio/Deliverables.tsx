/**
 * Campaign deliverables — the agreed units of work.
 *
 * "8 short videos, 4 carousels, 12 story sequences" is a commitment, and it is
 * what `mkt_campaign_progress()` measures deliverable progress against. It is
 * also an activation blocker: a campaign that has promised nothing cannot go
 * planned or active. Until this editor existed the blocker was unsatisfiable
 * from the interface, so nothing could leave draft at all.
 *
 * Required and completed are separate numbers on purpose. Completed is entered
 * by whoever is running the campaign; it is NOT derived from content items,
 * because a deliverable can be satisfied by work that never became a tracked
 * content row, and pretending otherwise would silently under-report delivery.
 */
import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import Button from '@/components/ui/Button';
import { FIELD } from './shared';

export interface Deliverable { label: string; required: number; completed: number }

/** Tolerant of whatever is already in the jsonb column: a bad row becomes an
 *  empty list rather than throwing the whole drawer away. */
export const asDeliverables = (v: unknown): Deliverable[] =>
  Array.isArray(v)
    ? v.map((d) => {
        const o = (d ?? {}) as Record<string, unknown>;
        return {
          label: typeof o.label === 'string' ? o.label : '',
          required: Number(o.required) || 0,
          completed: Number(o.completed) || 0,
        };
      })
    : [];

export function DeliverablesEditor({ value, isAr, disabled, onSave }: {
  value: unknown; isAr: boolean; disabled?: boolean;
  onSave: (rows: Deliverable[]) => void;
}) {
  const [rows, setRows] = useState<Deliverable[]>(() => asDeliverables(value));
  const set = (i: number, patch: Partial<Deliverable>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const totalReq = rows.reduce((a, r) => a + r.required, 0);
  const totalDone = rows.reduce((a, r) => a + r.completed, 0);

  return (
    <div className="rounded-xl border border-sand/50 bg-white p-2.5">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11.5px] font-medium text-charcoal/55">
          {isAr ? 'المخرجات' : 'Deliverables'}
        </span>
        <span className="text-[11px] tabular-nums text-charcoal/45">
          {totalReq === 0
            ? (isAr ? 'لم يُلتزم بشيء بعد' : 'nothing committed yet')
            : (isAr ? `${totalDone} من ${totalReq}` : `${totalDone} of ${totalReq}`)}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="mb-1.5 text-[11px] leading-snug text-charcoal/45">
          {isAr ? 'حملة بلا مخرجات لم تلتزم بإنتاج شيء — ولا يمكن تفعيلها.'
                : 'A campaign with no deliverables has committed to producing nothing, and cannot be activated.'}
        </p>
      ) : (
        <table className="mb-1.5 w-full text-[12px]">
          <thead>
            <tr className="text-[10.5px] text-charcoal/40">
              <th className="pb-1 text-start font-medium">{isAr ? 'المخرج' : 'Deliverable'}</th>
              <th className="w-20 pb-1 text-start font-medium">{isAr ? 'مطلوب' : 'Required'}</th>
              <th className="w-20 pb-1 text-start font-medium">{isAr ? 'منجز' : 'Done'}</th>
              <th className="w-6" />
            </tr>
          </thead>
          <tbody className="divide-y divide-sand/30">
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="py-1 pe-2">
                  <input value={r.label} disabled={disabled} className={FIELD}
                    placeholder={isAr ? 'مثال: فيديو قصير' : 'e.g. short video'}
                    onChange={(e) => set(i, { label: e.target.value })} />
                </td>
                <td className="py-1 pe-2">
                  <input type="number" min={0} value={r.required} disabled={disabled} className={FIELD}
                    onChange={(e) => set(i, { required: Number(e.target.value) || 0 })} />
                </td>
                <td className="py-1 pe-2">
                  <input type="number" min={0} value={r.completed} disabled={disabled} className={FIELD}
                    onChange={(e) => set(i, { completed: Number(e.target.value) || 0 })} />
                </td>
                <td className="py-1">
                  <button type="button" disabled={disabled}
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                    className="text-charcoal/30 hover:text-red-600 disabled:opacity-30">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>))}
          </tbody>
        </table>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={disabled}
          onClick={() => setRows([...rows, { label: '', required: 1, completed: 0 }])}
          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-copper hover:underline disabled:opacity-40">
          <Plus className="h-3.5 w-3.5" />{isAr ? 'مخرج' : 'Deliverable'}
        </button>
        <Button variant="secondary" disabled={disabled}
          onClick={() => onSave(rows.filter((r) => r.label.trim() !== ''))}>
          {isAr ? 'حفظ المخرجات' : 'Save deliverables'}
        </Button>
      </div>
    </div>
  );
}
