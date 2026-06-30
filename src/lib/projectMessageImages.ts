/**
 * Multi-image WhatsApp send for project message templates.
 *
 * A project's `chat_templates` record carries `project_image_file_ids` — the
 * CRM `files` ids of every image saved on the linked all_projects record
 * (the `project_images` gallery + `main_image`). Those files are PRIVATE
 * (Supabase Storage behind RLS), so they can't be handed to Haberchat as a
 * URL. For each one we: batch-sign a view URL → fetch the bytes as a blob →
 * upload to Haberchat (account-scoped file id) → send as its own `image`
 * message into the conversation.
 *
 * The text message is sent SEPARATELY by the caller first (StartChatModal's
 * first message / the Composer's text+single-media send); this only fans out
 * the gallery afterwards. Sequential to preserve gallery order; best-effort —
 * a single image failing is surfaced once and skipped, the rest still send.
 */

import { signViewUrls } from '@/lib/files/client';
import { uploadFile } from '@/lib/haberchat/client';
import { useAppStore } from '@/stores/appStore';

export async function sendProjectImageMessages(
  chatWid: string,
  fileIds: string[] | null | undefined,
): Promise<{ sent: number; failed: number }> {
  const ids = (fileIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return { sent: 0, failed: 0 };

  const { sendChatMessage, addToast, language } = useAppStore.getState();
  const isAr = language === 'ar';

  // Most ids are CRM `files` ids needing a signed view URL; a few projects store
  // a raw public image URL (e.g. a `main_image` that holds a marketing-assets
  // URL instead of a file id) — those are used as-is. Batch-sign only the file
  // ids; URL entries pass straight through to the fetch below.
  const isUrl = (s: string) => /^https?:\/\//i.test(s);
  const fileIdsToSign = ids.filter((id) => !isUrl(id));
  let signed: Record<string, string> = {};
  if (fileIdsToSign.length > 0) {
    try {
      signed = await signViewUrls(fileIdsToSign);
    } catch {
      addToast(
        isAr ? 'تعذّر تجهيز صور المشروع للإرسال' : 'Could not prepare the project images for sending',
        'error',
      );
      return { sent: 0, failed: ids.length };
    }
  }

  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    const url = isUrl(id) ? id : signed[id];
    if (!url) {
      failed++;
      continue;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch image failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const mime = blob.type || 'image/jpeg';
      const ext = (mime.split('/')[1] ?? 'jpg').split('+')[0];
      const file = new File([blob], `${id}.${ext}`, { type: mime });
      const uploaded = await uploadFile(file);
      // sendChatMessage already shows its own error toast + throws on failure;
      // our catch just keeps the loop going and tallies the failure.
      await sendChatMessage(chatWid, {
        mediaFileId: uploaded.fileId,
        kind: 'image',
        mediaMime: uploaded.mime ?? mime,
        mediaSize: uploaded.size ?? blob.size,
      });
      sent++;
    } catch {
      failed++;
    }
  }

  if (failed > 0) {
    addToast(
      isAr ? `تعذّر إرسال ${failed} من صور المشروع` : `Couldn't send ${failed} project image(s)`,
      failed === ids.length ? 'error' : 'info',
    );
  }
  return { sent, failed };
}
