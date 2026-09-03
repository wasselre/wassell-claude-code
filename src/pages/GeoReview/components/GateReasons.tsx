import { Check, TriangleAlert } from 'lucide-react';
import type { GateReason } from '../lib/types';

/**
 * The deterministic confidence/gate signals for the proposal, each shown as
 * pass (green) or needs-attention (amber). This is WHY the ability routed the
 * decision to human review rather than acting on its own.
 */
export default function GateReasons({ reasons, isAr }: { reasons: GateReason[]; isAr: boolean }) {
  if (!reasons.length) return null;
  const fmt = (v: number | null): string => (v === null ? '—' : v.toFixed(2));
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {reasons.map((r) => (
        <div
          key={r.key}
          className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-xs ${
            r.ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-300 bg-amber-50/70'
          }`}
        >
          <span className="flex items-center gap-1.5 text-charcoal/70">
            {r.ok ? <Check size={13} className="text-emerald-600" /> : <TriangleAlert size={13} className="text-amber-600" />}
            {isAr ? r.label_ar : r.label_en}
          </span>
          <span className={`font-bold tabular-nums ${r.ok ? 'text-emerald-700' : 'text-amber-700'}`}>{fmt(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
