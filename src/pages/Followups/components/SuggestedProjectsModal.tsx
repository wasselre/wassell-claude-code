import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2, Sparkles, AlertTriangle, Info, Bookmark, XCircle } from 'lucide-react';
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
import FinderCard from './FinderCard';

/**
 * The "Suggested Projects" modal — the Follow-up completion-phase centerpiece.
 * Phase 2: powered by the DETERMINISTIC, geography boundary-verified
 * /api/project-finder (NO LLM — parse:false, explain:false). Shows the four
 * location-centric groups (exact_district / nearby_district / same_city /
 * broader_fallback) ranked by code, reading the UNSAVED follow-up preferences
 * captured when the modal opened.
 *
 *   Top:  current preferences + missing-preference warnings
 *   Body: 4 group tabs → ranked, boundary-verified cards
 *
 * Sources: our_projects + all_projects + market_listings (all three) so the
 * salesperson sees the full picture; each card is source-labelled and non-portfolio
 * sources carry a "verify before offering" banner. The deterministic per-card
 * explanation is localized (locale = current UI language). No chat pane, no
 * compare, no WhatsApp, no next-action, no task creation.
 */

interface Props {
  isAr: boolean;
  clientsModel: AppModel | null;
  clientRec: AppRecord | null;
  prefDraft: Record<string, unknown>;
  followupDraft: Record<string, unknown>;
  followupId: string | null;
  projectName?: string | null;
  onClose: () => void;
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

export default function SuggestedProjectsModal({
  isAr, clientsModel, clientRec, prefDraft, followupDraft, followupId, projectName, onClose,
}: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);

  const [resp, setResp] = useState<FinderResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FinderGroupKey>('exact_district_matches');
  // Incremental render: the result set is uncapped (every match ≥ 70), which can be
  // hundreds of cards. Render a window and grow it as the user scrolls (keeps the DOM
  // light without a virtualization dep; handles variable card heights natively).
  const PAGE = 24;
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Bulk-selection (auto-checks only score===100), per-card single-save state, and
  // the eliminate-with-notes prompt. All persistence routes through clientOptions.ts.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saveStates, setSaveStates] = useState<Record<string, 'idle' | 'saving' | 'saved'>>({});
  const [bulkSaving, setBulkSaving] = useState(false);
  const [eliminateTarget, setEliminateTarget] = useState<FinderMatch | null>(null);
  const [eliminateNotes, setEliminateNotes] = useState('');
  const [eliminating, setEliminating] = useState(false);

  // Cross-reference the client's already-saved options so each card shows its
  // current status (and an eliminated one never silently reactivates).
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

