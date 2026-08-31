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
import StartChatModal from '@/pages/Chats/components/StartChatModal';
import ProjectFilePickerModal from '@/pages/Chats/components/ProjectFilePickerModal';
import { resolveClientSlugs, recordToPickedClient, type PickedClient } from '@/pages/Chats/components/ClientPicker';

/**
 * "WhatsApp this project" flow — launched from a Suggested Projects / Finder /
 * Client-Options card. Text → files → chat:
 *
 *   1. TEXT — the rep chooses:
 *      • Use the SAVED message. When that saved message was AI-authored (flagged
 *        `fact_check_on_use`), it is NOT re-written — a fast FACT-CHECK pass
 *        (`factCheckProjectMessage`) refreshes ONLY its numbers (price/area/
 *        bed-bath/unit types) to the project's current data and leaves the copy
 *        the rep approved intact. The corrected numbers are persisted back.
 *      • REWRITE with AI — a fresh message from the whole current record; on
 *        accept it is saved as the project's message (flagged for fact-check on
 *        future use) unless the rep unticks "save".
 *   2. FILES — pick which linked files (photos/videos/PDFs) to send.
 *   3. CHAT — StartChatModal opens on the client with the text + selected media.
 */

interface Props {
  isAr: boolean;
  /** all_projects record id (the suggestion card's project_id). */
  projectId: string;
  projectName: string;
  /** The follow-up's client record — preselected as the chat recipient. */
  clientRec: AppRecord | null;
  onClose: () => void;
}

type Phase = 'loading' | 'choose' | 'generating' | 'factchecking' | 'preview' | 'files' | 'chat' | 'error';
type PreviewMode = 'generate' | 'factcheck';

