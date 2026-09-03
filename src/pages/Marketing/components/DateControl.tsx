/**
 * The shared marketing date control: period segments + prev/next stepper +
 * a custom-range picker. It is the single surface that answers "which dates am
 * I looking at?" across the Overview and the Analytics page — so past periods
 * and arbitrary ranges are reachable everywhere the same way.
 *
 * Controlled: the parent owns the `DateSel` and passes it back to the API.
 */
import { useEffect, useRef, useState } from 'react';
import {
  DateSel, SelPeriod,
  shiftAnchor, todayIso, windowContainsToday, windowLabel, windowOf, ymd,
} from '../lib/period';
import '../styles/analytics.css';

const PERIOD_LABEL: Record<SelPeriod, { ar: string; en: string }> = {
  week: { ar: 'أسبوع', en: 'Week' },
  month: { ar: 'شهر', en: 'Month' },
  quarter: { ar: 'ربع', en: 'Quarter' },
  year: { ar: 'سنة', en: 'Year' },
  custom: { ar: 'مخصّص', en: 'Custom' },
};

export default function DateControl({
  sel, periods, isAr, onChange, showCustom = true,
}: {
  sel: DateSel;
  periods: SelPeriod[];
  isAr: boolean;
  onChange: (s: DateSel) => void;
  showCustom?: boolean;
}) {
  const [popOpen, setPopOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const win = windowOf(sel);
  const [cFrom, setCFrom] = useState(ymd(win.from));
  const [cTo, setCTo] = useState(ymd(new Date(win.to.getTime() - 86_400_000)));

  useEffect(() => {
    if (!popOpen) return;
    const onDoc = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setPopOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [popOpen]);

  const label = windowLabel(sel, isAr);
  const atPresent = windowContainsToday(sel) || windowOf(sel).from > new Date();

  const pickPeriod = (p: SelPeriod): void => {
    // Switching period re-anchors to now (the current window of that period).
    onChange({ period: p, anchorIso: todayIso() });
  };
  const applyPreset = (days: number): void => {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    setCFrom(ymd(from));
    setCTo(ymd(to));
  };
  const applyCustom = (): void => {
    if (!cFrom || !cTo) return;
    onChange({ period: 'custom', anchorIso: todayIso(), from: cFrom, to: cTo });
    setPopOpen(false);
  };

  return (
    <div className="datectl">
      <div className="stepper">
        <button type="button" title={isAr ? 'الفترة السابقة' : 'Previous'} onClick={() => onChange(shiftAnchor(sel, -1))}>‹</button>
        <div className="rangelbl">
          <div className="m" style={{ fontVariantNumeric: 'tabular-nums' }}>{label.main}</div>
          <div className="s">{label.sub}</div>
        </div>
        <button
          type="button"
          title={isAr ? 'الفترة التالية' : 'Next'}
          disabled={atPresent}
          onClick={() => { if (!atPresent) onChange(shiftAnchor(sel, 1)); }}
        >›</button>
      </div>

      <div className="seg" role="tablist">
        {periods.map((p) => (
          <button
            key={p}
            type="button"
            className={sel.period === p ? 'on' : ''}
            onClick={() => pickPeriod(p)}
          >
            {isAr ? PERIOD_LABEL[p].ar : PERIOD_LABEL[p].en}
          </button>
        ))}
      </div>

      {showCustom && (
        <div className="pop-wrap" ref={popRef}>
          <button
            type="button"
            className={`rangebtn${sel.period === 'custom' ? ' on' : ''}`}
            onClick={() => setPopOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" />
            </svg>
            {isAr ? 'نطاق مخصّص' : 'Custom range'}
          </button>
          {popOpen && (
            <div className="pop">
              <div className="presets">
                <button type="button" onClick={() => applyPreset(7)}>{isAr ? 'آخر ٧ أيام' : 'Last 7 days'}</button>
                <button type="button" onClick={() => applyPreset(30)}>{isAr ? 'آخر ٣٠ يوماً' : 'Last 30 days'}</button>
                <button type="button" onClick={() => applyPreset(90)}>{isAr ? 'آخر ٩٠ يوماً' : 'Last 90 days'}</button>
              </div>
              <label>{isAr ? 'من' : 'From'}</label>
              <input type="date" value={cFrom} max={cTo} onChange={(e) => setCFrom(e.target.value)} />
              <label>{isAr ? 'إلى' : 'To'}</label>
              <input type="date" value={cTo} min={cFrom} onChange={(e) => setCTo(e.target.value)} />
              <button type="button" className="apply" onClick={applyCustom}>{isAr ? 'تطبيق' : 'Apply'}</button>
            </div>
          )}
        </div>
      )}

      <button type="button" className="today" onClick={() => onChange({ period: sel.period === 'custom' ? 'month' : sel.period, anchorIso: todayIso() })}>
        {isAr ? 'اليوم' : 'Today'}
      </button>
    </div>
  );
}
