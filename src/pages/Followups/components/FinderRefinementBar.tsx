import { SlidersHorizontal, ArrowUpDown, RotateCcw, List, Map as MapIcon } from 'lucide-react';
import {
  SORT_LABELS, BEDROOM_OPTS, REFINE_DEFAULT, refineIsActive,
  type SortKey, type Refine,
} from '@/lib/matching/finderRefine';

export type FinderViewMode = 'list' | 'map';

/**
 * Results-refinement toolbar shared by the standalone Project Finder page and the
 * Follow-up "Suggested Projects" modal. Score slider + sort + a HARD-filter
 * "Refine" panel — all client-side over the already-fetched (≥ floor) set.
 */

interface Props {
  isAr: boolean;
  floor: number; // engine fetch floor (e.g. 70)
  scoreThreshold: number;
  onScore: (n: number) => void;
  sortKey: SortKey;
  onSort: (k: SortKey) => void;
  refine: Refine;
  onRefine: (r: Refine) => void;
  showRefine: boolean;
  onToggleRefine: () => void;
  refinedTotal: number;
  fetchedTotal: number;
  /** List/map results-view toggle. Omit both to hide the toggle entirely. */
  viewMode?: FinderViewMode;
  onViewMode?: (m: FinderViewMode) => void;
}

export default function FinderRefinementBar({
  isAr, floor, scoreThreshold, onScore, sortKey, onSort, refine, onRefine, showRefine, onToggleRefine,
  refinedTotal, fetchedTotal, viewMode, onViewMode,
}: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const numOrEmpty = (s: string): number | '' => (s === '' ? '' : Number(s));
  const ticks: number[] = [];
  for (let n = floor; n <= 100; n += 5) ticks.push(n);

  return (
    <div className="card mb-3 space-y-3 p-3">
      {/* Score slider */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-bold text-charcoal/70">{L('الحد الأدنى لنسبة التطابق', 'Minimum match score')}</span>
          <span className="rounded-md bg-copper/10 px-2 py-0.5 text-sm font-bold text-copper">{scoreThreshold}%+</span>
        </div>
        <input
          type="range"
          min={floor}
          max={100}
          step={5}
          value={scoreThreshold}
          onChange={(e) => onScore(Number(e.target.value))}
          className="w-full accent-copper"
          aria-label={L('الحد الأدنى لنسبة التطابق', 'Minimum match score')}
        />
        <div className="mt-0.5 flex justify-between px-0.5 text-[10px] text-charcoal/40">
          {ticks.map((n) => <span key={n}>{n}</span>)}
        </div>
      </div>

      {/* Count + sort + refine toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold text-charcoal/60">
          {L(`عرض ${refinedTotal} من ${fetchedTotal}`, `Showing ${refinedTotal} of ${fetchedTotal}`)}
        </span>
        <div className="ms-auto flex items-center gap-2">
          {viewMode && onViewMode && (
            <div className="flex items-center rounded-lg border border-sand/60 bg-white p-0.5">
              <button
                type="button"
                onClick={() => onViewMode('list')}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold transition ${
                  viewMode === 'list' ? 'bg-copper text-white' : 'text-charcoal/60 hover:bg-cream/60'
                }`}
                aria-pressed={viewMode === 'list'}
              >
                <List size={13} />
                {L('قائمة', 'List')}
              </button>
              <button
                type="button"
                onClick={() => onViewMode('map')}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold transition ${
                  viewMode === 'map' ? 'bg-copper text-white' : 'text-charcoal/60 hover:bg-cream/60'
                }`}
                aria-pressed={viewMode === 'map'}
              >
                <MapIcon size={13} />
                {L('خريطة', 'Map')}
              </button>
            </div>
          )}
          <ArrowUpDown size={13} className="text-charcoal/40" />
          <select
            value={sortKey}
            onChange={(e) => onSort(e.target.value as SortKey)}
            className="form-input !w-auto !py-1 text-xs"
            aria-label={L('ترتيب', 'Sort')}
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k}>{isAr ? SORT_LABELS[k].ar : SORT_LABELS[k].en}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={onToggleRefine}
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-bold transition ${
              showRefine || refineIsActive(refine)
                ? 'border-copper/40 bg-copper/10 text-copper'
                : 'border-sand/60 bg-white text-charcoal/70 hover:bg-cream/60'
            }`}
          >
            <SlidersHorizontal size={13} />
            {L('تصفية دقيقة', 'Refine')}
            {refineIsActive(refine) && <span className="h-1.5 w-1.5 rounded-full bg-copper" />}
          </button>
        </div>
      </div>

      {/* Refine panel — HARD post-filters to focus a large set. */}
      {showRefine && (
        <div className="grid grid-cols-2 gap-2.5 rounded-lg border border-sand/40 bg-cream/30 p-3 sm:grid-cols-3">
          <div>
            <label className="mb-1 block text-[11px] font-bold text-charcoal/60">{L('أعلى سعر (ر.س)', 'Max price (SAR)')}</label>
            <input type="number" min={0} value={refine.priceMax}
              onChange={(e) => onRefine({ ...refine, priceMax: numOrEmpty(e.target.value) })}
              placeholder={L('أي', 'Any')} className="form-input w-full !py-1 text-xs" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-charcoal/60">{L('أقل مساحة (م²)', 'Min area (m²)')}</label>
            <input type="number" min={0} value={refine.areaMin}
              onChange={(e) => onRefine({ ...refine, areaMin: numOrEmpty(e.target.value) })}
              placeholder={L('أي', 'Any')} className="form-input w-full !py-1 text-xs" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-charcoal/60">{L('أعلى مساحة (م²)', 'Max area (m²)')}</label>
            <input type="number" min={0} value={refine.areaMax}
              onChange={(e) => onRefine({ ...refine, areaMax: numOrEmpty(e.target.value) })}
              placeholder={L('أي', 'Any')} className="form-input w-full !py-1 text-xs" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-charcoal/60">{L('أقل عدد غرف', 'Min bedrooms')}</label>
            <select value={refine.bedroomsMin}
              onChange={(e) => onRefine({ ...refine, bedroomsMin: numOrEmpty(e.target.value) })}
              className="form-input w-full !py-1 text-xs">
              <option value="">{L('أي', 'Any')}</option>
              {BEDROOM_OPTS.map((n) => <option key={n} value={n}>{n}+</option>)}
            </select>
          </div>
          <label className="col-span-2 flex items-center gap-2 self-end pb-1 text-xs text-charcoal/80 sm:col-span-1">
            <input type="checkbox" checked={refine.availableOnly}
              onChange={(e) => onRefine({ ...refine, availableOnly: e.target.checked })}
              className="accent-copper" />
            {L('وحدات متاحة فقط', 'Available only')}
          </label>
          <label className="col-span-2 flex items-center gap-2 self-end pb-1 text-xs text-charcoal/80 sm:col-span-1">
            <input type="checkbox" checked={refine.verifiedOnly}
              onChange={(e) => onRefine({ ...refine, verifiedOnly: e.target.checked })}
              className="accent-copper" />
            {L('موثّق بالإحداثيات فقط', 'Coordinate-verified only')}
          </label>
          {refineIsActive(refine) && (
            <button type="button" onClick={() => onRefine(REFINE_DEFAULT)}
              className="col-span-2 inline-flex items-center justify-center gap-1 rounded-lg border border-sand/60 bg-white px-2 py-1 text-[11px] font-bold text-charcoal/70 transition hover:bg-cream/60 sm:col-span-3">
              <RotateCcw size={12} /> {L('مسح التصفية الدقيقة', 'Clear refine')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
