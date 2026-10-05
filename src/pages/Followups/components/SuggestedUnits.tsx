// The units of one project that FULLY match the client's request, shown inline
// under a Finder card (operator, 2026-10-05). Only AVAILABLE units — sold and
// reserved never appear — and only units meeting EVERY requested criterion
// (type, bedrooms, budget, size; missing data counts as not meeting it), cheapest
// first: 3 shown, «Show all matching units» expands in place. It used to rank
// every unsold unit by a score and show the top 3, so a reserved unit at 60% or
// a partial fit could appear. Units already live in the browser store, so this is
// a pure client-side read (matchingUnits in unitScore.ts); it never changes the
// project's own match.
import { useMemo, useState } from 'react';
import { BedDouble, Bath, Ruler, Layers } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { unitsForProject, resolveUnitView } from '@/lib/projects/unitView';
import { matchingUnits } from '@/lib/matching/unitScore';
import type { MatchRequirementsInput } from '@/lib/matching/requirements';
import type { FinderMatch } from '@/lib/matching/projectFinder';

const fmtNum = (n: number) => n.toLocaleString('en-US');
const FIRST = 3;

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
  const [showAll, setShowAll] = useState(false);

  // Units link to All Projects. all_projects cards use their own id; our_projects
  // cards resolve to their master All-Projects link (`project`) — same rule as
  // ProjectUnitsModal, so the inline list and the full popup read the same set.
  const allProjectId = useMemo(() => {
    if (item.source !== 'our_projects') return item.project_id;
    const our = models.find((m) => m.name === 'our_projects');
    const rec = our ? (records[our.id] ?? []).find((r) => r.id === item.project_id) : null;
    const master = (rec?.data as Record<string, unknown> | undefined)?.project;
    const id = Array.isArray(master) ? master[0] : master;
    return typeof id === 'string' && id ? id : item.project_id;
  }, [item.source, item.project_id, models, records]);

  const { matching, total } = useMemo(() => {
    const store = { models, records };
    const raw = unitsForProject(store, allProjectId);
    if (raw.length === 0) return { matching: [], total: 0 };
    const views = raw.map((r) => resolveUnitView(store, r, { isAr }));
    return { matching: matchingUnits(views, requirements), total: views.length };
  }, [models, records, allProjectId, requirements, isAr]);

  if (total === 0) return null;
  const shown = showAll ? matching : matching.slice(0, FIRST);

  return (
    <div className="space-y-1.5 rounded-lg border border-sand/40 bg-cream/20 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold text-charcoal/70">
          {L(`الوحدات المطابقة لطلب العميل (${matching.length}) — المتاحة فقط`, `Units matching the request (${matching.length}) — available only`)}
        </span>
        {onSeeAll && (
          <button type="button" onClick={onSeeAll} className="shrink-0 text-[11px] font-semibold text-copper hover:underline">
            {L(`كل وحدات المشروع (${total})`, `All project units (${total})`)}
          </button>
        )}
      </div>
      {matching.length === 0 && (
        <p className="text-[11px] text-charcoal/55">{L('لا توجد وحدة متاحة تطابق كل طلبات العميل في هذا المشروع.', 'No available unit in this project meets every part of the request.')}</p>
      )}
      {shown.map((unit) => {
        const cur = L('ر.س', 'SAR');
        const price = unit.totalPrice != null ? `${fmtNum(unit.totalPrice)} ${cur}` : null;
        const area = unit.area != null ? `${fmtNum(unit.area)} ${L('م²', 'm²')}` : null;
        const label = unit.code || unit.unitNumber || L('وحدة', 'Unit');
        const type = unit.type ? (isAr ? unit.type.label_ar : unit.type.label_en) : null;
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
            {price && <span className="ms-auto font-semibold text-charcoal">{price}</span>}
          </div>
        );
      })}
      {matching.length > FIRST && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="text-[11px] font-semibold text-copper hover:underline">
          {showAll ? L('أظهر أول ٣', 'Show the first 3') : L(`أظهر كل الوحدات المطابقة (${matching.length})`, `Show all matching units (${matching.length})`)}
        </button>
      )}
    </div>
  );
}
