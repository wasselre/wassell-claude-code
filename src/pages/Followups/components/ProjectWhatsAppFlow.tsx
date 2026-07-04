import { useEffect, useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { X, Loader2, Sparkles, MessageCircle, RefreshCw, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { resolveProjectFacts, composeProjectMessage } from '@/lib/projectMessageFacts';
import { findProjectTemplate, directVideoUrls } from '@/lib/matching/sendToClient';
import { detectInputLanguage } from '@/lib/translateLabel';
import { transliterateName } from '@/lib/transliterateName';
import Button from '@/components/ui/Button';
import type { AppRecord } from '@/types';
import StartChatModal from '@/pages/Chats/components/StartChatModal';
import { resolveClientSlugs, recordToPickedClient, type PickedClient } from '@/pages/Chats/components/ClientPicker';

/**
 * "WhatsApp this project" flow — launched from a Suggested Projects card.
 *
 * Opens the CLIENT's chat composer pre-filled with the project's stored WhatsApp
 * message (a `chat_templates` record linked by `project_id`). If NO template
 * exists for the project, it offers to generate one — using the EXACT existing
 * deterministic process (`resolveProjectFacts` → `composeProjectMessage`, same as
 * the chat_templates "Generate project messages" tool) — lets the rep review/edit,
 * and on approval STORES it as a `chat_templates` record before opening the chat.
 *
 * Everything happens as stacked popups over the Suggested Projects modal — the rep
 * never leaves the follow-up. On send the message lands in the client's chat.
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

type Phase = 'loading' | 'ask' | 'generating' | 'preview' | 'chat' | 'error';

export default function ProjectWhatsAppFlow({ isAr, projectId, projectName, clientRec, onClose }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const chatTemplatesModel = useMemo(() => models.find((m) => m.name === 'chat_templates'), [models]);
  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients'), [models]);

  const [phase, setPhase] = useState<Phase>('loading');
  const [bodyAr, setBodyAr] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [chatBody, setChatBody] = useState(''); // the body fed to the composer (current language)
  const [imageFileIds, setImageFileIds] = useState<string[]>([]); // project gallery to ride along
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Build the recipient PickedClient from the follow-up's client record.
  const pickedClient: PickedClient | null = useMemo(() => {
    if (!clientRec || !clientsModel) return null;
    return recordToPickedClient(clientRec, resolveClientSlugs(clientsModel), isAr);
  }, [clientRec, clientsModel, isAr]);

  // On open: does a stored template exist for this project?
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
      setBodyAr(ar);
      setBodyEn(en);
      setChatBody((isAr ? ar : en) || ar || en);
      setImageFileIds(
        Array.isArray(t.project_image_file_ids)
          ? (t.project_image_file_ids as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
          : [],
      );
      setPhase('chat');
    } else {
      setPhase('ask');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Generate a message with the SAME deterministic engine the chat_templates tool
  // uses. resolveProjectFacts reads everything from the all_projects master, so a
  // synthetic our_projects-shaped record carrying the `project` link is enough.
  async function generate() {
    setPhase('generating');
    setError(null);
    try {
      const synthetic = { id: 'wa-synthetic', data: { project: projectId } } as unknown as AppRecord;
      const facts = resolveProjectFacts(synthetic, models, records);
      let nameEn = facts.name;
      if (facts.name && detectInputLanguage(facts.name) === 'ar') {
        try {
          nameEn = await transliterateName(facts.name);
        } catch {
          nameEn = facts.name; // graceful — keep the Arabic name in the EN body
        }
      }
      const { body_ar, body_en } = composeProjectMessage(facts, { nameEn });
      setBodyAr(body_ar);
      setBodyEn(body_en);
      setChatBody((isAr ? body_ar : body_en) || body_ar || body_en);
      setImageFileIds(facts.imageFileIds);
      setMissing(facts.missing);
      setPhase('preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }

  // Approve → store the template (so next time it's reused) → open the chat.
  async function approveAndContinue() {
    if (!chatTemplatesModel) return;
    if (!chatBody.trim()) {
      addToast(L('الرسالة فارغة', 'Message is empty'), 'error');
      return;
    }
    setSaving(true);
    // The edited body sits in the current UI language; keep the other language's
    // generated body so the stored template stays bilingual (language='both').
    const ar = isAr ? chatBody : bodyAr;
    const en = isAr ? bodyEn : chatBody;
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
        project_image_file_ids: imageFileIds,
      },
      created_at: now,
      updated_at: now,
    };
    const res = await saveRecord(record);
    setSaving(false);
    if (res.status === 'conflict') {
      addToast(L('تعذّر الحفظ — حاول مجددًا', 'Could not save — try again'), 'error');
      return;
    }
    addToast(L('تم حفظ رسالة المشروع', 'Saved the project message'), 'success');
    setChatBody(isAr ? ar : en);
    setPhase('chat');
  }

  // Direct video FILES saved on the project (all_projects `project_videos`)
  // ride along after the gallery — sendProjectImageMessages sends them as
  // `video` messages by mime. HLS/page links are excluded (not uploadable).
  const projectVideoUrls = useMemo(() => {
    const apModel = models.find((m) => m.name === 'all_projects');
    const ap = apModel ? (records[apModel.id] ?? []).find((r) => r.id === projectId) : null;
    return directVideoUrls((ap?.data as Record<string, unknown> | undefined)?.project_videos);
  }, [models, records, projectId]);

  // The chat composer popup — reuses StartChatModal with the client preselected
  // and the body prefilled. On send the message lands in the client's chat.
  if (phase === 'chat') {
    return (
      <StartChatModal
        initialClient={pickedClient}
        initialBody={chatBody}
        initialImageFileIds={[...imageFileIds, ...projectVideoUrls]}
        onClose={onClose}
        onSent={() => {
          addToast(L('تم إرسال الرسالة', 'Message sent'), 'success');
          onClose();
        }}
      />
    );
  }

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

          {phase === 'ask' && (
            <div className="space-y-4">
              <p className="text-sm text-charcoal/80">
                {L(
                  `لا توجد رسالة واتساب محفوظة لمشروع «${projectName}». هل تريد إنشاء واحدة الآن؟`,
                  `There's no saved WhatsApp message for "${projectName}". Generate one now?`,
                )}
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={onClose}>{L('إلغاء', 'Cancel')}</Button>
                <Button variant="primary" onClick={generate}>
                  <Sparkles size={14} /> {L('نعم، أنشئ الرسالة', 'Yes, generate')}
                </Button>
              </div>
            </div>
          )}

          {phase === 'generating' && (
            <div className="flex items-center justify-center gap-2 py-8 text-charcoal/50 text-sm">
              <Loader2 size={16} className="animate-spin" /> {L('جارٍ توليد الرسالة…', 'Generating the message…')}
            </div>
          )}

          {phase === 'preview' && (
            <div className="space-y-3">
              {missing.length > 0 && (
                <div className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                  <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                  <span>{L('بعض الحقول غير متوفرة وحُذفت من الرسالة. راجع النص قبل الإرسال.', 'Some fields were missing and omitted. Review the message before sending.')}</span>
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
              </div>
              <div className="flex items-center justify-between gap-2">
                <button onClick={generate} className="inline-flex items-center gap-1 text-xs text-charcoal/60 hover:text-copper px-2 py-1 rounded-md hover:bg-cream">
                  <RefreshCw size={13} /> {L('إعادة التوليد', 'Regenerate')}
                </button>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={onClose} disabled={saving}>{L('إلغاء', 'Cancel')}</Button>
                  <Button variant="primary" onClick={approveAndContinue} disabled={saving || !chatBody.trim()}>
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <MessageCircle size={14} />}
                    {L('حفظ وفتح المحادثة', 'Save & open chat')}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="space-y-4">
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
              <div className="flex justify-end">
                <Button variant="secondary" onClick={onClose}>{L('إغلاق', 'Close')}</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