export default function ProjectWhatsAppFlow({ isAr, projectId, projectName, clientRec, onClose }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const chatTemplatesModel = useMemo(() => models.find((m) => m.name === 'chat_templates'), [models]);
  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients'), [models]);

  const [phase, setPhase] = useState<Phase>('loading');
  /** The existing saved template record, if any — upserted onto (never duplicated). */
  const [savedRec, setSavedRec] = useState<AppRecord | null>(null);
  const [savedAr, setSavedAr] = useState('');
  const [savedEn, setSavedEn] = useState('');
  /** True when the saved message was AI-authored → fact-check its numbers on use. */
  const [savedFactCheck, setSavedFactCheck] = useState(false);
  const [bodyAr, setBodyAr] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [chatBody, setChatBody] = useState(''); // body fed to the composer (current language)
  const [previewMode, setPreviewMode] = useState<PreviewMode>('generate');
  const [saveOnAccept, setSaveOnAccept] = useState(true);
  const [warn, setWarn] = useState<string | null>(null);
  const [selectedRefs, setSelectedRefs] = useState<string[]>([]);
  const [generatedBy, setGeneratedBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const hasTemplate = savedRec != null;

  // Recipient PickedClient from the follow-up's client record.
  const pickedClient: PickedClient | null = useMemo(() => {
    if (!clientRec || !clientsModel) return null;
    return recordToPickedClient(clientRec, resolveClientSlugs(clientsModel), isAr);
  }, [clientRec, clientsModel, isAr]);

  // On open: is there a saved template for this project?
  useEffect(() => {
    if (!chatTemplatesModel) {
      setError(L('نموذج القوالب غير متوفر', 'Templates model unavailable'));
      setPhase('error');
      return;
    }
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
  }, []);

  /**
   * Upsert the project's saved message (never a duplicate). Preserves the
   * existing record's other data (gallery, media) and flags it for fact-check
   * on future use. Returns the saved record so callers can keep it in state.
   */
  async function saveTemplate(ar: string, en: string): Promise<AppRecord | null> {
    if (!chatTemplatesModel) return null;
    const now = new Date().toISOString();
    const baseData = (savedRec?.data ?? {}) as Record<string, unknown>;
    // Gallery: keep the existing one, else resolve the project's images (so other
    // surfaces — the composer template picker — still ride images along).
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
        // Mark AI-authored so future use fact-checks the numbers rather than
        // re-writing the prose.
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
    // An AI-authored saved message fact-checks its numbers before sending.
    if (savedFactCheck) { void runFactCheck(); return; }
    setPreviewMode('factcheck');
    setBodyAr(savedAr);
    setBodyEn(savedEn);
    setChatBody((isAr ? savedAr : savedEn) || savedAr || savedEn);
    setPhase('files');
  }

  async function runFactCheck() {
    setPhase('factchecking');
    setError(null);
    setWarn(null);
    setPreviewMode('factcheck');

    // Fast path — skip the slow AI fact-check when the saved message already
    // reflects the project's CURRENT numbers (price / area / bed-bath ranges).
    // The fact-check only ever rewrites numbers, so if none drifted the call is
    // pure latency (~1–2 min against the model). Facts resolve from the same
    // synthetic our_projects record the save path uses. Conservative by design:
    // any un-provable number (or a now-sold-out project still quoting a price)
    // falls through to the real fact-check below.
    const currentFacts = resolveProjectFacts(
      { id: 'wa-synthetic', data: { project: projectId } } as unknown as AppRecord,
      models,
      records,
    );
    if (savedMessageMatchesCurrentFacts(currentFacts, savedAr, savedEn)) {
      setBodyAr(savedAr);
      setBodyEn(savedEn);
      setChatBody((isAr ? savedAr : savedEn) || savedAr || savedEn);
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
      setChatBody((isAr ? ar : en) || ar || en);
      setGeneratedBy(generated_by ?? null);
      setPhase('preview');
    } catch (e) {
      // Don't block the send — fall back to the saved text as-is, but warn the
      // rep to eyeball the numbers before sending.
      const msg = e instanceof Error ? e.message : String(e);
      setBodyAr(savedAr);
      setBodyEn(savedEn);
      setChatBody((isAr ? savedAr : savedEn) || savedAr || savedEn);
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
      setChatBody((isAr ? body_ar : body_en) || body_ar || body_en);
      setGeneratedBy(generated_by ?? null);
      setPhase('preview');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.trim() || L('تعذّر توليد الرسالة — حاول مجددًا', 'Could not generate the message — try again'));
      setPhase('error');
    }
  }

  // Accept the previewed text → persist (save new / update fact-checked) → files.
  async function acceptText() {
    if (!chatBody.trim()) {
      addToast(L('الرسالة فارغة', 'Message is empty'), 'error');
      return;
    }
    // The edited body is in the current UI language; keep the other language's
    // body so the stored template stays bilingual.
    const ar = isAr ? chatBody : bodyAr;
    const en = isAr ? bodyEn : chatBody;
    setBodyAr(ar);
    setBodyEn(en);

    // Persist: a fresh AI rewrite saves (if the rep left "save" on); a fact-check
    // updates the saved message so its numbers stay current for next time.
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
    setPhase('files');
  }

  // ── FILE picker → chat ──────────────────────────────────────────────
  if (phase === 'files') {
    return (
      <ProjectFilePickerModal
        allProjectId={projectId}
        projectName={projectName}
        isAr={isAr}
        onConfirm={(refs) => { setSelectedRefs(refs); setPhase('chat'); }}
        onClose={onClose}
      />
    );
  }

  if (phase === 'chat') {
    return (
      <StartChatModal
        initialClient={pickedClient}
        initialBody={chatBody}
        initialImageFileIds={selectedRefs}
        onClose={onClose}
        onSent={() => { addToast(L('تم إرسال الرسالة', 'Message sent'), 'success'); onClose(); }}
      />
    );
  }

  const BackIcon = isAr ? ArrowRight : ArrowLeft;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]" dir={isAr ? 'rtl' : 'ltr'}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-sand/20 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-copper/10 text-copper flex items-center justify-center shrink-0">
            <MessageCircle size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-chocolate truncate">{L('رسالة واتساب للمشروع', 'Project WhatsApp message')}</h2>
            <p className="text-xs text-charcoal/50 truncate">{projectName}</p>
          </div>
          <button onClick={onClose} disabled={saving} className="p-1.5 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream transition-colors" aria-label={L('إغلاق', 'Close')}>
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          {phase === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-8 text-charcoal/50 text-sm">
              <Loader2 size={16} className="animate-spin" /> {L('جارٍ التحقق…', 'Checking…')}
            </div>
          )}

          {/* Choose the text source */}
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

              <div className="flex justify-end">
                <Button variant="secondary" onClick={onClose}>{L('إلغاء', 'Cancel')}</Button>
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

          {/* Review + edit the text */}
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
                  {hasTemplate && (
                    <button onClick={() => setPhase('choose')} className="inline-flex items-center gap-1 text-xs text-charcoal/60 hover:text-copper px-2 py-1 rounded-md hover:bg-cream">
                      <BackIcon size={13} /> {L('رجوع', 'Back')}
                    </button>
                  )}
                  <Button variant="primary" onClick={acceptText} disabled={saving || !chatBody.trim()}>
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} className={isAr ? 'rotate-180' : ''} />}
                    {L('التالي: الملفات', 'Next: files')}
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
                <Button variant={hasTemplate ? 'primary' : 'secondary'} onClick={onClose}>{L('إغلاق', 'Close')}</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
