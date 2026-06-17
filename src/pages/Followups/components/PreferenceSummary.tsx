import { SlidersHorizontal } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

interface PreferenceSummaryProps {
  client: Record<string, unknown> | null;
  /** Opens the full generic form (where the client_pref mirror section lives). */
  onEditFull: () => void;
}

function rangeStr(v: unknown): string | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const r = v as { min?: unknown; max?: unknown };
    const min = r.min != null ? String(r.min) : '';
    const max = r.max != null ? String(r.max) : '';
    if (!min && !max) return null;
    return `${min || '…'} – ${max || '…'}`;
  }
  return null;
}

function listStr(v: unknown): string | null {
  if (Array.isArray(v)) return v.length ? v.map(String).join('، ') : null;
  if (typeof v === 'string' && v.trim()) return v;
  return null;
}

/** Compact preferences — budget, area, neighborhoods, unit type, language. */
export default function PreferenceSummary({ client, onEditFull }: PreferenceSummaryProps) {
  const isAr = useAppStore((s) => s.language === 'ar');
  if (!client) return null;

  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | null) => { if (value) rows.push({ label, value }); };
  push(isAr ? 'الميزانية' : 'Budget', rangeStr(client.budget));
  push(isAr ? 'المساحة' : 'Area', rangeStr(client.preferred_area));
  push(isAr ? 'الأحياء' : 'Neighborhoods', listStr(client.preferred_neighborhoods));
  push(isAr ? 'نوع الوحدة' : 'Unit Type', listStr(client.preferred_unit_type));
  push(isAr ? 'المدينة' : 'City', listStr(client.preferred_city));
  push(isAr ? 'اللغة' : 'Language', listStr(client.preferred_language));

  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-chocolate">{isAr ? 'تفضيلات العميل' : 'Preferences'}</h2>
        <button type="button" onClick={onEditFull} className="inline-flex items-center gap-1 text-xs font-semibold text-copper hover:underline">
          <SlidersHorizontal size={13} /> {isAr ? 'تعديل التفضيلات الكاملة' : 'Edit Full Preferences'}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-terracotta">{isAr ? 'لا توجد تفضيلات مسجلة' : 'No preferences recorded'}</p>
      ) : (
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2.5 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-charcoal/60">{r.label}</dt>
              <dd className="text-end font-semibold text-chocolate">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
