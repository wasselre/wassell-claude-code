import { useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import {
  X, Search, Sparkles, Loader2, RefreshCw, Save, SkipForward, Check,
  AlertTriangle, Building2, ArrowRight, ArrowLeft,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useApplyViewScope } from '@/hooks/usePermission';
import { normalizeForSearch } from '@/lib/recordSearch';
import { resolveProjectFacts, composeProjectMessage, type ProjectMessageFacts } from '@/lib/projectMessageFacts';
import { detectInputLanguage } from '@/lib/translateLabel';
import { transliterateName } from '@/lib/transliterateName';
import Button from '@/components/ui/Button';
import type { AppRecord } from '@/types';

/**
 * AI Project Message generator for the chat_templates editor. Flow:
 *   1. Select one or more our_projects records (search across the resolved
 *      facts — name / city / district / unit types / price).
 *   2. Compose one bilingual (ar + en) WhatsApp message PER project,
 *      client-side (deterministic — see composeProjectMessage below).
 *   3. Review each result (edit ar/en, regenerate, skip) and save it as a
 *      chat_templates record (language='both', linked to all_projects via
 *      `project_id`). Nothing is saved without the user pressing Save.
 *
 * All facts are resolved client-side (see projectMessageFacts.ts) so the model
 * never invents data — missing fields show a warning + a "not available"
 * placeholder in the message.
 */

interface GenItem {
  ourProjectId: string;
  allProjectId: string | null;
  name: string;
  facts: ProjectMessageFacts;
  status: 'idle' | 'generating' | 'done' | 'error' | 'saved' | 'skipped';
  bodyAr: string;
  bodyEn: string;
  error?: string;
}

const MISSING_LABELS: Record<string, { ar: string; en: string }> = {
  name: { ar: 'اسم المشروع', en: 'Name' },
  city: { ar: 'المدينة', en: 'City' },
  district: { ar: 'الحي', en: 'District' },
  unit_types: { ar: 'أنواع الوحدات', en: 'Unit types' },
  bedrooms: { ar: 'غرف النوم', en: 'Bedrooms' },
  area: { ar: 'المساحة', en: 'Area' },
  bathrooms: { ar: 'دورات المياه', en: 'Bathrooms' },
  min_price: { ar: 'السعر', en: 'Price' },
  link: { ar: 'رابط المشروع', en: 'Project link' },
};

export default function ProjectMessageGeneratorModal({ onClose }: { onClose: () => void }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const ourProjectsModel = useMemo(() => models.find((m) => m.name === 'our_projects'), [models]);
  const chatTemplatesModel = useMemo(() => models.find((m) => m.name === 'chat_templates'), [models]);

  const allOurProjects = ourProjectsModel ? (records[ourProjectsModel.id] ?? []) : [];
  const scopedProjects = useApplyViewScope(ourProjectsModel, allOurProjects);

  // Resolve facts once for every our_projects record on mount. Reused for both
  // the picker's search index AND generation, so we never re-resolve. our_projects
  // is a small curated set, so resolving all up front is cheap.
  const factsByRecord = useMemo(() => {
    const map = new Map<string, ProjectMessageFacts>();
    for (const r of scopedProjects) map.set(r.id, resolveProjectFacts(r, models, records));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedProjects, models, records]);

  // Search string per project, built from the resolved facts so it matches the
  // spec's "name / city / district / unit type / price" scope.
  const searchIndex = useMemo(() => {
    const idx = new Map<string, string>();
    for (const r of scopedProjects) {
      const f = factsByRecord.get(r.id);
      const parts = [
        f?.name ?? '',
        f?.city ? `${f.city.ar} ${f.city.en}` : '',
        f?.district ? `${f.district.ar} ${f.district.en}` : '',
        ...(f?.unitTypes ?? []).map((u) => `${u.ar} ${u.en}`),
        f?.minPrice ? `${f.minPrice.ar} ${f.minPrice.en}` : '',
        typeof r.data?.location === 'string' ? r.data.location : '',
      ];
      idx.set(r.id, normalizeForSearch(parts.join(' ')));
    }
    return idx;
  }, [scopedProjects, factsByRecord]);

  const [step, setStep] = useState<'select' | 'review'>('select');
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [items, setItems] = useState<GenItem[]>([]);

  const results = useMemo(() => {
    const q = normalizeForSearch(query.trim());
    if (!q) return scopedProjects;
    return scopedProjects.filter((r) => (searchIndex.get(r.id) ?? '').includes(q));
  }, [query, scopedProjects, searchIndex]);

  const toggle = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const nameOf = (r: AppRecord): string => {
    const f = factsByRecord.get(r.id);
    return f?.name || (typeof r.data?.project_name === 'string' ? r.data.project_name : null) || (isAr ? '(بدون اسم)' : '(no name)');
  };

  // ── Composition ──────────────────────────────────────────────────────
  // The message body is deterministic (no AI prose). The ONE async step is
  // translating the Arabic project name to English for the English body
  // (cached + dedup'd by translateLabel; non-Arabic names like "178" pass
  // through; falls back to the Arabic name if the translate API is down).
  const resolveNameEn = async (name: string | null): Promise<string | null> => {
    if (!name || detectInputLanguage(name) !== 'ar') return name;
    try {
      return await transliterateName(name); // phonetic, not a meaning translation
    } catch {
      return name; // graceful — keep the Arabic name in the EN body
    }
  };

  // Re-compose one project (also used by Regenerate); discards manual edits.
  const generateOne = async (ourProjectId: string) => {
    const facts = factsByRecord.get(ourProjectId);
    if (!facts) return;
    setItems((prev) => prev.map((i) => (i.ourProjectId === ourProjectId ? { ...i, status: 'generating', error: undefined } : i)));
    const nameEn = await resolveNameEn(facts.name);
    const { body_ar, body_en } = composeProjectMessage(facts, { nameEn });
    setItems((prev) => prev.map((i) => (i.ourProjectId === ourProjectId ? { ...i, status: 'done', bodyAr: body_ar, bodyEn: body_en } : i)));
  };

  const startReview = () => {
    const its: GenItem[] = selectedIds.map((id) => {
      const facts = factsByRecord.get(id)!;
      return {
        ourProjectId: id,
        allProjectId: facts.allProjectId,
        name: facts.name || (isAr ? '(بدون اسم)' : '(no name)'),
        facts,
        status: 'generating' as const,
        bodyAr: '',
        bodyEn: '',
      };
    });
    setItems(its);
    setStep('review');
    void Promise.allSettled(its.map((it) => generateOne(it.ourProjectId)));
  };

  const saveItem = async (ourProjectId: string) => {
    if (!chatTemplatesModel) {
      addToast(isAr ? 'نموذج القوالب غير متوفر' : 'Templates model unavailable', 'error');
      return;
    }
    const it = items.find((i) => i.ourProjectId === ourProjectId);
    if (!it) return;
    if (!it.bodyAr.trim() && !it.bodyEn.trim()) {
      addToast(isAr ? 'الرسالة فارغة' : 'Message is empty', 'error');
      return;
    }
    const now = new Date().toISOString();
    const record: AppRecord = {
      id: uuid(),
      model_id: chatTemplatesModel.id,
      data: {
        name: it.name,
        category: 'project',
        language: 'both',
        tags: ['project'],
        body_ar: it.bodyAr,
        body_en: it.bodyEn,
        media_kind: '',
        media_file_id: null,
        media_mime: null,
        media_size: null,
        media_filename: null,
        // Link the template to the master all_projects record (per spec).
        project_id: it.allProjectId,
        // Every image saved on the project — sent as its own WhatsApp image
        // message after the text when this template is used.
        project_image_file_ids: it.facts.imageFileIds,
      },
      created_at: now,
      updated_at: now,
    };
    try {
      await saveRecord(record);
      setItems((prev) => prev.map((i) => (i.ourProjectId === ourProjectId ? { ...i, status: 'saved' } : i)));
      addToast(isAr ? `تم حفظ قالب: ${it.name}` : `Saved: ${it.name}`, 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const saveAll = async () => {
    const savable = items.filter((i) => i.status === 'done');
    for (const it of savable) {
      // eslint-disable-next-line no-await-in-loop
      await saveItem(it.ourProjectId);
    }
  };

  const skipItem = (ourProjectId: string) =>
    setItems((prev) => prev.map((i) => (i.ourProjectId === ourProjectId ? { ...i, status: 'skipped' } : i)));

  const editBody = (ourProjectId: string, lang: 'ar' | 'en', value: string) =>
    setItems((prev) =>
      prev.map((i) =>
        i.ourProjectId === ourProjectId ? { ...i, ...(lang === 'ar' ? { bodyAr: value } : { bodyEn: value }) } : i,
      ),
    );

  const BackIcon = isAr ? ArrowRight : ArrowLeft;
  const savedCount = items.filter((i) => i.status === 'saved').length;
  const pendingSavable = items.filter((i) => i.status === 'done').length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-sand/20 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-copper/10 text-copper flex items-center justify-center shrink-0">
            <Sparkles size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-chocolate">
              {isAr ? 'توليد رسائل المشاريع' : 'Generate project messages'}
            </h2>
            <p className="text-xs text-charcoal/50">
              {step === 'select'
                ? (isAr ? 'اختر مشروعًا أو أكثر من «مشاريعنا»' : 'Pick one or more projects from Our Projects')
                : (isAr ? 'راجع كل رسالة قبل الحفظ' : 'Review each message before saving')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream transition-colors"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={16} />
          </button>
        </div>

        {/* ── SELECT step ── */}
        {step === 'select' && (
          <>
            <div className="px-5 py-3 border-b border-sand/10 shrink-0">
              <div className="relative">
                <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-charcoal/30" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={isAr ? 'ابحث بالاسم أو المدينة أو الحي أو السعر…' : 'Search by name, city, district, price…'}
                  className="form-input ps-8 text-sm w-full"
                  autoFocus
                  dir="auto"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-2 min-h-[200px]">
              {!ourProjectsModel ? (
                <p className="text-sm text-charcoal/50 py-6 text-center">
                  {isAr ? 'نموذج «مشاريعنا» غير متوفر' : 'Our Projects model unavailable'}
                </p>
              ) : results.length === 0 ? (
                <p className="text-sm text-charcoal/40 py-6 text-center">
                  {scopedProjects.length === 0
                    ? (isAr ? 'لا توجد مشاريع' : 'No projects')
                    : (isAr ? 'لا توجد نتائج' : 'No matches')}
                </p>
              ) : (
                <div className="divide-y divide-sand/15">
                  {results.map((r) => {
                    const f = factsByRecord.get(r.id);
                    const checked = selectedIds.includes(r.id);
                    const sub = [f?.city ? (isAr ? f.city.ar : f.city.en) : null, f?.district ? (isAr ? f.district.ar : f.district.en) : null, f?.minPrice ? (isAr ? f.minPrice.ar : f.minPrice.en) : null]
                      .filter(Boolean)
                      .join(' · ');
                    return (
                      <label key={r.id} className="flex items-center gap-3 py-2 cursor-pointer hover:bg-cream/40 px-2 rounded-lg">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(r.id)}
                          className="w-4 h-4 accent-copper shrink-0"
                        />
                        <div className="w-8 h-8 rounded-lg bg-copper/10 text-copper flex items-center justify-center shrink-0">
                          <Building2 size={15} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm text-charcoal truncate">{nameOf(r)}</div>
                          {sub && <div className="text-xs text-charcoal/50 truncate">{sub}</div>}
                        </div>
                        {(f?.missing.length ?? 0) > 0 && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5 shrink-0"
                            title={isAr ? 'بعض الحقول غير متوفرة' : 'Some fields missing'}
                          >
                            <AlertTriangle size={10} />
                            {f!.missing.length}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-sand/20 shrink-0">
              <span className="text-sm text-charcoal/60">
                {isAr ? `${selectedIds.length} محدد` : `${selectedIds.length} selected`}
              </span>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={onClose}>
                  {isAr ? 'إلغاء' : 'Cancel'}
                </Button>
                <Button variant="primary" onClick={startReview} disabled={selectedIds.length === 0}>
                  <Sparkles size={14} />
                  {isAr ? `توليد (${selectedIds.length})` : `Generate (${selectedIds.length})`}
                </Button>
              </div>
            </div>
          </>
        )}

        {/* ── REVIEW step ── */}
        {step === 'review' && (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
              {items.map((it) => (
                <ReviewCard
                  key={it.ourProjectId}
                  item={it}
                  isAr={isAr}
                  onRegenerate={() => generateOne(it.ourProjectId)}
                  onSave={() => saveItem(it.ourProjectId)}
                  onSkip={() => skipItem(it.ourProjectId)}
                  onEdit={(lang, v) => editBody(it.ourProjectId, lang, v)}
                />
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-sand/20 shrink-0">
              <button onClick={() => setStep('select')} className="inline-flex items-center gap-1.5 text-sm text-charcoal/60 hover:text-copper">
                <BackIcon size={14} />
                {isAr ? 'تعديل الاختيار' : 'Change selection'}
              </button>
              <div className="flex items-center gap-3">
                {savedCount > 0 && (
                  <span className="text-xs text-green-700">
                    {isAr ? `${savedCount} محفوظ` : `${savedCount} saved`}
                  </span>
                )}
                <Button variant="secondary" onClick={saveAll} disabled={pendingSavable === 0}>
                  <Save size={14} />
                  {isAr ? `حفظ الكل (${pendingSavable})` : `Save all (${pendingSavable})`}
                </Button>
                <Button variant="primary" onClick={onClose}>
                  {isAr ? 'تم' : 'Done'}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Per-project review card ───────────────────────────────────────────

function ReviewCard({
  item,
  isAr,
  onRegenerate,
  onSave,
  onSkip,
  onEdit,
}: {
  item: GenItem;
  isAr: boolean;
  onRegenerate: () => void;
  onSave: () => void;
  onSkip: () => void;
  onEdit: (lang: 'ar' | 'en', value: string) => void;
}) {
  const saved = item.status === 'saved';
  const skipped = item.status === 'skipped';
  const generating = item.status === 'generating';

  return (
    <div className={`card p-4 ${saved ? 'border-green-300 bg-green-50/40' : skipped ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2 mb-2">
        <Building2 size={15} className="text-copper shrink-0" />
        <h3 className="font-bold text-sm text-charcoal flex-1 truncate">{item.name}</h3>
        {saved && (
          <span className="inline-flex items-center gap-1 text-xs text-green-700 font-medium">
            <Check size={13} /> {isAr ? 'محفوظ' : 'Saved'}
          </span>
        )}
        {skipped && <span className="text-xs text-charcoal/50">{isAr ? 'تم التخطي' : 'Skipped'}</span>}
      </div>

      {/* Missing-field warning */}
      {item.facts.missing.length > 0 && (
        <div className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mb-2">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>
            {isAr ? 'حقول غير متوفرة (ستظهر «غير متوفر»): ' : 'Missing (shown as “Not available”): '}
            {item.facts.missing.map((k) => (isAr ? MISSING_LABELS[k]?.ar : MISSING_LABELS[k]?.en) ?? k).join(isAr ? '، ' : ', ')}
          </span>
        </div>
      )}

      {generating ? (
        <div className="flex items-center justify-center gap-2 py-8 text-charcoal/50 text-sm">
          <Loader2 size={16} className="animate-spin" />
          {isAr ? 'جارٍ التوليد…' : 'Generating…'}
        </div>
      ) : item.status === 'error' ? (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2">
          {item.error ?? (isAr ? 'فشل التوليد' : 'Generation failed')}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-bold text-charcoal/40 mb-1">{isAr ? 'النص العربي' : 'Arabic'}</label>
            <textarea
              value={item.bodyAr}
              onChange={(e) => onEdit('ar', e.target.value)}
              rows={8}
              dir="rtl"
              disabled={saved || skipped}
              className="form-input w-full text-sm resize-none leading-relaxed"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-charcoal/40 mb-1">{isAr ? 'النص الإنجليزي' : 'English'}</label>
            <textarea
              value={item.bodyEn}
              onChange={(e) => onEdit('en', e.target.value)}
              rows={8}
              dir="ltr"
              disabled={saved || skipped}
              className="form-input w-full text-sm resize-none leading-relaxed"
            />
          </div>
        </div>
      )}

      {/* Per-card actions */}
      {!saved && !skipped && (
        <div className="flex items-center justify-end gap-2 mt-3">
          <button
            onClick={onRegenerate}
            disabled={generating}
            className="inline-flex items-center gap-1 text-xs text-charcoal/60 hover:text-copper px-2 py-1 rounded-md hover:bg-cream disabled:opacity-50"
          >
            <RefreshCw size={13} className={generating ? 'animate-spin' : ''} />
            {isAr ? 'إعادة التوليد' : 'Regenerate'}
          </button>
          <button
            onClick={onSkip}
            disabled={generating}
            className="inline-flex items-center gap-1 text-xs text-charcoal/60 hover:text-charcoal px-2 py-1 rounded-md hover:bg-cream disabled:opacity-50"
          >
            <SkipForward size={13} />
            {isAr ? 'تخطٍ' : 'Skip'}
          </button>
          <Button
            variant="primary"
            onClick={onSave}
            disabled={generating || item.status === 'error' || (!item.bodyAr.trim() && !item.bodyEn.trim())}
            className="!py-1 !px-3 !text-xs"
          >
            <Save size={13} />
            {isAr ? 'حفظ' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  );
}
