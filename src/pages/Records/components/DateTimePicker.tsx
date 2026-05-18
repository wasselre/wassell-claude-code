import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

/**
 * Wassel-branded date / datetime picker. Replaces the browser-native
 * `<input type="date">` / `<input type="datetime-local">` everywhere a
 * record field is edited.
 *
 * Visual contract (matches the brief screenshot):
 * - Input row: calendar icon + formatted value, opens a popover on click
 * - Popover: month/year header with prev/next chevrons in copper,
 *   weekday labels in copper, calendar grid with selected day rendered as
 *   a filled copper circle and today's day rendered in copper text
 * - For datetime mode: hour/minute spinners + صباحاً/مساءً (AM/PM) toggle
 *
 * Storage shape matches the previous native inputs so downstream code
 * (filters, formula engine, workflow tokens, dateFormat.ts) stays correct:
 *   mode='date'     → 'YYYY-MM-DD'
 *   mode='datetime' → 'YYYY-MM-DDTHH:MM'
 *
 * RTL: the calendar grid relies on the document's `dir` attribute so that
 * weekday columns flow Sunday-on-the-right when Arabic is active. Saudi
 * weeks start on Sunday — we don't shift the grid.
 */

type Mode = 'date' | 'datetime';

interface DateTimePickerProps {
  value: string | null | undefined;
  onChange: (next: string) => void;
  mode: Mode;
  placeholder?: string;
}

interface ParsedValue {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  hour: number;  // 0-23
  minute: number; // 0-59
}

const MONTH_NAMES_AR = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
] as const;

const MONTH_NAMES_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

// Weekday labels — index 0 = Sunday (Saudi week starts on Sunday).
const WEEKDAY_NAMES_AR = ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'] as const;
const WEEKDAY_NAMES_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parseValue(raw: string | null | undefined): ParsedValue | null {
  if (!raw) return null;
  // Accept both 'YYYY-MM-DD' and 'YYYY-MM-DDTHH:MM[:SS]'
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10);
  const day = parseInt(m[3]!, 10);
  const hour = m[4] ? parseInt(m[4], 10) : 0;
  const minute = m[5] ? parseInt(m[5], 10) : 0;
  if (
    Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day) ||
    Number.isNaN(hour) || Number.isNaN(minute)
  ) return null;
  return { year, month, day, hour, minute };
}

