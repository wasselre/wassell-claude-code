import { MapPin } from 'lucide-react';
import type { ProposalView } from '../lib/types';

export default function ProposalList({
  proposals,
  selectedId,
  onSelect,
  isAr,
}: {
  proposals: ProposalView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  isAr: boolean;
}) {
  return (
    <ul className="space-y-1.5">
      {proposals.map((p) => {
        const active = p.id === selectedId;
        return (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onSelect(p.id)}
              className={`w-full rounded-xl border p-3 text-start transition-colors ${
                active ? 'border-copper bg-copper/10' : 'border-sand/30 bg-white hover:bg-cream/60'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-bold text-charcoal">
                  {p.client_name || (isAr ? 'عميل غير معروف' : 'Unknown client')}
                </span>
                {p.status === 'must_confirm' && (
                  <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                    {isAr ? 'تأكيد' : 'confirm'}
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-charcoal/45">
                <MapPin size={11} />
                <span>{p.preview_items.length} {isAr ? 'معيار' : 'rules'}</span>
                <span>· {new Date(p.created_at).toLocaleDateString(isAr ? 'ar' : 'en')}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
