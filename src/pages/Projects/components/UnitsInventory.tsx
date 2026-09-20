import { useCallback, useMemo, useState } from 'react';
import { Check, Download, FileText, GitCompare, ListPlus, Loader2, Search, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import DualRangeSlider from '@/components/ui/DualRangeSlider';
import { normalizeForSearch } from '@/lib/recordSearch';
import { modelByName, fieldByCandidates, resolveProjectView, type OptionView, type ProjectView } from '@/lib/projects/projectView';
import { resolveUnitView, unitsForProject, sortUnits, type UnitView, type UnitSortKey } from '@/lib/projects/unitView';
import { saveUnitToClient } from '@/lib/matching/saveUnitOption';
import type { ClientOptionStatus } from '@/lib/matching/clientOptions';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import { buildUnitsTablePdf, unitsPdfFilename } from '@/lib/projects/unitsPdf';
import { downloadPdf, type ChatPdfContext } from '@/lib/projects/sendPdfToChat';
import SendUnitsPdfModal from '@/pages/Chats/components/SendUnitsPdfModal';
import UnitDrawer from './UnitDrawer';
import UnitCompareModal from './UnitCompareModal';

interface UnitsInventoryProps {
  projectId: string;
  projectName?: string | null;
  isAr: boolean;
  /**
   * Pre-resolved project view (from the caller that already has it — e.g. the
   * chat browser's drilled project). When omitted it's resolved locally from
   * `projectId` so the PDF actions still work on the project detail page.
   */
  project?: ProjectView | null;
  /**
   * When set (the in-chat browser), each PDF action offers "Send to client"
   * into this conversation. When null (project pages), only Download is shown.
   */
  chatPdf?: ChatPdfContext | null;
  /**
   * When set (a client is in context — the Finder, the in-chat browser, the
   * Client Options tab), each unit row + the unit drawer gain a "Save to client
   * options" action. Saving a unit ALSO saves its parent project (see
   * saveUnitToClient). Absent (plain project pages) → no save action is shown.
   */
  clientId?: string | null;
}

/** Drop the punctuation reps omit when typing a code by hand (B-18 -> b18). */
const stripSeparators = (s: string) => s.replace(/[\s\-_/.]/g, '');

const SAR = (n: number | null, isAr: boolean) => (n === null ? (isAr ? 'غير متوفر' : 'N/A') : `${n.toLocaleString(isAr ? 'ar-SA' : 'en-US')} ${isAr ? 'ر.س' : 'SAR'}`);

export default function UnitsInventory({ projectId, projectName, isAr, project, chatPdf, clientId }: UnitsInventoryProps) {
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);

  const unitsModel = modelByName(models, 'units');
  const statusField = fieldByCandidates(unitsModel, ['unit_status']);
  const typeField = fieldByCandidates(unitsModel, ['unit_type']);
  const floorField = fieldByCandidates(unitsModel, ['floor']);

  const translationVersion = useRecordTranslationVersion();
  const allUnits: UnitView[] = useMemo(
    () => unitsForProject({ models, records }, projectId).map((r) => resolveUnitView({ models, records }, r, { isAr, translate: getEntityFieldText })),
    // translationVersion: re-resolve unit model/notes/developer once translations hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, records, projectId, isAr, translationVersion],
  );

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [floor, setFloor] = useState('');
  const [bedMin, setBedMin] = useState('');
  const [bedMax, setBedMax] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [areaMin, setAreaMin] = useState('');
  const [areaMax, setAreaMax] = useState('');
  const [sortKey, setSortKey] = useState<UnitSortKey>('cheapest');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Hold the OPEN UNIT'S ID, not its resolved view: editing the unit's status
  // from the drawer rewrites the record, and a captured UnitView object would
  // keep showing the pre-edit status. Re-deriving from `allUnits` (unfiltered,
  // so a status change that no longer matches the active filter doesn't yank
  // the drawer shut) keeps the drawer live.
  const [drawerUnitId, setDrawerUnitId] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  // "Save to client options" (only when a client is in context). Which unit is
  // mid-save, and this client's already-saved unit options → status, so a saved
  // unit shows "In options" instead of the Save button.
  const [savingUnitId, setSavingUnitId] = useState<string | null>(null);
  const savedUnitStatus = useMemo(() => {
    const map = new Map<string, ClientOptionStatus>();
    if (!clientId) return map;
    const m = models.find((mm) => mm.name === 'client_property_options');
    if (!m) return map;
    for (const r of records[m.id] ?? []) {
      if (r.data.client_id !== clientId || r.data.source_type !== 'unit') continue;
      map.set(String(r.data.source_id), r.data.status as ClientOptionStatus);
    }
    return map;
  }, [clientId, models, records]);

  const handleSaveUnit = async (u: UnitView) => {
    if (!clientId || savingUnitId) return;
    setSavingUnitId(u.id);
    try {
      const { unit } = await saveUnitToClient(clientId, u.raw);
      if (unit.outcome === 'created' || unit.outcome === 'queued' || unit.outcome === 'updated') {
        addToast(
          isAr ? 'أُضيفت الوحدة ومشروعها إلى خيارات العميل' : 'Unit (and its project) added to the client’s options',
          'success',
        );
      } else if (unit.outcome === 'eliminated_exists') {
        addToast(
          isAr
            ? 'هذه الوحدة مستبعدة سابقاً لهذا العميل — أعِد تفعيلها من قائمة الخيارات.'
            : 'This unit was eliminated for this client — reactivate it from the options list.',
          'error',
        );
      } else {
        // conflict / error — the store already surfaced the Supabase failure;
        // this toast tells the rep what THEIR action did (fail-loudly rule).
        addToast(
          isAr ? 'تعذّر إضافة الوحدة لخيارات العميل' : 'Could not add the unit to the client’s options',
          'error',
        );
      }
    } finally {
      setSavingUnitId(null);
    }
  };

  // Free-text search over a unit's IDENTITY text — our unit code, the
  // developer's own code, the unit number, its model name, and the type /
  // floor / status labels. `normalizeForSearch` folds Arabic orthography and
  // unifies Arabic-Indic digits with ASCII (the same folding the SQL search
  // index uses), so ٤٩٥٥٤ finds U-49554 and "شقه" finds "شقة". Every typed
  // token must match, so "دور 2" narrows instead of widening.
  //
  // Each token is also tried against a SEPARATOR-STRIPPED copy of the text, so
  // a code read aloud off a sheet and typed without its punctuation ("b18",
  // "U49554") still finds B-18 / U-49554. Reps type codes both ways.
  const searchTokens = useMemo(
    () => normalizeForSearch(search).split(/\s+/).filter(Boolean),
    [search],
  );
  const searchHaystack = useCallback(
    (u: UnitView) => {
      const hay = normalizeForSearch(
        [
          u.code,
          u.developerCode,
          u.unitNumber,
          u.model,
          u.building,
          u.block,
          u.type ? (isAr ? u.type.label_ar : u.type.label_en) : null,
          u.floor ? (isAr ? u.floor.label_ar : u.floor.label_en) : null,
          u.status ? (isAr ? u.status.label_ar : u.status.label_en) : null,
        ]
          .filter(Boolean)
          .join(' '),
      );
      return { hay, compact: stripSeparators(hay) };
    },
    [isAr],
  );

  const filtered = useMemo(() => {
    const pMin = priceMin ? Number(priceMin) : null;
    const pMax = priceMax ? Number(priceMax) : null;
    const aMin = areaMin ? Number(areaMin) : null;
    const aMax = areaMax ? Number(areaMax) : null;
    const bMin = bedMin ? Number(bedMin) : null;
    const bMax = bedMax ? Number(bedMax) : null;
    const out = allUnits.filter((u) => {
      if (searchTokens.length > 0) {
        const { hay, compact } = searchHaystack(u);
        if (!searchTokens.every((t) => hay.includes(t) || compact.includes(stripSeparators(t)))) return false;
      }
      if (status && u.status?.value !== status) return false;
      if (type && u.type?.value !== type) return false;
      if (floor && u.floor?.value !== floor) return false;
      if (bMin !== null && (u.bedrooms ?? Infinity) < bMin) return false;
      if (bMax !== null && (u.bedrooms ?? 0) > bMax) return false;
      if (pMin !== null && (u.totalPrice ?? Infinity) < pMin) return false;
      if (pMax !== null && (u.totalPrice ?? 0) > pMax) return false;
      if (aMin !== null && (u.area ?? Infinity) < aMin) return false;
      if (aMax !== null && (u.area ?? 0) > aMax) return false;
      return true;
    });
    return sortUnits(out, sortKey);
  }, [allUnits, searchTokens, searchHaystack, status, type, floor, bedMin, bedMax, priceMin, priceMax, areaMin, areaMax, sortKey]);

  // How many of THIS project's units sit under each status / type / floor
  // option. Drives both the count shown beside each choice and the decision to
  // omit options no unit here uses — a floor list of twenty on a project with
  // three is noise, and picking an absent option could only ever return zero.
  // Nothing is hidden from the table by this; it only trims the menus.
  const optionCounts = useMemo(() => {
    const tally = (pick: (u: UnitView) => OptionView | null) => {
      const m = new Map<string, number>();
      for (const u of allUnits) {
        const v = pick(u)?.value;
        if (v) m.set(v, (m.get(v) ?? 0) + 1);
      }
      return m;
    };
    return {
      status: tally((u) => u.status),
      type: tally((u) => u.type),
      floor: tally((u) => u.floor),
    };
  }, [allUnits]);

  const activeFilterCount =
    (search.trim() ? 1 : 0) + (status ? 1 : 0) + (type ? 1 : 0) + (floor ? 1 : 0) +
    (bedMin || bedMax ? 1 : 0) + (priceMin || priceMax ? 1 : 0) + (areaMin || areaMax ? 1 : 0);

  const clearFilters = () => {
    setSearch(''); setStatus(''); setType(''); setFloor('');
    setBedMin(''); setBedMax(''); setPriceMin(''); setPriceMax(''); setAreaMin(''); setAreaMax('');
  };

  // Bounds for the bedrooms / price / area range sliders — the project's own min↔max.
  const bedBounds = useMemo(() => {
    const v = allUnits.map((u) => u.bedrooms).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
  }, [allUnits]);
  const priceBounds = useMemo(() => {
    const v = allUnits.map((u) => u.totalPrice).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
  }, [allUnits]);
  const areaBounds = useMemo(() => {
    const v = allUnits.map((u) => u.area).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
  }, [allUnits]);

  const selectedUnits = useMemo(() => filtered.filter((u) => selected.has(u.id)), [filtered, selected]);
  const drawerUnit = useMemo(
    () => (drawerUnitId ? allUnits.find((u) => u.id === drawerUnitId) ?? null : null),
    [allUnits, drawerUnitId],
  );

  // Project view for the PDF header — the caller's if provided, else resolved
  // from the project record so Download works on the project detail page too.
  const projectView = useMemo<ProjectView | null>(() => {
    if (project) return project;
    const pm = modelByName(models, 'all_projects');
    const rec = pm ? (records[pm.id] ?? []).find((r) => r.id === projectId) : undefined;
    return rec ? resolveProjectView({ models, records }, rec, { isAr, translate: getEntityFieldText }) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, models, records, projectId, isAr, translationVersion]);

  // Re-resolve the project + the filtered units in a REQUESTED language, so the
  // WhatsApp PDF can be sent in English even while the app UI is Arabic (and
  // vice-versa). Names come from the translation variant (else the source),
  // geo names localize with an Arabic fallback, and option labels are picked in
  // the requested language — the same resolvers the on-screen views use. When
  // the requested language equals the UI language we reuse the already-resolved
  // views. The Send/Download PDF path is the only caller; nothing else re-runs.
  const projectViewByLang = useCallback(
    (wantAr: boolean): ProjectView | null => {
      if (wantAr === isAr) return projectView;
      const pm = modelByName(models, 'all_projects');
      const rec = pm ? (records[pm.id] ?? []).find((r) => r.id === (project?.id ?? projectId)) : undefined;
      return rec ? resolveProjectView({ models, records }, rec, { isAr: wantAr, translate: getEntityFieldText }) : projectView;
    },
    [isAr, projectView, models, records, project, projectId],
  );

  const unitsByLang = useCallback(
    (wantAr: boolean): UnitView[] => {
      if (wantAr === isAr) return filtered;
      const byId = new Map(
        unitsForProject({ models, records }, projectId).map((r) => [
          r.id,
          resolveUnitView({ models, records }, r, { isAr: wantAr, translate: getEntityFieldText }),
        ]),
      );
      return filtered.map((u) => byId.get(u.id)).filter((u): u is UnitView => !!u);
    },
    [isAr, filtered, models, records, projectId],
  );

  const [pdfOpen, setPdfOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const downloadTable = async () => {
    if (!projectView || downloading) return;
    setDownloading(true);
    try {
      const blob = await buildUnitsTablePdf({ project: projectView, units: filtered, isAr });
      downloadPdf(blob, unitsPdfFilename(projectView));
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setDownloading(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (!unitsModel) return <p className="text-sm text-charcoal/50">{isAr ? 'نموذج الوحدات غير موجود.' : 'Units model not found.'}</p>;

  // `.form-input` is `width:100%` (correct inside a form grid), so in this
  // wrapping toolbar every select used to claim a whole line — four stacked
  // full-width bars for four one-word choices. `!w-auto` shrinks each to its
  // own content so they sit side by side as compact pills. An engaged filter
  // wears the copper border, so "what is narrowing this list" is visible
  // without opening each menu.
  const selectCls = (on: boolean) =>
    `form-input !w-auto !py-1 !px-2 text-xs ${on ? '!border-copper bg-copper/5 font-bold text-copper' : ''}`;

  return (
    <div className="space-y-3">
      {/* Toolbar — search + the filter pills on one wrapping row. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[190px] flex-1">
          <Search size={14} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-charcoal/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isAr ? 'بحث بكود الوحدة أو رمز المطور أو النوع…' : 'Search unit code, developer code, or type…'}
            className="form-input w-full !py-1 ps-8 pe-7 text-xs"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute end-2 top-1/2 -translate-y-1/2 text-charcoal/40 hover:text-charcoal"
              aria-label={isAr ? 'مسح البحث' : 'Clear search'}
            >
              <X size={13} />
            </button>
          )}
        </div>

        <select className={selectCls(!!status)} value={status} onChange={(e) => setStatus(e.target.value)} title={isAr ? 'الحالة' : 'Status'}>
          <option value="">{isAr ? 'كل الحالات' : 'All statuses'}</option>
          {(statusField?.options ?? [])
            .filter((o) => optionCounts.status.has(o.value) || o.value === status)
            .map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en} ({optionCounts.status.get(o.value) ?? 0})</option>)}
        </select>
        <select className={selectCls(!!type)} value={type} onChange={(e) => setType(e.target.value)} title={isAr ? 'النوع' : 'Type'}>
          <option value="">{isAr ? 'كل الأنواع' : 'All types'}</option>
          {(typeField?.options ?? [])
            .filter((o) => optionCounts.type.has(o.value) || o.value === type)
            .map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en} ({optionCounts.type.get(o.value) ?? 0})</option>)}
        </select>
        <select className={selectCls(!!floor)} value={floor} onChange={(e) => setFloor(e.target.value)} title={isAr ? 'الطابق' : 'Floor'}>
          <option value="">{isAr ? 'كل الطوابق' : 'All floors'}</option>
          {(floorField?.options ?? [])
            .filter((o) => optionCounts.floor.has(o.value) || o.value === floor)
            .map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en} ({optionCounts.floor.get(o.value) ?? 0})</option>)}
        </select>
        <select className={selectCls(false)} value={sortKey} onChange={(e) => setSortKey(e.target.value as UnitSortKey)} title={isAr ? 'الترتيب' : 'Sort'}>
          <option value="cheapest">{isAr ? 'الأرخص' : 'Cheapest'}</option>
          <option value="largest">{isAr ? 'الأكبر مساحة' : 'Largest'}</option>
          <option value="best_per_m2">{isAr ? 'أفضل سعر متر' : 'Best price/m²'}</option>
          <option value="newest">{isAr ? 'الأحدث' : 'Newest'}</option>
        </select>

        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-terracotta hover:bg-terracotta/10"
          >
            <X size={13} /> {isAr ? `مسح (${activeFilterCount})` : `Clear (${activeFilterCount})`}
          </button>
        )}

        {/* Units table PDF — send to the client (in a chat) or download. The PDF
            reflects the CURRENT filter (`filtered`). */}
        {projectView && filtered.length > 0 && (
          <div className="ms-auto">
            {chatPdf ? (
              <Button variant="secondary" className="text-xs !py-1" onClick={() => setPdfOpen(true)}>
                <FileText size={13} className="inline -mt-0.5 me-1" />
                {isAr ? `PDF الوحدات (${filtered.length})` : `Units PDF (${filtered.length})`}
              </Button>
            ) : (
              <Button variant="secondary" className="text-xs !py-1" disabled={downloading} onClick={() => void downloadTable()}>
                {downloading ? <Loader2 size={13} className="inline -mt-0.5 me-1 animate-spin" /> : <Download size={13} className="inline -mt-0.5 me-1" />}
                {isAr ? `تنزيل PDF (${filtered.length})` : `Download PDF (${filtered.length})`}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Price / area range sliders — drag either handle; the two ends are the
          min and the max, bounded by this project's own unit range. */}
      {((bedBounds && bedBounds.max > bedBounds.min) || (priceBounds && priceBounds.max > priceBounds.min) || (areaBounds && areaBounds.max > areaBounds.min)) && (
        <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-lg border border-sand/40 bg-cream/20 px-3 py-2.5">
          {bedBounds && bedBounds.max > bedBounds.min && (
            <DualRangeSlider
              isAr={isAr}
              label={isAr ? 'غرف النوم' : 'Bedrooms'}
              min={bedBounds.min}
              max={bedBounds.max}
              step={1}
              low={bedMin ? Number(bedMin) : bedBounds.min}
              high={bedMax ? Number(bedMax) : bedBounds.max}
              format={(n) => String(Math.round(n))}
              onChange={(lo, hi) => {
                setBedMin(lo <= bedBounds.min ? '' : String(Math.round(lo)));
                setBedMax(hi >= bedBounds.max ? '' : String(Math.round(hi)));
              }}
            />
          )}
          {priceBounds && priceBounds.max > priceBounds.min && (
            <DualRangeSlider
              isAr={isAr}
              label={isAr ? 'السعر (ر.س)' : 'Price (SAR)'}
              min={priceBounds.min}
              max={priceBounds.max}
              step={1000}
              low={priceMin ? Number(priceMin) : priceBounds.min}
              high={priceMax ? Number(priceMax) : priceBounds.max}
              format={(n) => Math.round(n).toLocaleString('en-US')}
              onChange={(lo, hi) => {
                setPriceMin(lo <= priceBounds.min ? '' : String(Math.round(lo)));
                setPriceMax(hi >= priceBounds.max ? '' : String(Math.round(hi)));
              }}
            />
          )}
          {areaBounds && areaBounds.max > areaBounds.min && (
            <DualRangeSlider
              isAr={isAr}
              label={isAr ? 'المساحة (م²)' : 'Area (m²)'}
              min={areaBounds.min}
              max={areaBounds.max}
              step={1}
              low={areaMin ? Number(areaMin) : areaBounds.min}
              high={areaMax ? Number(areaMax) : areaBounds.max}
              format={(n) => Math.round(n).toLocaleString('en-US')}
              onChange={(lo, hi) => {
                setAreaMin(lo <= areaBounds.min ? '' : String(Math.round(lo)));
                setAreaMax(hi >= areaBounds.max ? '' : String(Math.round(hi)));
              }}
            />
          )}
        </div>
      )}

      {/* Selection action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 bg-copper/10 rounded-lg px-3 py-2">
          <span className="text-sm text-charcoal/70">{isAr ? `${selected.size} محددة` : `${selected.size} selected`}</span>
          <Button variant="secondary" className="text-sm !py-1" onClick={() => setCompareOpen(true)} disabled={selected.size < 2}>
            <GitCompare size={14} className="inline -mt-0.5 me-1" /> {isAr ? 'مقارنة' : 'Compare'}
          </Button>
          <button onClick={() => setSelected(new Set())} className="text-charcoal/40 hover:text-charcoal ms-auto" aria-label="clear"><X size={16} /></button>
        </div>
      )}

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="card p-10 text-center text-charcoal/40">
          <p>{isAr ? 'لا توجد وحدات مطابقة.' : 'No matching units.'}</p>
          {activeFilterCount > 0 && allUnits.length > 0 && (
            <button type="button" onClick={clearFilters} className="mt-2 text-xs font-bold text-copper hover:underline">
              {isAr ? `مسح الفلاتر وعرض ${allUnits.length} وحدة` : `Clear filters — show all ${allUnits.length} units`}
            </button>
          )}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-charcoal/40 text-xs border-b border-sand/50">
                <th className="p-2 w-8"></th>
                <th className="p-2 text-start">{isAr ? 'الكود' : 'Code'}</th>
                <th className="p-2 text-start">{isAr ? 'رمز المطور' : 'Dev. code'}</th>
                <th className="p-2 text-start">{isAr ? 'النوع' : 'Type'}</th>
                <th className="p-2 text-end">{isAr ? 'المساحة' : 'Area'}</th>
                <th className="p-2 text-center">{isAr ? 'غرف' : 'Beds'}</th>
                <th className="p-2 text-center">{isAr ? 'حمامات' : 'Baths'}</th>
                <th className="p-2 text-start">{isAr ? 'الطابق' : 'Floor'}</th>
                <th className="p-2 text-end">{isAr ? 'السعر' : 'Price'}</th>
                <th className="p-2 text-end">{isAr ? 'سعر المتر' : 'Price/m²'}</th>
                <th className="p-2 text-start">{isAr ? 'الحالة' : 'Status'}</th>
                {clientId && <th className="p-2 text-center">{isAr ? 'خيارات العميل' : 'Client options'}</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id} className="border-b border-sand/30 hover:bg-cream/50 cursor-pointer" onClick={() => setDrawerUnitId(u.id)}>
                  <td className="p-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} className="rounded border-sand text-copper focus:ring-copper/30" />
                  </td>
                  <td className="p-2 font-medium text-charcoal">{u.code ?? `#${u.id.slice(0, 6)}`}</td>
                  <td className="p-2 text-charcoal/60">{u.developerCode ?? '—'}</td>
                  <td className="p-2 text-charcoal/70">{u.type ? (isAr ? u.type.label_ar : u.type.label_en) : '—'}</td>
                  <td className="p-2 text-end text-charcoal/70">{u.area !== null ? `${u.area} m²` : '—'}</td>
                  <td className="p-2 text-center text-charcoal/70">{u.bedrooms ?? '—'}</td>
                  <td className="p-2 text-center text-charcoal/70">{u.bathrooms ?? '—'}</td>
                  <td className="p-2 text-charcoal/70">{u.floor ? (isAr ? u.floor.label_ar : u.floor.label_en) : '—'}</td>
                  <td className="p-2 text-end font-medium text-charcoal">{SAR(u.totalPrice, isAr)}</td>
                  <td className="p-2 text-end text-charcoal/70">{u.pricePerM2 !== null ? u.pricePerM2.toLocaleString() : '—'}</td>
                  <td className="p-2">{u.status && <Badge label={isAr ? u.status.label_ar : u.status.label_en} color={u.status.color ?? undefined} />}</td>
                  {clientId && (
                    <td className="p-2 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const st = savedUnitStatus.get(u.id);
                        const busy = savingUnitId === u.id;
                        if (st === 'eliminated') {
                          return (
                            <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-700">
                              {isAr ? 'مستبعدة' : 'Eliminated'}
                            </span>
                          );
                        }
                        if (st) {
                          return (
                            <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-bold text-green-700">
                              <Check size={12} /> {isAr ? 'ضمن الخيارات' : 'In options'}
                            </span>
                          );
                        }
                        return (
                          <button
                            type="button"
                            onClick={() => void handleSaveUnit(u)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 rounded-lg border border-copper/30 bg-copper/5 px-2 py-1 text-[11px] font-bold text-copper transition hover:bg-copper/10 disabled:opacity-60"
                            title={isAr ? 'حفظ الوحدة (ومشروعها) ضمن خيارات العميل' : 'Save this unit (and its project) to the client’s options'}
                          >
                            {busy ? <Loader2 size={12} className="animate-spin" /> : <ListPlus size={12} />}
                            {isAr ? 'حفظ' : 'Save'}
                          </button>
                        );
                      })()}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-xs text-charcoal/40">{isAr ? `${filtered.length} من ${allUnits.length} وحدة` : `${filtered.length} of ${allUnits.length} units`}</div>

      <UnitDrawer
        unit={drawerUnit}
        projectName={projectName}
        isAr={isAr}
        project={projectView}
        chatPdf={chatPdf}
        onSaveToClient={clientId && drawerUnit ? () => void handleSaveUnit(drawerUnit) : undefined}
        saveOptionState={
          !clientId || !drawerUnit
            ? undefined
            : savingUnitId === drawerUnit.id
              ? 'saving'
              : savedUnitStatus.get(drawerUnit.id) === 'eliminated'
                ? 'eliminated'
                : savedUnitStatus.get(drawerUnit.id)
                  ? 'saved'
                  : 'idle'
        }
        onClose={() => setDrawerUnitId(null)}
      />
      <UnitCompareModal open={compareOpen} onClose={() => setCompareOpen(false)} units={selectedUnits} projectName={projectName} isAr={isAr} />

      {/* Send/Download the units table PDF (chat context). Mounted only while
          open so its cached-blob state resets per open. */}
      {pdfOpen && chatPdf && projectView && (
        <SendUnitsPdfModal
          open
          onClose={() => setPdfOpen(false)}
          chatWid={chatPdf.chatWid}
          clientName={chatPdf.clientName}
          clientPhone={chatPdf.clientPhone}
          titleFor={(a) => (a ? `وحدات ${projectViewByLang(true)?.name ?? ''}`.trim() : `${projectViewByLang(false)?.name ?? 'Project'} units`)}
          subtitleFor={(a) => (a ? `${filtered.length} وحدة` : `${filtered.length} units`)}
          filenameFor={() => unitsPdfFilename(projectView)}
          captionFor={(a) => (a ? `قائمة وحدات ${projectViewByLang(true)?.name ?? ''}`.trim() : `${projectViewByLang(false)?.name ?? 'Project'} — units list`)}
          buildFor={(a) => buildUnitsTablePdf({ project: projectViewByLang(a) ?? projectView, units: unitsByLang(a), isAr: a })}
        />
      )}
    </div>
  );
}
