import { create } from 'zustand';
import { useAppStore } from '@/stores/appStore';
import { resolveProjectFacts } from '@/lib/projectMessageFacts';
import { savedMessageMatchesCurrentFacts } from '@/lib/projectMessage/factsMatch';
import { ensureOffPlanDisclosed } from '@/lib/projectMessage/delivery';
import { generateProjectMessageAi, factCheckProjectMessage } from '@/lib/projectMessage/client';
import { buildProjectTemplateRecord } from '@/lib/projectMessage/templateRecord';
import { findProjectTemplate } from '@/lib/matching/sendToClient';
import { chatPdfFromClient } from '@/lib/projects/sendPdfToChat';
import { mintTrackedLink } from '@/lib/trackedLinks/client';
import { replaceLinksInMessage } from '@/lib/trackedLinks/text';
import { sendProjectImageMessages } from '@/lib/projectMessageImages';
import { listSendableProjectFiles } from '@/lib/files/recordFiles';
import {
  buildPickerItems, defaultBulkSelection, isUnitPlanFile, orderSelectedRefsBulk,
} from '@/pages/Chats/lib/projectFilePicker';
import type { AppRecord } from '@/types';

/**
 * One-click "send this project to the client" (2026-10-08, operator: "I should
 * only click on the project button … no pop-up, no confirm — the button shows
 * that the message has been sent").
 *
 * Replaces the compose → files → chat-modal popups on every single-project
 * send button (Project Finder, follow-up Suggested Projects, Client Options,
 * the chat's project browser). The SAME decisions the popups defaulted to are
 * made here, with no preview:
 *
 *   1. TEXT  — the project's saved message. One flagged for fact-check has its
 *              numbers refreshed by the AI first (skipped when they already
 *              match the project); no saved message → one is written by AI from
 *              the project's current data and saved for next time. The off-plan
 *              line is always enforced. Language = the client's preferred
 *              language, else the rep's UI language.
 *   2. LINKS — this customer's tracked links + the cover photo replace the
 *              website link. If no link can be minted, the brochure + top-3
 *              photos go instead (the file picker's default selection).
 *   3. SEND  — straight into the client's WhatsApp conversation (created if it
 *              doesn't exist yet), text first, then the media.
 *
 * Stale prices are never sent: a fact-check that fails falls back to a fresh
 * AI message from the project's current data (validated + saved); only if that
 * fails too is the send stopped with a red toast. The popup used to show stale
 * numbers with a warning, and with no preview there is nobody to read it.
 *
 * Per-button state lives in a tiny store keyed by client + project, so the same
 * project shows «تم الإرسال» on every surface for this session.
 */

export type QuickSendState = 'idle' | 'sending' | 'sent' | 'failed';

interface QuickSendStore {
  states: Record<string, Exclude<QuickSendState, 'idle'>>;
  set: (key: string, state: Exclude<QuickSendState, 'idle'>) => void;
}

const useQuickSendStore = create<QuickSendStore>((set) => ({
  states: {},
  set: (key, state) => set((s) => ({ states: { ...s.states, [key]: state } })),
}));

const stateKey = (clientId: string, projectId: string) => `${clientId}:${projectId}`;

/** The send state of one project for one client (idle until clicked). */
export function useQuickSendState(clientId: string | null | undefined, projectId: string): QuickSendState {
  return useQuickSendStore((s) => (clientId ? s.states[stateKey(clientId, projectId)] : undefined) ?? 'idle');
}

/** Client's preferred language (clients.preferred_language), else the UI's. */
function sendLanguageFor(clientRec: AppRecord, uiIsAr: boolean): 'ar' | 'en' {
  const v = (clientRec.data as Record<string, unknown>)?.preferred_language;
  const s = typeof v === 'string' ? v : '';
  if (s.includes('الإنجليزية') || /english/i.test(s)) return 'en';
  if (s.includes('العربية') || /arabic/i.test(s)) return 'ar';
  return uiIsAr ? 'ar' : 'en';
}