  // Snapshot the draft-first context + requirements when the modal opens (the
  // underlying form can't be edited while the modal is up).
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

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchProjectFinder(
      {
        requirements,
        clientId: clientRec?.id ?? null,
        followupId,
        // Show EVERY option that scores ≥ 70 — no per-group cap (perGroup:0 = unlimited).
        perGroup: 0,
        minScore: 70,
        // Show the full picture: our portfolio + the broad catalog + market ads.
        // Non-portfolio sources are labelled + carry a "verify before offering" banner.
        sources: ['our_projects', 'all_projects', 'market_listings'],
        locale: isAr ? 'ar' : 'en',
      },
      controller.signal,
    )
      .then((r) => {
        setResp(r);
        const firstFilled = FINDER_GROUP_KEYS.find((k) => (r.groups[k]?.length ?? 0) > 0);
        if (firstFilled) setActiveTab(firstFilled);
        // Auto-select ONLY perfect (100%) matches; everything below 100 stays
        // visible but unchecked until the rep selects it.
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

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function onOpenDetails(item: FinderMatch) {
    // our_projects + all_projects ids are all_projects record ids; market_listings
    // items carry a market_listings record id.
    const model = item.source === 'market_listings' ? 'market_listings' : 'all_projects';
    window.open(`/model/${model}/${item.project_id}`, '_blank', 'noopener');
  }
  const noClient = () =>
    addToast(L('لا يوجد عميل مرتبط بهذه المتابعة.', 'No client linked to this follow-up.'), 'error');

  /** Map a finder match → an option upsert payload (snapshots the display facts). */
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
    const all = FINDER_GROUP_KEYS.flatMap((k) => resp?.groups[k] ?? []);
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
    // Ensure the option exists, then eliminate it with the reason notes. A
    // freshly-found match is created (suitable) then flipped to eliminated; an
    // existing one is updated in place.
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

  const total = totalFinderMatches(resp);
  const missing = resp?.metadata.missing_required_preferences ?? [];
  const needsPreferences = resp?.metadata.needs_preferences === true;
  const activeItems = resp?.groups[activeTab] ?? [];
  const market = resp?.metadata.market;
  const suggestLabel = (code: string) => (MISSING_LABELS[code] ? (isAr ? MISSING_LABELS[code].ar : MISSING_LABELS[code].en) : code);

  // Reset the render window when the visible list changes (tab switch / new results).
  useEffect(() => { setVisibleCount(PAGE); scrollRef.current?.scrollTo({ top: 0 }); }, [activeTab, resp]);
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
  const shown = activeItems.slice(0, visibleCount);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 p-3 sm:p-6" onMouseDown={onClose}>
      <div
        className="flex h-full max-h-[92vh] w-full max-w-[860px] flex-col overflow-hidden rounded-2xl bg-cream shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        dir={isAr ? 'rtl' : 'ltr'}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-sand/40 bg-white px-4 py-3">
          <Sparkles size={18} className="text-copper" />
          <div className="min-w-0 flex-1">
            <div className="text-base font-bold text-chocolate">{L('الباحث عن المشاريع', 'Project Finder')}</div>
            <div className="text-[11px] text-charcoal/60">{L('ترتيب دقيق موثّق بالإحداثيات — مبني على تفضيلات العميل الحالية (تشمل تعديلات لم تُحفظ).', 'Coordinate-verified ranking — based on the current follow-up preferences (including unsaved edits).')}</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-charcoal/50 transition hover:bg-cream hover:text-charcoal" aria-label={L('إغلاق', 'Close')}>
            <X size={18} />
          </button>
        </div>

        {/* Preferences + missing warnings */}
        <div className="border-b border-sand/30 bg-white/60 px-4 py-2.5">
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

        {/* Market-source honesty notice — we NEVER silently drop listings; when the
            area is too dense to scan in full we ask for more criteria instead. */}
        {market?.status === 'too_many' && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
            <AlertTriangle size={13} className="shrink-0" />
            <span className="font-semibold">
              {market.count != null
                ? L(`إعلانات السوق غير معروضة: يوجد ${market.count.toLocaleString('en-US')} إعلان في هذا الحي.`,
                    `Market listings hidden: ${market.count.toLocaleString('en-US')} ads in this district.`)
                : L('إعلانات السوق غير معروضة: عددها كبير جداً في هذا الحي.', 'Market listings hidden: too many ads in this district.')}
            </span>
            <span>{L('أضف', 'Add')}</span>
            {(market.suggest ?? []).map((s) => (
              <span key={s} className="inline-flex items-center rounded-full border border-amber-300 bg-white px-2 py-0.5 font-semibold">
                {suggestLabel(s)}
              </span>
            ))}
            <span>{L('لعرضها (لا يتم حذف أي إعلان).', 'to show them (nothing is dropped).')}</span>
          </div>
        )}
        {market?.status === 'needs_district' && (
          <div className="flex items-center gap-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
            <AlertTriangle size={13} className="shrink-0" />
            <span>{L('حدّد الحي لعرض إعلانات السوق.', 'Set a district to include market listings.')}</span>
          </div>
        )}
        {market?.status === 'unavailable' && (
          <div className="flex items-center gap-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
            <AlertTriangle size={13} className="shrink-0" />
            <span>{L('تعذّر تحميل إعلانات السوق — أعد المحاولة.', 'Couldn’t load market listings — please retry.')}</span>
          </div>
        )}

        {/* Group tabs */}
        <div className="flex flex-wrap gap-1 border-b border-sand/30 bg-white/40 px-3 py-2">
          {FINDER_GROUP_KEYS.map((k) => {
            const count = resp?.groups[k]?.length ?? 0;
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

        {/* Cards */}
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {loading && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-charcoal/55">
              <Loader2 size={22} className="animate-spin text-copper" />
              <span className="text-sm">{L('جارٍ ترشيح المشاريع…', 'Finding the best-fit projects…')}</span>
            </div>
          )}
          {!loading && error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
          )}
          {!loading && !error && needsPreferences && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-charcoal/55">
              <Info size={22} className="text-copper" />
              <p className="text-sm">{L('لم تُحدَّد أي تفضيلات لهذا العميل. حدِّد الحي أو الميزانية أو نوع العقار (أو اسأل العميل) للحصول على ترشيح دقيق.', 'No preferences are set for this client. Set a district, budget, or unit type (or ask the client) for a precise match.')}</p>
            </div>
          )}
          {!loading && !error && !needsPreferences && total === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-charcoal/55">
              <Info size={22} className="text-copper" />
              <p className="text-sm">{L('لا توجد مشاريع مطابقة بالتفضيلات الحالية. جرّب توسيع الميزانية أو الموقع، أو اسأل العميل عن تفاصيل أكثر.', 'No matching projects for the current preferences. Try widening the budget or location, or gather more details from the client.')}</p>
            </div>
          )}
          {!loading && !error && total > 0 && activeItems.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-charcoal/55">{L('لا نتائج في هذه المجموعة — جرّب تبويباً آخر.', 'Nothing in this group — try another tab.')}</div>
          )}
          {!loading && !error && shown.map((item) => (
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
          {!loading && !error && activeItems.length > 0 && (
            <>
              {visibleCount < activeItems.length && <div ref={sentinelRef} className="h-1" aria-hidden />}
              <div className="py-2 text-center text-[11px] text-charcoal/45">
                {L(`عرض ${shown.length} من ${activeItems.length}`, `Showing ${shown.length} of ${activeItems.length}`)}
              </div>
            </>
          )}
        </div>

        {/* Footer — bulk-save the SELECTED options into the client's unified list.
            Only score===100 matches are pre-checked; the rep can select more. */}
        {!loading && !error && total > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-sand/40 bg-white px-4 py-3">
            <span className="text-xs text-charcoal/60">
              {L(`${selected.size} محدّد`, `${selected.size} selected`)}
            </span>
            <button
              type="button"
              onClick={onBulkSave}
              disabled={bulkSaving || selected.size === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-3.5 py-2 text-sm font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
            >
              {bulkSaving ? <Loader2 size={15} className="animate-spin" /> : <Bookmark size={15} />}
              {L('حفظ المحدّد كخيارات للعميل', 'Save selected to client options')}
            </button>
          </div>
        )}
      </div>

      {/* Eliminate-with-notes prompt — the reason is a free-text notes field (no
          structured reason codes yet, by design). */}
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
