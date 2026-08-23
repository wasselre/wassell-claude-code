// A two-handle range slider: one thumb is the min, the other the max, dragged
// along a single bar. Built on two overlaid native <input type="range"> so it's
// accessible + touch-friendly with no dependency. The bar is always LTR (min on
// the left, max on the right) in every language; labels stay localized.

import { useId } from 'react';

interface DualRangeSliderProps {
  /** Bar bounds (the full data range). */
  min: number;
  max: number;
  step?: number;
  /** Current selected [low, high]. */
  low: number;
  high: number;
  onChange: (low: number, high: number) => void;
  label?: string;
  /** Format a value for the min/max readout (e.g. thousands separators + unit). */
  format?: (n: number) => string;
  /** Localize the small "min"/"max" end captions. */
  isAr?: boolean;
  /** Override the outer width/layout (default is a fixed toolbar width). */
  className?: string;
}

export default function DualRangeSlider({ min, max, step = 1, low, high, onChange, label, format, isAr = false, className }: DualRangeSliderProps) {
  const uid = useId().replace(/[:]/g, '');
  const fmt = format ?? ((n: number) => n.toLocaleString('en-US'));
  const span = max - min;
  const disabled = !(span > 0);
  // Clamp + keep the handles ordered.
  const lo = Math.min(Math.max(low, min), max);
  const hi = Math.min(Math.max(high, min), max);
  const pct = (v: number) => (span > 0 ? ((v - min) / span) * 100 : 0);

  const setLow = (v: number) => onChange(Math.min(v, hi), hi);
  const setHigh = (v: number) => onChange(lo, Math.max(v, lo));

  const cls = `drs-${uid}`;
  return (
    <div className={className ?? 'w-full sm:w-64'}>
      <style>{`
        .${cls}{position:relative;height:20px}
        .${cls} input[type=range]{-webkit-appearance:none;appearance:none;position:absolute;top:0;left:0;width:100%;height:20px;margin:0;background:transparent;pointer-events:none}
        .${cls} input[type=range]:focus{outline:none}
        .${cls} input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;pointer-events:auto;height:16px;width:16px;border-radius:9999px;background:#B8734F;border:2px solid #fff;box-shadow:0 0 0 1px rgba(74,78,84,.25);cursor:pointer}
        .${cls} input[type=range]::-moz-range-thumb{pointer-events:auto;height:16px;width:16px;border-radius:9999px;background:#B8734F;border:2px solid #fff;box-shadow:0 0 0 1px rgba(74,78,84,.25);cursor:pointer}
        .${cls} input[type=range]:disabled::-webkit-slider-thumb{background:#c8b79f;cursor:not-allowed}
        .${cls} input[type=range]:disabled::-moz-range-thumb{background:#c8b79f;cursor:not-allowed}
      `}</style>
      {(label || true) && (
        <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
          <span className="font-semibold text-charcoal/60">{label}</span>
          <span dir="ltr" className="font-bold text-charcoal/85">{fmt(lo)} — {fmt(hi)}</span>
        </div>
      )}
      <div className={cls} dir="ltr">
        {/* Track + selected fill — inset by the thumb radius (8px) so the colored
            bar lines up with the thumb CENTERS. Native thumbs stay inside their
            input box, travelling 8px…(width−8px), so a full-width bar would drift
            out of line at both ends and let the end thumbs clip. */}
        <div className="pointer-events-none absolute left-2 right-2 top-1/2 h-1 -translate-y-1/2 rounded-full bg-sand/70" />
        {!disabled && (
          <div
            className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-copper"
            style={{
              left: `calc(8px + (100% - 16px) * ${pct(lo) / 100})`,
              width: `calc((100% - 16px) * ${Math.max(0, pct(hi) - pct(lo)) / 100})`,
            }}
          />
        )}
        {/* Low handle (kept below the high handle in DOM so an overlap still lets
            you grab the high one; low stays reachable everywhere else). */}
        <input
          type="range" min={min} max={max} step={step} value={lo} disabled={disabled}
          onChange={(e) => setLow(Number(e.target.value))}
          aria-label={label ? `${label} — min` : 'min'}
          style={{ zIndex: lo >= hi ? 5 : 3 }}
        />
        <input
          type="range" min={min} max={max} step={step} value={hi} disabled={disabled}
          onChange={(e) => setHigh(Number(e.target.value))}
          aria-label={label ? `${label} — max` : 'max'}
          style={{ zIndex: 4 }}
        />
      </div>
      {/* Which end is which — left is the minimum, right is the maximum. */}
      <div dir="ltr" className="mt-0.5 flex justify-between text-[9px] font-medium uppercase tracking-wide text-charcoal/40">
        <span>{isAr ? 'الأدنى' : 'Min'}</span>
        <span>{isAr ? 'الأقصى' : 'Max'}</span>
      </div>
    </div>
  );
}
