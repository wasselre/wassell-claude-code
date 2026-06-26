import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2, Sparkles, AlertTriangle, GitCompareArrows, Info } from 'lucide-react';
import type { AppModel, AppRecord } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { buildAssistantContext } from '@/lib/followups/assistantContext';
import { draftToMatchRequirements } from '@/lib/matching/requirements';
import {
  fetchSuggestedProjects, totalSuggestions, SUGGESTION_GROUP_KEYS,
  type SuggestionsResponse, type SuggestionGroupKey, type SuggestionItem,
} from '@/lib/matching/suggestions';
import { addProjectToClient } from '@/lib/matching/addToClient';
import SuggestionCard from './SuggestionCard';
import AssistantChatPane, { type AssistantChatHandle } from './AssistantChatPane';
import ProjectWhatsAppFlow from './ProjectWhatsAppFlow';

/**
 * The large "Suggested Projects" modal — the completion-phase centerpiece.
 *   Top:   current preferences + missing-preference warnings
 *   Left:  grouped, ranked project cards (Exact / Nearby / Budget / Location / Fallback)
 *   Right: the assistant chat (explain / compare / pitch / WhatsApp), grounded in
 *          the SAME draft-first context.
 *
 * The grouped cards come from the DETERMINISTIC /api/suggest-projects (no LLM).
 * It reads the UNSAVED follow-up preferences (prefDraft) captured when the modal
 * opened, so recommendations reflect what the rep is editing on the call.
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

const TAB_LABELS: Record<SuggestionGroupKey, { ar: string; en: string }> = {
  exact_matches: { ar: 'مطابقة تامة', en: 'Exact' },
  nearby_alternatives: { ar: 'قريب', en: 'Nearby' },
  budget_matches: { ar: 'ضمن الميزانية', en: 'Budget' },
  location_matches: { ar: 'الموقع', en: 'Location' },
  fallback_matches: { ar: 'بدائل', en: 'Fallback' },
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

  const chatRef = useRef<AssistantChatHandle>(null);
  const [resp, setResp] = useState<SuggestionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SuggestionGroupKey>('exact_matches');
  const [compare, setCompare] = useState<SuggestionItem[]>([]);
  const [addStates, setAddStates] = useState<Record<string, 'idle' | 'saving' | 'added'>>({});
  // The project whose WhatsApp flow is open (popup over this modal), if any.
  const [waProject, setWaProject] = useState<SuggestionItem | null>(null);

  // id → display name for districts + cities, from the loaded geography records.
  // Wires both the requirements mapper's lookup-first path AND the assistant
  // context preface (which now reads lookup ids, resolved via geoNames).
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

  // Snapshot the draft-first context + requirements when the modal opens. The
  // underlying form can't be edited while the modal is up, so this captures the
  // rep's CURRENT unsaved values (the acceptance-critical behavior).
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
    fetchSuggestedProjects(
      {
        requirements,
        clientId: clientRec?.id ?? null,
        followupId,
        usedDraftValues: true,
        perGroup: 8,
      },
      controller.signal,
    )
      .then((r) => {
        setResp(r);
        // Land on the first non-empty tab so the rep sees results immediately.
        const firstFilled = SUGGESTION_GROUP_KEYS.find((k) => (r.groups[k]?.length ?? 0) > 0);
        if (firstFilled) setActiveTab(firstFilled);
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

  const getPreface = () => ctx.preface;

  function toggleCompare(item: SuggestionItem) {
    setCompare((prev) => {
      const exists = prev.some((p) => p.project_id === item.project_id);
      if (exists) return prev.filter((p) => p.project_id !== item.project_id);
      if (prev.length >= 4) return prev; // matcher compares 2–4
      return [...prev, item];
    });
  }

  function runCompare() {
    if (compare.length < 2) return;
    const names = compare.map((c) => c.project_name).join('، ');
    chatRef.current?.ask(L(`قارن بين هذه المشاريع لهذا العميل: ${names}`, `Compare these projects for this customer: ${names}`));
  }

  function onPitch(item: SuggestionItem) {
    chatRef.current?.ask(L(`اكتب عرضاً مختصراً لمشروع «${item.project_name}» لهذا العميل بناءً على تفضيلاته.`, `Write a short pitch for "${item.project_name}" for this customer based on their preferences.`));
  }
  function onDraftWhatsApp(item: SuggestionItem) {
    // Open the project's WhatsApp flow: prefill the client's chat with the stored
    // project template (or generate + save one first) — a popup over this modal.
    setWaProject(item);
  }
  function onAsk(item: SuggestionItem) {
    chatRef.current?.ask(L(`لماذا يُعتبر مشروع «${item.project_name}» مناسباً لهذا العميل؟`, `Why is "${item.project_name}" a good fit for this customer?`));
  }
  function onOpenDetails(item: SuggestionItem) {
    window.open(`/model/all_projects/${item.project_id}`, '_blank', 'noopener');
  }
  async function onAddToClient(item: SuggestionItem) {
    if (!clientRec?.id) { addToast(L('لا يوجد عميل مرتبط بهذه المتابعة.', 'No client linked to this follow-up.'), 'error'); return; }
    setAddStates((s) => ({ ...s, [item.project_id]: 'saving' }));
    const res = await addProjectToClient(clientRec.id, item.project_id);
    if (res.ok) {
      setAddStates((s) => ({ ...s, [item.project_id]: 'added' }));
      addToast(res.status === 'already' ? L('المشروع مضاف مسبقاً لتفضيلات العميل.', 'Already in the client preferences.') : L('تمت إضافة المشروع لتفضيلات العميل.', 'Added to client preferences.'), 'success');
    } else {
      setAddStates((s) => ({ ...s, [item.project_id]: 'idle' }));
      addToast(res.status === 'conflict'
        ? L('تم تعديل العميل من مستخدم آخر — حدّث الصفحة وأعد المحاولة.', 'Client was edited elsewhere — reload and retry.')
        : L('تعذّرت إضافة المشروع.', 'Could not add the project.'), 'error');
    }
  }

  const total = totalSuggestions(resp);
  const missing = resp?.client_preferences_summary.missing_required_preferences ?? [];
  const activeItems = resp?.groups[activeTab] ?? [];

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 p-3 sm:p-6" onMouseDown={onClose}>
      <div
        className="flex h-full max-h-[92vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-2xl bg-cream shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        dir={isAr ? 'rtl' : 'ltr'}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-sand/40 bg-white px-4 py-3">
          <Sparkles size={18} className="text-copper" />
          <div className="min-w-0 flex-1">
            <div className="text-base font-bold text-chocolate">{L('المشاريع المقترحة', 'Suggested Projects')}</div>
            <div className="text-[11px] text-charcoal/60">{L('مبنية على تفضيلات العميل الحالية في نموذج المتابعة (تشمل تعديلات لم تُحفظ).', 'Based on the current follow-up preferences (including unsaved edits).')}</div>
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

        {/* Body: grouped cards (left) + chat (right) */}
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* Left — grouped cards */}
          <div className="flex min-h-0 flex-1 flex-col border-b border-sand/30 lg:border-b-0 lg:border-e">
            {/* Tabs */}
            <div className="flex flex-wrap gap-1 border-b border-sand/30 bg-white/40 px-3 py-2">
              {SUGGESTION_GROUP_KEYS.map((k) => {
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

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              {loading && (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-charcoal/55">
                  <Loader2 size={22} className="animate-spin text-copper" />
                  <span className="text-sm">{L('جارٍ ترشيح المشاريع…', 'Finding the best-fit projects…')}</span>
                </div>
              )}
              {!loading && error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
              )}
              {!loading && !error && resp && !resp.metadata.has_criteria && total > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  {L(
                    'لم تُحدَّد أي تفضيلات لهذا العميل، لذلك هذه ليست ترشيحات مطابقة — إنما مشاريع متاحة عامة. حدِّد الحي أو الميزانية أو نوع العقار (أو اسأل العميل) للحصول على ترشيح دقيق.',
                    'No preferences are set for this client, so these are not matched recommendations — just generally available projects. Set a district, budget, or unit type (or ask the client) for a precise match.',
                  )}
                </div>
              )}
              {!loading && !error && total === 0 && (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-charcoal/55">
                  <Info size={22} className="text-copper" />
                  <p className="text-sm">{L('لا توجد مشاريع مطابقة بالتفضيلات الحالية. جرّب توسيع الميزانية أو الموقع، أو اسأل العميل عن تفاصيل أكثر.', 'No matching projects for the current preferences. Try widening the budget or location, or gather more details from the client.')}</p>
                </div>
              )}
              {!loading && !error && total > 0 && activeItems.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-charcoal/55">{L('لا نتائج في هذه المجموعة — جرّب تبويباً آخر.', 'Nothing in this group — try another tab.')}</div>
              )}
              {!loading && !error && activeItems.map((item) => (
                <SuggestionCard
                  key={item.project_id}
                  item={item}
                  isAr={isAr}
                  compareSelected={compare.some((c) => c.project_id === item.project_id)}
                  onToggleCompare={toggleCompare}
                  onPitch={onPitch}
                  onDraftWhatsApp={onDraftWhatsApp}
                  onAsk={onAsk}
                  onOpenDetails={onOpenDetails}
                  onAddToClient={onAddToClient}
                  addState={addStates[item.project_id] ?? 'idle'}
                />
              ))}
            </div>

            {/* Compare bar */}
            {compare.length > 0 && (
              <div className="flex items-center gap-2 border-t border-sand/30 bg-white px-3 py-2">
                <GitCompareArrows size={15} className="text-copper" />
                <span className="text-xs text-charcoal/70">{L(`${compare.length} مُحدد للمقارنة`, `${compare.length} selected`)}</span>
                <div className="flex-1" />
                <button type="button" onClick={() => setCompare([])} className="text-[11px] text-charcoal/55 hover:underline">{L('مسح', 'Clear')}</button>
                <button type="button" onClick={runCompare} disabled={compare.length < 2} className="rounded-lg bg-copper px-3 py-1 text-xs font-bold text-white transition hover:bg-terracotta disabled:opacity-50">
                  {L('قارن', 'Compare')}
                </button>
              </div>
            )}
          </div>

          {/* Right — assistant chat */}
          <div className="flex min-h-0 w-full flex-col bg-white lg:w-[400px] lg:shrink-0">
            <div className="border-b border-sand/30 bg-copper/10 px-3 py-2 text-sm font-bold text-chocolate">{L('اسأل المساعد', 'Ask the assistant')}</div>
            <div className="min-h-0 flex-1">
              <AssistantChatPane ref={chatRef} isAr={isAr} getPreface={getPreface} />
            </div>
          </div>
        </div>
      </div>
    </div>

    {/* WhatsApp flow — a SIBLING popup (not nested in the modal's onMouseDown
        backdrop, so clicking it never closes the whole modal). Finds/generates the
        project template → opens the client chat prefilled. Keeps the rep here. */}
    {waProject && (
      <ProjectWhatsAppFlow
        isAr={isAr}
        projectId={waProject.project_id}
        projectName={waProject.project_name}
        clientRec={clientRec}
        onClose={() => setWaProject(null)}
      />
    )}
    </>
  );
}
