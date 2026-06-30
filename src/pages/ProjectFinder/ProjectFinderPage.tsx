import { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, Loader2, Search, RotateCcw, Info, AlertTriangle, SlidersHorizontal, ArrowUpDown } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import DynamicField from '@/pages/Records/components/DynamicField';
import { draftToMatchRequirements, type MatchRequirementsInput } from '@/lib/matching/requirements';
import {
  fetchProjectFinder, totalFinderMatches, FINDER_GROUP_KEYS,
  type FinderResponse, type FinderGroupKey, type FinderMatch, type FinderSource,
} from '@/lib/matching/projectFinder';
import FinderCard from '@/pages/Followups/components/FinderCard';
import type { AppModel, ModelField } from '@/types';

/**
 * Standalone Project Finder — a self-service discovery tool reachable from the
 * sidebar, usable WITHOUT a client. The salesperson fills structured pickers
 * (location cascade, unit type, budget/area ranges, amenities — all sourced from
 * the live `clients` model's own field definitions, so there's NO free text and
 * NO AI), then runs the SAME deterministic, geography-verified /api/project-finder
 * the Follow-up "Suggested Projects" modal uses (parse:false, explain:false).
 *
 * The search always pulls EVERYTHING scoring ≥ 70 (FETCH_FLOOR). Above the
 * results sits a refinement toolbar that operates 100% client-side on that set
 * (no re-fetch, instant):
 *   • a score slider (70→100) — drag right to raise the bar, fewer cards;
 *   • a sort dropdown (best match / price / area / nearest / availability / name);
 *   • a "Refine" panel of HARD post-filters (max price, area window, min beds,
 *     available-only, coordinate-verified-only) to focus a large result set.
 *
 * Difference from the Follow-up modal: there's no client to attach options to, so
 * the cards show "Details" only (hideClientActions) — no save / eliminate.
 */

const TAB_LABELS: Record<FinderGroupKey, { ar: string; en: string }> = {
  exact_district_matches: { ar: 'في الحي المطلوب', en: 'Exact district' },
  nearby_district_matches: { ar: 'أحياء قريبة', en: 'Nearby' },
  same_city_matches: { ar: 'نفس المدينة', en: 'Same city' },
  broader_fallback: { ar: 'بدائل أوسع', en: 'Broader' },
};

// The clients-model field slugs the finder reads (mirrors the Follow-up draft
// shape consumed by draftToMatchRequirements). Rendered if present on the live model.
const FILTER_SLUGS = ['location', 'preferred_districts', 'preferred_unit_type', 'budget', 'preferred_area', 'preferred_amenities'] as const;

const SOURCE_LABELS: Record<FinderSource, { ar: string; en: string }> = {
  our_projects: { ar: 'مشاريعنا', en: 'Our Projects' },
  all_projects: { ar: 'كل المشاريع', en: 'All Projects' },
  market_listings: { ar: 'إعلانات السوق', en: 'Market listings' },
};

// The engine always returns everything ≥ this; the score slider refines upward client-side.
const FETCH_FLOOR = 70;
const PAGE = 24;

type SortKey = 'score' | 'price_asc' | 'price_desc' | 'area_desc' | 'area_asc' | 'distance' | 'available_desc' | 'name';

const SORT_LABELS: Record<SortKey, { ar: string; en: string }> = {
  score: { ar: 'الأفضل تطابقاً', en: 'Best match' },
  price_asc: { ar: 'السعر: الأقل أولاً', en: 'Price: low → high' },
  price_desc: { ar: 'السعر: الأعلى أولاً', en: 'Price: high → low' },
  area_desc: { ar: 'المساحة: الأكبر أولاً', en: 'Area: large → small' },
  area_asc: { ar: 'المساحة: الأصغر أولاً', en: 'Area: small → large' },
  distance: { ar: 'الأقرب مسافةً', en: 'Nearest' },
  available_desc: { ar: 'الأكثر وحدات متاحة', en: 'Most available units' },
  name: { ar: 'الاسم (أ → ي)', en: 'Name (A → Z)' },
};

