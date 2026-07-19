/**
 * Multi-media WhatsApp send for chat templates — SERVER-SIDE fan-out.
 *
 * Accepts a mixed list of media references:
 *   • CRM `files` ids — a project template's `project_image_file_ids` (the
 *     linked all_projects gallery + `main_image`). Private files — the batch
 *     endpoint RLS-checks visibility and signs them server-side.
 *   • Raw public URLs — a listing template's cleaned photos
 *     (`images[].public_url`) and direct video-file URLs (project_videos /
 *     listing video_urls / converted HLS mp4s), passed through as-is.
 * (HLS playlists / page links are filtered out by the CALLER — see
 * directVideoUrls in lib/matching/sendToClient.ts — they aren't sendable.)
 *
 * The text message is sent SEPARATELY by the caller first (StartChatModal's
 * first message / the Composer's text+single-media send); this fans out the
 * gallery afterwards.
 *
 * REFRESH-SAFE BY DESIGN (2026-07-19): the whole ordered batch goes to
 * `/api/whatsapp/send-media-batch` in ONE small keepalive request; the WAHA
 * gateway fetches each media's bytes itself and the nodejs function completes
 * the sequential sends even if this tab refreshes or closes. The old
 * implementation looped fetch→upload→send IN THE TAB — a refresh after the
 * text send silently killed every remaining media message (live incident
 * 2026-07-19, chat 88a6c43e: listing text sent, 0 of the images/videos went
 * out). Do not reintroduce a browser-side send loop here.
 */

import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import { startJob, completeJob, failJob } from '@/lib/jobs/jobCenter';

/** Legacy webhook-created chats can carry the whole device OBJECT in
 *  data.device_id — same guard as appStore's deviceIdString. */
function deviceIdString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    return (v as { id: string }).id;
  }
  return null;
}

/** Recipient phone + send-from device for a chat wid — mirrors the resolution
 *  in appStore.sendChatMessage (record device → default → any active → live). */
function resolveChatTarget(chatWid: string): { phone: string; deviceId: string | null } {
  const state = useAppStore.getState();
  const chatsModel = state.models.find((m) => m.name === 'chats');
  const record = chatsModel
    ? (state.records[chatsModel.id] ?? []).find((r) => (r.data as Record<string, unknown>).wid === chatWid)
    : undefined;
  const data = (record?.data ?? {}) as Record<string, unknown>;
  const phone = typeof data.phone === 'string' && data.phone
    ? data.phone
    // Direct-chat wid is "<digits>@c.us" — recover the phone from it when the
    // record hasn't loaded (defensive; callers normally have the record).
    : chatWid.endsWith('@c.us') ? `+${chatWid.slice(0, -'@c.us'.length).replace(/\D/g, '')}` : '';
  const deviceId =
    deviceIdString(data.device_id) ??
    (state.waDevices ?? []).find((d) => d.is_default && d.is_active)?.device_id ??
    (state.waDevices ?? []).find((d) => d.is_active)?.device_id ??
    (state.waDevicesLive ?? [])[0]?.id ??
    null;
  return { phone, deviceId };
}

export async function sendProjectImageMessages(
  chatWid: string,
  fileIds: string[] | null | undefined,
  opts: {
    /**
     * Schedule instead of sending now: the caller's text message sits in the
     * delivery queue at this time, and the endpoint staggers each gallery item
     * a few seconds after it (queue order within the same second isn't
     * guaranteed, so the stagger keeps text → image1 → image2 delivery order).
     */
    deliverAt?: string;
  } = {},
): Promise<{ sent: number; failed: number }> {
  const ids = (fileIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return { sent: 0, failed: 0 };

  const { addToast, language } = useAppStore.getState();
  const isAr = language === 'ar';
  const jobId = startJob({
    kind: 'media_fanout',
    label: opts.deliverAt
      ? (isAr ? `جدولة ${ids.length} من الوسائط` : `Scheduling ${ids.length} media message(s)`)
      : (isAr ? `إرسال ${ids.length} من الوسائط` : `Sending ${ids.length} media message(s)`),
    progress: { done: 0, total: ids.length },
    href: `/model/chats/`,
  });

  try {
    const { phone, deviceId } = resolveChatTarget(chatWid);
    if (!phone) throw new Error(isAr ? 'المحادثة بلا رقم مستلم' : 'conversation is missing the recipient phone');

    const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : null;
    // keepalive: the browser delivers the request even if the page unloads
    // right after send — from then on the server owns the fan-out.
    const res = await fetch('/api/whatsapp/send-media-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        phone,
        deviceId: deviceId ?? undefined,
        items: ids.map((ref) => ({ ref })),
        ...(opts.deliverAt ? { deliverAt: opts.deliverAt } : {}),
      }),
      keepalive: true,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body?.error || `send-media-batch failed (${res.status})`);
    }
    const result = (await res.json()) as { sent: number; failed: number; firstError?: string };

    if (result.failed > 0) {
      addToast(
        isAr
          ? `تعذّر إرسال ${result.failed} من الوسائط${result.firstError ? ` — ${result.firstError}` : ''}`
          : `Couldn't send ${result.failed} media message(s)${result.firstError ? ` — ${result.firstError}` : ''}`,
        result.failed === ids.length ? 'error' : 'info',
      );
    }
    if (result.failed === ids.length) {
      failJob(jobId, isAr ? 'فشل إرسال كل الوسائط' : 'all media failed to send', { toastMessage: null });
    } else {
      // The caller surfaces its own success toast; keep the job entry quiet.
      completeJob(jobId, { toastMessage: null });
    }
    return { sent: result.sent, failed: result.failed };
  } catch (err) {
    // NEVER reject: every caller fires this with `void ...then(...)` (no catch),
    // so a throw here would be an unhandled rejection with no user feedback.
    // Toast + fail the job entry, report everything as failed.
    const msg = err instanceof Error ? err.message : String(err);
    failJob(jobId, msg, { toastMessage: null });
    addToast(
      isAr ? `تعذّر إرسال الوسائط — ${msg}` : `Couldn't send the media — ${msg}`,
      'error',
    );
    return { sent: 0, failed: ids.length };
  }
}
