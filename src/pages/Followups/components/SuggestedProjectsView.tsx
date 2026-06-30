import { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, Check, Loader2, AlertTriangle, Info, Bookmark, XCircle } from 'lucide-react';
import type { AppModel, AppRecord } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { buildAssistantContext } from '@/lib/followups/assistantContext';
import { draftToMatchRequirements } from '@/lib/matching/requirements';
import {
  fetchProjectFinder, totalFinderMatches, FINDER_GROUP_KEYS,
  type FinderResponse, type FinderGroupKey, type FinderMatch,
} from '@/lib/matching/projectFinder';
import {
  saveClientOption, eliminateOption, reactivateOption, bulkSaveOptions,
  finderSourceToOptionType, findClientOption,
  type ClientOptionStatus, type SaveOptionInput,
} from '@/lib/matching/clientOptions';
import {
  refineGroups, totalInGroups, REFINE_DEFAULT, FETCH_FLOOR,
  type SortKey, type Refine,
} from '@/lib/matching/finderRefine';
import FinderCard from './FinderCard';
import FinderRefinementBar from './FinderRefinementBar';

/**
 * The "Suggested Projects" finder rendered as a FULL PAGE (was a cramped modal).
 * Reached at /model/followups/:id/projects — stays connected to the follow-up via
 * its id (audit log + saves into THAT client's options) and matches against the
 * preference draft handed off from the workspace (unsaved edits included). The
 * DETERMINISTIC, geography boundary-verified /api/project-finder powers it (NO LLM
 * — parse:false, explain:false); four location-centric groups, the shared
 * refinement toolbar, and bulk-save into client_property_options.
 *
 * A prominent "Done" button (onDone) returns the rep to the follow-up record.
 */

interface Props {
  isAr: boolean;
  clientsModel: AppModel | null;
  clientRec: AppRecord | null;
  prefDraft: Record<string, unknown>;
  followupDraft: Record<string, unknown>;
  followupId: string | null;
  projectName?: string | null;
  /** Display name of the linked client (header subtitle) — purely cosmetic. */
  clientName?: string | null;
  /** Called by the "Done" button + Esc — returns to the follow-up record. */
  onDone: () => void;
}

const TAB_LABELS: Record<FinderGroupKey, { ar: string; en: string }> = {
  exact_district_matches: { ar: 'في الحي المطلوب', en: 'Exact district' },
  nearby_district_matches: { ar: 'أحياء قريبة', en: 'Nearby' },
  same_city_matches: { ar: 'نفس المدينة', en: 'Same city' },
  broader_fallback: { ar: 'بدائل أوسع', en: 'Broader' },
};

const MISSING_LABELS: Record<string, { ar: string; en: string }> = {
  budget: { ar: 'الميزانية', en: 'Budget' },
  location: { ar: 'الحي / المدينة', en: 'District / City' },
  unit_type: { ar: 'نوع العقار', en: 'Unit type' },
  bedrooms: { ar: 'عدد الغرف', en: 'Bedrooms' },
};

const PAGE = 24;

