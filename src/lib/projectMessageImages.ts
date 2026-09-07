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
import { startJob, completeJob, failJob, updateJob } from '@/lib/jobs/jobCenter';
import { holdSendLane } from '@/lib/chat/sendLane';

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
    /**
     * Override the per-item delivery spacing (seconds) for a scheduled send.
     * Bulk project send uses a tighter cadence than the default 10s so a batch
     * of several projects drips out faster. Ignored for a send-now (no
     * deliverAt) call. Clamped server-side to [3, 60].
     */
    staggerSeconds?: number;
  } = {},
): Promise<{ sent: number; failed: number }> {
  const ids = (fileIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return { sent: 0, failed: 0 };

  const { addToast, language } = useAppStore.getState();
  const isAr = language === 'ar';
  const label = opts.deliverAt
    ? (isAr ? `جدولة ${ids.length} من الوسائط` : `Scheduling ${ids.length} media message(s)`)
    : (isAr ? `إرسال ${ids.length} من الوسائط` : `Sending ${ids.length} media message(s)`);
  const jobId = startJob({
    kind: 'media_fanout',
    label,
    progress: { done: 0, total: ids.length },
    href: `/model/chats/`,
  });

  // A send-now gallery HOLDS the conversation's send lane for as long as the
  // server is still sending it, so anything else the rep sends to this
  // conversation meanwhile (a units PDF from the units list, a typed reply)
  // waits and lands AFTER the last photo/video instead of in the middle of
  // them. Scheduled galleries sit in the server queue at explicit times and
  // don't hold the lane. Released in `finally` — never left dangling.
  let releaseLane: (() => void) | null = null;
  if (!opts.deliverAt) {
    let settle: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => { settle = resolve; });
    // estimatedMs: what OTHER tabs honor if this tab closes mid-batch (the
    // keepalive request keeps sending server-side) — ~10 s per item.
    const release = holdSendLane(chatWid, label, inFlight, { estimatedMs: ids.length * 10_000 });
    releaseLane = () => { settle(); release(); };
  }

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
        ...(opts.staggerSeconds != null ? { staggerSeconds: opts.staggerSeconds } : {}),
      }),
      keepalive: true,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body?.error || `send-media-batch failed (${res.status})`);
    }
    const result = (await res.json()) as {
      sent: number;
      failed: number;
      firstError?: string;
      /** Present when the server routed the batch through its delivery queue
       *  (send-now galleries above the inline ceiling): the moment the LAST
       *  item is due. The lane stays held until then. */
      lastDeliverAt?: string;
    };

    // Server upgraded a send-now gallery to its queue → the sends are still
    // going out on a timer after this request returned. Keep the lane held
    // until the last item is due (plus one stagger for the worker's poll), so
    // a PDF sent meanwhile still queues behind the whole gallery.
    const lastDue = !opts.deliverAt && typeof result.lastDeliverAt === 'string'
      ? new Date(result.lastDeliverAt).getTime()
      : NaN;
    if (Number.isFinite(lastDue) && lastDue > Date.now() && result.sent > 0) {
      holdSendLane(chatWid, label, { until: lastDue + 10_000 });
      updateJob(jobId, {
        detail: isAr
          ? `في طابور الإرسال حتى ${new Date(lastDue).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })}`
          : `Queued on the server until ${new Date(lastDue).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
      });
    }

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
  } finally {
    releaseLane?.();
  }
}
