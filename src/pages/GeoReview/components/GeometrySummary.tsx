import { MapPin, Ban } from 'lucide-react';
import { describeLocationItem, type LocationItem } from '@/lib/geo/locationItems';
import type { GeometrySummaryEntry } from '../lib/types';

/**
 * Resolved geography for the proposal: the location-item chips it would add
 * (exactly what an apply writes — the server computes these with the same mapping
 * used on confirm) plus a per-shape resolution summary (operation, resolved
 * element ids, radius/band). A textual summary rather than the live map picker,
 * which is an editor for a client's own items, not a read-only proposal preview.
 */
export default function GeometrySummary({
  items,
  geometry,
  isAr,
}: {
  items: LocationItem[];
  geometry: GeometrySummaryEntry[];
  isAr: boolean;
}) {
  return (
    <div className="space-y-3">
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {items.map((it) => {
            const exclude = it.polarity === 'exclude';
            return (
              <span
                key={it.id}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold ${
                  exclude ? 'bg-red-50 text-red-600' : 'bg-copper/10 text-copper'
                }`}
              >
                {exclude ? <Ban size={12} /> : <MapPin size={12} />}
                {describeLocationItem(it, isAr)}
              </span>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-charcoal/50">
          {isAr ? 'لم تُترجم أي معايير موقعية قابلة للتطبيق.' : 'No applicable location rules were resolved.'}
        </p>
      )}

      {geometry.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-xs">
            <thead>
              <tr className="text-charcoal/45">
                <th className="border-b border-sand/30 py-1.5 text-start font-bold">{isAr ? 'العملية' : 'Operation'}</th>
                <th className="border-b border-sand/30 py-1.5 text-start font-bold">{isAr ? 'العناصر' : 'Elements'}</th>
                <th className="border-b border-sand/30 py-1.5 text-start font-bold">{isAr ? 'النطاق' : 'Radius/band'}</th>
                <th className="border-b border-sand/30 py-1.5 text-start font-bold">{isAr ? 'القوة' : 'Strength'}</th>
              </tr>
            </thead>
            <tbody>
              {geometry.map((g, i) => (
                <tr key={i} className="text-charcoal/70">
                  <td className="border-b border-sand/15 py-1.5">
                    <span className={g.polarity === 'exclude' ? 'text-red-600' : ''}>
                      {g.polarity === 'exclude' ? '¬ ' : ''}{g.operation}
                    </span>
                    {g.label ? <span className="text-charcoal/40"> · {g.label}</span> : null}
                  </td>
                  <td className="border-b border-sand/15 py-1.5 font-mono text-[11px]">{g.element_ids.join(', ') || '—'}</td>
                  <td className="border-b border-sand/15 py-1.5">{g.radius_m != null ? `${Math.round((g.radius_m / 1000) * 10) / 10} ${isAr ? 'كم' : 'km'}` : '—'}</td>
                  <td className="border-b border-sand/15 py-1.5">{g.group_strength}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
