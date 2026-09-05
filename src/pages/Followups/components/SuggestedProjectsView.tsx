import { buildGeoNameMap } from '@/lib/geo/geoNameMap';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, Check, Loader2, AlertTriangle, Info, Bookmark, XCircle, SlidersHorizontal, Search, Save, ChevronDown, ChevronUp, TimerOff, RefreshCw, CheckSquare, List, Map as MapIcon, Maximize2, Columns2 } from 'lucide-react';
import type { AppModel, AppRecord, ModelField } from '@/types';
import { useAppStore } from '@/stores/appStore';
import DynamicField from '@/pages/Records/components/DynamicField';
import { buildAssistantContext } from '@/lib/followups/assistantContext';
import { draftToMatchRequirements, type MatchRequirementsInput } from '@/lib/matching/requirements';
import {
  fetchProjectFinder, totalFinderMatches, FINDER_GROUP_KEYS, FinderRequestError,
  type FinderResponse, type FinderMatch,
} from '@/lib/matching/projectFinder';
import {
  saveClientOption, eliminateOption, reactivateOption, bulkSaveOptions, updateOptionStatus,
  finderSourceToOptionType, findClientOption, CLIENT_OPTION_STATUS_META,
  type ClientOptionStatus, type SaveOptionInput,
} from '@/lib/matching/clientOptions';
import {
  refineGroups, totalInGroups, buildFinderTabs, DISPLAY_TAB_KEYS, DISPLAY_TAB_LABELS,
  REFINE_DEFAULT, FETCH_FLOOR,
  type SortKey, type Refine, type DisplayTabKey,
} from '@/lib/matching/finderRefine';
import { summarizeConstraintDrops } from '@/lib/matching/constraints';
import { setFinderHandoff } from '@/lib/matching/finderHandoff';
import { preferencesDirty, saveClientPreferences } from '@/lib/clients/preferences';
import { saveFinderStash, loadFinderStash, clearFinderStash, type FinderStash } from '@/lib/matching/finderStash';
import { setFormUnsaved } from '@/lib/staleBuild';
import { startFreezeDetector, markActivity } from '@/lib/perf/freezeDetector';
import { chatPdfFromClient } from '@/lib/projects/sendPdfToChat';
import FinderCard from './FinderCard';
import FinderRefinementBar, { type FinderViewMode } from './FinderRefinementBar';
import FinderMapView from './FinderMapView';
import { collectClientAreaItems } from '@/lib/geo/clientArea';
import ProjectWhatsAppFlow from './ProjectWhatsAppFlow';
import ListingWhatsAppFlow from '@/components/matching/ListingWhatsAppFlow';
import LeaveWithoutSavingModal from '@/components/matching/LeaveWithoutSavingModal';

/** List / map results-view toggle. Lives in the ALWAYS-VISIBLE bottom bar so the
 *  rep can switch views no matter how the refine controls above are collapsed
 *  (moved out of FinderRefinementBar for exactly that — user report 2026-08-24:
 *  "the list and map view buttons should be below so they are always shown"). */
function ViewToggle({ viewMode, onViewMode, isAr }: { viewMode: FinderViewMode; onViewMode: (m: FinderViewMode) => void; isAr: boolean }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  return (
    <div className="flex items-center rounded-lg border border-sand/60 bg-white p-0.5">
      <button
        type="button"
        onClick={() => onViewMode('list')}
        className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-bold transition ${viewMode === 'list' ? 'bg-copper text-white' : 'text-charcoal/60 hover:bg-cream/60'}`}
        aria-pressed={viewMode === 'list'}
      >
        <List size={13} /> {L('قائمة', 'List')}
      </button>
      <button
        type="button"
        onClick={() => onViewMode('map')}
        className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-bold transition ${viewMode === 'map' ? 'bg-copper text-white' : 'text-charcoal/60 hover:bg-cream/60'}`}
        aria-pressed={viewMode === 'map'}
      >
        <MapIcon size={13} /> {L('خريطة', 'Map')}
      </button>
    </div>
  );
}

