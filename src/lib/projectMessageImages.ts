/**
 * Multi-media WhatsApp send for chat templates.
 *
 * Accepts a mixed list of media references:
 *   • CRM `files` ids — a project template's `project_image_file_ids` (the
 *     linked all_projects gallery + `main_image`). Those files are PRIVATE
 *     (Supabase Storage behind RLS), so they can't be handed to Haberchat as
 *     a URL — each is batch-signed to a view URL first.
 *   • Raw public URLs — a listing template's cleaned photos
 *     (`images[].public_url`, hosted on the public marketing-assets bucket)
 *     and direct video-file URLs (project_videos / listing video_urls),
 *     used as-is.
 * For each entry we: resolve a fetchable URL → fetch the bytes as a blob →
 * upload to Haberchat (account-scoped file id) → send as its own message
 * into the conversation — `video` when the bytes are a video, else `image`.
 * (HLS playlists / page links are filtered out by the CALLER — see
 * directVideoUrls in lib/matching/sendToClient.ts — they aren't uploadable.)
 *
 * The text message is sent SEPARATELY by the caller first (StartChatModal's
 * first message / the Composer's text+single-media send); this only fans out
 * the gallery afterwards. Sequential to preserve gallery order; best-effort —
 * a single image failing is surfaced once and skipped, the rest still send.
 */

import { signViewUrls } from '@/lib/files/client';
import { uploadFile } from '@/lib/haberchat/client';
import { useAppStore } from '@/stores/appStore';

// Servers occasionally omit content-type on direct video files; the URL's
// extension recovers the mime so the bytes still send as a `video` message.
const VIDEO_EXT_MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', '3gp': 'video/3gpp',
};

export async function sendProjectImageMessages(
  chatWid: string,
  fileIds: string[] | null | undefined,
  opts: {
    /**
     * Schedule instead of sending now: the caller's text message sits in
     * Haberchat's queue at this time, and each gallery item is staggered a
     * few seconds after it (queue order within the same second isn't
     * guaranteed, so the stagger keeps text → image1 → image2 delivery
     * order). Uploads to Haberchat still happen immediately.
     */
    deliverAt?: string;
  } = {},
): Promise<{ sent: number; failed: number }> {
  const ids = (fileIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return { sent: 0, failed: 0 };

  // Media message i goes out at deliverAt + (i+1) * 10s.
  const baseDeliverMs = opts.deliverAt ? new Date(opts.deliverAt).getTime() : null;
  const STAGGER_MS = 10_000;

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

  /** Fetch → upload → send one media item. Throws on failure. */
  const sendOne = async (id: string, index: number) => {
    const url = isUrl(id) ? id : signed[id];
    if (!url) throw new Error('no fetchable url');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch image failed (HTTP ${res.status})`);
    const blob = await res.blob();
    const urlExt = ((url.split('?')[0] ?? url).split('.').pop() ?? '').toLowerCase();
    const mime = blob.type || VIDEO_EXT_MIME[urlExt] || 'image/jpeg';
    const ext = (mime.split('/')[1] ?? 'jpg').split('+')[0];
    // URL entries would otherwise put the whole URL in the filename; use the
    // last path segment instead (file-id entries keep the id as the name).
    const baseName = isUrl(id)
      ? ((id.split('?')[0] ?? id).split('/').pop() || 'image').slice(0, 80)
      : id;
    const file = new File([blob], baseName.includes('.') ? baseName : `${baseName}.${ext}`, { type: mime });
    const uploaded = await uploadFile(file);
    // sendChatMessage already shows its own error toast + throws on failure;
    // callers just tally the failure and keep going.
    await sendChatMessage(chatWid, {
      mediaFileId: uploaded.fileId,
      kind: mime.startsWith('video/') ? 'video' : 'image',
      mediaMime: uploaded.mime ?? mime,
      mediaSize: uploaded.size ?? blob.size,
      deliverAt: baseDeliverMs != null
        ? new Date(baseDeliverMs + (index + 1) * STAGGER_MS).toISOString()
        : undefined,
    });
  };

  if (baseDeliverMs != null) {
    // Scheduled: delivery order comes from the staggered deliverAt, not from
    // send order — so uploads can run CONCURRENTLY (small pool). A 10-photo
    // gallery drops from ~10 sequential round-trips to ~3 batches, which is
    // the difference between "schedule feels instant" and a long spinner.
    const CONCURRENCY = 4;
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const index = cursor++;
        try {
          await sendOne(ids[index] as string, index);
          sent++;
        } catch {
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  } else {
    // Immediate: sequential — WhatsApp delivery order follows send order here.
    for (const [index, id] of ids.entries()) {
      try {
        await sendOne(id, index);
        sent++;
      } catch {
        failed++;
      }
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
