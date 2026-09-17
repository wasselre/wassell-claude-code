// The best-fitting UNITS of one project, shown inline under a Finder card. The
// finder ranks PROJECTS (server-side, from rollup ranges); this ranks the units
// INSIDE the project against the same client requirements and surfaces the top 3
// — so the rep sees concrete units to offer, not just the project's aggregate
// ranges. Units already live in the browser store (the SPA loads them all), so
// this is a pure client-side read + the deterministic scoreUnit ranker; it never
// touches the server and never changes the project's own match.

import { useMemo } from 'react';
import { BedDouble, Bath, Ruler, Layers } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { unitsForProject, resolveUnitView } from '@/lib/projects/unitView';
import { rankUnits } from '@/lib/matching/unitScore';
import type { MatchRequirementsInput } from '@/lib/matching/requirements';
import type { FinderMatch } from '@/lib/matching/projectFinder';

const fmtNum = (n: number) => n.toLocaleString('en-US');

/** Band → pill classes (matches the card's badge palette). */
const BAND_CLS: Record<string, string> = {
  strong: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  good: 'bg-copper/10 text-copper border-copper/30',
  partial: 'bg-sand/40 text-charcoal/60 border-sand/60',
};

export default function SuggestedUnits({
  item, requirements, isAr, onSeeAll,
}: {
  item: FinderMatch;
  requirements: MatchRequirementsInput;
  isAr: boolean;
  /** Open the full units popup (the existing ProjectUnitsModal). */
  onSeeAll?: () => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  // Units link to All Projects. all_projects cards use their own id; our_projects
  // cards resolve to their master All-Projects link (`project`) — same rule as
  // ProjectUnitsModal, so the inline preview and the full popup show the same set.
  const allProjectId = useMemo(() => {
    if (item.source !== 'our_projects') return item.project_id;
    const our = models.find((m) => m.name === 'our_projects');
    const rec = our ? (records[our.id] ?? []).find((r) => r.id === item.project_id) : null;
    const master = (rec?.data as Record<string, unknown> | undefined)?.project;
    const id = Array.isArray(master) ? master[0] : master;
    return typeof id === 'string' && id ? id : item.project_id;
  }, [item.source, item.project_id, models, records]);

  const { top, total } = useMemo(() => {
    const store = { models, records };
    const raw = unitsForProject(store, allProjectId);
    if (raw.length === 0) return { top: [], total: 0 };
    const views = raw.map((r) => resolveUnitView(store, r, { isAr }));
    const offerable = views.filter((u) => u.status?.value !== 'sold');
    return { top: rankUnits(views, requirements, 3), total: offerable.length };
  }, [models, records, allProjectId, requirements, isAr]);

  if (top.length === 0) return null;

  return (
    <div className="space-y-1.5 rounded-lg border border-sand/40 bg-cream/20 p-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-charcoal/70">{L('أفضل الوحدات المقترحة', 'Suggested units')}</span>
        {onSeeAll && total > top.length && (
          <button type="button" onClick={onSeeAll} className="text-[11px] font-semibold text-copper hover:underline">
            {L(`كل الوحدات (${total})`, `All units (${total})`)}
          </button>
        )}
      </div>
      {top.map(({ unit, score, band }) => {
        const cur = L('ر.س', 'SAR');
        const price = unit.totalPrice != null ? `${fmtNum(unit.totalPrice)} ${cur}` : null;
        const area = unit.area != null ? `${fmtNum(unit.area)} ${L('م²', 'm²')}` : null;
        const label = unit.code || unit.unitNumber || L('وحدة', 'Unit');
        const type = unit.type ? (isAr ? unit.type.label_ar : unit.type.label_en) : null;
        const statusLabel = unit.status ? (isAr ? unit.status.label_ar : unit.status.label_en) : null;
        return (
          <div key={unit.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-sand/40 bg-white px-2 py-1.5 text-[11px] text-charcoal/80">
            <span className="font-bold text-charcoal">{label}</span>
            {type && <span className="text-charcoal/60">{type}</span>}
            {unit.bedrooms != null && (
              <span className="inline-flex items-center gap-0.5"><BedDouble size={11} className="text-copper" />{unit.bedrooms}</span>
            )}
            {unit.bathrooms != null && (
              <span className="inline-flex items-center gap-0.5"><Bath size={11} className="text-copper" />{unit.bathrooms}</span>
            )}
            {area && (
              <span className="inline-flex items-center gap-0.5"><Ruler size={11} className="text-copper" />{area}</span>
            )}
            {unit.floor && (
              <span className="inline-flex items-center gap-0.5"><Layers size={11} className="text-copper" />{isAr ? unit.floor.label_ar : unit.floor.label_en}</span>
            )}
            {price && <span className="font-semibold text-charcoal">{price}</span>}
            {statusLabel && (
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                style={unit.status?.color ? { color: unit.status.color, backgroundColor: `${unit.status.color}18` } : undefined}
              >
                {statusLabel}
              </span>
            )}
            {/* Fit badge — same idea as the project's band chip, at the unit level. */}
            <span className={`ms-auto rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${BAND_CLS[band] ?? BAND_CLS.partial}`}
              title={L('مدى ملاءمة الوحدة لمتطلبات العميل', 'How well this unit fits the client requirements')}>
              {score}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