/** The message text to send — saved (fact-checked) or AI-written + saved. */
async function resolveMessageText(projectId: string, projectName: string, lang: 'ar' | 'en'): Promise<string> {
  const { models, records, saveRecord, addToast, language } = useAppStore.getState();
  const isAr = language === 'ar';
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const chatTemplatesModel = models.find((m) => m.name === 'chat_templates');
  if (!chatTemplatesModel) throw new Error(L('نموذج القوالب غير متوفر', 'Templates model unavailable'));

  const facts = resolveProjectFacts(
    { id: 'wa-synthetic', data: { project: projectId } } as unknown as AppRecord,
    models,
    records,
  );
  const saved = findProjectTemplate(records[chatTemplatesModel.id] ?? [], projectId);
  const sd = (saved?.data ?? {}) as Record<string, unknown>;
  const savedAr = typeof sd.body_ar === 'string' ? sd.body_ar : '';
  const savedEn = typeof sd.body_en === 'string' ? sd.body_en : '';

  // A fresh AI message from the project's current data — validated server-side
  // (prices, district, city, off-plan) and saved, so a broken saved message
  // is repaired by the send itself.
  const writeFresh = async (why: string | null): Promise<{ ar: string; en: string }> => {
    try {
      const r = await generateProjectMessageAi(projectId);
      return { ar: r.body_ar, en: r.body_en };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[quickSendProject] AI message failed — not sending:', msg, why ? `(after: ${why})` : '');
      throw new Error(L(
        `تعذّر تجهيز رسالة «${projectName}» بأسعار محدّثة — لم تُرسل (${msg})`,
        `Couldn't prepare "${projectName}" with current prices — not sent (${msg})`,
      ));
    }
  };

  // A saved English side that is a copy of the Arabic (written by the compose
  // step's bug fixed 2026-10-08) can't be sent to an English client and fails
  // every fact-check — treat the saved message as unusable.
  const englishIsArabicCopy = savedEn.trim() !== '' && savedEn.trim() === savedAr.trim();

  let ar: string;
  let en: string;
  let persist = false;
  if (saved && (savedAr.trim() || savedEn.trim()) && !englishIsArabicCopy) {
    ar = savedAr;
    en = savedEn;
    if (sd.fact_check_on_use === true && !savedMessageMatchesCurrentFacts(facts, savedAr, savedEn)) {
      try {
        const r = await factCheckProjectMessage(projectId, savedAr, savedEn);
        ar = r.body_ar || savedAr;
        en = r.body_en || savedEn;
      } catch (e) {
        // Never send the stale numbers — write a fresh, validated message.
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[quickSendProject] fact-check failed — writing a fresh message:', msg);
        ({ ar, en } = await writeFresh(msg));
      }
      persist = true;
    }
  } else {
    ({ ar, en } = await writeFresh(englishIsArabicCopy ? 'saved English is a copy of the Arabic' : null));
    persist = true;
  }

  ar = ensureOffPlanDisclosed(ar, 'ar', facts.delivery);
  en = ensureOffPlanDisclosed(en, 'en', facts.delivery);

  if (persist) {
    const record = buildProjectTemplateRecord({
      chatTemplatesModelId: chatTemplatesModel.id,
      savedRec: saved, projectId, projectName, ar, en, models, records,
    });
    const res = await saveRecord(record);
    if (res.status === 'conflict') {
      addToast(L('تعذّر حفظ رسالة المشروع — ستُرسل على أي حال', 'Could not save the project message — sending anyway'), 'info');
    }
  }

  const body = ((lang === 'ar' ? ar : en) || ar || en).trim();
  if (!body) throw new Error(L('رسالة المشروع فارغة', 'The project message is empty'));
  return body;
}

/** Brochure + top-3 photos — the file picker's default, used when no tracked
 *  link could be minted. */
async function defaultProjectFileRefs(projectId: string): Promise<string[]> {
  const allProjectsModel = useAppStore.getState().models.find((m) => m.name === 'all_projects');
  if (!allProjectsModel) return [];
  const entries = await listSendableProjectFiles(allProjectsModel.id, projectId);
  const items = buildPickerItems(entries.filter((e) => !isUnitPlanFile(e.file)), []);
  return orderSelectedRefsBulk(items, defaultBulkSelection(items));
}

/**
 * Send one project to one client, now. Never throws — failures toast and mark
 * the button failed (click again to retry). A click while the same project is
 * already sending/sent for this client is ignored (no double sends).
 */