export default function SuggestedProjectsView({
  isAr, clientsModel, clientRec, prefDraft, followupDraft, followupId, projectName, clientName, onDone,
}: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);

  const [resp, setResp] = useState<FinderResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FinderGroupKey>('exact_district_matches');
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saveStates, setSaveStates] = useState<Record<string, 'idle' | 'saving' | 'saved'>>({});
  const [bulkSaving, setBulkSaving] = useState(false);
  const [eliminateTarget, setEliminateTarget] = useState<FinderMatch | null>(null);
  const [eliminateNotes, setEliminateNotes] = useState('');
  const [eliminating, setEliminating] = useState(false);

  // Results-refinement (shared with the standalone Project Finder page).
  const [scoreThreshold, setScoreThreshold] = useState<number>(FETCH_FLOOR);
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [showRefine, setShowRefine] = useState(false);
  const [refine, setRefine] = useState<Refine>(REFINE_DEFAULT);

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

  // id → display name for districts + cities, from the loaded geography records.
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

  // Snapshot the draft-first context + requirements on mount.
  const ctx = useMemo(
    () => buildAssistantContext({ clientsModel, prefDraft, savedClientData: clientRec?.data ?? null, followupDraft, projectName, geoNames, isAr }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const requirements = useMemo(
    () => draftToMatchRequirements({ clientsModel, prefDraft, savedClientData: clientRec?.data ?? null, resolveLookupName }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const refinedGroups = useMemo(
    () => refineGroups(resp?.groups, scoreThreshold, refine, sortKey),
    [resp, scoreThreshold, refine, sortKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchProjectFinder(
      {
        requirements,
        clientId: clientRec?.id ?? null,
        followupId,
        perGroup: 0,
        minScore: FETCH_FLOOR,
        sources: ['our_projects', 'all_projects', 'market_listings'],
        locale: isAr ? 'ar' : 'en',
      },
      controller.signal,
    )
      .then((r) => {
        setResp(r);
        const firstFilled = FINDER_GROUP_KEYS.find((k) => (r.groups[k]?.length ?? 0) > 0);
        if (firstFilled) setActiveTab(firstFilled);
        const all = FINDER_GROUP_KEYS.flatMap((k) => r.groups[k] ?? []);
        setSelected(new Set(all.filter((i) => i.score === 100).map((i) => i.project_id)));
      })
      .catch((e) => {
        if (e?.name !== 'AbortError') setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc returns to the follow-up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);

  function onOpenDetails(item: FinderMatch) {
    const model = item.source === 'market_listings' ? 'market_listings' : 'all_projects';
    window.open(`/model/${model}/${item.project_id}`, '_blank', 'noopener');
  }
  const noClient = () =>
    addToast(L('لا يوجد عميل مرتبط بهذه المتابعة.', 'No client linked to this follow-up.'), 'error');

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
    // Only save selected cards still VISIBLE under the active refinement.
    const all = FINDER_GROUP_KEYS.flatMap((k) => refinedGroups[k]);
    const chosen = all.filter((i) => selected.has(i.project_id));
    setBulkSaving(true);
    const summary = await bulkSaveOptions(clientRec.id, chosen.map(matchToInput), 'project_finder');
    setBulkSaving(false);
    const saved = summary.created + summary.updated;
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
    addToast(res.ok ? L('تمت إعادة تفعيل الخيار.', 'Option reactivated.') : L('تعذّرت إعادة التفعيل.', 'Could not reactivate.'), res.ok ? 'success' : 'error');
  }

  const fetchedTotal = totalFinderMatches(resp);
  const refinedTotal = totalInGroups(refinedGroups);
  const missing = resp?.metadata.missing_required_preferences ?? [];
  const needsPreferences = resp?.metadata.needs_preferences === true;
  const activeItems = refinedGroups[activeTab] ?? [];
  const market = resp?.metadata.market;
  const suggestLabel = (code: string) => (MISSING_LABELS[code] ? (isAr ? MISSING_LABELS[code].ar : MISSING_LABELS[code].en) : code);
  const selectedVisible = FINDER_GROUP_KEYS.reduce(
    (n, k) => n + refinedGroups[k].filter((i) => selected.has(i.project_id)).length, 0,
  );

  useEffect(() => { setVisibleCount(PAGE); scrollRef.current?.scrollTo({ top: 0 }); }, [activeTab, refinedGroups]);
  useEffect(() => {
    if (!resp) return;
    if (refinedGroups[activeTab].length === 0) {
      const first = FINDER_GROUP_KEYS.find((k) => refinedGroups[k].length > 0);
      if (first && first !== activeTab) setActiveTab(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refinedGroups]);
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
  const shown = activeItems.slice(0, visibleCount);

  const headerSubtitle = [clientName, projectName].filter(Boolean).join(' · ');

  return (
    <div className="flex h-full flex-col bg-cream" dir={isAr ? 'rtl' : 'ltr'}>
      {/* Header with the Done button (returns to the follow-up record) */}
      <div className="flex items-center gap-3 border-b border-sand/40 bg-white px-4 py-3 sm:px-6">
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
        <button
          type="button"
          onClick={onDone}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-copper px-4 py-2 text-sm font-bold text-white transition hover:bg-terracotta"
        >
          <Check size={16} />
          {L('تم', 'Done')}
        </button>
      </div>

      {/* Preferences + missing warnings */}
      <div className="border-b border-sand/30 bg-white/60">
        <div className="mx-auto w-full max-w-6xl px-4 py-2.5 sm:px-6">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-charcoal/45">{L('التفضيلات', 'Preferences')}</span>
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
        </div>
      </div>

      {/* Market-source honesty notices */}
      {(market?.status === 'too_many' || market?.status === 'needs_district' || market?.status === 'unavailable') && (
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

      {/* Refinement toolbar + group tabs */}
      {!loading && !error && !needsPreferences && fetchedTotal > 0 && (
        <div className="border-b border-sand/30 bg-white/40">
          <div className="mx-auto w-full max-w-6xl px-4 pt-3 sm:px-6">
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
          </div>
        </div>
      )}

      {/* Cards */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6">
          {loading && (
            <div className="flex h-[50vh] flex-col items-center justify-center gap-2 text-charcoal/55">
              <Loader2 size={24} className="animate-spin text-copper" />
              <span className="text-sm">{L('جارٍ ترشيح المشاريع…', 'Finding the best-fit projects…')}</span>
            </div>
          )}
          {!loading && error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
          )}
          {!loading && !error && needsPreferences && (
            <div className="flex h-[50vh] flex-col items-center justify-center gap-2 px-6 text-center text-charcoal/55">
              <Info size={24} className="text-copper" />
              <p className="text-sm">{L('لم تُحدَّد أي تفضيلات لهذا العميل. حدِّد الحي أو الميزانية أو نوع العقار (أو اسأل العميل) للحصول على ترشيح دقيق.', 'No preferences are set for this client. Set a district, budget, or unit type (or ask the client) for a precise match.')}</p>
            </div>
          )}
          {!loading && !error && !needsPreferences && fetchedTotal === 0 && (
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
          {!loading && !error && refinedTotal > 0 && activeItems.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-charcoal/55">{L('لا نتائج في هذه المجموعة — جرّب تبويباً آخر.', 'Nothing in this group — try another tab.')}</div>
          )}

          {!loading && !error && shown.length > 0 && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((item) => (
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
                  saveState={saveStates[item.project_id] ?? 'idle'}
                  existingStatus={existingStatusFor(item)}
                />
              ))}
            </div>
          )}
          {!loading && !error && activeItems.length > 0 && (
            <>
              {visibleCount < activeItems.length && <div ref={sentinelRef} className="h-1" aria-hidden />}
              <div className="py-3 text-center text-[11px] text-charcoal/45">
                {L(`عرض ${shown.length} من ${activeItems.length}`, `Showing ${shown.length} of ${activeItems.length}`)}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer — bulk-save the SELECTED options into the client's unified list. */}
      {!loading && !error && fetchedTotal > 0 && (
        <div className="border-t border-sand/40 bg-white">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <span className="text-xs text-charcoal/60">
              {L(`${selectedVisible} محدّد`, `${selectedVisible} selected`)}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onBulkSave}
                disabled={bulkSaving || selectedVisible === 0}
                className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-3.5 py-2 text-sm font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
              >
                {bulkSaving ? <Loader2 size={15} className="animate-spin" /> : <Bookmark size={15} />}
                {L('حفظ المحدّد كخيارات للعميل', 'Save selected to client options')}
              </button>
              <button
                type="button"
                onClick={onDone}
                className="inline-flex items-center gap-1.5 rounded-lg border border-sand/60 bg-white px-3.5 py-2 text-sm font-bold text-charcoal/75 transition hover:bg-cream/60"
              >
                <Check size={15} /> {L('تم', 'Done')}
              </button>
            </div>
          </div>
        </div>
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
