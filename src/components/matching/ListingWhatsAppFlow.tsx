import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import {
  findReadyListingTemplate, templateListingImageUrls, templateBody, directVideoUrls,
} from '@/lib/matching/sendToClient';
import StartChatModal from '@/pages/Chats/components/StartChatModal';
import ListingMessageModal from '@/pages/Records/components/ListingMessageModal';
import { resolveClientSlugs, recordToPickedClient, type PickedClient } from '@/pages/Chats/components/ClientPicker';

/**
 * "Send this market listing to the client" flow — launched from a Project
 * Finder card or a Client Options card. The listing twin of ProjectWhatsAppFlow:
 *
 *   • A ready chat_templates message exists for the listing → open the CLIENT's
 *     chat composer (StartChatModal, client preselected) pre-filled with the
 *     stored body; the cleaned photos + any direct video files ride along as
 *     their own WhatsApp messages after the text.
 *   • No message yet → open the EXACT existing creation flow
 *     (ListingMessageModal: AI text + text-removed photos). When it closes,
 *     if a ready template now exists (the rep approved) we continue straight
 *     into the chat; if not (cancelled), the flow just closes.
 */

interface Props {
  isAr: boolean;
  /** market_listings record id. */
  listingId: string;
  listingName: string;
  /** The connected client — preselected as the chat recipient. */
  clientRec: AppRecord | null;
  onClose: () => void;
}

export default function ListingWhatsAppFlow({ isAr, listingId, listingName, clientRec, onClose }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);

  const chatTemplatesModel = useMemo(() => models.find((m) => m.name === 'chat_templates') ?? null, [models]);
  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const marketModel = useMemo(() => models.find((m) => m.name === 'market_listings') ?? null, [models]);

  // Re-evaluated on every store change — so when ListingMessageModal saves the
  // approved template, this flips from null to the fresh record.
  const readyTemplate = useMemo(
    () => (chatTemplatesModel ? findReadyListingTemplate(records[chatTemplatesModel.id] ?? [], listingId) : null),
    [chatTemplatesModel, records, listingId],
  );

  // 'chat' opens the composer; 'create' hosts the existing generation modal.
  const [phase, setPhase] = useState<'chat' | 'create'>(() => (readyTemplate ? 'chat' : 'create'));

  const pickedClient: PickedClient | null = useMemo(() => {
    if (!clientRec || !clientsModel) return null;
    return recordToPickedClient(clientRec, resolveClientSlugs(clientsModel), isAr);
  }, [clientRec, clientsModel, isAr]);

  const listing = useMemo(
    () => (marketModel ? (records[marketModel.id] ?? []).find((r) => r.id === listingId) ?? null : null),
    [marketModel, records, listingId],
  );
  const listingData = (listing?.data ?? {}) as Record<string, unknown>;

  // Media that rides along after the text: the template's cleaned photos +
  // its curated VIDEOS. `data.videos` is seeded server-side on Approve
  // ({source_url, public_url}: direct files as-is + HLS streams via the
  // worker's video-convert mp4 cache — Aqar videos are Cloudflare Stream
  // .m3u8 playlists WhatsApp can't carry directly) and is user-editable in
  // the saved-message modal / template editor, exactly like images. When the
  // key is present it is AUTHORITATIVE (an empty array = user removed all
  // videos). Legacy templates without the key fall back to the old
  // listing-derived path (best-effort — the slim market_listings_summary the
  // store loads strips video fields, so this usually yields nothing).
  // sendProjectImageMessages picks image/video by mime.
  const mediaSends = useMemo(() => {
    const d = (readyTemplate?.data ?? {}) as Record<string, unknown>;
    const curated = Array.isArray(d.videos)
      ? (d.videos as Array<{ public_url?: unknown } | null>)
          .map((v) => v?.public_url)
          .filter((u): u is string => typeof u === 'string' && u.length > 0)
      : null;
    const raw = listingData.video_urls ?? listingData.videos;
    const mp4Map = (listingData.video_mp4_map ?? {}) as Record<string, unknown>;
    const legacyConverted = Array.isArray(raw)
      ? (raw as unknown[])
          .map((u) => (typeof u === 'string' ? mp4Map[u] : null))
          .filter((u): u is string => typeof u === 'string' && u.length > 0)
      : [];
    const videos = curated ?? [...new Set([...directVideoUrls(raw), ...legacyConverted])];
    return [...templateListingImageUrls(d), ...videos];
  }, [readyTemplate, listingData]);

  // Loud, not silent — without the model there is no template to send or create.
  // (Effect, not render-time: toasting + closing mutate state.)
  useEffect(() => {
    if (chatTemplatesModel) return;
    addToast(L('نموذج القوالب غير متوفر', 'Templates model unavailable'), 'error');
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatTemplatesModel]);
  if (!chatTemplatesModel) return null;

  if (phase === 'chat' && readyTemplate) {
    return (
      <StartChatModal
        initialClient={pickedClient}
        initialBody={templateBody(readyTemplate.data as Record<string, unknown>, isAr)}
        initialImageFileIds={mediaSends}
        onClose={onClose}
        onSent={() => {
          addToast(L('تم إرسال الرسالة', 'Message sent'), 'success');
          onClose();
        }}
      />
    );
  }

  // No ready message yet → the EXISTING creation flow. On close: approved →
  // continue to the chat with the fresh template; cancelled → just close.
  const listingExternalId =
    typeof listingData.external_id === 'string' && listingData.external_id.trim()
      ? listingData.external_id.trim()
      : String(listingData.external_id ?? '').trim();
  const listingTitle = (listingExternalId && `@${listingExternalId}`) || listingName || L('رسالة الإعلان', 'Listing message');

  return (
    <ListingMessageModal
      listingId={listingId}
      listingTitle={listingTitle}
      chatTemplatesModelId={chatTemplatesModel.id}
      existing={null}
      onClose={() => {
        const saved = findReadyListingTemplate(
          useAppStore.getState().records[chatTemplatesModel.id] ?? [],
          listingId,
        );
        if (saved) setPhase('chat');
        else onClose();
      }}
    />
  );
}