interface Refine {
  priceMax: number | '';
  areaMin: number | '';
  areaMax: number | '';
  bedroomsMin: number | '';
  availableOnly: boolean;
  verifiedOnly: boolean;
}
const REFINE_DEFAULT: Refine = {
  priceMax: '', areaMin: '', areaMax: '', bedroomsMin: '', availableOnly: false, verifiedOnly: false,
};
const refineIsActive = (r: Refine): boolean =>
  r.priceMax !== '' || r.areaMin !== '' || r.areaMax !== '' || r.bedroomsMin !== '' || r.availableOnly || r.verifiedOnly;

/** A fact value that's either a scalar number or a { min, max } range → {min,max}. */
function factRange(facts: Record<string, unknown>, key: string): { min: number | null; max: number | null } {
  const v = facts?.[key];
  if (v == null) return { min: null, max: null };
  if (typeof v === 'number' && Number.isFinite(v)) return { min: v, max: v };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const mn = typeof o.min === 'number' ? o.min : Number(o.min);
    const mx = typeof o.max === 'number' ? o.max : Number(o.max);
    return { min: Number.isFinite(mn) ? mn : null, max: Number.isFinite(mx) ? mx : null };
  }
  return { min: null, max: null };
}
const availOf = (item: FinderMatch): number | null =>
  typeof item.facts?.available_units === 'number' ? (item.facts.available_units as number) : null;

/** HARD post-filters over the already-scored set — focus a large result list. */
function passesRefine(item: FinderMatch, r: Refine): boolean {
  const price = factRange(item.facts, 'price_range');
  const area = factRange(item.facts, 'area_range');
  const beds = factRange(item.facts, 'bedroom_range');
  if (r.priceMax !== '' && (price.min == null || price.min > r.priceMax)) return false;
  if (r.areaMin !== '' && (area.max == null || area.max < r.areaMin)) return false;
  if (r.areaMax !== '' && (area.min == null || area.min > r.areaMax)) return false;
  if (r.bedroomsMin !== '' && (beds.max == null || beds.max < r.bedroomsMin)) return false;
  if (r.availableOnly) { const a = availOf(item); if (a == null || a <= 0) return false; }
  if (r.verifiedOnly && item.geo_status !== 'verified_match' && item.geo_status !== 'verified_derived') return false;
  return true;
}

/** Compare two nullable numbers; nulls always sort last regardless of direction. */
function cmpNum(a: number | null, b: number | null, asc: boolean): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return asc ? a - b : b - a;
}

function sortItems(items: FinderMatch[], key: SortKey): FinderMatch[] {
  const arr = [...items];
  switch (key) {
    case 'price_asc': return arr.sort((a, b) => cmpNum(factRange(a.facts, 'price_range').min, factRange(b.facts, 'price_range').min, true));
    case 'price_desc': return arr.sort((a, b) => cmpNum(factRange(a.facts, 'price_range').max, factRange(b.facts, 'price_range').max, false));
    case 'area_desc': return arr.sort((a, b) => cmpNum(factRange(a.facts, 'area_range').max, factRange(b.facts, 'area_range').max, false));
    case 'area_asc': return arr.sort((a, b) => cmpNum(factRange(a.facts, 'area_range').min, factRange(b.facts, 'area_range').min, true));
    case 'distance': return arr.sort((a, b) => cmpNum(a.distance_km, b.distance_km, true));
    case 'available_desc': return arr.sort((a, b) => cmpNum(availOf(a), availOf(b), false));
    case 'name': return arr.sort((a, b) => a.project_name.localeCompare(b.project_name, 'ar'));
    case 'score':
    default: return arr.sort((a, b) => b.score - a.score);
  }
}