export async function quickSendProject(input: {
  projectId: string;
  projectName: string;
  clientRec: AppRecord | null | undefined;
  /** Send into this conversation instead of the client's own number. */
  chatWid?: string | null;
}): Promise<void> {
  const { projectId, projectName, clientRec } = input;
  const app = useAppStore.getState();
  const isAr = app.language === 'ar';
  const L = (ar: string, en: string) => (isAr ? ar : en);

  if (!clientRec?.id) {
    app.addToast(L('لا يوجد عميل محدد', 'No client selected'), 'error');
    return;
  }
  const key = stateKey(clientRec.id, projectId);
  const store = useQuickSendStore.getState();
  const current = store.states[key];
  if (current === 'sending' || current === 'sent') return;
  store.set(key, 'sending');

  // Already toasted by the store's send (startNewChat) — don't toast twice.
  let toasted = false;
  try {
    // The open conversation when the caller has one (the chat's project
    // browser), else the client's own number.
    const fromClient = chatPdfFromClient(clientRec);
    const targetWid = input.chatWid ?? fromClient?.chatWid ?? null;
    const targetPhone = input.chatWid?.endsWith('@c.us')
      ? `+${input.chatWid.slice(0, -'@c.us'.length).replace(/\D/g, '')}`
      : fromClient?.clientPhone ?? null;
    if (!targetWid || !targetPhone) {
      throw new Error(L('لا يوجد رقم جوال لهذا العميل', 'This client has no phone number'));
    }
    const lang = sendLanguageFor(clientRec, isAr);
    let body = await resolveMessageText(projectId, projectName, lang);

    let refs: string[] | null = null;
    try {
      const link = await mintTrackedLink({ projectId, chatWid: targetWid, lang, sentVia: 'rep' });
      if (link.block) {
        body = replaceLinksInMessage(body, link.block);
        refs = link.coverFileId ? [link.coverFileId] : [];
      }
    } catch (err) {
      console.error('[quickSendProject] tracked link failed — sending the project files instead:', err);
      app.addToast(L('تعذّر إنشاء روابط التتبع — تُرسل ملفات المشروع بدلًا منها', 'Could not create tracked links — sending the project files instead'), 'info');
    }
    if (refs === null) {
      try {
        refs = await defaultProjectFileRefs(projectId);
      } catch (err) {
        // The text still goes out — only the attachments are lost, and the
        // rep is told so they can send files from the chat.
        console.error('[quickSendProject] loading the project files failed — sending text only:', err);
        app.addToast(L('تعذّر تحميل ملفات المشروع — تُرسل الرسالة بدون مرفقات', 'Could not load the project files — sending the message without attachments'), 'error');
        refs = [];
      }
    }

    // An existing conversation sends through it (its own WhatsApp line, the
    // send lane, and the project link on the bubble); otherwise the first
    // message creates the conversation and links it to the client.
    const s = useAppStore.getState();
    const chatsModel = s.models.find((m) => m.name === 'chats');
    const chatExists = !!chatsModel && (s.records[chatsModel.id] ?? [])
      .some((r) => (r.data as Record<string, unknown>)?.wid === targetWid);
    if (chatExists) {
      try {
        await s.sendChatMessage(targetWid, { body, projectId });
      } catch (err) {
        toasted = true; // sendChatMessage toasts every failure of a non-empty send
        throw err;
      }
    } else {
      const result = await s.startNewChat({ phone: targetPhone, body, clientRecordId: clientRec.id });
      const { ok } = await result.sent;
      if (!ok) { toasted = true; throw new Error('send failed'); }
    }

    // Media after the text is accepted, so it lands below it. Fully
    // backgrounded; it owns its job entry + failure toast.
    if (refs.length > 0) void sendProjectImageMessages(targetWid, refs);

    useQuickSendStore.getState().set(key, 'sent');
    useAppStore.getState().addToast(L(`أُرسل «${projectName}» للعميل`, `Sent "${projectName}" to the client`), 'success');
  } catch (err) {
    useQuickSendStore.getState().set(key, 'failed');
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[quickSendProject] send failed:', msg);
    if (!toasted) useAppStore.getState().addToast(msg, 'error');
  }
}
