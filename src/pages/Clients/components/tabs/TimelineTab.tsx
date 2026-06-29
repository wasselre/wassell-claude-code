import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, CircleDot } from 'lucide-react';
import { buildClientTimeline, type ClientView, type ClientViewCtx, type TimelineItem } from '../../lib/clientView';
import { formatDate, formatDateTime } from '../../lib/lifecycleDisplay';

interface TimelineTabProps {
  view: ClientView;
  ctx: ClientViewCtx;
  isAr: boolean;
}

/** Group key for a timeline item — its localized day, or "Undated". */
function dayKey(item: TimelineItem, isAr: boolean): string {
  const d = formatDate(item.date, isAr);
  return d ?? (isAr ? 'بدون تاريخ' : 'Undated');
}

/** Chronological cross-model activity stream, grouped by day. Read-only; each
 *  item opens its source record. WhatsApp is on its own tab (excluded here). */
export default function TimelineTab({ view, ctx, isAr }: TimelineTabProps) {
  const navigate = useNavigate();
  const items = useMemo(() => buildClientTimeline(ctx, view.id), [ctx, view.id]);
  const Chevron = isAr ? ChevronLeft : ChevronRight;

  if (items.length === 0) {
    return (
      <div className="card p-10 text-center text-sm text-charcoal/50">
        {isAr ? 'لا توجد سجلات مرتبطة محمّلة لهذا العميل.' : 'No related records loaded for this client.'}
      </div>
    );
  }

  // Preserve the resolver's newest-first order while grouping by day.
  const groups: { key: string; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const key = dayKey(item, isAr);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, items: [item] });
  }

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <div key={group.key}>
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-charcoal/40">{group.key}</h4>
          <div className="space-y-2">
            {group.items.map((item) => (
              <button
                key={`${item.modelName}-${item.id}`}
                type="button"
                onClick={() => navigate(item.href)}
                className="card flex w-full items-start gap-3 p-3.5 text-start transition hover:shadow-md"
              >
                <CircleDot size={16} className="mt-0.5 shrink-0 text-copper" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-chocolate">{item.typeLabel}</span>
                    {item.status && (
                      <span className="rounded-full bg-charcoal/8 px-2 py-0.5 text-[11px] font-semibold text-charcoal/70">{item.status}</span>
                    )}
                  </div>
                  {item.summary && <p className="mt-0.5 line-clamp-2 text-sm text-charcoal/70">{item.summary}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-charcoal/45">
                    <span>{formatDateTime(item.date, isAr) ?? (isAr ? 'بدون تاريخ' : 'Undated')}</span>
                    {item.ownerName && (
                      <>
                        <span className="text-charcoal/25">•</span>
                        <span>{item.ownerName}</span>
                      </>
                    )}
                  </div>
                </div>
                <Chevron size={16} className="mt-0.5 shrink-0 text-charcoal/30" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
