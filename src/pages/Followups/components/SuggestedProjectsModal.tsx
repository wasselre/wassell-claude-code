import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, Sparkles, AlertTriangle, Info } from 'lucide-react';
import type { AppModel, AppRecord } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { buildAssistantContext } from '@/lib/followups/assistantContext';
import { draftToMatchRequirements } from '@/lib/matching/requirements';
import {
  fetchProjectFinder, totalFinderMatches, FINDER_GROUP_KEYS,
  type FinderResponse, type FinderGroupKey, type FinderMatch,
} from '@/lib/matching/projectFinder';
import { addProjectToClient } from '@/lib/matching/addToClient';
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
 * Default sources are our_projects + all_projects only — market_listings is NOT
 * used here (opt-in only; its area scan is slow for dense districts). No chat
 * pane, no compare, no WhatsApp, no next-action, no task creation.
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
  const [addStates, setAddStates] = useState<Record<string, 'idle' | 'saving' | 'added'>>({});

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
      { requirements, clientId: clientRec?.id ?? null, followupId, perGroup: 8 },
      controller.signal,
    )
      .then((r) => {
        setResp(r);
        const firstFilled = FINDER_GROUP_KEYS.find((k) => (r.groups[k]?.length ?? 0) > 0);
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

  function onOpenDetails(item: FinderMatch) {
    window.open(`/model/all_projects/${item.project_id}`, '_blank', 'noopener');
  }
  async function onAddToClient(item: FinderMatch) {
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

  const total = totalFinderMatches(resp);
  const missing = resp?.metadata.missing_required_preferences ?? [];
  const needsPreferences = resp?.metadata.needs_preferences === true;
  const activeItems = resp?.groups[activeTab] ?? [];

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
          {!loading && !error && activeItems.map((item) => (
            <FinderCard
              key={item.project_id}
              item={item}
              isAr={isAr}
              onOpenDetails={onOpenDetails}
              onAddToClient={onAddToClient}
              addState={addStates[item.project_id] ?? 'idle'}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
