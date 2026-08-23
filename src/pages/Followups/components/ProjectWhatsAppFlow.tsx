import { useEffect, useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { X, Loader2, Sparkles, MessageCircle, RefreshCw, FileText, ArrowRight, ArrowLeft } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { resolveProjectFacts } from '@/lib/projectMessageFacts';
import { generateProjectMessageAi } from '@/lib/projectMessage/client';
import { findProjectTemplate } from '@/lib/matching/sendToClient';
import Button from '@/components/ui/Button';
import type { AppRecord } from '@/types';
import StartChatModal from '@/pages/Chats/components/StartChatModal';
import ProjectFilePickerModal from '@/pages/Chats/components/ProjectFilePickerModal';
import { resolveClientSlugs, recordToPickedClient, type PickedClient } from '@/pages/Chats/components/ClientPicker';

/**
 * "WhatsApp this project" flow — launched from a Suggested Projects / Finder /
 * Client-Options card. Two rep choices, then a file picker, then the chat:
 *
 *   1. TEXT — because a project's content (price, unit mix, availability) drifts
 *      after a template was written, the rep chooses between the SAVED template
 *      text and a fresh AI REWRITE built from the project's CURRENT data
 *      (`/api/templates/project-message-ai`, which sends the whole record to the
 *      LLM and gates the output). Always offered, even when a template exists.
 *   2. FILES — the rep picks which of the project's linked files (photos,
 *      videos, PDFs) get sent, via ProjectFilePickerModal (everything
 *      pre-checked). Replaces the old fixed gallery ride-along.
 *   3. CHAT — StartChatModal opens on the client with the chosen text + the
 *      selected media, and sends.
 *
 * If no saved template exists for the project, the AI rewrite IS the primary
 * path; on accept it is stored as the project's `chat_templates` record so other
 * surfaces (composer template picker) can reuse it.
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

type Phase = 'loading' | 'choose' | 'generating' | 'preview' | 'files' | 'chat' | 'error';

export default function ProjectWhatsAppFlow({ isAr, projectId, projectName, clientRec, onClose }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const chatTemplatesModel = useMemo(() => models.find((m) => m.name === 'chat_templates'), [models]);
  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients'), [models]);

  const [phase, setPhase] = useState<Phase>('loading');
  const [hasTemplate, setHasTemplate] = useState(false);
  const [savedAr, setSavedAr] = useState('');
  const [savedEn, setSavedEn] = useState('');
  const [bodyAr, setBodyAr] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [chatBody, setChatBody] = useState(''); // body fed to the composer (current language)
  const [selectedRefs, setSelectedRefs] = useState<string[]>([]);
  const [generatedBy, setGeneratedBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
      const ar = typeof t.body_ar === 'string' ? t.body_ar : '';
      const en = typeof t.body_en === 'string' ? t.body_en : '';
      setSavedAr(ar);
      setSavedEn(en);
      setHasTemplate(true);
    } else {
      setHasTemplate(false);
    }
    setPhase('choose');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── TEXT choices ────────────────────────────────────────────────────
  function useSaved() {
    setBodyAr(savedAr);
    setBodyEn(savedEn);
    setChatBody((isAr ? savedAr : savedEn) || savedAr || savedEn);
    setPhase('files');
  }

  async function generateAi() {
    setPhase('generating');
    setError(null);
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

  // Accept the AI text → (store a NEW template if none existed) → files step.
  async function acceptAiText() {
    if (!chatBody.trim()) {
      addToast(L('الرسالة فارغة', 'Message is empty'), 'error');
      return;
    }
    // The edited body is in the current UI language; keep the other language's
    // generated body so a stored template stays bilingual.
    const ar = isAr ? chatBody : bodyAr;
    const en = isAr ? bodyEn : chatBody;
    setBodyAr(ar);
    setBodyEn(en);

    // Only persist a template when the project had NONE — avoids duplicates and
    // never silently overwrites a curated template with a one-off rewrite.
    if (!hasTemplate && chatTemplatesModel) {
      setSaving(true);
      // Keep the gallery on the saved template so other surfaces (composer
      // template picker) still ride images along; the per-send file choice here
      // is separate and lives only on this send.
      const synthetic = { id: 'wa-synthetic', data: { project: projectId } } as unknown as AppRecord;
      const facts = resolveProjectFacts(synthetic, models, records);
      const now = new Date().toISOString();
      const record: AppRecord = {
        id: uuid(),
        model_id: chatTemplatesModel.id,
        data: {
          name: projectName,
          language: 'both',
          tags: ['project'],
          body_ar: ar,
          body_en: en,
          media_kind: '',
          media_file_id: null,
          media_mime: null,
          media_size: null,
          media_filename: null,
          project_id: projectId,
          project_image_file_ids: facts.imageFileIds,
        },
        created_at: now,
        updated_at: now,
      };
      const res = await saveRecord(record);
      setSaving(false);
      if (res.status === 'conflict') {
        addToast(L('تعذّر حفظ القالب — سيُرسل النص على أي حال', 'Could not save the template — sending the text anyway'), 'info');
      } else {
        setHasTemplate(true);
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
        onConfirm={(refs) => {
          setSelectedRefs(refs);
          setPhase('chat');
        }}
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
        onSent={() => {
          addToast(L('تم إرسال الرسالة', 'Message sent'), 'success');
          onClose();
        }}
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
                    <FileText size={15} className="text-copper" />
                    <span className="font-semibold text-sm text-charcoal">{L('استخدام الرسالة المحفوظة', 'Use the saved message')}</span>
                  </div>
                  <p className="text-xs text-charcoal/60 line-clamp-3 whitespace-pre-line" dir="auto">
                    {(isAr ? savedAr : savedEn) || savedAr || savedEn}
                  </p>
                </button>
              )}

              <button
                type="button"
                onClick={generateAi}
                className="w-full text-start rounded-xl border border-sand/50 hover:border-copper hover:bg-copper/5 transition-colors px-4 py-3"
              >
                <div className="flex items-center gap-2 mb-1">
                  <Sparkles size={15} className="text-copper" />
                  <span className="font-semibold text-sm text-charcoal">{L('إعادة الكتابة بالذكاء الاصطناعي', 'Rewrite with AI')}</span>
                </div>
                <p className="text-xs text-charcoal/60">
                  {L('نص جديد مبني على بيانات المشروع الحالية (الأسعار والوحدات المتاحة).',
                     'A fresh message from the project’s current data (available prices & units).')}
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

          {/* Review + edit the AI text */}
          {phase === 'preview' && (
            <div className="space-y-3">
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
                  <p className="text-[10px] text-charcoal/35 mt-1">{L('وُلّد بواسطة', 'Generated by')} {generatedBy}</p>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <button onClick={generateAi} className="inline-flex items-center gap-1 text-xs text-charcoal/60 hover:text-copper px-2 py-1 rounded-md hover:bg-cream">
                  <RefreshCw size={13} /> {L('إعادة التوليد', 'Regenerate')}
                </button>
                <div className="flex gap-2">
                  {hasTemplate && (
                    <button onClick={() => setPhase('choose')} className="inline-flex items-center gap-1 text-xs text-charcoal/60 hover:text-copper px-2 py-1 rounded-md hover:bg-cream">
                      <BackIcon size={13} /> {L('رجوع', 'Back')}
                    </button>
                  )}
                  <Button variant="primary" onClick={acceptAiText} disabled={saving || !chatBody.trim()}>
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
