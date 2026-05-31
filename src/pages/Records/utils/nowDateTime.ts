/**
 * "Now" (local wall-clock) serialized in the record date/datetime storage
 * shape — `'YYYY-MM-DD'` for date, `'YYYY-MM-DDTHH:MM'` for datetime. This is
 * the same contract `DateTimePicker` reads and writes (see its header), kept
 * here as a dependency-free util so non-UI callers — e.g. auto-stamping
 * موعد المتابعة الفعلي when a follow-up's call result is recorded — can produce
 * a value the picker reads back cleanly, without importing the component.
 */
export function nowDateTimeValue(mode: 'date' | 'datetime' = 'datetime'): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const d = new Date();
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (mode === 'date') return date;
  return `${date}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
