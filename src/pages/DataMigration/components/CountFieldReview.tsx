import { useState } from 'react';
import { ChevronDown, ChevronRight, Calculator } from 'lucide-react';
import type { CountRowResult } from '../lib/types';

interface Props {
  isAr: boolean;
  fieldLabel: string;
  results: CountRowResult[];
  /** row index → a short unit label for display. */
  rowLabel: (rowIndex: number) => string;
  onChange: (next: CountRowResult[]) => void;
}

/**
 * Review card for an AI-counted number field (e.g. total bathrooms). Shows the
 * computed count per unit with the AI's reasoning; the user can adjust any
 * number before migrating. Same approve-before-apply gate as standardization.
 */
export default function CountFieldReview({ isAr, fieldLabel, results, rowLabel, onChange }: Props) {
  const [open, setOpen] = useState(true);
  const setCount = (i: number, count: number) =>
    onChange(results.map((r, ri) => (ri === i ? { ...r, count } : r)));

  return (
    <div className="rounded-xl border border-sand/30 bg-white">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 p-3 text-start"
      >
        {open ? <ChevronDown size={16} className="text-charcoal/40" /> : <ChevronRight size={16} className="text-charcoal/40" />}
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1 font-bold text-sm text-charcoal truncate">
            <Calculator size={13} className="text-copper shrink-0" />
            {fieldLabel}
          </span>
          <span className="block text-[11px] text-charcoal/50">
            {isAr ? `${results.length} وحدة · يحسبها الذكاء` : `${results.length} units · AI-counted`}
          </span>
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-1.5 max-h-[40vh] overflow-y-auto">
          {results.map((r, i) => (
            <div key={r.rowIndex} className="flex items-center gap-2 p-2 rounded-lg border border-sand/20">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-charcoal truncate">
                  {rowLabel(r.rowIndex) || (isAr ? `صف ${r.rowIndex + 1}` : `Row ${r.rowIndex + 1}`)}
                </div>
                {r.reason && (
                  <div className="text-[10px] text-charcoal/40 truncate" title={r.reason}>
                    {r.reason}
                  </div>
                )}
              </div>
              <input
                type="number"
                min={0}
                value={r.count}
                onChange={(e) => setCount(i, Math.max(0, Math.round(Number(e.target.value) || 0)))}
                className="form-input w-16 text-sm py-1 text-center shrink-0"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
