import { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, Loader2, Search, RotateCcw, Info, AlertTriangle, User, X, Bookmark, XCircle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import DynamicField from '@/pages/Records/components/DynamicField';
import { draftToMatchRequirements, type MatchRequirementsInput } from '@/lib/matching/requirements';
import {
  fetchProjectFinder, totalFinderMatches, FINDER_GROUP_KEYS,
  type FinderResponse, type FinderMatch, type FinderSource,
} from '@/lib/matching/projectFinder';
import {
  saveClientOption, eliminateOption, bulkSaveOptions, updateOptionStatus,
  finderSourceToOptionType, CLIENT_OPTION_STATUS_META,
  type ClientOptionStatus, type SaveOptionInput,
} from '@/lib/matching/clientOptions';
import {
  refineGroups, totalInGroups, buildFinderTabs, DISPLAY_TAB_KEYS, DISPLAY_TAB_LABELS,
  REFINE_DEFAULT, FETCH_FLOOR, BEDROOM_OPTS,
  type SortKey, type Refine, type DisplayTabKey,
} from '@/lib/matching/finderRefine';
import FinderCard from '@/pages/Followups/components/FinderCard';
import FinderRefinementBar, { type FinderViewMode } from '@/pages/Followups/components/FinderRefinementBar';
import FinderMapView from '@/pages/Followups/components/FinderMapView';
import ProjectWhatsAppFlow from '@/pages/Followups/components/ProjectWhatsAppFlow';
import ListingWhatsAppFlow from '@/components/matching/ListingWhatsAppFlow';
import LeaveWithoutSavingModal from '@/components/matching/LeaveWithoutSavingModal';
import { startFreezeDetector, markActivity } from '@/lib/perf/freezeDetector';
import type { AppModel, AppRecord, ModelField } from '@/types';

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
 * sidebar. The salesperson fills structured pickers (unified location editor with
 * district include/exclude + geo-element rules, unit type, budget/area ranges,
 * amenities — all sourced from the live `clients` model's own field definitions,
 * so there's NO free text and NO AI), then runs the SAME deterministic,
 * geography-verified /api/project-finder the Follow-up finder uses.
 *
 * It can be used WITHOUT a client (pure discovery — cards show Details only), OR
 * a client can be SELECTED at the top: their saved preferences seed the pickers,
 * the search is geo-gated for that client (client_id + location_items), and every
 * result card gains the full client-option actions — inline status selector,
 * bulk-select + save, and eliminate — writing into that client's unified options.
 *
 * The search always pulls EVERYTHING scoring ≥ FETCH_FLOOR. Above the results sits
 * the shared FinderRefinementBar (score slider + sort + hard refine filters) that
 * operates 100% client-side on that set — no re-fetch. Same bar + FinderCard are
 * used in the Follow-up finder so both surfaces behave identically.
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
const noop = () => {};

/** Best-effort human label for a client record (name → code → phone → id). */
function clientLabel(rec: AppRecord): string {
  const d = rec.data as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  return pick(d.client_name) || pick(d.client_code) || pick(d.phone_number) || rec.id.slice(0, 8);
}

export default function ProjectFinderPage() {
  const language = useAppStore((s) => s.language);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);
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

  // ── Selected client (optional). When set, the search is geo-gated for them and
  //    result cards can save options into their unified list. ──
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [clientQuery, setClientQuery] = useState('');
  const [clientPickerOpen, setClientPickerOpen] = useState(false);

  const clientRec = useMemo<AppRecord | null>(() => {
    if (!selectedClientId || !clientsModel) return null;
    return (records[clientsModel.id] ?? []).find((r) => r.id === selectedClientId) ?? null;
  }, [selectedClientId, clientsModel, records]);

  const filteredClients = useMemo<AppRecord[]>(() => {
    if (!clientsModel) return [];
    const all = records[clientsModel.id] ?? [];
    const q = clientQuery.trim().toLowerCase();
    if (!q) return all.slice(0, 30);
    return all
      .filter((r) => {
        const d = r.data as Record<string, unknown>;
        return [d.client_name, d.phone_number, d.client_code].some(
          (v) => typeof v === 'string' && v.toLowerCase().includes(q),
        );
      })
      .slice(0, 30);
  }, [clientsModel, records, clientQuery]);

  // Client-option cross-reference (each card shows its saved status for THIS client).
  const clientOptionsModelId = useMemo(
    () => models.find((m) => m.name === 'client_property_options')?.id ?? null,
    [models],
  );
  const existingByKey = useMemo(() => {
    const map: Record<string, ClientOptionStatus> = {};
    if (!clientOptionsModelId || !selectedClientId) return map;
    for (const r of records[clientOptionsModelId] ?? []) {
      if (r.data.client_id !== selectedClientId) continue;
      map[`${r.data.source_type}:${r.data.source_id}`] = r.data.status as ClientOptionStatus;
    }
    return map;
  }, [records, clientOptionsModelId, selectedClientId]);
  const existingStatusFor = (item: FinderMatch): ClientOptionStatus | null =>
    existingByKey[`${finderSourceToOptionType(item.source)}:${item.project_id}`] ?? null;

  // Results-refinement state (all client-side over the ≥ FETCH_FLOOR set).
  const [scoreThreshold, setScoreThreshold] = useState<number>(FETCH_FLOOR);
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [showRefine, setShowRefine] = useState(false);
  const [refine, setRefine] = useState<Refine>(REFINE_DEFAULT);

  // Client-option action state (used only when a client is selected).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saveStates, setSaveStates] = useState<Record<string, 'idle' | 'saving' | 'saved'>>({});
  const [bulkSaving, setBulkSaving] = useState(false);
  const [eliminateTarget, setEliminateTarget] = useState<FinderMatch | null>(null);
  const [eliminateNotes, setEliminateNotes] = useState('');
  const [eliminating, setEliminating] = useState(false);
  // "Send to client" from a card — only offered while a client is selected.
  const [sendTarget, setSendTarget] = useState<FinderMatch | null>(null);
  // Whether at least ONE option was saved for the selected client this session —
  // clearing the client (or closing the tab) without it triggers a confirmation.
  const [savedAny, setSavedAny] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

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

  // Seed the pickers from a client's saved preferences (location + rules, unit
  // type, budget, area, amenities, bedrooms). Resets any in-flight results.
  function selectClient(id: string) {
    setSelectedClientId(id);
    setClientPickerOpen(false);
    setClientQuery('');
    setSelected(new Set());
    setSaveStates({});
    setSavedAny(false);
    const rec = clientsModel ? (records[clientsModel.id] ?? []).find((r) => r.id === id) : null;
    if (rec) {
      const d = rec.data as Record<string, unknown>;
      const next: Record<string, unknown> = {};
      for (const slug of FILTER_SLUGS) next[slug] = d[slug];
      next.location_items = d.location_items ?? [];
      setDraft(next);
      const pb = d.preferred_bedrooms;
      const bn = typeof pb === 'number' ? pb : pb && typeof pb === 'object' ? Number((pb as Record<string, unknown>).min) : NaN;
      setBedrooms(Number.isFinite(bn) && bn > 0 ? bn : '');
    }
    setResp(null);
    setError(null);
    setHasSearched(false);
  }

  function clearClient() {
    setSelectedClientId(null);
    setSelected(new Set());
    setSaveStates({});
    setSavedAny(false);
    setConfirmLeave(false);
  }

  function buildRequirements(): MatchRequirementsInput {
    const reqs = draftToMatchRequirements({
      clientsModel, prefDraft: draft, savedClientData: clientRec?.data ?? null, resolveLookupName,
    });
    if (typeof bedrooms === 'number' && bedrooms > 0) reqs.bedrooms = bedrooms;
    return reqs;
  }

  const hasAnyCriteria = useMemo(() => {
    const r = buildRequirements();
    return Object.keys(r).length > 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, bedrooms, resolveLookupName, clientRec]);

  const controllerRef = useRef<AbortController | null>(null);

  // Install the console-only freeze detector once (diagnoses main-thread hangs).
  useEffect(() => { startFreezeDetector(); }, []);

  async function runSearch() {
    markActivity('finder: search request');
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
          // A selected client geo-gates the search (client_id + their current
          // location_items) and lets us attach options; without one it's pure
          // discovery pulling EVERYTHING ≥ floor (score slider refines upward).
          clientId: selectedClientId ?? undefined,
          locationItems: Array.isArray(draft.location_items) ? draft.location_items : undefined,
          perGroup: 0,
          minScore: FETCH_FLOOR,
          sources: chosenSources,
          locale: isAr ? 'ar' : 'en',
        },
        controller.signal,
      );
      markActivity('finder: rendering results');
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
    setSelected(new Set());
    setSaveStates({});
  }

  useEffect(() => () => controllerRef.current?.abort(), []);

  function onOpenDetails(item: FinderMatch) {
    const model = item.source === 'market_listings' ? 'market_listings' : 'all_projects';
    window.open(`/model/${model}/${item.project_id}`, '_blank', 'noopener');
  }

  // ── Client-option actions (mirrors the Follow-up finder). Guarded by a selected client. ──
  function matchToInput(item: FinderMatch): Omit<SaveOptionInput, 'clientId'> {
    return {
      sourceType: finderSourceToOptionType(item.source),
      sourceId: item.project_id,
      sourceName: item.project_name,
      matchScore: item.score,
      matchRunId: resp?.metadata.generated_at ?? null,
      facts: item.facts,
      status: 'suitable',
    };
  }

  function toggleSelect(item: FinderMatch) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.project_id)) next.delete(item.project_id);
      else next.add(item.project_id);
      return next;
    });
  }

  const openEliminate = (item: FinderMatch) => { setEliminateNotes(''); setEliminateTarget(item); };

  // Inline status pick from a card. 'eliminated' routes through the reason modal;
  // every other status ensures the option exists then applies it (main_focus →
  // single active main; any non-eliminated pick reactivates an eliminated option).
  async function onSetStatus(item: FinderMatch, status: ClientOptionStatus) {
    if (!selectedClientId) return;
    if (status === 'eliminated') { openEliminate(item); return; }
    setSaveStates((s) => ({ ...s, [item.project_id]: 'saving' }));
    const ensured = await saveClientOption({ clientId: selectedClientId, ...matchToInput(item), addedFrom: 'project_finder', status });
    let ok = ensured.ok;
    if (ensured.optionId) {
      const res = await updateOptionStatus(ensured.optionId, status);
      ok = res.ok;
    }
    setSaveStates((s) => ({ ...s, [item.project_id]: 'idle' }));
    if (ok) setSavedAny(true);
    const label = isAr ? CLIENT_OPTION_STATUS_META[status].ar : CLIENT_OPTION_STATUS_META[status].en;
    addToast(
      ok ? L(`تم ضبط الحالة: ${label}`, `Status set: ${label}`) : L('تعذّر ضبط الحالة.', 'Could not set status.'),
      ok ? 'success' : 'error',
    );
  }

  async function onBulkSave() {
    if (!selectedClientId || selected.size === 0) return;
    const all = FINDER_GROUP_KEYS.flatMap((k) => refinedGroups[k]);
    const chosen = all.filter((i) => selected.has(i.project_id));
    setBulkSaving(true);
    const summary = await bulkSaveOptions(selectedClientId, chosen.map(matchToInput), 'project_finder');
    setBulkSaving(false);
    const saved = summary.created + summary.updated;
    if (saved > 0) setSavedAny(true);
    const parts: string[] = [];
    if (saved > 0) parts.push(L(`حُفظ ${saved}`, `${saved} saved`));
    if (summary.skippedEliminated > 0) parts.push(L(`${summary.skippedEliminated} مستبعد (تجاهل)`, `${summary.skippedEliminated} eliminated (skipped)`));
    if (summary.failed > 0) parts.push(L(`${summary.failed} فشل`, `${summary.failed} failed`));
    addToast(parts.join(' · ') || L('لا تغييرات', 'No changes'), summary.failed > 0 ? 'error' : 'success');
  }

  async function confirmEliminate() {
    if (!eliminateTarget || !selectedClientId) { setEliminateTarget(null); return; }
    setEliminating(true);
    const ensured = await saveClientOption({ clientId: selectedClientId, ...matchToInput(eliminateTarget), addedFrom: 'project_finder' });
    let ok = ensured.ok;
    if (ensured.optionId) {
      const res = await eliminateOption(ensured.optionId, eliminateNotes.trim());
      ok = res.ok;
    }
    setEliminating(false);
    if (ok) {
      setSavedAny(true);
      addToast(L('تم استبعاد الخيار.', 'Option eliminated.'), 'success');
      setEliminateTarget(null);
      setEliminateNotes('');
    } else {
      addToast(L('تعذّر استبعاد الخيار.', 'Could not eliminate the option.'), 'error');
    }
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

  const selectedVisible = useMemo(
    () => (selectedClientId ? FINDER_GROUP_KEYS.reduce((n, k) => n + refinedGroups[k].filter((i) => selected.has(i.project_id)).length, 0) : 0),
    [selectedClientId, refinedGroups, selected],
  );

  // Dropping the client (or closing the tab) without having saved a single
  // option for them — after results were shown — needs a confirmation.
  const mustConfirmLeave = !!selectedClientId && !savedAny && fetchedTotal > 0;
  function requestClearClient() {
    if (mustConfirmLeave) setConfirmLeave(true);
    else clearClient();
  }
  useEffect(() => {
    if (!mustConfirmLeave) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [mustConfirmLeave]);

  // One card, wired for a selected client (full actions) or read-only discovery.
  const renderCard = (item: FinderMatch, key: string) => (
    <FinderCard
      key={key}
      item={item}
      isAr={isAr}
      onOpenDetails={onOpenDetails}
      selected={selectedClientId ? selected.has(item.project_id) : false}
      onToggleSelect={selectedClientId ? toggleSelect : noop}
      onSaveOption={noop}
      onEliminate={noop}
      onReactivate={noop}
      onSetStatus={selectedClientId ? onSetStatus : undefined}
      onSendToClient={clientRec ? setSendTarget : undefined}
      saveState={selectedClientId ? saveStates[item.project_id] ?? 'idle' : 'idle'}
      existingStatus={selectedClientId ? existingStatusFor(item) : null}
      hideClientActions={!selectedClientId}
    />
  );

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
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold text-chocolate">{L('الباحث عن المشاريع', 'Project Finder')}</h1>
          <p className="text-xs text-charcoal/60">
            {L('ابحث عن المشاريع المطابقة بالحقول والخيارات — مع عميل أو بدونه، وبدون نص حر أو ذكاء اصطناعي.',
               'Find matching projects by structured fields — with or without a client, no free text, no AI.')}
          </p>
        </div>
        {selectedClientId && (
          <button
            type="button"
            onClick={onBulkSave}
            disabled={bulkSaving || selectedVisible === 0}
            title={L('حفظ المحدّد كخيارات للعميل', 'Save selected to client options')}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-copper px-4 py-2 text-sm font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
          >
            {bulkSaving ? <Loader2 size={16} className="animate-spin" /> : <Bookmark size={16} />}
            <span className="hidden sm:inline">{L('حفظ الخيارات', 'Save options')}</span>
            <span className="rounded-full bg-white/25 px-1.5 text-[11px]">{selectedVisible}</span>
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 lg:flex-row lg:overflow-hidden">
        {/* ── Filters ── */}
        <div className="w-full shrink-0 lg:w-[340px] lg:overflow-y-auto">
          <div className="card p-5">
            {!clientsModel ? (
              <div className="text-sm text-charcoal/60">{L('نموذج العملاء غير محمّل.', 'Clients model not loaded.')}</div>
            ) : (
              <div className="space-y-4">
                {/* ── Client picker (optional) ── */}
                <div>
                  <label className="mb-1 block text-xs font-bold text-charcoal/70">{L('العميل (اختياري)', 'Client (optional)')}</label>
                  {clientRec ? (
                    <div className="flex items-center gap-2 rounded-lg border border-copper/40 bg-copper/5 px-3 py-2">
                      <User size={15} className="shrink-0 text-copper" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold text-charcoal">{clientLabel(clientRec)}</div>
                        <div className="text-[11px] text-charcoal/55">{L('البحث والخيارات مرتبطة بهذا العميل', 'Search & options are tied to this client')}</div>
                      </div>
                      <button
                        type="button"
                        onClick={requestClearClient}
                        className="shrink-0 rounded-md p-1 text-charcoal/45 transition hover:bg-white hover:text-red-600"
                        title={L('إزالة العميل', 'Clear client')}
                        aria-label={L('إزالة العميل', 'Clear client')}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ) : (
                    <div className="relative">
                      <div className="flex items-center gap-1.5 rounded-lg border border-sand/60 bg-white px-2.5 py-1.5">
                        <Search size={14} className="shrink-0 text-charcoal/40" />
                        <input
                          type="text"
                          value={clientQuery}
                          onChange={(e) => { setClientQuery(e.target.value); setClientPickerOpen(true); }}
                          onFocus={() => setClientPickerOpen(true)}
                          placeholder={L('ابحث بالاسم أو الجوال…', 'Search by name or phone…')}
                          className="w-full bg-transparent text-sm text-charcoal placeholder:text-charcoal/35 focus:outline-none"
                        />
                      </div>
                      {clientPickerOpen && (
                        <div className="fixed inset-0 z-10" onClick={() => setClientPickerOpen(false)} aria-hidden />
                      )}
                      {clientPickerOpen && (
                        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-sand/60 bg-white shadow-lg">
                          {filteredClients.length === 0 ? (
                            <div className="px-3 py-2 text-xs text-charcoal/50">{L('لا عملاء مطابقون', 'No matching clients')}</div>
                          ) : (
                            filteredClients.map((r) => {
                              const d = r.data as Record<string, unknown>;
                              const phone = typeof d.phone_number === 'string' ? d.phone_number : '';
                              return (
                                <button
                                  key={r.id}
                                  type="button"
                                  onClick={() => selectClient(r.id)}
                                  className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm transition hover:bg-cream/70"
                                >
                                  <User size={14} className="shrink-0 text-charcoal/40" />
                                  <span className="min-w-0 flex-1 truncate font-semibold text-charcoal">{clientLabel(r)}</span>
                                  {phone && <span className="shrink-0 text-[11px] text-charcoal/45" dir="ltr">{phone}</span>}
                                </button>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

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
                      modelId={clientsModel.id}
                      recordId={selectedClientId ?? undefined}
                      onPatch={(patch) => setDraft((d) => ({ ...d, ...patch }))}
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
                renderSelectedCard={(m) => renderCard(m, `map-${m.project_id}`)}
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
                {ourProjects.map((item) => renderCard(item, `our-${item.project_id}`))}
                {tierItems.length > 0 && <SectionLabel text={L('خيارات أخرى', 'Other options')} tone="other" />}
              </>
            )}

            {/* This tab's other matches (all_projects + market_listings). */}
            {!loading && !error && shownTier.map((item) => renderCard(item, item.project_id))}
            {!loading && !error && tierItems.length > 0 && (
              <>
                {visibleCount < tierItems.length && <div ref={sentinelRef} className="h-1" aria-hidden />}
                <div className="py-2 text-center text-[11px] text-charcoal/45">
                  {L(`عرض ${ourProjects.length + shownTier.length} من ${activeCount}`, `Showing ${ourProjects.length + shownTier.length} of ${activeCount}`)}
                </div>
              </>
            )}
          </div>

          {/* Footer — selection summary (the Save-options action lives in the header). */}
          {selectedClientId && !loading && !error && fetchedTotal > 0 && (
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-sand/40 pt-2">
              <span className="text-xs text-charcoal/60">{L(`${selectedVisible} محدّد`, `${selectedVisible} selected`)}</span>
              {!savedAny && (
                <span className="text-[11px] font-semibold text-amber-700">
                  {L('لم يُحفظ أي خيار لهذا العميل بعد.', 'No option saved for this client yet.')}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* "Send to client" WhatsApp flow — stored message → chat composer;
          missing message → creation flow first. Client is always set here
          (the button only renders while one is selected). */}
      {sendTarget && clientRec && (
        sendTarget.source === 'market_listings' ? (
          <ListingWhatsAppFlow
            isAr={isAr}
            listingId={sendTarget.project_id}
            listingName={sendTarget.project_name}
            clientRec={clientRec}
            onClose={() => setSendTarget(null)}
          />
        ) : (
          <ProjectWhatsAppFlow
            isAr={isAr}
            projectId={sendTarget.project_id}
            projectName={sendTarget.project_name}
            clientRec={clientRec}
            onClose={() => setSendTarget(null)}
          />
        )
      )}

      {/* Clearing the client without saving any option → confirm first. */}
      {confirmLeave && clientRec && (
        <LeaveWithoutSavingModal
          isAr={isAr}
          clientName={clientLabel(clientRec)}
          onStay={() => setConfirmLeave(false)}
          onLeave={clearClient}
        />
      )}

      {/* Eliminate-with-notes prompt */}
      {eliminateTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4" onMouseDown={() => !eliminating && setEliminateTarget(null)}>
          <div className="w-full max-w-md rounded-2xl bg-cream p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()} dir={isAr ? 'rtl' : 'ltr'}>
            <div className="mb-2 flex items-center gap-2 text-chocolate">
              <XCircle size={18} className="text-red-600" />
              <h3 className="text-base font-bold">{L('استبعاد الخيار', 'Eliminate option')}</h3>
            </div>
            <p className="mb-3 text-sm text-charcoal/70">{eliminateTarget.project_name}</p>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">{L('سبب الاستبعاد', 'Elimination reason')}</label>
            <textarea
              value={eliminateNotes}
              onChange={(e) => setEliminateNotes(e.target.value)}
              rows={3}
              autoFocus
              placeholder={L('مثال: خارج الميزانية، الموقع بعيد…', 'e.g. over budget, location too far…')}
              className="form-input w-full resize-none"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => !eliminating && setEliminateTarget(null)} className="rounded-lg border border-sand/60 bg-white px-3 py-2 text-sm font-bold text-charcoal/75 transition hover:bg-cream/60">
                {L('إلغاء', 'Cancel')}
              </button>
              <button type="button" onClick={confirmEliminate} disabled={eliminating} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50">
                {eliminating ? <Loader2 size={15} className="animate-spin" /> : <XCircle size={15} />}
                {L('استبعاد', 'Eliminate')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