export default function ProjectFinderPage() {
  const language = useAppStore((s) => s.language);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const isAr = language === 'ar';
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const clientsModel = useMemo<AppModel | null>(
    () => models.find((m) => m.name === 'clients') ?? null,
    [models],
  );

  // The filter fields we render, pulled from the LIVE clients model by slug (the
  // live model can drift from seedModels — only render what actually exists).
  const filterFields = useMemo<ModelField[]>(() => {
    if (!clientsModel) return [];
    const bySlug = new Map<string, ModelField>();
    for (const sec of clientsModel.schema.sections) {
      for (const f of sec.fields) bySlug.set(f.name, f);
    }
    return FILTER_SLUGS.map((slug) => bySlug.get(slug)).filter((f): f is ModelField => !!f);
  }, [clientsModel]);

  // The structured preference buffer (same slug shape as the Follow-up draft).
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [bedrooms, setBedrooms] = useState<number | ''>('');
  const [sources, setSources] = useState<Record<FinderSource, boolean>>({
    our_projects: true, all_projects: true, market_listings: false,
  });

  // Results-refinement state (all client-side over the ≥ FETCH_FLOOR set).
  const [scoreThreshold, setScoreThreshold] = useState<number>(FETCH_FLOOR);
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [showRefine, setShowRefine] = useState(false);
  const [refine, setRefine] = useState<Refine>(REFINE_DEFAULT);

  const [resp, setResp] = useState<FinderResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [activeTab, setActiveTab] = useState<FinderGroupKey>('exact_district_matches');
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // id → display name for districts + cities, for resolving the location cascade's
  // record ids into the names the matcher expects (identical to the modal).
  const geoNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const name of ['districts', 'cities']) {
      const m = models.find((mm) => mm.name === name);
      if (!m) continue;
      for (const r of records[m.id] ?? []) {
        const dn = (r.data?.display_name ?? r.data?.name_ar ?? r.data?.name_en) as unknown;
        if (typeof dn === 'string' && dn.trim()) map[r.id] = dn.trim();
      }
    }
    return map;
  }, [models, records]);
  const resolveLookupName = useMemo(
    () => (id: string, _target: 'districts' | 'cities'): string | null => geoNames[id] ?? null,
    [geoNames],
  );

  const setField = (slug: string, value: unknown) =>
    setDraft((d) => ({ ...d, [slug]: value }));

  function buildRequirements(): MatchRequirementsInput {
    const reqs = draftToMatchRequirements({
      clientsModel, prefDraft: draft, savedClientData: null, resolveLookupName,
    });
    if (typeof bedrooms === 'number' && bedrooms > 0) reqs.bedrooms = bedrooms;
    return reqs;
  }

  const hasAnyCriteria = useMemo(() => {
    const r = buildRequirements();
    return Object.keys(r).length > 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, bedrooms, resolveLookupName]);

  const controllerRef = useRef<AbortController | null>(null);

  async function runSearch() {
    const chosenSources = (Object.keys(sources) as FinderSource[]).filter((s) => sources[s]);
    if (chosenSources.length === 0) {
      setError(L('اختر مصدراً واحداً على الأقل.', 'Pick at least one source.'));
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    setHasSearched(true);
    // A fresh search resets the refinement controls so the full ≥70 set is shown.
    setScoreThreshold(FETCH_FLOOR);
    setRefine(REFINE_DEFAULT);
    try {
      const r = await fetchProjectFinder(
        {
          requirements: buildRequirements(),
          // Standalone: no client → no geo-preference gate, no options to attach.
          // Pull EVERYTHING ≥ 70; the score slider refines upward client-side.
          perGroup: 0,
          minScore: FETCH_FLOOR,
          sources: chosenSources,
          locale: isAr ? 'ar' : 'en',
        },
        controller.signal,
      );
      setResp(r);
      const firstFilled = FINDER_GROUP_KEYS.find((k) => (r.groups[k]?.length ?? 0) > 0);
      setActiveTab(firstFilled ?? 'exact_district_matches');
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function resetFilters() {
    controllerRef.current?.abort();
    setDraft({});
    setBedrooms('');
    setSources({ our_projects: true, all_projects: true, market_listings: false });
    setScoreThreshold(FETCH_FLOOR);
    setSortKey('score');
    setRefine(REFINE_DEFAULT);
    setShowRefine(false);
    setResp(null);
    setError(null);
    setHasSearched(false);
  }

  useEffect(() => () => controllerRef.current?.abort(), []);

  function onOpenDetails(item: FinderMatch) {
    const model = item.source === 'market_listings' ? 'market_listings' : 'all_projects';
    window.open(`/model/${model}/${item.project_id}`, '_blank', 'noopener');
  }

  // Apply the score threshold + refine post-filters, then sort — per group.
  const refinedGroups = useMemo(() => {
    const out = {} as Record<FinderGroupKey, FinderMatch[]>;
    for (const k of FINDER_GROUP_KEYS) {
      const base = (resp?.groups[k] ?? []).filter((it) => it.score >= scoreThreshold && passesRefine(it, refine));
      out[k] = sortItems(base, sortKey);
    }
    return out;
  }, [resp, scoreThreshold, refine, sortKey]);

  const fetchedTotal = totalFinderMatches(resp);
  const refinedTotal = useMemo(
    () => FINDER_GROUP_KEYS.reduce((n, k) => n + refinedGroups[k].length, 0),
    [refinedGroups],
  );
  const activeItems = refinedGroups[activeTab] ?? [];
  const shown = activeItems.slice(0, visibleCount);

  // Reset the render window whenever the visible list changes (tab / refine / sort / new results).
  useEffect(() => { setVisibleCount(PAGE); scrollRef.current?.scrollTo({ top: 0 }); }, [activeTab, refinedGroups]);

  // If refining empties the active tab, hop to the first tab that still has matches.
  useEffect(() => {
    if (!resp) return;
    if (refinedGroups[activeTab].length === 0) {
      const first = FINDER_GROUP_KEYS.find((k) => refinedGroups[k].length > 0);
      if (first && first !== activeTab) setActiveTab(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refinedGroups]);

  // Grow the window as the sentinel scrolls into view (infinite scroll).
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setVisibleCount((c) => Math.min(c + PAGE, activeItems.length)); },
      { root, rootMargin: '800px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [activeItems.length, activeTab, visibleCount]);

  const BEDROOM_OPTS = [1, 2, 3, 4, 5, 6];
  const numOrEmpty = (s: string): number | '' => (s === '' ? '' : Number(s));

  return (
    <div className="flex h-full flex-col" dir={isAr ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-sand/40 bg-white px-5 py-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-copper/10">
          <Compass size={20} className="text-copper" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-chocolate">{L('الباحث عن المشاريع', 'Project Finder')}</h1>
          <p className="text-xs text-charcoal/60">
            {L('ابحث عن المشاريع المطابقة بالحقول والخيارات — بدون عميل، وبدون نص حر أو ذكاء اصطناعي.',
               'Find matching projects by structured fields — no client, no free text, no AI.')}
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 lg:flex-row lg:overflow-hidden">
        {/* ── Filters ── */}
        <div className="w-full shrink-0 lg:w-[340px] lg:overflow-y-auto">
          <div className="card p-5">
            {!clientsModel ? (
              <div className="text-sm text-charcoal/60">{L('نموذج العملاء غير محمّل.', 'Clients model not loaded.')}</div>
            ) : (
              <div className="space-y-4">
                {filterFields.map((field) => (
                  <div key={field.id}>
                    <label className="mb-1 block text-xs font-bold text-charcoal/70">
                      {isAr ? field.label_ar : field.label_en}
                    </label>
                    <DynamicField
                      field={field}
                      value={draft[field.name]}
                      onChange={(v) => setField(field.name, v)}
                      recordData={draft}
                      compact
                    />
                  </div>
                ))}

                {/* Bedrooms — not a clients field; an extra structured filter. */}
                <div>
                  <label className="mb-1 block text-xs font-bold text-charcoal/70">{L('عدد الغرف', 'Bedrooms')}</label>
                  <select
                    value={bedrooms}
                    onChange={(e) => setBedrooms(e.target.value === '' ? '' : Number(e.target.value))}
                    className="form-input w-full"
                  >
                    <option value="">{L('أي عدد', 'Any')}</option>
                    {BEDROOM_OPTS.map((n) => (
                      <option key={n} value={n}>{n}{n === 6 ? '+' : ''}</option>
                    ))}
                  </select>
                </div>

                {/* Sources */}
                <div>
                  <label className="mb-1.5 block text-xs font-bold text-charcoal/70">{L('المصادر', 'Sources')}</label>
                  <div className="space-y-1.5">
                    {(Object.keys(SOURCE_LABELS) as FinderSource[]).map((s) => (
                      <label key={s} className="flex items-center gap-2 text-sm text-charcoal/80">
                        <input
                          type="checkbox"
                          checked={sources[s]}
                          onChange={(e) => setSources((prev) => ({ ...prev, [s]: e.target.checked }))}
                          className="accent-copper"
                        />
                        {isAr ? SOURCE_LABELS[s].ar : SOURCE_LABELS[s].en}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={runSearch}
                    disabled={loading || !hasAnyCriteria}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-copper px-3.5 py-2.5 text-sm font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
                  >
                    {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
                    {L('بحث', 'Find projects')}
                  </button>
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-sand/60 bg-white px-3 py-2.5 text-sm font-bold text-charcoal/70 transition hover:bg-cream/60"
                    title={L('إعادة تعيين', 'Reset')}
                  >
                    <RotateCcw size={15} />
                  </button>
                </div>
                {!hasAnyCriteria && (
                  <p className="text-[11px] text-charcoal/45">
                    {L('حدّد معياراً واحداً على الأقل (الموقع، النوع، الميزانية…).', 'Set at least one criterion (location, type, budget…).')}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Results ── */}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Refinement toolbar — score slider + sort + refine, all client-side. */}
          {hasSearched && !loading && !error && fetchedTotal > 0 && (
            <div className="card mb-3 space-y-3 p-3">
              {/* Score slider */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-bold text-charcoal/70">{L('الحد الأدنى لنسبة التطابق', 'Minimum match score')}</span>
                  <span className="rounded-md bg-copper/10 px-2 py-0.5 text-sm font-bold text-copper">{scoreThreshold}%+</span>
                </div>
                <input
                  type="range"
                  min={FETCH_FLOOR}
                  max={100}
                  step={5}
                  value={scoreThreshold}
                  onChange={(e) => setScoreThreshold(Number(e.target.value))}
                  className="w-full accent-copper"
                  aria-label={L('الحد الأدنى لنسبة التطابق', 'Minimum match score')}
                />
                <div className="mt-0.5 flex justify-between px-0.5 text-[10px] text-charcoal/40">
                  {[70, 75, 80, 85, 90, 95, 100].map((n) => <span key={n}>{n}</span>)}
                </div>
              </div>

              {/* Count + sort + refine toggle */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold text-charcoal/60">
                  {L(`عرض ${refinedTotal} من ${fetchedTotal}`, `Showing ${refinedTotal} of ${fetchedTotal}`)}
                </span>
                <div className="ms-auto flex items-center gap-2">
                  <ArrowUpDown size={13} className="text-charcoal/40" />
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                    className="form-input !w-auto !py-1 text-xs"
                    aria-label={L('ترتيب', 'Sort')}
                  >
                    {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                      <option key={k} value={k}>{isAr ? SORT_LABELS[k].ar : SORT_LABELS[k].en}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setShowRefine((v) => !v)}
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
                      onChange={(e) => setRefine((r) => ({ ...r, priceMax: numOrEmpty(e.target.value) }))}
                      placeholder={L('أي', 'Any')} className="form-input w-full !py-1 text-xs" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-bold text-charcoal/60">{L('أقل مساحة (م²)', 'Min area (m²)')}</label>
                    <input type="number" min={0} value={refine.areaMin}
                      onChange={(e) => setRefine((r) => ({ ...r, areaMin: numOrEmpty(e.target.value) }))}
                      placeholder={L('أي', 'Any')} className="form-input w-full !py-1 text-xs" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-bold text-charcoal/60">{L('أعلى مساحة (م²)', 'Max area (m²)')}</label>
                    <input type="number" min={0} value={refine.areaMax}
                      onChange={(e) => setRefine((r) => ({ ...r, areaMax: numOrEmpty(e.target.value) }))}
                      placeholder={L('أي', 'Any')} className="form-input w-full !py-1 text-xs" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-bold text-charcoal/60">{L('أقل عدد غرف', 'Min bedrooms')}</label>
                    <select value={refine.bedroomsMin}
                      onChange={(e) => setRefine((r) => ({ ...r, bedroomsMin: numOrEmpty(e.target.value) }))}
                      className="form-input w-full !py-1 text-xs">
                      <option value="">{L('أي', 'Any')}</option>
                      {BEDROOM_OPTS.map((n) => <option key={n} value={n}>{n}+</option>)}
                    </select>
                  </div>
                  <label className="col-span-2 flex items-center gap-2 self-end pb-1 text-xs text-charcoal/80 sm:col-span-1">
                    <input type="checkbox" checked={refine.availableOnly}
                      onChange={(e) => setRefine((r) => ({ ...r, availableOnly: e.target.checked }))}
                      className="accent-copper" />
                    {L('وحدات متاحة فقط', 'Available only')}
                  </label>
                  <label className="col-span-2 flex items-center gap-2 self-end pb-1 text-xs text-charcoal/80 sm:col-span-1">
                    <input type="checkbox" checked={refine.verifiedOnly}
                      onChange={(e) => setRefine((r) => ({ ...r, verifiedOnly: e.target.checked }))}
                      className="accent-copper" />
                    {L('موثّق بالإحداثيات فقط', 'Coordinate-verified only')}
                  </label>
                  {refineIsActive(refine) && (
                    <button type="button" onClick={() => setRefine(REFINE_DEFAULT)}
                      className="col-span-2 inline-flex items-center justify-center gap-1 rounded-lg border border-sand/60 bg-white px-2 py-1 text-[11px] font-bold text-charcoal/70 transition hover:bg-cream/60 sm:col-span-3">
                      <RotateCcw size={12} /> {L('مسح التصفية الدقيقة', 'Clear refine')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Group tabs (counts reflect the refined set) */}
          {hasSearched && !loading && !error && fetchedTotal > 0 && (
            <div className="mb-3 flex flex-wrap gap-1">
              {FINDER_GROUP_KEYS.map((k) => {
                const count = refinedGroups[k].length;
                const on = activeTab === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setActiveTab(k)}
                    className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-bold transition ${on ? 'bg-copper text-white' : 'text-charcoal/70 hover:bg-cream/70'} ${count === 0 ? 'opacity-50' : ''}`}
                  >
                    {isAr ? TAB_LABELS[k].ar : TAB_LABELS[k].en}
                    <span className={`rounded-full px-1.5 text-[10px] ${on ? 'bg-white/25' : 'bg-sand/40'}`}>{count}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            {loading && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-charcoal/55">
                <Loader2 size={22} className="animate-spin text-copper" />
                <span className="text-sm">{L('جارٍ ترشيح المشاريع…', 'Finding the best-fit projects…')}</span>
              </div>
            )}
            {!loading && error && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
            )}
            {!loading && !error && !hasSearched && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-charcoal/55">
                <Compass size={26} className="text-copper/60" />
                <p className="text-sm">{L('حدّد التفضيلات واضغط «بحث» لعرض المشاريع المطابقة.', 'Set your preferences and press “Find projects” to see matches.')}</p>
              </div>
            )}
            {!loading && !error && hasSearched && fetchedTotal === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-charcoal/55">
                <Info size={22} className="text-copper" />
                <p className="text-sm">{L('لا توجد مشاريع مطابقة. جرّب توسيع الموقع أو الميزانية.', 'No matching projects. Try widening the location or budget.')}</p>
              </div>
            )}
            {!loading && !error && hasSearched && fetchedTotal > 0 && refinedTotal === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-charcoal/55">
                <Info size={22} className="text-copper" />
                <p className="text-sm">{L('لا نتائج بهذه التصفية. اخفض نسبة التطابق أو وسّع التصفية الدقيقة.', 'Nothing matches this refinement. Lower the score or relax the refine filters.')}</p>
              </div>
            )}
            {!loading && !error && refinedTotal > 0 && activeItems.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-charcoal/55">{L('لا نتائج في هذه المجموعة — جرّب تبويباً آخر.', 'Nothing in this group — try another tab.')}</div>
            )}

            {/* Market-source honesty notice (we never silently drop listings). */}
            {!loading && !error && resp?.metadata.market?.status === 'too_many' && (
              <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                <AlertTriangle size={13} className="shrink-0" />
                <span>{L('إعلانات السوق غير معروضة: عددها كبير في هذا الحي — أضف معايير أدق.', 'Market listings hidden: too many ads in this district — add finer criteria.')}</span>
              </div>
            )}

            {!loading && !error && shown.map((item) => (
              <FinderCard
                key={item.project_id}
                item={item}
                isAr={isAr}
                onOpenDetails={onOpenDetails}
                selected={false}
                onToggleSelect={() => {}}
                onSaveOption={() => {}}
                onEliminate={() => {}}
                onReactivate={() => {}}
                saveState="idle"
                existingStatus={null}
                hideClientActions
              />
            ))}
            {!loading && !error && activeItems.length > 0 && (
              <>
                {visibleCount < activeItems.length && <div ref={sentinelRef} className="h-1" aria-hidden />}
                <div className="py-2 text-center text-[11px] text-charcoal/45">
                  {L(`عرض ${shown.length} من ${activeItems.length}`, `Showing ${shown.length} of ${activeItems.length}`)}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