/** Small labelled divider heading a card section (our projects / other options). */
function SectionLabel({ text, tone }: { text: string; tone: 'ours' | 'other' }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tone === 'ours' ? 'bg-green-600 text-white' : 'bg-sand/40 text-charcoal/60'}`}>{text}</span>
      <span className="h-px flex-1 bg-sand/40" />
    </div>
  );
}

/**
 * The "Suggested Projects" finder rendered as a FULL PAGE (was a cramped modal).
 * Reached at /model/followups/:id/projects — stays connected to the follow-up via
 * its id (audit log + saves into THAT client's options) and matches against the
 * preference draft handed off from the workspace (unsaved edits included).
 *
 * In addition to the client-side refinement toolbar (slider / sort / hard
 * filters), the rep can EDIT the client's preferences here (location, unit type,
 * budget, area, bedrooms, amenities) and press "Search" to RE-RUN the server-side
 * deterministic match — a genuinely more-detailed search. The edits also carry
 * back to the workspace (hand-off).
 *
 * SAVING the preferences and SEARCHING are two separate actions (2026-08-18).
 * "Save preferences only" persists them onto the client record and stays put —
 * the WhatsApp Client-Options popup embeds this view, so a rep noting down what
 * a client just said must not have to run a whole projects + market search to
 * record it. "Search" keeps saving first (the server geo-gate compiles from the
 * SAVED client, so an unsaved district rule wouldn't affect the results) and
 * then runs the match. Both go through the shared `saveClientPreferences`.
 *
 * A prominent "Done" button (onDone) returns the rep to the follow-up record.
 */

/**
 * A snapshot of the finder's in-memory working session — the edited preferences,
 * the results they produced, and the view state around them. A host that mounts
 * this component in two interchangeable shells (the WhatsApp Client-Options
 * modal: a docked side panel AND a full-screen modal are two DIFFERENT instances)
 * passes a shared `sessionRef`; the finder restores from it on mount and mirrors
 * into it on every change, so Split↔Full-screen no longer bins the rep's typed
 * preferences and search results (user report 2026-09-05). `clientId` guards the
 * restore so switching the viewed client never rehydrates the wrong session.
 */
export interface FinderSession {
  clientId: string | null;
  editDraft: Record<string, unknown>;
  searchedDraft: Record<string, unknown>;
  lastDraft: Record<string, unknown>;
  resp: FinderResponse | null;
  loading: boolean;
  hasSearched: boolean;
  showEdit: boolean;
  showPrefs: boolean;
  showControls: boolean;
  viewMode: FinderViewMode;
  activeTab: DisplayTabKey;
  scoreThreshold: number;
  sortKey: SortKey;
  refine: Refine;
  showRefine: boolean;
  visibleCount: number;
  selected: string[];
  savedAny: boolean;
}

interface Props {
  isAr: boolean;
  clientsModel: AppModel | null;
  clientRec: AppRecord | null;
  prefDraft: Record<string, unknown>;
  followupDraft: Record<string, unknown>;
  followupId: string | null;
  projectName?: string | null;
  clientName?: string | null;
  /** Start with the preferences-chips area collapsed — popup hosts (e.g. the
   *  WhatsApp Client-Options modal) set this so the results get the height.
   *  The rep can always expand/collapse it with the toggle. */
  defaultPrefsCollapsed?: boolean;
  /** Open with the EDIT-PREFERENCES panel and DON'T auto-run the first search
   *  (user request 2026-07-19: "inside the chat I should be able to edit the
   *  preferences BEFORE the search starts"). The rep reviews/adjusts, then
   *  presses Search. Hosts that want the old fire-immediately behavior (the
   *  follow-up workspace, the standalone page) simply omit this. */
  editPrefsFirst?: boolean;
  onDone: () => void;
  /** Open a result's SOURCE (project / market listing) as an in-place overlay
   *  the host can back out of, instead of the default new-tab `window.open`.
   *  In-chat hosts pass this so "Details" returns to THIS finder, not the
   *  All Projects list. Absent = the old new-tab behaviour (standalone page /
   *  follow-up workspace). */
  onOpenSource?: (sourceType: 'project' | 'market_listing', sourceId: string) => void;
  /** When set, a header button lets the rep switch the HOST surface between the
   *  docked split panel and the full-screen modal — so the Split/Full-screen
   *  choice is available here too, not only on the options list before entering
   *  the finder (user request 2026-08-31). Passed only by the in-chat Client
   *  Options host on a wide screen; the standalone page / workspace omit it. */
  onToggleLayout?: () => void;
  /** Whether the host is CURRENTLY docked — picks the button's icon/label
   *  (docked → "Full screen", modal → "Split"). */
  layoutDocked?: boolean;
  /** Shared holder for the finder's working session. When present, the finder
   *  restores its edited preferences + results + view state from it on mount and
   *  keeps it current on every change — so a host that swaps this component
   *  between two shells (docked panel ↔ full-screen modal) doesn't lose the
   *  rep's unsaved preferences across the switch. Omit for hosts with a single
   *  stable mount (the standalone page, the follow-up workspace). */
  sessionRef?: { current: FinderSession | null };
}

const MISSING_LABELS: Record<string, { ar: string; en: string }> = {
  budget: { ar: 'الميزانية', en: 'Budget' },
  location: { ar: 'الحي / المدينة', en: 'District / City' },
  unit_type: { ar: 'نوع العقار', en: 'Unit type' },
  bedrooms: { ar: 'عدد الغرف', en: 'Bedrooms' },
};

// Client preference fields the rep can edit here to refine the search, in order.
// Only those present on the live clients model are rendered.
const EDIT_SLUGS = ['location', 'preferred_districts', 'preferred_unit_type', 'preferred_max_unit_age', 'budget', 'preferred_area', 'preferred_bedrooms', 'preferred_amenities'] as const;

const PAGE = 24;

export default function SuggestedProjectsView({
  isAr, clientsModel, clientRec, prefDraft, followupDraft, followupId, projectName, clientName,
  defaultPrefsCollapsed, editPrefsFirst, onDone, onOpenSource, onToggleLayout, layoutDocked, sessionRef,
}: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);
  const saveRecord = useAppStore((s) => s.saveRecord);

  // A persisted session left by a previous mount in the SAME shell-switch (e.g.
  // Split↔Full-screen) — restored only when it belongs to the client on screen,
  // so switching clients never rehydrates the wrong session. Captured once at
  // mount; every state below seeds from it when present.
  const restored =
    sessionRef?.current && sessionRef.current.clientId === (clientRec?.id ?? null)
      ? sessionRef.current
      : null;

  // A client is attached → each card's units popup can SEND the units-table +
  // single-unit PDFs to the client (derived conversation), not just download.
  const chatPdf = useMemo(() => chatPdfFromClient(clientRec), [clientRec]);

  const [resp, setResp] = useState<FinderResponse | null>(restored?.resp ?? null);
  // Starts true because the search normally fires on mount — but NOT when the
  // host defers it (editPrefsFirst), or the spinner would hang forever in place
  // of the start screen (caught in the live smoke-test 2026-07-19). A restored
  // session keeps its own loading flag (a search in flight at the swap resumes).
  const [loading, setLoading] = useState(restored ? restored.loading : !editPrefsFirst);
  const [error, setError] = useState<{ message: string; timeout: boolean } | null>(null);
  const [activeTab, setActiveTab] = useState<DisplayTabKey>(restored?.activeTab ?? 'exact_district_matches');
  const [viewMode, setViewMode] = useState<FinderViewMode>(restored?.viewMode ?? 'list');
  // "Show on map" from a card: switch to the map and open/center that pin. The
  // nonce lets the same project be re-focused (e.g. clicked twice).
  const [mapFocus, setMapFocus] = useState<{ id: string; nonce: number } | null>(null);
  const mapFocusNonce = useRef(0);
  const [visibleCount, setVisibleCount] = useState(restored?.visibleCount ?? PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(restored?.selected ?? []));
  const [saveStates, setSaveStates] = useState<Record<string, 'idle' | 'saving' | 'saved'>>({});
  const [bulkSaving, setBulkSaving] = useState(false);
  const [eliminateTarget, setEliminateTarget] = useState<FinderMatch | null>(null);
  const [eliminateNotes, setEliminateNotes] = useState('');
  const [eliminating, setEliminating] = useState(false);
  // "Send to client" from a card — the WhatsApp flow modal for this match.
  const [sendTarget, setSendTarget] = useState<FinderMatch | null>(null);
  // Whether at least ONE option was saved for the client during THIS visit —
  // leaving (Done / Esc / unload) without it triggers a confirmation.
  const [savedAny, setSavedAny] = useState(restored?.savedAny ?? false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  // Results-refinement (shared with the standalone Project Finder page).
  const [scoreThreshold, setScoreThreshold] = useState<number>(restored?.scoreThreshold ?? FETCH_FLOOR);
  const [sortKey, setSortKey] = useState<SortKey>(restored?.sortKey ?? 'score');
  const [showRefine, setShowRefine] = useState(restored?.showRefine ?? false);
  const [refine, setRefine] = useState<Refine>(restored?.refine ?? REFINE_DEFAULT);

  // Editable preference draft + the draft the CURRENT results were searched with.
  const [editDraft, setEditDraft] = useState<Record<string, unknown>>(() => ({ ...(restored?.editDraft ?? prefDraft) }));
  const [searchedDraft, setSearchedDraft] = useState<Record<string, unknown>>(() => ({ ...(restored?.searchedDraft ?? prefDraft) }));
  const [showEdit, setShowEdit] = useState(restored ? restored.showEdit : !!editPrefsFirst);
  // False until a search has actually been run — drives the "review your
  // preferences, then search" start screen when editPrefsFirst defers it.
  const [hasSearched, setHasSearched] = useState(restored ? restored.hasSearched : !editPrefsFirst);
  const [savingPrefs, setSavingPrefs] = useState(false);
  // Version this surface loaded the client with (optimistic concurrency). Pinned
  // in a ref and bumped after each successful save so a second save in the same
  // session can't self-conflict; re-pinned when the viewed client changes.
  const prefVersionRef = useRef<{ id: string; version: number | null } | null>(null);
  if (clientRec && prefVersionRef.current?.id !== clientRec.id) {
    prefVersionRef.current = { id: clientRec.id, version: clientRec.version ?? null };
  }
  // The preferences-chips area (QA: collapsible so popup results get the height).
  const [showPrefs, setShowPrefs] = useState(restored ? restored.showPrefs : !defaultPrefsCollapsed);
  // The refinement toolbar + group tabs — collapsible so the results/map get the
  // full height when the rep just wants to browse.
  const [showControls, setShowControls] = useState(restored ? restored.showControls : true);

  // Cross-reference the client's already-saved options so each card shows its status.
  const clientOptionsModelId = useMemo(
    () => models.find((m) => m.name === 'client_property_options')?.id ?? null,
    [models],
  );
  const existingByKey = useMemo(() => {
    const map: Record<string, ClientOptionStatus> = {};
    if (!clientOptionsModelId || !clientRec?.id) return map;
    for (const r of records[clientOptionsModelId] ?? []) {
      if (r.data.client_id !== clientRec.id) continue;
      map[`${r.data.source_type}:${r.data.source_id}`] = r.data.status as ClientOptionStatus;
    }
    return map;
  }, [records, clientOptionsModelId, clientRec]);
  const existingStatusFor = (item: FinderMatch): ClientOptionStatus | null =>
    existingByKey[`${finderSourceToOptionType(item.source)}:${item.project_id}`] ?? null;

  // ISSUE #8 — id → LOCALIZED name (was a single Arabic string, which leaked
  // into English assistant prefaces). The MATCHER still wants Arabic: it fuzzy-
  // matches against Arabic project text, so resolveLookupName returns `.ar`.
  const geoNames = useMemo(() => buildGeoNameMap(models, records), [models, records]);
  const resolveLookupName = useMemo(
    () => (id: string, _target: 'districts' | 'cities'): string | null => geoNames[id]?.ar ?? null,
    [geoNames],
  );

  // Preference chips reflect the LAST SEARCHED draft (so they match the results).
  const ctx = useMemo(
    () => buildAssistantContext({ clientsModel, prefDraft: searchedDraft, savedClientData: clientRec?.data ?? null, followupDraft, projectName, geoNames, isAr }),
    [clientsModel, searchedDraft, clientRec, followupDraft, projectName, geoNames, isAr],
  );

  // The editable preference fields present on the live clients model.
  const editFields = useMemo<ModelField[]>(() => {
    if (!clientsModel) return [];
    const bySlug = new Map<string, ModelField>();
    for (const sec of clientsModel.schema.sections) for (const f of sec.fields) bySlug.set(f.name, f);
    return EDIT_SLUGS.map((slug) => bySlug.get(slug)).filter((f): f is ModelField => !!f);
  }, [clientsModel]);

  // Build the server-side requirements from a preference draft. Bedrooms (range →
  // AT-LEAST minimum) and the per-field strictness bands (`preference_constraints`)
  // are both mapped inside draftToMatchRequirements now, so the finder and the live
  // inventory meter share one builder — nothing extra to wire here.
  // The client's selected area AS SEARCHED — highlighted under the map pins so the
  // rep sees which results fall inside it (draft rules win over the saved record,
  // exactly as the search itself compiled them). Declared AFTER resolveLookupName.
  const searchedAreaItems = useMemo(
    () => collectClientAreaItems({
      draft: searchedDraft,
      savedClientData: (clientRec?.data as Record<string, unknown> | undefined) ?? null,
      resolveDistrictName: (id) => resolveLookupName(id, 'districts'),
    }),
    [searchedDraft, clientRec?.data, resolveLookupName],
  );

  function buildReqs(d: Record<string, unknown>): MatchRequirementsInput {
    return draftToMatchRequirements({ clientsModel, prefDraft: d, savedClientData: clientRec?.data ?? null, resolveLookupName });
  }

  const refinedGroups = useMemo(
    () => refineGroups(resp?.groups, scoreThreshold, refine, sortKey),
    [resp, scoreThreshold, refine, sortKey],
  );

  const controllerRef = useRef<AbortController | null>(null);
  // The draft of the LAST ATTEMPTED search — retry after a timeout re-sends it
  // verbatim (searchedDraft only updates on success, so it can't serve here).
  const lastDraftRef = useRef<Record<string, unknown>>(restored?.lastDraft ?? prefDraft);
  // Re-run the deterministic match for a preference draft and reset the view.
  function runSearch(d: Record<string, unknown>) {
    markActivity('finder: search request');
    lastDraftRef.current = d;
    // Abort any in-flight search: a rep who edits mid-search gets the NEW one
    // (the aborted request's .catch ignores AbortError).
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setHasSearched(true);
    setLoading(true);
    setError(null);
    setScoreThreshold(FETCH_FLOOR);
    setRefine(REFINE_DEFAULT);
    fetchProjectFinder(
      {
        requirements: buildReqs(d),
        clientId: clientRec?.id ?? null,
        followupId,
        perGroup: 0,
        minScore: FETCH_FLOOR,
        sources: ['our_projects', 'all_projects', 'market_listings'],
        locale: isAr ? 'ar' : 'en',
        // Compile the geo gate from the DRAFT rules the rep is looking at (so an
        // unsaved "south of the road" filters immediately), not the saved record.
        locationItems: Array.isArray(d.location_items) ? (d.location_items as unknown[]) : undefined,
      },
      controller.signal,
    )
      .then((r) => {
        if (controller.signal.aborted) return;
        markActivity('finder: rendering results');
        setResp(r);
        setSearchedDraft({ ...d });
        setActiveTab('exact_district_matches'); // auto-switch effect hops if empty
        const all = FINDER_GROUP_KEYS.flatMap((k) => r.groups[k] ?? []);
        setSelected(new Set(all.filter((i) => i.score === 100).map((i) => i.project_id)));
        // Carry the searched draft back to the workspace (so returning shows the edits).
        if (followupId) setFinderHandoff({ followupId, prefDraft: { ...d }, followupDraft, projectName: projectName ?? null });
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return;
        setError({
          message: e instanceof Error ? e.message : String(e),
          timeout: e instanceof FinderRequestError && e.timeout,
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }

  // Initial fetch on mount — SKIPPED when the host wants the rep to review the
  // preferences first (editPrefsFirst); the panel is open and the results area
  // shows the start screen until Search is pressed.
  useEffect(() => {
    startFreezeDetector();
    if (restored) {
      // Re-mounted from a persisted session (a Split↔Full-screen swap). The
      // edited preferences, results and view state were already restored above;
      // only resume a search that was actually in flight when the shell swapped.
      if (restored.loading) {
        markActivity('finder: resume search after layout switch');
        runSearch(restored.lastDraft);
      }
    } else if (!editPrefsFirst) {
      markActivity('finder: initial load');
      runSearch(prefDraft);
    }
    return () => controllerRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the working session into the shared holder on every change, so a host
  // that swaps this component between shells (docked panel ↔ full-screen modal)
  // can restore it on the next mount. No-op when no `sessionRef` is passed.
  useEffect(() => {
    if (!sessionRef) return;
    sessionRef.current = {
      clientId: clientRec?.id ?? null,
      editDraft, searchedDraft, lastDraft: lastDraftRef.current,
      resp, loading, hasSearched, showEdit, showPrefs, showControls,
      viewMode, activeTab, scoreThreshold, sortKey, refine, showRefine,
      visibleCount, selected: Array.from(selected), savedAny,
    };
  });

  // ── Refresh safety net for the UNSAVED selection ─────────────────────────
  // A finder session is in-memory only, so a forced stale-build reload (or an
  // accidental F5) used to bin the whole selection — 95 ticked cards gone
  // (live report 2026-07-19). Two layers:
  //   1. register the selection as unsaved WORK so the update banner turns into
  //      the amber "save before the reload" warning and beforeunload prompts;
  //   2. stash the ready-to-save payloads so even a hard reload can restore
  //      them with one click on the next open.
  const selectedPayloads = useMemo(() => {
    if (selected.size === 0) return [];
    const all = FINDER_GROUP_KEYS.flatMap((k) => resp?.groups[k] ?? []);
    return all.filter((i) => selected.has(i.project_id)).map(matchToInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, resp]);

  useEffect(() => {
    const key = `finder:${clientRec?.id ?? 'none'}`;
    setFormUnsaved(key, selectedPayloads.length > 0);
    return () => setFormUnsaved(key, false);
  }, [selectedPayloads.length, clientRec?.id]);

  useEffect(() => {
    if (!clientRec?.id) return;
    // Debounced: ticking through cards shouldn't hit localStorage per click.
    const t = setTimeout(() => saveFinderStash(clientRec.id, selectedPayloads), 400);
    return () => clearTimeout(t);
  }, [selectedPayloads, clientRec?.id]);

  // A stash left by a previous session (reload/crash) — offered for restore.
  const [stash, setStash] = useState<FinderStash | null>(() =>
    clientRec?.id ? loadFinderStash(clientRec.id) : null);
  const [restoring, setRestoring] = useState(false);

  async function restoreStash() {
    if (!stash || !clientRec?.id || restoring) return;
    setRestoring(true);
    const summary = await bulkSaveOptions(clientRec.id, stash.items, 'project_finder');
    setRestoring(false);
    const saved = summary.created + summary.updated;
    if (saved > 0) setSavedAny(true);
    clearFinderStash(clientRec.id);
    setStash(null);
    const parts: string[] = [];
    if (saved > 0) parts.push(L(`حُفظ ${saved}`, `${saved} saved`));
    if (summary.skippedEliminated > 0) parts.push(L(`${summary.skippedEliminated} مستبعد (تجاهل)`, `${summary.skippedEliminated} eliminated (skipped)`));
    if (summary.failed > 0) parts.push(L(`${summary.failed} فشل`, `${summary.failed} failed`));
    addToast(parts.join(' · ') || L('لا تغييرات', 'No changes'), summary.failed > 0 ? 'error' : 'success');
  }

  function discardStash() {
    if (clientRec?.id) clearFinderStash(clientRec.id);
    setStash(null);
  }

  // Leaving without saving a single option for the client needs a confirmation
  // (only once results were actually shown — an empty/failed search isn't a choice).
  const mustConfirmLeave = !!clientRec && !savedAny && totalFinderMatches(resp) > 0;
  function requestDone() {
    if (mustConfirmLeave) setConfirmLeave(true);
    else onDone();
  }

  // Esc returns to the follow-up (via the no-options-saved guard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirmLeave) { setConfirmLeave(false); return; }
      requestDone();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDone, confirmLeave, mustConfirmLeave]);

  // Tab close / reload with unsaved options → the browser's native leave prompt.
  useEffect(() => {
    if (!mustConfirmLeave) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [mustConfirmLeave]);

  function onOpenDetails(item: FinderMatch) {
    // In-chat host: open the source as an overlay it can back out of (returns to
    // THIS finder). Standalone / follow-up workspace: the old new-tab.
    if (onOpenSource) {
      onOpenSource(item.source === 'market_listings' ? 'market_listing' : 'project', item.project_id);
      return;
    }
    const model = item.source === 'market_listings' ? 'market_listings' : 'all_projects';
    window.open(`/model/${model}/${item.project_id}`, '_blank', 'noopener');
  }
  const noClient = () =>
    addToast(L('لا يوجد عميل مرتبط بهذه المتابعة.', 'No client linked to this follow-up.'), 'error');

  // Send THIS card's project/listing to the connected client — the prepared
  // message if one exists, else the creation flow (all inside stacked popups).
  function onSendToClient(item: FinderMatch) {
    if (!clientRec?.id) return noClient();
    setSendTarget(item);
  }

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

  async function onSaveOption(item: FinderMatch) {
    if (!clientRec?.id) return noClient();
    setSaveStates((s) => ({ ...s, [item.project_id]: 'saving' }));
    const res = await saveClientOption({ clientId: clientRec.id, ...matchToInput(item), addedFrom: 'project_finder' });
    if (res.ok) {
      setSaveStates((s) => ({ ...s, [item.project_id]: 'saved' }));
      setSavedAny(true);
      if (res.outcome === 'eliminated_exists') {
        addToast(L('هذا الخيار مستبعد مسبقاً — أعد تفعيله يدوياً.', 'This option is already eliminated — reactivate it manually.'), 'info');
      } else {
        addToast(res.outcome === 'updated'
          ? L('تم تحديث الخيار المحفوظ.', 'Saved option refreshed.')
          : L('تمت إضافة الخيار لقائمة خيارات العميل.', 'Saved to client options.'), 'success');
      }
    } else {
      setSaveStates((s) => ({ ...s, [item.project_id]: 'idle' }));
      addToast(res.outcome === 'conflict'
        ? L('تم تعديل البيانات من مستخدم آخر — حدّث الصفحة وأعد المحاولة.', 'Edited elsewhere — reload and retry.')
        : L('تعذّر حفظ الخيار.', 'Could not save the option.'), 'error');
    }
  }

  async function onBulkSave() {
    if (!clientRec?.id) return noClient();
    if (selected.size === 0) return;
    const all = FINDER_GROUP_KEYS.flatMap((k) => refinedGroups[k]);
    const chosen = all.filter((i) => selected.has(i.project_id));
    setBulkSaving(true);
    const summary = await bulkSaveOptions(clientRec.id, chosen.map(matchToInput), 'project_finder');
    setBulkSaving(false);
    const saved = summary.created + summary.updated;
    if (saved > 0) setSavedAny(true);
    // The work is persisted — drop the refresh safety net so it can't resurface
    // as a stale "unsaved selection" on the next open.
    if (summary.failed === 0) {
      setSelected(new Set());
      if (clientRec.id) clearFinderStash(clientRec.id);
    }
    const parts: string[] = [];
    if (saved > 0) parts.push(L(`حُفظ ${saved}`, `${saved} saved`));
    if (summary.skippedEliminated > 0) parts.push(L(`${summary.skippedEliminated} مستبعد (تجاهل)`, `${summary.skippedEliminated} eliminated (skipped)`));
    if (summary.failed > 0) parts.push(L(`${summary.failed} فشل`, `${summary.failed} failed`));
    addToast(parts.join(' · ') || L('لا تغييرات', 'No changes'), summary.failed > 0 ? 'error' : 'success');
  }

  async function confirmEliminate() {
    if (!eliminateTarget || !clientRec?.id) { setEliminateTarget(null); return; }
    setEliminating(true);
    const ensured = await saveClientOption({ clientId: clientRec.id, ...matchToInput(eliminateTarget), addedFrom: 'project_finder' });
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

  async function onReactivate(item: FinderMatch) {
    if (!clientRec?.id) return noClient();
    const existing = findClientOption(clientRec.id, finderSourceToOptionType(item.source), item.project_id);
    if (!existing) return;
    const res = await reactivateOption(existing.id);
    if (res.ok) setSavedAny(true);
    addToast(res.ok ? L('تمت إعادة تفعيل الخيار.', 'Option reactivated.') : L('تعذّرت إعادة التفعيل.', 'Could not reactivate.'), res.ok ? 'success' : 'error');
  }

  // Inline status pick from a card. 'eliminated' routes through the reason modal
  // (so a note is captured); every other status ensures the option exists (creating
  // it if new) then applies the status — updateOptionStatus routes 'main_focus'
  // through setMainOption (single active main) and reactivates an eliminated option.
  async function onSetStatus(item: FinderMatch, status: ClientOptionStatus) {
    if (!clientRec?.id) return noClient();
    if (status === 'eliminated') { setEliminateNotes(''); setEliminateTarget(item); return; }
    setSaveStates((s) => ({ ...s, [item.project_id]: 'saving' }));
    const ensured = await saveClientOption({ clientId: clientRec.id, ...matchToInput(item), addedFrom: 'follow_up', status });
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

  // Persist the edited preferences (incl. location_items + the strictness bands)
  // to the client record, version-safe, through the ONE shared helper every
  // preference surface uses. Runs NO search.
  //
  // It is also REQUIRED before a re-search when location_items changed: the
  // server geo-gate compiles from the SAVED client (wassell_compile_client_geo by
  // id), so an unsaved district/element rule wouldn't affect the results — which
  // is why Search still saves first (see onSearchWithPrefs).
  //
  // `silent` suppresses the success toast for the save-then-search path (the
  // results landing is the feedback there); failures ALWAYS toast.
  async function persistPrefs(silent = false): Promise<boolean> {
    if (!clientRec) return true;
    markActivity('finder: saving preferences to client');
    setSavingPrefs(true);
    const res = await saveClientPreferences({
      client: clientRec,
      draft: editDraft,
      slugs: EDIT_SLUGS,
      saveRecord,
      expectedVersion: prefVersionRef.current?.version ?? null,
      isAr,
    });
    setSavingPrefs(false);
    if (res.ok && prefVersionRef.current) {
      prefVersionRef.current = { id: clientRec.id, version: res.nextVersion };
    }
    if (!res.ok || !silent) addToast(res.message, res.tone);
    return res.ok;
  }

  // Explicit SAVE action — persists the preferences and stays put (no search).
  async function onSavePrefsOnly() {
    if (!clientRec || savingPrefs || !clientPrefsDirty) return;
    await persistPrefs();
  }

  // The edited prefs differ from what's SAVED on the client (so a save is needed).
  const clientPrefsDirty = useMemo(
    () => preferencesDirty(clientRec?.data, editDraft, EDIT_SLUGS),
    [editDraft, clientRec],
  );

  // Unsaved PREFERENCE edits are unsaved work too — a forced stale-build reload
  // must warn instead of binning what the rep just typed.
  useEffect(() => {
    const key = `finder-prefs:${clientRec?.id ?? 'none'}`;
    setFormUnsaved(key, clientPrefsDirty);
    return () => setFormUnsaved(key, false);
  }, [clientPrefsDirty, clientRec?.id]);

  // Save the edited prefs to the client (if changed) THEN re-run the match — so
  // district/element rules in location_items actually narrow the results.
  // Collapse the panel so the incoming results are visible immediately.
  async function onSearchWithPrefs() {
    if (clientRec && clientPrefsDirty) {
      const ok = await persistPrefs(true);
      if (!ok) return;
    }
    setShowEdit(false);
    runSearch(editDraft);
  }

  const editDirty = useMemo(
    () => EDIT_SLUGS.some((slug) => JSON.stringify(editDraft[slug] ?? null) !== JSON.stringify(searchedDraft[slug] ?? null))
      || JSON.stringify(editDraft.location_items ?? null) !== JSON.stringify(searchedDraft.location_items ?? null),
    [editDraft, searchedDraft],
  );

  const fetchedTotal = totalFinderMatches(resp);
  const refinedTotal = totalInGroups(refinedGroups);
  const missing = resp?.metadata.missing_required_preferences ?? [];
  const needsPreferences = resp?.metadata.needs_preferences === true;
  const market = resp?.metadata.market;
  const suggestLabel = (code: string) => (MISSING_LABELS[code] ? (isAr ? MISSING_LABELS[code].ar : MISSING_LABELS[code].en) : code);
  // Amber notices above the results — folded away with the refine controls when
  // there ARE results (kept always-on at zero results, where they explain the
  // emptiness). The collapsed strip keeps a small count so nothing is hidden silently.
  const constraintDropSummary = summarizeConstraintDrops(resp?.metadata.constraint_drops, isAr);
  const hasMarketNotice = market?.status === 'too_many' || market?.status === 'needs_district' || market?.status === 'unavailable';
  const topNoticeCount = (constraintDropSummary ? 1 : 0) + (hasMarketNotice ? 1 : 0);
  const showTopNotices = showControls || fetchedTotal === 0;
  const selectedVisible = FINDER_GROUP_KEYS.reduce(
    (n, k) => n + refinedGroups[k].filter((i) => selected.has(i.project_id)).length, 0,
  );

  // Select ALL currently-FILTERED results (score slider + refine filters, across
  // every tab) — or clear them if they already all are. Filtered-out items are
  // never touched; bulk-save persists only the filtered∩selected set anyway, so
  // tightening the slider after "select all" saves only what remains visible.
  const allFilteredSelected = refinedTotal > 0 && selectedVisible === refinedTotal;
  function toggleSelectAllFiltered() {
    const ids = FINDER_GROUP_KEYS.flatMap((k) => refinedGroups[k].map((i) => i.project_id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) for (const id of ids) next.delete(id);
      else for (const id of ids) next.add(id);
      return next;
    });
  }

  // Collapse to 3 display tabs + lift our-projects into a pinned top list.
  const tabView = useMemo(() => buildFinderTabs(refinedGroups), [refinedGroups]);
  const ourProjects = tabView.ourProjects;
  const tierItems = tabView.tabs[activeTab] ?? [];
  const activeCount = ourProjects.length + tierItems.length;
  const shownTier = tierItems.slice(0, visibleCount);

  // Card → map. Ensure the pin is in the plotted set (our-projects show on every
  // tab; a tier match only shows on its own tab, so hop to it), switch to the map
  // view, and hand the map a focus request to open + center that pin.
  function onShowOnMap(item: FinderMatch) {
    const inOurs = ourProjects.some((o) => o.project_id === item.project_id);
    if (!inOurs) {
      const tab = DISPLAY_TAB_KEYS.find((k) => (tabView.tabs[k] ?? []).some((t) => t.project_id === item.project_id));
      if (tab && tab !== activeTab) setActiveTab(tab);
    }
    setViewMode('map');
    mapFocusNonce.current += 1;
    setMapFocus({ id: item.project_id, nonce: mapFocusNonce.current });
  }

  useEffect(() => { setVisibleCount(PAGE); scrollRef.current?.scrollTo({ top: 0 }); }, [activeTab, tabView]);
  useEffect(() => {
    if (!resp) return;
    const tabHas = (k: DisplayTabKey) => ourProjects.length > 0 || tabView.tabs[k].length > 0;
    if (!tabHas(activeTab)) {
      const first = DISPLAY_TAB_KEYS.find(tabHas);
      if (first && first !== activeTab) setActiveTab(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabView]);
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

  const headerSubtitle = [clientName, projectName].filter(Boolean).join(' · ');

  return (
    <div className="flex h-full flex-col bg-cream" dir={isAr ? 'rtl' : 'ltr'}>
      {/* Header with Edit-preferences toggle + Done button. flex-wrap so the
          action buttons drop to a second line on a phone instead of crowding. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-sand/40 bg-white px-4 py-3 sm:px-6">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-copper/10">
          <Compass size={20} className="text-copper" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-bold text-chocolate sm:text-lg">{L('الباحث عن المشاريع', 'Project Finder')}</h1>
          <p className="truncate text-[11px] text-charcoal/60">
            {headerSubtitle
              ? L(`لـ ${headerSubtitle} — ترتيب موثّق بالإحداثيات`, `For ${headerSubtitle} — coordinate-verified ranking`)
              : L('ترتيب دقيق موثّق بالإحداثيات — مبني على تفضيلات هذه المتابعة.', 'Coordinate-verified ranking — based on this follow-up’s preferences.')}
          </p>
        </div>
        {editFields.length > 0 && (
          <button
            type="button"
            onClick={() => setShowEdit((v) => !v)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-bold transition ${
              showEdit ? 'border-copper/40 bg-copper/10 text-copper' : 'border-sand/60 bg-white text-charcoal/75 hover:bg-cream/60'
            }`}
          >
            <SlidersHorizontal size={15} />
            <span className="hidden sm:inline">{L('تعديل التفضيلات', 'Edit preferences')}</span>
          </button>
        )}
        {clientRec && (
          <>
            <button
              type="button"
              onClick={toggleSelectAllFiltered}
              disabled={refinedTotal === 0}
              title={allFilteredSelected
                ? L('إلغاء تحديد جميع النتائج المصفّاة', 'Clear all filtered results')
                : L('تحديد جميع النتائج المصفّاة الحالية', 'Select all currently-filtered results')}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-bold transition disabled:opacity-50 ${
                allFilteredSelected ? 'border-copper/40 bg-copper/10 text-copper' : 'border-sand/60 bg-white text-charcoal/75 hover:bg-cream/60'
              }`}
            >
              <CheckSquare size={15} />
              <span className="hidden sm:inline">{allFilteredSelected ? L('إلغاء التحديد', 'Clear selection') : L('تحديد الكل', 'Select all')}</span>
              <span className={`rounded-full px-1.5 text-[11px] ${allFilteredSelected ? 'bg-copper/15' : 'bg-sand/40'}`}>{refinedTotal}</span>
            </button>
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
          </>
        )}
        {/* Split ↔ Full-screen — available here too (in the finder, and while
            editing preferences), not only on the options list. */}
        {onToggleLayout && (
          <button
            type="button"
            onClick={onToggleLayout}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-copper/30 bg-copper/5 px-3 py-2 text-sm font-bold text-copper transition hover:bg-copper/10"
            title={layoutDocked ? L('عرض بملء الشاشة', 'Show full screen') : L('تقسيم الشاشة بجانب المحادثة', 'Split beside the chat')}
          >
            {layoutDocked ? <Maximize2 size={15} /> : <Columns2 size={15} />}
            <span className="hidden sm:inline">{layoutDocked ? L('ملء الشاشة', 'Full screen') : L('تقسيم', 'Split')}</span>
          </button>
        )}
        <button
          type="button"
          onClick={requestDone}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-sand/60 bg-white px-3.5 py-2 text-sm font-bold text-charcoal/75 transition hover:bg-cream/60"
        >
          <Check size={16} />
          {L('تم', 'Done')}
        </button>
      </div>

      {/* Recovered selection from a previous session (forced update / refresh /
          crash). One click saves it — no re-search, nothing lost. */}
      {stash && stash.items.length > 0 && clientRec && (
        <div className="border-b border-amber-300/70 bg-amber-50">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2 px-4 py-2 sm:px-6">
            <AlertTriangle size={15} className="shrink-0 text-amber-600" />
            <span className="text-xs font-bold text-amber-800">
              {L(
                `${stash.items.length} خيار كنت قد حدّدتها ولم تُحفظ قبل إعادة تحميل الصفحة.`,
                `${stash.items.length} option(s) you had selected were not saved before the page reloaded.`,
              )}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={restoreStash}
              disabled={restoring}
              className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-3 py-1.5 text-xs font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
            >
              {restoring ? <Loader2 size={13} className="animate-spin" /> : <Bookmark size={13} />}
              {L('حفظها الآن', 'Save them now')}
            </button>
            <button
              type="button"
              onClick={discardStash}
              disabled={restoring}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50"
            >
              <XCircle size={13} /> {L('تجاهل', 'Discard')}
            </button>
          </div>
        </div>
      )}

      {/* Editable preferences panel — refine the SERVER-SIDE search. Height is
          CAPPED with its own scrollbar so it can never swallow the results area
          (critical when the finder is embedded in a popup / short viewport). */}
      {showEdit && editFields.length > 0 && (
        <div className="max-h-[42vh] overflow-y-auto overscroll-contain border-b border-sand/40 bg-white/70">
          <div className="mx-auto w-full max-w-6xl px-4 py-3 sm:px-6">
            {/* Sticky panel header: the COLLAPSE control lives here so the
                results are always one click away — previously the only way to
                close the panel was the header toggle or running a search
                (live report 2026-07-19: "no button to collapse the
                preferences, the listings window stays tiny"). */}
            <div className="sticky top-0 z-10 -mx-4 mb-2 flex items-center gap-2 bg-white/95 px-4 py-1.5 backdrop-blur sm:-mx-6 sm:px-6">
              <SlidersHorizontal size={14} className="shrink-0 text-copper" />
              <span className="text-xs font-bold text-charcoal/75">
                {hasSearched
                  ? L('تعديل تفضيلات العميل وإعادة البحث', 'Edit client preferences & search again')
                  : L('راجع التفضيلات ثم ابدأ البحث', 'Review the preferences, then search')}
              </span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setShowEdit(false)}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-[11px] font-bold text-charcoal/70 transition hover:bg-cream/60"
                title={L('إخفاء التفضيلات وإظهار النتائج', 'Collapse preferences and show the results')}
              >
                <ChevronUp size={13} /> {L('طيّ التفضيلات', 'Collapse')}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {editFields.map((field) => (
                <div key={field.id} className={field.name === 'location' ? 'sm:col-span-2 lg:col-span-3' : ''}>
                  <label className="mb-1 block text-[11px] font-bold text-charcoal/70">
                    {isAr ? field.label_ar : field.label_en}
                  </label>
                  <DynamicField
                    field={field}
                    value={editDraft[field.name]}
                    onChange={(v) => setEditDraft((d) => ({ ...d, [field.name]: v }))}
                    recordData={editDraft}
                    compact
                    modelId={clientsModel?.id}
                    recordId={clientRec?.id ?? undefined}
                    onPatch={(patch) => setEditDraft((d) => ({ ...d, ...patch }))}
                  />
                  {/* The band control renders inside DynamicField for eligible
                      clients preference fields (writing preference_constraints). */}
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {/* Enabled DURING a search on purpose: editing mid-flight and
                  pressing search supersedes the running request (runSearch
                  aborts it) instead of forcing the rep to wait it out. */}
              <button
                type="button"
                onClick={onSearchWithPrefs}
                disabled={savingPrefs}
                className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-4 py-2 text-sm font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
              >
                {savingPrefs ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
                {!hasSearched
                  ? L('ابدأ البحث', 'Start search')
                  : loading
                    ? L('إعادة البحث بالتفضيلات الجديدة', 'Restart with new preferences')
                    : L('بحث بالتفضيلات الجديدة', 'Search with new preferences')}
              </button>
              {/* SAVE — a first-class action of its own: persists the
                  preferences onto the client and STAYS PUT (no search). The rep
                  editing prefs from the WhatsApp popup shouldn't have to run a
                  full projects + market search just to record what the client
                  told them (user request 2026-08-18). */}
              {clientRec && (
                <button
                  type="button"
                  onClick={() => void onSavePrefsOnly()}
                  disabled={savingPrefs || !clientPrefsDirty}
                  title={clientPrefsDirty
                    ? L('حفظ التفضيلات على بطاقة العميل بدون بحث', 'Save preferences to the client without searching')
                    : L('لا توجد تغييرات لحفظها', 'No changes to save')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold transition disabled:opacity-50 ${
                    clientPrefsDirty
                      ? 'bg-chocolate text-white hover:bg-chocolate/90'
                      : 'border border-sand/60 bg-white text-charcoal/70'
                  }`}
                >
                  {savingPrefs ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  {savingPrefs
                    ? L('جارٍ الحفظ…', 'Saving…')
                    : L('حفظ التفضيلات فقط', 'Save preferences only')}
                </button>
              )}
              <span className="inline-flex items-center gap-1 text-[11px] text-charcoal/50">
                <Save size={12} /> {clientPrefsDirty
                  ? L('«حفظ» يحفظ بدون بحث · «بحث» يحفظ ثم يبحث.', '“Save” saves without searching · “Search” saves then searches.')
                  : L('التفضيلات محفوظة على بطاقة العميل.', 'Preferences are saved on the client.')}
              </span>
              {clientPrefsDirty && (
                <span className="text-[11px] font-semibold text-amber-700">
                  {L('تعديلات غير محفوظة على تفضيلات العميل.', 'Unsaved changes to this client’s preferences.')}
                </span>
              )}
              {/* Only when the prefs ARE saved but the results predate them —
                  otherwise the "unsaved" line above already says it. */}
              {editDirty && !clientPrefsDirty && (
                <span className="text-[11px] font-semibold text-amber-700">
                  {L('لديك تعديلات غير مطبّقة على النتائج — اضغط «بحث».', 'Edits not applied to the results — press “Search”.')}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Preferences chips + missing warnings (reflect the last searched draft).
          COLLAPSIBLE — in a popup every pixel belongs to the results, so hosts
          can default this collapsed; the toggle row stays one thin line with a
          truncated summary so the context is never fully gone. */}
      <div className="border-b border-sand/30 bg-white/60">
        <div className="mx-auto w-full max-w-6xl px-4 py-2 sm:px-6">
          <button
            type="button"
            onClick={() => setShowPrefs((v) => !v)}
            aria-expanded={showPrefs}
            className="flex w-full items-center gap-1.5 text-start"
            title={showPrefs ? L('إخفاء التفضيلات', 'Hide preferences') : L('عرض التفضيلات', 'Show preferences')}
          >
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-charcoal/45">{L('التفضيلات', 'Preferences')}</span>
            <span className="shrink-0 rounded-full bg-sand/30 px-1.5 text-[10px] font-semibold text-charcoal/60">{ctx.used.length}</span>
            {!showPrefs && missing.length > 0 && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-semibold text-amber-700">
                <AlertTriangle size={11} /> {missing.length}
              </span>
            )}
            {!showPrefs && (
              <span className="min-w-0 flex-1 truncate text-[11px] text-charcoal/55">
                {ctx.used.length > 0 ? ctx.used.map((p) => p.value).join(' · ') : L('لا توجد تفضيلات محددة', 'None set')}
              </span>
            )}
            {showPrefs && <span className="flex-1" />}
            <ChevronDown size={14} className={`shrink-0 text-charcoal/50 transition ${showPrefs ? 'rotate-180' : ''}`} />
          </button>
          {showPrefs && (
            <>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {ctx.used.length === 0 && <span className="text-xs text-charcoal/55">{L('لا توجد تفضيلات محددة', 'None set')}</span>}
                {ctx.used.map((p) => (
                  <span key={p.slug} className="inline-flex items-center gap-1 rounded-full border border-sand/50 bg-cream/50 px-2 py-0.5 text-[11px] text-charcoal/80">
                    <span className="text-charcoal/50">{isAr ? p.label_ar : p.label_en}:</span>
                    <span className="font-semibold">{p.value}</span>
                  </span>
                ))}
              </div>
              {missing.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <AlertTriangle size={13} className="text-amber-600" />
                  <span className="text-[11px] font-semibold text-amber-700">{L('اسأل العميل عن:', 'Ask the client about:')}</span>
                  {missing.map((m) => (
                    <span key={m} className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                      {MISSING_LABELS[m] ? (isAr ? MISSING_LABELS[m].ar : MISSING_LABELS[m].en) : m}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Required-field exclusions — name the field(s) doing the cutting so a
          short list isn't mistaken for "nothing available". */}
      {constraintDropSummary && showTopNotices && (
        <div className="border-b border-amber-200 bg-amber-50">
          <div className="mx-auto w-full max-w-6xl px-4 py-2 sm:px-6">
            <div className="flex items-start gap-1.5 text-[11px] text-amber-800">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                {L('حقول إلزامية استبعدت خيارات — ', 'Required fields excluded options — ')}
                <span className="font-semibold">{constraintDropSummary}</span>
                {L('. حوّل الحقل إلى «مفضّل» أو وسّع نطاقه لعرضها.', '. Switch the field to "Preferred" or widen its band to see them.')}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Market-source honesty notices */}
      {hasMarketNotice && showTopNotices && (
        <div className="border-b border-amber-200 bg-amber-50">
          <div className="mx-auto w-full max-w-6xl px-4 py-2 sm:px-6">
            {market?.status === 'too_many' && (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-amber-800">
                <AlertTriangle size={13} className="shrink-0" />
                <span className="font-semibold">
                  {market.count != null
                    ? L(`إعلانات السوق غير معروضة: يوجد ${market.count.toLocaleString('en-US')} إعلان في هذا الحي.`,
                        `Market listings hidden: ${market.count.toLocaleString('en-US')} ads in this district.`)
                    : L('إعلانات السوق غير معروضة: عددها كبير جداً في هذا الحي.', 'Market listings hidden: too many ads in this district.')}
                </span>
                <span>{L('أضف', 'Add')}</span>
                {(market.suggest ?? []).map((s) => (
                  <span key={s} className="inline-flex items-center rounded-full border border-amber-300 bg-white px-2 py-0.5 font-semibold">{suggestLabel(s)}</span>
                ))}
                <span>{L('لعرضها (لا يتم حذف أي إعلان).', 'to show them (nothing is dropped).')}</span>
              </div>
            )}
            {market?.status === 'needs_district' && (
              <div className="flex items-center gap-1.5 text-[11px] text-amber-800">
                <AlertTriangle size={13} className="shrink-0" />
                <span>{L('حدّد الحي لعرض إعلانات السوق.', 'Set a district to include market listings.')}</span>
              </div>
            )}
            {market?.status === 'unavailable' && (
              <div className="flex items-center gap-1.5 text-[11px] text-amber-800">
                <AlertTriangle size={13} className="shrink-0" />
                <span>{L('تعذّر تحميل إعلانات السوق — أعد المحاولة.', 'Couldn’t load market listings — please retry.')}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Refinement toolbar + group tabs — collapsible so results/map get the height */}
      {!loading && !error && !needsPreferences && fetchedTotal > 0 && (
        <div className="border-b border-sand/30 bg-white/40">
          <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
            {/* Collapse/expand strip — collapsed, it shows the current match floor +
                active tab so the rep still knows the state at a glance. */}
            <div className="flex items-center justify-between gap-2 py-1.5">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                {!showControls && topNoticeCount > 0 && (
                  <span
                    className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-semibold text-amber-700"
                    title={L('تنبيهات مخفية — وسّع لعرضها', 'Hidden notices — expand to view')}
                  >
                    <AlertTriangle size={11} /> {topNoticeCount}
                  </span>
                )}
                <span className="truncate text-[11px] font-semibold text-charcoal/50">
                  {showControls
                    ? L('أدوات التصفية والتبويبات', 'Refine & tabs')
                    : `${L('التطابق ≥', 'Match ≥')} ${scoreThreshold}% · ${isAr ? DISPLAY_TAB_LABELS[activeTab].ar : DISPLAY_TAB_LABELS[activeTab].en} (${ourProjects.length + tabView.tabs[activeTab].length})`}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowControls((v) => !v)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold text-copper transition hover:bg-cream"
                title={showControls ? L('طيّ أدوات التصفية', 'Collapse controls') : L('توسيع أدوات التصفية', 'Expand controls')}
              >
                {showControls ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                {showControls ? L('طيّ', 'Collapse') : L('توسيع', 'Expand')}
              </button>
            </div>
            {showControls && (<>
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
            />
            <div className="flex flex-wrap gap-1 pb-2">
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
            </>)}
          </div>
        </div>
      )}

      {/* Cards */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6">
          {/* Start screen — editPrefsFirst hosts land here: nothing has been
              searched yet, so prompt instead of showing an empty result set. */}
          {!hasSearched && !loading && (
            <div className="flex h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center">
              <Compass size={26} className="text-copper" />
              <p className="text-sm font-bold text-chocolate">{L('راجع تفضيلات العميل قبل البحث', 'Review the client’s preferences before searching')}</p>
              <p className="max-w-lg text-sm text-charcoal/60">
                {L('عدّل الموقع أو الميزانية أو النوع من لوحة التفضيلات بالأعلى، ثم اضغط «ابدأ البحث». يمكنك التعديل وإعادة البحث في أي وقت.',
                   'Adjust location, budget or type in the preferences panel above, then press “Start search”. You can edit and search again at any time.')}
              </p>
              <button
                type="button"
                onClick={onSearchWithPrefs}
                disabled={savingPrefs}
                className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-4 py-2 text-sm font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
              >
                {savingPrefs ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} {L('ابدأ البحث', 'Start search')}
              </button>
              {!showEdit && editFields.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowEdit(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-sand/60 bg-white px-3.5 py-2 text-sm font-bold text-charcoal/75 transition hover:bg-cream/60"
                >
                  <SlidersHorizontal size={15} /> {L('تعديل التفضيلات', 'Edit preferences')}
                </button>
              )}
            </div>
          )}
          {loading && (
            <div className="flex h-[50vh] flex-col items-center justify-center gap-2 text-charcoal/55">
              <Loader2 size={24} className="animate-spin text-copper" />
              <span className="text-sm">{L('جارٍ ترشيح المشاريع…', 'Finding the best-fit projects…')}</span>
            </div>
          )}
          {!loading && error && error.timeout && (
            <div className="flex h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center">
              <TimerOff size={26} className="text-copper" />
              <p className="text-sm font-bold text-chocolate">
                {L('البحث استغرق وقتاً أطول من المسموح فتوقّف قبل اكتماله.', 'The search took longer than allowed and was stopped before finishing.')}
              </p>
              <p className="max-w-lg text-sm text-charcoal/60">
                {L(
                  'يحدث هذا عادةً عندما يكون نطاق الموقع واسعاً جداً — مثل قاعدة اتجاه على طريق طويل («جنوب طريق الملك سلمان») تغطي معظم المدينة. ضيّق الموقع: اختر أحياء محددة، أو اجعل قاعدة الاتجاه استثناءً على الأحياء المختارة بدل شمولها للمدينة كلها، ثم أعد المحاولة.',
                  'This usually happens when the location scope is too wide — e.g. a direction rule on a long road ("south of King Salman Rd") covering most of the city. Narrow the location: pick specific districts, or make the direction rule an exclude on top of the chosen districts instead of city-wide, then try again.',
                )}
              </p>
              <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                {editFields.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowEdit(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-3.5 py-2 text-sm font-bold text-white transition hover:bg-terracotta"
                  >
                    <SlidersHorizontal size={15} /> {L('تضييق التفضيلات', 'Narrow preferences')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => runSearch(lastDraftRef.current)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-sand/60 bg-white px-3.5 py-2 text-sm font-bold text-charcoal/75 transition hover:bg-cream/60"
                >
                  <RefreshCw size={15} /> {L('إعادة المحاولة', 'Try again')}
                </button>
              </div>
            </div>
          )}
          {!loading && error && !error.timeout && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <p>{error.message}</p>
              <button
                type="button"
                onClick={() => runSearch(lastDraftRef.current)}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-bold text-red-700 transition hover:bg-red-100"
              >
                <RefreshCw size={13} /> {L('إعادة المحاولة', 'Try again')}
              </button>
            </div>
          )}
          {!loading && !error && needsPreferences && (
            <div className="flex h-[50vh] flex-col items-center justify-center gap-2 px-6 text-center text-charcoal/55">
              <Info size={24} className="text-copper" />
              <p className="text-sm">{L('لم تُحدَّد أي تفضيلات لهذا العميل. حدِّد الحي أو الميزانية أو نوع العقار (أو اسأل العميل) للحصول على ترشيح دقيق.', 'No preferences are set for this client. Set a district, budget, or unit type (or ask the client) for a precise match.')}</p>
              {editFields.length > 0 && (
                <button type="button" onClick={() => setShowEdit(true)} className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-copper px-3.5 py-2 text-sm font-bold text-white transition hover:bg-terracotta">
                  <SlidersHorizontal size={15} /> {L('تعديل التفضيلات', 'Edit preferences')}
                </button>
              )}
            </div>
          )}
          {hasSearched && !loading && !error && !needsPreferences && fetchedTotal === 0 && (
            <div className="flex h-[50vh] flex-col items-center justify-center gap-2 px-6 text-center text-charcoal/55">
              <Info size={24} className="text-copper" />
              <p className="text-sm">{L('لا توجد مشاريع مطابقة بالتفضيلات الحالية. جرّب توسيع الميزانية أو الموقع، أو اسأل العميل عن تفاصيل أكثر.', 'No matching projects for the current preferences. Try widening the budget or location, or gather more details from the client.')}</p>
            </div>
          )}
          {!loading && !error && !needsPreferences && fetchedTotal > 0 && refinedTotal === 0 && (
            <div className="flex h-[50vh] flex-col items-center justify-center gap-2 px-6 text-center text-charcoal/55">
              <Info size={24} className="text-copper" />
              <p className="text-sm">{L('لا نتائج بهذه التصفية. اخفض نسبة التطابق أو وسّع التصفية الدقيقة.', 'Nothing matches this refinement. Lower the score or relax the refine filters.')}</p>
            </div>
          )}
          {!loading && !error && refinedTotal > 0 && activeCount === 0 && (
            <div className="px-4 py-8 text-center text-sm text-charcoal/55">{L('لا نتائج في هذه المجموعة — جرّب تبويباً آخر.', 'Nothing in this group — try another tab.')}</div>
          )}

          {/* MAP view — plots the active tab's pinned our-projects + other matches.
              Click a pin → Details (same as a card). Client-option actions stay on
              the list; the map is a presentation surface. */}
          {viewMode === 'map' && !loading && !error && activeCount > 0 && (
            <FinderMapView
              matches={[...ourProjects, ...tierItems]}
              isAr={isAr}
              focus={mapFocus}
              areaItems={searchedAreaItems}
              onOpenDetails={onOpenDetails}
              renderSelectedCard={(item) => (
                <FinderCard
                  item={item}
                  isAr={isAr}
                  onOpenDetails={onOpenDetails}
                  selected={selected.has(item.project_id)}
                  onToggleSelect={toggleSelect}
                  onSaveOption={onSaveOption}
                  onEliminate={(it) => { setEliminateNotes(''); setEliminateTarget(it); }}
                  onReactivate={onReactivate}
                  onSetStatus={onSetStatus}
                  onSendToClient={onSendToClient}
                  saveState={saveStates[item.project_id] ?? 'idle'}
                  existingStatus={existingStatusFor(item)}
                  chatPdf={chatPdf}
                  clientId={clientRec?.id ?? null}
                />
              )}
            />
          )}

          {/* Pinned OUR PROJECTS — best-first, shown at the top of every tab. */}
          {viewMode === 'list' && !loading && !error && ourProjects.length > 0 && (
            <div className="mb-3">
              <SectionLabel text={L('مشاريعنا', 'Our Projects')} tone="ours" />
              <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {ourProjects.map((item) => (
                  <FinderCard
                    key={`our-${item.project_id}`}
                    item={item}
                    isAr={isAr}
                    onOpenDetails={onOpenDetails}
                    selected={selected.has(item.project_id)}
                    onToggleSelect={toggleSelect}
                    onSaveOption={onSaveOption}
                    onEliminate={(it) => { setEliminateNotes(''); setEliminateTarget(it); }}
                    onReactivate={onReactivate}
                    onSetStatus={onSetStatus}
                    onSendToClient={onSendToClient}
                    onShowOnMap={onShowOnMap}
                    saveState={saveStates[item.project_id] ?? 'idle'}
                    existingStatus={existingStatusFor(item)}
                    chatPdf={chatPdf}
                    clientId={clientRec?.id ?? null}
                  />
                ))}
              </div>
            </div>
          )}

          {/* This tab's other matches (all_projects + market_listings). */}
          {viewMode === 'list' && !loading && !error && shownTier.length > 0 && (
            <>
              {ourProjects.length > 0 && <SectionLabel text={L('خيارات أخرى', 'Other options')} tone="other" />}
              <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {shownTier.map((item) => (
                  <FinderCard
                    key={item.project_id}
                    item={item}
                    isAr={isAr}
                    onOpenDetails={onOpenDetails}
                    selected={selected.has(item.project_id)}
                    onToggleSelect={toggleSelect}
                    onSaveOption={onSaveOption}
                    onEliminate={(it) => { setEliminateNotes(''); setEliminateTarget(it); }}
                    onReactivate={onReactivate}
                    onSetStatus={onSetStatus}
                    onSendToClient={onSendToClient}
                    onShowOnMap={onShowOnMap}
                    saveState={saveStates[item.project_id] ?? 'idle'}
                    existingStatus={existingStatusFor(item)}
                    chatPdf={chatPdf}
                    clientId={clientRec?.id ?? null}
                  />
                ))}
              </div>
            </>
          )}
          {viewMode === 'list' && !loading && !error && tierItems.length > 0 && (
            <>
              {visibleCount < tierItems.length && <div ref={sentinelRef} className="h-1" aria-hidden />}
              <div className="py-3 text-center text-[11px] text-charcoal/45">
                {L(`عرض ${ourProjects.length + shownTier.length} من ${activeCount}`, `Showing ${ourProjects.length + shownTier.length} of ${activeCount}`)}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer — ALWAYS-VISIBLE list/map toggle + the selection summary (the
          Save-options action lives in the header). The view toggle sits here, not
          in the collapsible refine toolbar, so switching views is always one click
          away regardless of how the controls above are folded. */}
      {!loading && !error && fetchedTotal > 0 && (
        <div className="border-t border-sand/40 bg-white">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-2 sm:px-6">
            <ViewToggle viewMode={viewMode} onViewMode={setViewMode} isAr={isAr} />
            {clientRec && (
              <div className="flex min-w-0 items-center gap-3">
                <span className="shrink-0 text-xs text-charcoal/60">
                  {L(`${selectedVisible} محدّد`, `${selectedVisible} selected`)}
                </span>
                {!savedAny && (
                  <span className="truncate text-[11px] font-semibold text-amber-700">
                    {L('لم يُحفظ أي خيار لهذا العميل بعد.', 'No option saved for this client yet.')}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* "Send to client" WhatsApp flow — the stored message opens the client's
          chat composer directly; a missing message runs the creation flow first
          (project: deterministic compose; listing: AI text + cleaned photos). */}
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

      {/* Leaving without saving any option for the client → confirm first. */}
      {confirmLeave && (
        <LeaveWithoutSavingModal
          isAr={isAr}
          clientName={clientName}
          onStay={() => setConfirmLeave(false)}
          onLeave={() => { setConfirmLeave(false); onDone(); }}
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
