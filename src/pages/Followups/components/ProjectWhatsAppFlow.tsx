import { useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import StartChatModal from '@/pages/Chats/components/StartChatModal';
import ProjectFilePickerModal from '@/pages/Chats/components/ProjectFilePickerModal';
import ProjectMessageComposeStep from '@/pages/Chats/components/ProjectMessageComposeStep';
import { resolveClientSlugs, recordToPickedClient, type PickedClient } from '@/pages/Chats/components/ClientPicker';
import { chatPdfFromClient } from '@/lib/projects/sendPdfToChat';
import { mintTrackedLink } from '@/lib/trackedLinks/client';
import { replaceLinksInMessage } from '@/lib/trackedLinks/text';

/**
 * "WhatsApp this project" flow — launched from a Suggested Projects / Finder /
 * Client-Options card. Text → files → chat:
 *
 *   1. TEXT  — `ProjectMessageComposeStep` (saved message / AI rewrite / fact-check /
 *              language toggle / save-as-template). Shared with the bulk wizard.
 *   2. LINKS — this customer's tracked links + one cover photo replace the
 *              files (2026-09-29). Only when the link can't be minted (no
 *              client phone, or the mint fails — toasted) does the rep pick
 *              files instead:
 *      FILES — pick which linked files (photos/videos/PDFs) to send.
 *   3. CHAT  — StartChatModal opens on the client with the text + selected media.
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

type Phase = 'compose' | 'files' | 'chat';

export default function ProjectWhatsAppFlow({ isAr, projectId, projectName, clientRec, onClose }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const addToast = useAppStore((s) => s.addToast);

  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients'), [models]);

  const [phase, setPhase] = useState<Phase>('compose');
  const [chatBody, setChatBody] = useState('');
  const [selectedRefs, setSelectedRefs] = useState<string[]>([]);

  // Recipient PickedClient from the follow-up's client record.
  const pickedClient: PickedClient | null = useMemo(() => {
    if (!clientRec || !clientsModel) return null;
    return recordToPickedClient(clientRec, resolveClientSlugs(clientsModel), isAr);
  }, [clientRec, clientsModel, isAr]);

  const acceptText = async (text: string) => {
    setChatBody(text);
    const wid = chatPdfFromClient(clientRec)?.chatWid ?? null;
    if (!wid) { setPhase('files'); return; }
    try {
      const lang: 'ar' | 'en' = /[؀-ۿ]/.test(text) ? 'ar' : 'en';
      const link = await mintTrackedLink({ projectId, chatWid: wid, lang, sentVia: 'rep' });
      if (!link.block) { setPhase('files'); return; }
      setChatBody(replaceLinksInMessage(text, link.block));
      setSelectedRefs(link.coverFileId ? [link.coverFileId] : []);
      setPhase('chat');
    } catch (err) {
      console.error('[ProjectWhatsAppFlow] tracked link failed — picking files instead:', err);
      addToast(L('تعذّر إنشاء روابط التتبع — اختر الملفات لإرسالها', 'Could not create tracked links — pick the files to send'), 'error');
      setPhase('files');
    }
  };

  if (phase === 'compose') {
    return (
      <ProjectMessageComposeStep
        isAr={isAr}
        projectId={projectId}
        projectName={projectName}
        onAccept={({ text }) => void acceptText(text)}
        onCancel={onClose}
      />
    );
  }

  if (phase === 'files') {
    return (
      <ProjectFilePickerModal
        allProjectId={projectId}
        projectName={projectName}
        isAr={isAr}
        // Same smart default as the bulk flow: pre-check the brochure + top-3
        // photos (not every file), and send them documents→photos→videos so the
        // send reads text → PDF → pictures. The rep can still tick/untick.
        preselect="bulk"
        onConfirm={(refs) => { setSelectedRefs(refs); setPhase('chat'); }}
        onClose={onClose}
      />
    );
  }

  // phase === 'chat'
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
