import { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, Loader2, Search, RotateCcw, Info, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import DynamicField from '@/pages/Records/components/DynamicField';
import { draftToMatchRequirements, type MatchRequirementsInput } from '@/lib/matching/requirements';
import {
  fetchProjectFinder, totalFinderMatches,
  type FinderResponse, type FinderMatch, type FinderSource,
} from '@/lib/matching/projectFinder';
import {
  refineGroups, totalInGroups, buildFinderTabs, DISPLAY_TAB_KEYS, DISPLAY_TAB_LABELS,
  REFINE_DEFAULT, FETCH_FLOOR, BEDROOM_OPTS,
  type SortKey, type Refine, type DisplayTabKey,
} from '@/lib/matching/finderRefine';
import FinderCard from '@/pages/Followups/components/FinderCard';
import FinderRefinementBar, { type FinderViewMode } from '@/pages/Followups/components/FinderRefinementBar';
import FinderMapView from '@/pages/Followups/components/FinderMapView';
import type { AppModel, ModelField } from '@/types';

/** Small labelled divider used to head a card section (our projects / other options). */
function SectionLabel({ text, tone }: { text: string; tone: 'ours' | 'other' }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tone === 'ours' ? 'bg-green-600 text-white' : 'bg-sand/40 text-charcoal/60'}`}>{text}</span>
      <span className="h-px flex-1 bg-sand/40" />
    </div>
  );
}

/**
 * Standalone Project Finder — a self-service discovery tool reachable from the
 * sidebar, usable WITHOUT a client. The salesperson fills structured pickers
 * (location cascade, unit type, budget/area ranges, amenities — all sourced from
 * the live `clients` model's own field definitions, so there's NO free text and
 * NO AI), then runs the SAME deterministic, geography-verified /api/project-finder
 * the Follow-up "Suggested Projects" modal uses (parse:false, explain:false).
 *
 * The search always pulls EVERYTHING scoring ≥ FETCH_FLOOR. Above the results sits
 * the shared FinderRefinementBar (score slider + sort + hard refine filters) that
 * operates 100% client-side on that set — no re-fetch. Same bar is used in the
 * Follow-up modal so both surfaces behave identically.
 *
 * Difference from the Follow-up modal: there's no client to attach options to, so
 * the cards show "Details" only (hideClientActions) — no save / eliminate.
 */

// The clients-model field slugs the finder reads (mirrors the Follow-up draft
// shape consumed by draftToMatchRequirements). Rendered if present on the live model.
const FILTER_SLUGS = ['location', 'preferred_districts', 'preferred_unit_type', 'budget', 'preferred_area', 'preferred_amenities'] as const;

const SOURCE_LABELS: Record<FinderSource, { ar: string; en: string }> = {
  our_projects: { ar: 'مشاريعنا', en: 'Our Projects' },
  all_projects: { ar: 'كل المشاريع', en: 'All Projects' },
  market_listings: { ar: 'إعلانات السوق', en: 'Market listings' },
};

const PAGE = 24;

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
  const [activeTab, setActiveTab] = useState<DisplayTabKey>('exact_district_matches');
  const [viewMode, setViewMode] = useState<FinderViewMode>('list');
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
    // A fresh search resets the refinement controls so the full ≥ floor set is shown.
    setScoreThreshold(FETCH_FLOOR);
    setRefine(REFINE_DEFAULT);
    try {
      const r = await fetchProjectFinder(
        {
          requirements: buildRequirements(),
          // Standalone: no client → no geo-preference gate, no options to attach.
          // Pull EVERYTHING ≥ floor; the score slider refines upward client-side.
          perGroup: 0,
          minScore: FETCH_FLOOR,
          sources: chosenSources,
          locale: isAr ? 'ar' : 'en',
        },
        controller.signal,
      );
      setResp(r);
      // Land on the same-district tab; the auto-switch effect hops to the first
      // non-empty display tab if it has nothing (pinned our-projects aside).
      setActiveTab('exact_district_matches');
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

  // Apply the score threshold + refine post-filters, then sort — per group (shared engine).
  const refinedGroups = useMemo(
    () => refineGroups(resp?.groups, scoreThreshold, refine, sortKey),
    [resp, scoreThreshold, refine, sortKey],
  );

  const fetchedTotal = totalFinderMatches(resp);
  const refinedTotal = useMemo(() => totalInGroups(refinedGroups), [refinedGroups]);
  // Collapse to 3 display tabs + lift our-projects into a pinned top list.
  const tabView = useMemo(() => buildFinderTabs(refinedGroups), [refinedGroups]);
  const ourProjects = tabView.ourProjects;
  const tierItems = tabView.tabs[activeTab] ?? [];
  const activeCount = ourProjects.length + tierItems.length; // total cards in the active tab
  const shownTier = tierItems.slice(0, visibleCount);

  // Reset the render window whenever the visible list changes (tab / refine / sort / new results).
  useEffect(() => { setVisibleCount(PAGE); scrollRef.current?.scrollTo({ top: 0 }); }, [activeTab, tabView]);

  // If refining empties the active tab (pinned our-projects aside), hop to the first
  // display tab that still has matches.
  useEffect(() => {
    if (!resp) return;
    const tabHas = (k: DisplayTabKey) => ourProjects.length > 0 || tabView.tabs[k].length > 0;
    if (!tabHas(activeTab)) {
      const first = DISPLAY_TAB_KEYS.find(tabHas);
      if (first && first !== activeTab) setActiveTab(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabView]);

  // Grow the window as the sentinel scrolls into view (infinite scroll).
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setVisibleCount((c) => Math.min(c + PAGE, tierItems.length)); },
      { root, rootMargin: '800px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [tierItems.length, activeTab, visibleCount]);

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
          {/* Refinement toolbar (shared with the Follow-up modal). */}
          {hasSearched && !loading && !error && fetchedTotal > 0 && (
            <FinderRefinementBar
              isAr={isAr}
              floor={FETCH_FLOOR}
              scoreThreshold={scoreThreshold}
              onScore={setScoreThreshold}
              sortKey={sortKey}
              onSort={setSortKey}
              refine={refine}
              onRefine={setRefine}
              showRefine={showRefine}
              onToggleRefine={() => setShowRefine((v) => !v)}
              refinedTotal={refinedTotal}
              fetchedTotal={fetchedTotal}
              viewMode={viewMode}
              onViewMode={setViewMode}
            />
          )}

          {/* Display tabs (3): same district / nearby / alternatives. Count = pinned
              our-projects + this tab's other matches. */}
          {hasSearched && !loading && !error && fetchedTotal > 0 && (
            <div className="mb-3 flex flex-wrap gap-1">
              {DISPLAY_TAB_KEYS.map((k) => {
                const count = ourProjects.length + tabView.tabs[k].length;
                const on = activeTab === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setActiveTab(k)}
                    className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-bold transition ${on ? 'bg-copper text-white' : 'text-charcoal/70 hover:bg-cream/70'} ${count === 0 ? 'opacity-50' : ''}`}
                  >
                    {isAr ? DISPLAY_TAB_LABELS[k].ar : DISPLAY_TAB_LABELS[k].en}
                    <span className={`rounded-full px-1.5 text-[10px] ${on ? 'bg-white/25' : 'bg-sand/40'}`}>{count}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* MAP view — plots the active tab's pinned our-projects + other matches. */}
          {viewMode === 'map' && !loading && !error && activeCount > 0 && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <FinderMapView
                matches={[...ourProjects, ...tierItems]}
                isAr={isAr}
                onOpenDetails={onOpenDetails}
              />
            </div>
          )}

          <div
            ref={scrollRef}
            className={`min-h-0 flex-1 space-y-3 overflow-y-auto ${viewMode === 'map' && !loading && !error && activeCount > 0 ? 'hidden' : ''}`}
          >
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
            {!loading && !error && refinedTotal > 0 && activeCount === 0 && (
              <div className="px-4 py-8 text-center text-sm text-charcoal/55">{L('لا نتائج في هذه المجموعة — جرّب تبويباً آخر.', 'Nothing in this group — try another tab.')}</div>
            )}

            {/* Market-source honesty notice (we never silently drop listings). */}
            {!loading && !error && resp?.metadata.market?.status === 'too_many' && (
              <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                <AlertTriangle size={13} className="shrink-0" />
                <span>{L('إعلانات السوق غير معروضة: عددها كبير في هذا الحي — أضف معايير أدق.', 'Market listings hidden: too many ads in this district — add finer criteria.')}</span>
              </div>
            )}

            {/* Pinned OUR PROJECTS — best-first, shown at the top of every tab. */}
            {!loading && !error && ourProjects.length > 0 && (
              <>
                <SectionLabel text={L('مشاريعنا', 'Our Projects')} tone="ours" />
                {ourProjects.map((item) => (
                  <FinderCard
                    key={`our-${item.project_id}`}
                    item={item} isAr={isAr} onOpenDetails={onOpenDetails}
                    selected={false} onToggleSelect={() => {}} onSaveOption={() => {}}
                    onEliminate={() => {}} onReactivate={() => {}} saveState="idle" existingStatus={null}
                    hideClientActions
                  />
                ))}
                {tierItems.length > 0 && <SectionLabel text={L('خيارات أخرى', 'Other options')} tone="other" />}
              </>
            )}

            {/* This tab's other matches (all_projects + market_listings). */}
            {!loading && !error && shownTier.map((item) => (
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
            {!loading && !error && tierItems.length > 0 && (
              <>
                {visibleCount < tierItems.length && <div ref={sentinelRef} className="h-1" aria-hidden />}
                <div className="py-2 text-center text-[11px] text-charcoal/45">
                  {L(`عرض ${ourProjects.length + shownTier.length} من ${activeCount}`, `Showing ${ourProjects.length + shownTier.length} of ${activeCount}`)}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
