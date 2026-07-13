import { useState, useMemo } from 'react';
import { CalendarClock } from 'lucide-react';

/**
 * Shared "schedule send" popover — quick presets (in 1 hour / tonight 8 PM /
 * tomorrow 10 AM / tomorrow 8 PM) + a custom datetime picker. Confirms with a
 * future ISO datetime (`deliverAt`) that Haberchat's delivery queue honors.
 *
 * Used by every send surface: the open-chat Composer, StartChatModal (new
 * conversations — incl. the Project Finder / Client Options / advertiser
 * flows), and SendDocumentModal. Render inside a `relative` wrapper anchored
 * to the trigger button; `align` picks which edge it grows from.
 */

/** Format a deliverAt for toasts / strip rows — localized date + time. */
export function formatScheduleTime(iso: string, isAr: boolean): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const isTomorrow = d.toDateString() === tomorrow.toDateString();
    const time = new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', { timeStyle: 'short' }).format(d);
    if (sameDay) return isAr ? `اليوم ${time}` : `today at ${time}`;
    if (isTomorrow) return isAr ? `غدًا ${time}` : `tomorrow at ${time}`;
    const date = new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
    return date;
  } catch {
    return iso;
  }
}

/** Local-time "YYYY-MM-DDTHH:mm" for <input type="datetime-local">. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SchedulePopover({
  isAr,
  onClose,
  onConfirm,
  align = 'end',
}: {
  isAr: boolean;
  onClose: () => void;
  onConfirm: (iso: string) => void;
  /** Which edge of the anchored wrapper the popover hugs. */
  align?: 'start' | 'end';
}) {
  // Default the custom picker to one hour from now.
  const [customValue, setCustomValue] = useState(() => {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setSeconds(0, 0);
    return toLocalInputValue(d);
  });

  const presets = useMemo(() => {
    const now = new Date();
    const list: Array<{ key: string; label: string; date: Date }> = [];

    const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
    list.push({ key: '1h', label: isAr ? 'بعد ساعة' : 'In 1 hour', date: inOneHour });

    const tonight = new Date(now);
    tonight.setHours(20, 0, 0, 0);
    if (tonight.getTime() > now.getTime() + 5 * 60 * 1000) {
      list.push({ key: 'tonight', label: isAr ? 'مساء اليوم 8:00' : 'Tonight 8:00 PM', date: tonight });
    }

    const tomorrowMorning = new Date(now);
    tomorrowMorning.setDate(now.getDate() + 1);
    tomorrowMorning.setHours(10, 0, 0, 0);
    list.push({ key: 'tm-am', label: isAr ? 'غدًا صباحًا 10:00' : 'Tomorrow 10:00 AM', date: tomorrowMorning });

    const tomorrowEvening = new Date(now);
    tomorrowEvening.setDate(now.getDate() + 1);
    tomorrowEvening.setHours(20, 0, 0, 0);
    list.push({ key: 'tm-pm', label: isAr ? 'غدًا مساءً 8:00' : 'Tomorrow 8:00 PM', date: tomorrowEvening });

    return list;
  }, [isAr]);

  const confirm = (d: Date) => {
    onConfirm(d.toISOString());
  };

  const customDate = new Date(customValue);
  const customValid = !Number.isNaN(customDate.getTime()) && customDate.getTime() > Date.now() + 60 * 1000;

  return (
    <>
      {/* Click-outside overlay */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className={`absolute bottom-full mb-2 z-50 w-64 bg-white rounded-xl shadow-lg border border-sand/30 p-3 ${
          align === 'end' ? 'end-0' : 'start-0'
        }`}
      >
        <div className="flex items-center gap-1.5 text-xs font-bold text-chocolate mb-2">
          <CalendarClock size={13} className="text-copper" />
          {isAr ? 'جدولة الإرسال' : 'Schedule send'}
        </div>
        <div className="flex flex-col gap-1">
          {presets.map((p) => (
            <button
              key={p.key}
              onClick={() => confirm(p.date)}
              className="w-full text-start text-xs px-2.5 py-1.5 rounded-lg hover:bg-cream/70 text-charcoal transition-colors flex items-center justify-between gap-2"
              type="button"
            >
              <span>{p.label}</span>
              <span className="text-[10px] text-charcoal/40" dir="ltr">
                {new Intl.DateTimeFormat(isAr ? 'ar-SA' : 'en-US', { timeStyle: 'short' }).format(p.date)}
              </span>
            </button>
          ))}
        </div>
        <div className="border-t border-sand/30 mt-2 pt-2">
          <label className="block text-[10px] font-medium text-charcoal/60 mb-1">
            {isAr ? 'أو اختر وقتًا محددًا' : 'Or pick a specific time'}
          </label>
          <input
            type="datetime-local"
            value={customValue}
            min={toLocalInputValue(new Date(Date.now() + 2 * 60 * 1000))}
            onChange={(e) => setCustomValue(e.target.value)}
            className="w-full text-xs border border-sand rounded-lg px-2 py-1.5 text-charcoal focus:outline-none focus:border-copper"
            dir="ltr"
          />
          <button
            onClick={() => customValid && confirm(customDate)}
            disabled={!customValid}
            className="mt-2 w-full text-xs font-bold rounded-lg px-3 py-1.5 bg-copper text-white hover:bg-terracotta disabled:bg-charcoal/20 disabled:cursor-not-allowed transition-colors"
            type="button"
          >
            {isAr ? 'جدولة' : 'Schedule'}
          </button>
          {!customValid && (
            <p className="text-[10px] text-charcoal/40 mt-1">
              {isAr ? 'اختر وقتًا في المستقبل' : 'Pick a time in the future'}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