function serialize(p: ParsedValue, mode: Mode): string {
  const date = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  if (mode === 'date') return date;
  return `${date}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

function todayParts(): ParsedValue {
  const d = new Date();
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
  };
}

interface DayCell {
  day: number;
  month: number;
  year: number;
  /** True if the cell belongs to the prev/next month (faded). */
  outside: boolean;
}

/**
 * Build the 6×7 grid of day cells for a given view month, starting on
 * Sunday. Always returns 42 cells so the popover layout is stable.
 */
function buildCalendarGrid(viewYear: number, viewMonth: number): DayCell[] {
  const firstOfMonth = new Date(viewYear, viewMonth - 1, 1);
  const firstWeekday = firstOfMonth.getDay(); // 0=Sun
  const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();

  // Lead-in: the last `firstWeekday` days of the previous month.
  const prevMonthDays = new Date(viewYear, viewMonth - 1, 0).getDate();
  const cells: DayCell[] = [];
  for (let i = firstWeekday - 1; i >= 0; i--) {
    const day = prevMonthDays - i;
    const m = viewMonth === 1 ? 12 : viewMonth - 1;
    const y = viewMonth === 1 ? viewYear - 1 : viewYear;
    cells.push({ day, month: m, year: y, outside: true });
  }

  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, month: viewMonth, year: viewYear, outside: false });
  }

  // Trail: fill out to 42 cells with next-month days.
  let nextDay = 1;
  while (cells.length < 42) {
    const m = viewMonth === 12 ? 1 : viewMonth + 1;
    const y = viewMonth === 12 ? viewYear + 1 : viewYear;
    cells.push({ day: nextDay++, month: m, year: y, outside: true });
  }
  return cells;
}

export default function DateTimePicker({ value, onChange, mode, placeholder }: DateTimePickerProps) {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const monthNames = isAr ? MONTH_NAMES_AR : MONTH_NAMES_EN;
  const weekdayNames = isAr ? WEEKDAY_NAMES_AR : WEEKDAY_NAMES_EN;

  const parsed = parseValue(value);
  const today = todayParts();

  // The month the popover is currently displaying. Defaults to the value's
  // month, falling back to today.
  const [viewYear, setViewYear] = useState(parsed?.year ?? today.year);
  const [viewMonth, setViewMonth] = useState(parsed?.month ?? today.month);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // When the external value changes (e.g. via a "today" shortcut elsewhere),
  // pull the view month to wherever the new value is so the user sees the
  // selection on the next open.
  useEffect(() => {
    if (parsed) {
      setViewYear(parsed.year);
      setViewMonth(parsed.month);
    }
    // We intentionally key off the raw string so a no-op re-render of the
    // same value doesn't snap the calendar view away from where the user is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const cells = useMemo(() => buildCalendarGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  const isToday = (c: DayCell) =>
    c.year === today.year && c.month === today.month && c.day === today.day;

  const isSelected = (c: DayCell) =>
    !!parsed && c.year === parsed.year && c.month === parsed.month && c.day === parsed.day;

  const goPrevMonth = () => {
    if (viewMonth === 1) { setViewYear(viewYear - 1); setViewMonth(12); }
    else setViewMonth(viewMonth - 1);
  };
  const goNextMonth = () => {
    if (viewMonth === 12) { setViewYear(viewYear + 1); setViewMonth(1); }
    else setViewMonth(viewMonth + 1);
  };

  const pickDay = (c: DayCell) => {
    const base: ParsedValue = {
      year: c.year,
      month: c.month,
      day: c.day,
      hour: parsed?.hour ?? 0,
      minute: parsed?.minute ?? 0,
    };
    onChange(serialize(base, mode));
    if (c.outside) {
      setViewYear(c.year);
      setViewMonth(c.month);
    }
    if (mode === 'date') setOpen(false);
  };

  /** Update only the time portion. Requires a selected date — falls back to today. */
  const setTime = (hour24: number, minute: number) => {
    const base: ParsedValue = parsed ?? { ...today, hour: 0, minute: 0 };
    onChange(serialize({ ...base, hour: hour24, minute }, mode));
  };

  // 12-hour display values derived from stored 24-hour time.
  const hour24 = parsed?.hour ?? 0;
  const minute = parsed?.minute ?? 0;
  const isPm = hour24 >= 12;
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;

  const bumpHour = (delta: number) => {
    let next = hour24 + delta;
    if (next < 0) next = 23;
    if (next > 23) next = 0;
    setTime(next, minute);
  };
  const bumpMinute = (delta: number) => {
    let next = minute + delta;
    let h = hour24;
    if (next < 0) { next = 59; h = h === 0 ? 23 : h - 1; }
    if (next > 59) { next = 0; h = h === 23 ? 0 : h + 1; }
    setTime(h, next);
  };
  const setAmPm = (pm: boolean) => {
    if (pm === isPm) return;
    // Flip just the AM/PM bit while keeping the visible 12h hour the same.
    let next = hour24;
    if (pm && !isPm) next = hour24 + 12;
    else if (!pm && isPm) next = hour24 - 12;
    setTime(next, minute);
  };

  // Display text on the trigger input. For RTL we show time-then-date to
  // match the brief screenshot; for LTR we show date-then-time.
  const displayValue = (() => {
    if (!parsed) return '';
    const dateStr = `${parsed.year}-${pad2(parsed.month)}-${pad2(parsed.day)}`;
    if (mode === 'date') return dateStr;
    const timeStr = `${pad2(parsed.hour)}:${pad2(parsed.minute)}:00`;
    return isAr ? `${timeStr} ${dateStr}` : `${dateStr} ${timeStr}`;
  })();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="form-input flex items-center gap-3 text-start cursor-pointer"
      >
        <Calendar size={18} className="text-copper shrink-0" />
        {displayValue ? (
          <span className="flex-1 text-charcoal" dir="ltr">{displayValue}</span>
        ) : (
          <span className="flex-1 text-charcoal/30">{placeholder ?? ''}</span>
        )}
      </button>

      {open && (
        <div className="absolute z-30 mt-2 w-[320px] bg-white rounded-2xl border border-sand/40 shadow-[0_8px_32px_rgba(74,44,42,0.12)] p-4 animate-[fadeIn_0.12s_ease]">
          {/* Month header */}
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xl text-copper-500 font-bold">
              {monthNames[viewMonth - 1]} {viewYear !== today.year ? viewYear : ''}
            </h3>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={goNextMonth}
                className="p-1.5 rounded-md text-copper hover:bg-copper/10 transition-colors"
                aria-label={isAr ? 'الشهر التالي' : 'Next month'}
              >
                <ChevronRight size={18} className="rtl:hidden" />
                <ChevronLeft size={18} className="hidden rtl:inline" />
              </button>
              <button
                type="button"
                onClick={goPrevMonth}
                className="p-1.5 rounded-md text-copper hover:bg-copper/10 transition-colors"
                aria-label={isAr ? 'الشهر السابق' : 'Previous month'}
              >
                <ChevronLeft size={18} className="rtl:hidden" />
                <ChevronRight size={18} className="hidden rtl:inline" />
              </button>
            </div>
          </div>

          {/* Weekday labels */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {weekdayNames.map((w) => (
              <div
                key={w}
                className="text-center text-xs text-copper-500 font-bold py-1"
              >
                {w}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-1">
            {cells.map((c, i) => {
              const selected = isSelected(c);
              const todayFlag = isToday(c);
              const base = 'h-9 w-9 mx-auto flex items-center justify-center rounded-full text-sm transition-colors';
              let cls = base;
              if (selected) {
                cls += ' bg-copper text-white font-bold shadow-sm';
              } else if (todayFlag) {
                cls += ' text-copper font-bold hover:bg-copper/10';
              } else if (c.outside) {
                cls += ' text-charcoal/25 hover:bg-cream';
              } else {
                cls += ' text-charcoal hover:bg-cream';
              }
              return (
                <button
                  key={`${c.year}-${c.month}-${c.day}-${i}`}
                  type="button"
                  onClick={() => pickDay(c)}
                  className={cls}
                  dir="ltr"
                >
                  {c.day}
                </button>
              );
            })}
          </div>

          {mode === 'datetime' && (
            <div className="mt-4 pt-4 border-t border-sand/30 flex items-center justify-between gap-3">
              {/* Hour / minute spinners */}
              <div className="flex items-center gap-2" dir="ltr">
                <TimeSpinner value={pad2(hour12)} onUp={() => bumpHour(1)} onDown={() => bumpHour(-1)} />
                <span className="text-charcoal/60 font-bold pb-1">:</span>
                <TimeSpinner value={pad2(minute)} onUp={() => bumpMinute(1)} onDown={() => bumpMinute(-1)} />
              </div>

              {/* AM / PM toggle pill */}
              <div className="flex items-center bg-cream rounded-full p-0.5">
                <button
                  type="button"
                  onClick={() => setAmPm(true)}
                  className={`px-3 py-1 text-xs rounded-full transition-colors ${
                    isPm ? 'bg-copper text-white font-bold' : 'text-charcoal/60'
                  }`}
                >
                  {isAr ? 'مساءً' : 'PM'}
                </button>
                <button
                  type="button"
                  onClick={() => setAmPm(false)}
                  className={`px-3 py-1 text-xs rounded-full transition-colors ${
                    !isPm ? 'bg-copper text-white font-bold' : 'text-charcoal/60'
                  }`}
                >
                  {isAr ? 'صباحاً' : 'AM'}
                </button>
              </div>

              <span className="text-sm text-charcoal/70 font-bold shrink-0">
                {isAr ? 'الوقت' : 'Time'}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Tiny vertical up/down stepper used for the hour and minute fields.
 * Numbers display in LTR regardless of document direction so that "07"
 * never gets reordered as "70" by the bidi algorithm.
 */
function TimeSpinner({
  value,
  onUp,
  onDown,
}: {
  value: string;
  onUp: () => void;
  onDown: () => void;
}) {
  return (
    <div className="flex flex-col items-center select-none">
      <button
        type="button"
        onClick={onUp}
        className="text-charcoal/50 hover:text-copper transition-colors"
        aria-label="+"
      >
        <ChevronUp size={14} />
      </button>
      <span className="text-base font-bold text-charcoal min-w-[2ch] text-center" dir="ltr">
        {value}
      </span>
      <button
        type="button"
        onClick={onDown}
        className="text-charcoal/50 hover:text-copper transition-colors"
        aria-label="−"
      >
        <ChevronDown size={14} />
      </button>
    </div>
  );
}
