import { useEffect, useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { X, Loader2, Sparkles, MessageCircle, RefreshCw, FileText, ArrowRight, ArrowLeft, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { resolveProjectFacts } from '@/lib/projectMessageFacts';
import { savedMessageMatchesCurrentFacts } from '@/lib/projectMessage/factsMatch';
import { generateProjectMessageAi, factCheckProjectMessage } from '@/lib/projectMessage/client';
import { findProjectTemplate } from '@/lib/matching/sendToClient';
import Button from '@/components/ui/Button';
import type { AppRecord } from '@/types';

/**
 * ProjectMessageComposeStep — compose ONE project's WhatsApp message text.
 *
 * The saved-message / AI-rewrite / fact-check / language-toggle / save-as-template
 * step, extracted from ProjectWhatsAppFlow so the single-project flow AND the bulk
 * wizard share ONE implementation (identical behaviour, no fork). It renders its
 * own modal shell and, on accept, hands back the final `{ text, sendLang }`.
 *
 *   1. CHOOSE — use the SAVED message (AI-authored ones fact-check their numbers
 *      first) or REWRITE with AI from the project's current data.
 *   2. PREVIEW — review + edit + switch language; on accept the text is persisted
 *      as the project's message (a fresh rewrite saves if "save" is ticked; a
 *      fact-check updates the saved numbers) and returned via `onAccept`.
 */

interface Props {
  isAr: boolean;
  /** all_projects record id. */
  projectId: string;
  projectName: string;
  /** Small line under the title, e.g. "Project 2 of 5". Defaults to projectName. */
  subtitle?: string;
  /** Primary button label at the preview step. Defaults to "Next: files". */
  primaryLabel?: string;
  onAccept: (result: { text: string; sendLang: 'ar' | 'en' }) => void;
  onCancel: () => void;
  /** Optional "previous project" affordance for the wizard. */
  onBack?: () => void;
  backLabel?: string;
}

type Phase = 'loading' | 'choose' | 'generating' | 'factchecking' | 'preview' | 'error';
type PreviewMode = 'generate' | 'factcheck';

export default function ProjectMessageComposeStep({
  isAr,
  projectId,
  projectName,
  subtitle,
  primaryLabel,
  onAccept,
  onCancel,
  onBack,
  backLabel,
}: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const chatTemplatesModel = useMemo(() => models.find((m) => m.name === 'chat_templates'), [models]);

  const [phase, setPhase] = useState<Phase>('loading');
  const [savedRec, setSavedRec] = useState<AppRecord | null>(null);
  const [savedAr, setSavedAr] = useState('');
  const [savedEn, setSavedEn] = useState('');
  const [savedFactCheck, setSavedFactCheck] = useState(false);
  const [bodyAr, setBodyAr] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [chatBody, setChatBody] = useState('');
  const [sendLang, setSendLang] = useState<'ar' | 'en'>(isAr ? 'ar' : 'en');
  const sendAr = sendLang === 'ar';
  const [previewMode, setPreviewMode] = useState<PreviewMode>('generate');
  const [saveOnAccept, setSaveOnAccept] = useState(true);
  const [warn, setWarn] = useState<string | null>(null);
  const [generatedBy, setGeneratedBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const hasTemplate = savedRec != null;

  // On open (and whenever the project changes — the wizard reuses this component
  // across projects): load this project's saved template, if any.
  useEffect(() => {
    if (!chatTemplatesModel) {
      setError(L('نموذج القوالب غير متوفر', 'Templates model unavailable'));
      setPhase('error');
      return;
    }
    setSavedRec(null);
    setSavedAr('');
    setSavedEn('');
    setSavedFactCheck(false);
    setSaveOnAccept(true);
    setWarn(null);
    setGeneratedBy(null);
    setError(null);
    setSendLang(isAr ? 'ar' : 'en');
    const existing = findProjectTemplate(records[chatTemplatesModel.id] ?? [], projectId);
    if (existing) {
      const t = existing.data as Record<string, unknown>;
      setSavedRec(existing);
      setSavedAr(typeof t.body_ar === 'string' ? t.body_ar : '');
      setSavedEn(typeof t.body_en === 'string' ? t.body_en : '');
      setSavedFactCheck(t.fact_check_on_use === true);
    }
    setPhase('choose');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /** Upsert the project's saved message (never a duplicate) — same rule as the
   *  single-project flow, keeps the gallery + flags it for fact-check on reuse. */
  async function saveTemplate(ar: string, en: string): Promise<AppRecord | null> {
    if (!chatTemplatesModel) return null;
    const now = new Date().toISOString();
    const baseData = (savedRec?.data ?? {}) as Record<string, unknown>;
    let galleryIds = baseData.project_image_file_ids;
    if (!Array.isArray(galleryIds)) {
      const synthetic = { id: 'wa-synthetic', data: { project: projectId } } as unknown as AppRecord;
      galleryIds = resolveProjectFacts(synthetic, models, records).imageFileIds;
    }
    const record: AppRecord = {
      id: savedRec?.id ?? uuid(),
      model_id: chatTemplatesModel.id,
      data: {
        media_kind: '', media_file_id: null, media_mime: null, media_size: null, media_filename: null,
        ...baseData,
        name: projectName,
        language: 'both',
        tags: Array.isArray(baseData.tags) && baseData.tags.length ? baseData.tags : ['project'],
        body_ar: ar,
        body_en: en,
        project_id: projectId,
        project_image_file_ids: galleryIds,
        fact_check_on_use: true,
      },
      created_at: savedRec?.created_at ?? now,
      updated_at: now,
    };
    const res = await saveRecord(record);
    if (res.status === 'conflict') return null;
    setSavedRec(record);
    setSavedAr(ar);
    setSavedEn(en);
    setSavedFactCheck(true);
    return record;
  }

  // ── TEXT choices ────────────────────────────────────────────────────
  function useSaved() {
    if (savedFactCheck) { void runFactCheck(); return; }
    setPreviewMode('factcheck');
    setBodyAr(savedAr);
    setBodyEn(savedEn);
    setChatBody((sendAr ? savedAr : savedEn) || savedAr || savedEn);
    setPhase('preview');
  }

  async function runFactCheck() {
    setPhase('factchecking');
    setError(null);
    setWarn(null);
    setPreviewMode('factcheck');

    const currentFacts = resolveProjectFacts(
      { id: 'wa-synthetic', data: { project: projectId } } as unknown as AppRecord,
      models,
      records,
    );
    if (savedMessageMatchesCurrentFacts(currentFacts, savedAr, savedEn)) {
      setBodyAr(savedAr);
      setBodyEn(savedEn);
      setChatBody((sendAr ? savedAr : savedEn) || savedAr || savedEn);
      setGeneratedBy(null);
      setPhase('preview');
      return;
    }

    try {
      const { body_ar, body_en, generated_by } = await factCheckProjectMessage(projectId, savedAr, savedEn);
      const ar = body_ar || savedAr;
      const en = body_en || savedEn;
      setBodyAr(ar);
      setBodyEn(en);
      setChatBody((sendAr ? ar : en) || ar || en);
      setGeneratedBy(generated_by ?? null);
      setPhase('preview');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBodyAr(savedAr);
      setBodyEn(savedEn);
      setChatBody((sendAr ? savedAr : savedEn) || savedAr || savedEn);
      setGeneratedBy(null);
      setWarn(L(`تعذّر تحديث الأرقام تلقائيًا (${msg}). راجعها قبل الإرسال.`, `Couldn't auto-refresh the numbers (${msg}). Review them before sending.`));
      setPhase('preview');
    }
  }

  async function generateAi() {
    setPhase('generating');
    setError(null);
    setWarn(null);
    setPreviewMode('generate');
    try {
      const { body_ar, body_en, generated_by } = await generateProjectMessageAi(projectId);
      setBodyAr(body_ar);
      setBodyEn(body_en);
      setChatBody((sendAr ? body_ar : body_en) || body_ar || body_en);
      setGeneratedBy(generated_by ?? null);
      setPhase('preview');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.trim() || L('تعذّر توليد الرسالة — حاول مجددًا', 'Could not generate the message — try again'));
      setPhase('error');
    }
  }

  function switchSendLang(next: 'ar' | 'en') {
    if (next === sendLang) return;
    const currentAr = sendAr ? chatBody : bodyAr;
    const currentEn = sendAr ? bodyEn : chatBody;
    setBodyAr(currentAr);
    setBodyEn(currentEn);
    setSendLang(next);
    setChatBody(next === 'ar' ? currentAr : currentEn);
  }

  // Accept the previewed text → persist → hand back to the caller.
  async function acceptText() {
    if (!chatBody.trim()) {
      addToast(L('الرسالة فارغة', 'Message is empty'), 'error');
      return;
    }
    const ar = sendAr ? chatBody : bodyAr;
    const en = sendAr ? chatBody : bodyEn;
    setBodyAr(ar);
    setBodyEn(en);

    const shouldSave = previewMode === 'factcheck' ? hasTemplate : saveOnAccept;
    if (shouldSave) {
      setSaving(true);
      const saved = await saveTemplate(ar, en);
      setSaving(false);
      if (!saved) {
        addToast(L('تعذّر حفظ الرسالة — ستُرسل على أي حال', 'Could not save the message — sending anyway'), 'info');
      } else if (previewMode === 'generate') {
        addToast(L('تم حفظ رسالة المشروع', 'Saved the project message'), 'success');
      }
    }
    onAccept({ text: chatBody.trim(), sendLang });
  }

  const BackIcon = isAr ? ArrowRight : ArrowLeft;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onCancel(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]" dir={isAr ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-sand/20 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-copper/10 text-copper flex items-center justify-center shrink-0">
            <MessageCircle size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-chocolate truncate">{L('رسالة واتساب للمشروع', 'Project WhatsApp message')}</h2>
            <p className="text-xs text-charcoal/50 truncate">{subtitle || projectName}</p>
          </div>
          <button onClick={onCancel} disabled={saving} className="p-1.5 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream transition-colors" aria-label={L('إغلاق', 'Close')}>
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          {phase === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-8 text-charcoal/50 text-sm">
              <Loader2 size={16} className="animate-spin" /> {L('جارٍ التحقق…', 'Checking…')}
            </div>
          )}

          {phase === 'choose' && (
            <div className="space-y-4">
              <p className="text-sm text-charcoal/80">
                {hasTemplate
                  ? L('كيف تريد نص رسالة هذا المشروع؟', 'How do you want this project’s message text?')
                  : L(`لا توجد رسالة محفوظة لمشروع «${projectName}». أنشئ واحدة بالذكاء الاصطناعي من بيانات المشروع الحالية.`,
                      `There's no saved message for "${projectName}". Generate one with AI from the project's current data.`)}
              </p>

              {hasTemplate && (
                <button
                  type="button"
                  onClick={useSaved}
                  className="w-full text-start rounded-xl border border-sand/50 hover:border-copper hover:bg-copper/5 transition-colors px-4 py-3"
                >
                  <div className="flex items-center gap-2 mb-1">
                    {savedFactCheck ? <ShieldCheck size={15} className="text-copper" /> : <FileText size={15} className="text-copper" />}
                    <span className="font-semibold text-sm text-charcoal">{L('استخدام الرسالة المحفوظة', 'Use the saved message')}</span>
                    {savedFactCheck && (
                      <span className="text-[10px] font-medium text-copper bg-copper/10 rounded-full px-2 py-0.5">
                        {L('يُدقّق الأرقام', 'auto-checks numbers')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-charcoal/60 line-clamp-3 whitespace-pre-line mb-1" dir="auto">
                    {(isAr ? savedAr : savedEn) || savedAr || savedEn}
                  </p>
                  {savedFactCheck && (
                    <p className="text-[11px] text-charcoal/45">
                      {L('تُحدَّث الأسعار والمساحات تلقائيًا لبيانات المشروع الحالية قبل الإرسال.',
                         'Prices & sizes are auto-updated to the project’s current data before sending.')}
                    </p>
                  )}
                </button>
              )}

              <button
                type="button"
                onClick={generateAi}
                className="w-full text-start rounded-xl border border-sand/50 hover:border-copper hover:bg-copper/5 transition-colors px-4 py-3"
              >
                <div className="flex items-center gap-2 mb-1">
                  <Sparkles size={15} className="text-copper" />
                  <span className="font-semibold text-sm text-charcoal">
                    {hasTemplate ? L('إعادة الكتابة بالذكاء الاصطناعي', 'Rewrite with AI') : L('إنشاء بالذكاء الاصطناعي', 'Generate with AI')}
                  </span>
                </div>
                <p className="text-xs text-charcoal/60">
                  {L('نص جديد مبني على بيانات المشروع الحالية — يمكنك حفظه كرسالة المشروع.',
                     'A fresh message from the project’s current data — you can save it as the project’s message.')}
                </p>
              </button>

              <div className="flex justify-between">
                {onBack ? (
                  <button onClick={onBack} className="inline-flex items-center gap-1 text-xs text-charcoal/60 hover:text-copper px-2 py-1 rounded-md hover:bg-cream">
                    <BackIcon size={13} /> {backLabel || L('السابق', 'Back')}
                  </button>
                ) : <span />}
                <Button variant="secondary" onClick={onCancel}>{L('إلغاء', 'Cancel')}</Button>
              </div>
            </div>
          )}

          {phase === 'generating' && (
            <div className="flex items-center justify-center gap-2 py-8 text-charcoal/50 text-sm">
              <Loader2 size={16} className="animate-spin" /> {L('جارٍ كتابة الرسالة بالذكاء الاصطناعي…', 'Writing the message with AI…')}
            </div>
          )}

          {phase === 'factchecking' && (
            <div className="flex items-center justify-center gap-2 py-8 text-charcoal/50 text-sm">
              <Loader2 size={16} className="animate-spin" /> {L('جارٍ تدقيق الأرقام وتحديثها…', 'Fact-checking & updating the numbers…')}
            </div>
          )}

          {phase === 'preview' && (
            <div className="space-y-3">
              {previewMode === 'factcheck' && !warn && (
                <div className="flex items-start gap-2 text-[11px] text-green-700 bg-green-50 border border-green-200 rounded-lg px-2.5 py-1.5">
                  <ShieldCheck size={13} className="shrink-0 mt-0.5" />
                  <span>{L('حُدّثت الأرقام (الأسعار والمساحات) لبيانات المشروع الحالية. النص كما هو.', 'The numbers (prices & sizes) were updated to the project’s current data. The copy is unchanged.')}</span>
                </div>
              )}
              {warn && (
                <div className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span>{warn}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold text-charcoal/40">{L('لغة الرسالة', 'Message language')}</span>
                <div className="inline-flex rounded-lg border border-sand/50 overflow-hidden">
                  <button type="button" onClick={() => switchSendLang('ar')}
                    className={`px-3 py-1 text-xs font-semibold transition-colors ${sendAr ? 'bg-copper text-white' : 'text-charcoal/70 hover:bg-cream'}`}>
                    {L('العربية', 'Arabic')}
                  </button>
                  <button type="button" onClick={() => switchSendLang('en')}
                    className={`px-3 py-1 text-xs font-semibold transition-colors ${!sendAr ? 'bg-copper text-white' : 'text-charcoal/70 hover:bg-cream'}`}>
                    {L('الإنجليزية', 'English')}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-charcoal/40 mb-1">{L('الرسالة', 'Message')}</label>
                <textarea
                  value={chatBody}
                  onChange={(e) => setChatBody(e.target.value)}
                  rows={10}
                  dir="auto"
                  className="form-input w-full text-sm resize-none leading-relaxed"
                />
                {generatedBy && (
                  <p className="text-[10px] text-charcoal/35 mt-1">
                    {previewMode === 'factcheck' ? L('دُقّق بواسطة', 'Checked by') : L('وُلّد بواسطة', 'Generated by')} {generatedBy}
                  </p>
                )}
              </div>

              {previewMode === 'generate' && (
                <label className="flex items-center gap-2 text-xs text-charcoal/70 cursor-pointer select-none">
                  <input type="checkbox" checked={saveOnAccept} onChange={(e) => setSaveOnAccept(e.target.checked)} className="w-4 h-4 accent-copper" />
                  {hasTemplate
                    ? L('حفظ كرسالة المشروع (استبدال المحفوظة)', 'Save as the project’s message (replace the saved one)')
                    : L('حفظ كرسالة المشروع (تُستخدم لاحقًا)', 'Save as the project’s message (reused next time)')}
                </label>
              )}

              <div className="flex items-center justify-between gap-2">
                <button
                  onClick={() => (previewMode === 'factcheck' ? void runFactCheck() : void generateAi())}
                  className="inline-flex items-center gap-1 text-xs text-charcoal/60 hover:text-copper px-2 py-1 rounded-md hover:bg-cream"
                >
                  <RefreshCw size={13} /> {previewMode === 'factcheck' ? L('إعادة التدقيق', 'Re-check') : L('إعادة التوليد', 'Regenerate')}
                </button>
                <div className="flex gap-2">
                  <button onClick={() => setPhase('choose')} className="inline-flex items-center gap-1 text-xs text-charcoal/60 hover:text-copper px-2 py-1 rounded-md hover:bg-cream">
                    <BackIcon size={13} /> {L('رجوع', 'Back')}
                  </button>
                  <Button variant="primary" onClick={acceptText} disabled={saving || !chatBody.trim()}>
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} className={isAr ? 'rotate-180' : ''} />}
                    {primaryLabel || L('التالي: الملفات', 'Next: files')}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="space-y-4">
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
              <div className="flex justify-end gap-2">
                {hasTemplate && (
                  <Button variant="secondary" onClick={useSaved}>{L('استخدام الرسالة المحفوظة', 'Use saved message')}</Button>
                )}
                <Button variant={hasTemplate ? 'primary' : 'secondary'} onClick={onCancel}>{L('إغلاق', 'Close')}</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
