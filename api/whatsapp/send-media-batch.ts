/**
 * POST /api/whatsapp/send-media-batch — server-side media fan-out.
 *
 * Sends an ORDERED batch of media messages (a template's photo gallery +
 * videos) into one WhatsApp chat. Replaces the old browser-side loop in
 * `src/lib/projectMessageImages.ts`, which fetched/uploaded/sent each item
 * from the tab: a refresh mid-loop silently killed the remaining sends with
 * no server-side record (live incident 2026-07-19 — a listing message's text
 * went out, the user refreshed, and none of the images/videos ever sent).
 *
 * One request carries ALL refs; once it reaches this NODEJS function the
 * fan-out completes even if the tab closes (serverless execution is not tied
 * to the client connection — same reason backfill-history uses this runtime).
 * WAHA fetches each media's bytes itself from the URL we hand it
 * (waha.resolveMediaFile passes {url} straight through), so no bytes flow
 * through this function at all.
 *
 * Body: {
 *   deviceId?:  string,          // default: the active default number
 *   phone:      "+9665...",      // recipient (direct chats only)
 *   items:      [{ ref: string }],  // ORDERED. ref = public URL or CRM files id
 *   deliverAt?: ISO datetime      // schedule: item i delivers at +(i+1)*10s
 * }
 * Reply: { sent, failed, total, firstError? }
 *
 * Access gating: CRM file ids resolve through the CALLER's JWT client — RLS
 * (`files_select`) filters to files they may view, same posture as
 * /api/files/sign-view-urls; the signing itself is service-role (bytes live
 * under the uploader's auth.uid() prefix). Refs the caller can't see count as
 * failed, never silently skipped.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { sendMessage, resolveDefaultDeviceId, maybeScheduleWaha, HaberchatError } from '../_lib/whatsappGateway.js';
import { getJwtClient, isFileIdShape, signFileUrl } from '../_lib/files.js';

export const config = {
  runtime: 'nodejs',
  // A mixed gallery can be slow server-side too (WAHA downloads each file and
  // `convert`s videos) — give the fan-out the full ceiling.
  maxDuration: 300,
};

/** Largest batch the inline (send-now) loop can finish within maxDuration —
 *  WAHA downloads + converts each item, so ~10s/item worst case. Batches
 *  bigger than this are NOT rejected: they auto-upgrade to the scheduled
 *  queue (deliverAt = now), which the Fly worker drains with no time limit.
 *  (A 33-image project gallery used to 400 the whole batch here — the text
 *  went out and zero media followed; live incident 2026-07-22.) */
const INLINE_MAX_ITEMS = 30;
/** Hard sanity ceiling — a gallery beyond this is almost certainly a caller
 *  bug, and per the no-silent-caps rule it fails LOUDLY rather than trimming. */
const MAX_ITEMS = 120;
/** Scheduled items are staggered after the caller's text message so the queue
 *  delivers text → media1 → media2 in order (same spacing the client used). */
const STAGGER_MS = 10_000;

// ── Node↔Web bridge (the nodejs runtime ignores a returned Web Response) ────
async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of nodeReq) chunks.push(Buffer.from(chunk));
    body = Buffer.concat(chunks).toString('utf8');
  }
  return new Request(url.toString(), { method, headers, body });
}

async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  nodeRes.end(Buffer.from(await webResp.arrayBuffer()));
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const req = await nodeToWebRequest(nodeReq);
  const resp = await runBatch(req);
  await writeWebResponseToNode(resp, nodeRes);
}

async function runBatch(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    let body: { deviceId?: unknown; phone?: unknown; items?: unknown; deliverAt?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const phone = typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim() : null;
    if (!phone) return jsonError(400, 'phone is required');

    const rawItems = Array.isArray(body.items) ? body.items : null;
    if (!rawItems || rawItems.length === 0) return jsonError(400, 'items (non-empty array) is required');
    const refs = rawItems
      .map((it) => (it && typeof it === 'object' && typeof (it as { ref?: unknown }).ref === 'string'
        ? ((it as { ref: string }).ref).trim()
        : ''))
      .filter((r) => r.length > 0);
    if (refs.length === 0) return jsonError(400, 'items must carry non-empty ref strings');
    if (refs.length > MAX_ITEMS) return jsonError(400, `too many items (max ${MAX_ITEMS})`);

    const deliverAt = typeof body.deliverAt === 'string' ? body.deliverAt : undefined;
    let baseDeliverMs: number | null = null;
    if (deliverAt) {
      baseDeliverMs = new Date(deliverAt).getTime();
      if (Number.isNaN(baseDeliverMs)) return jsonError(400, 'deliverAt must be a valid ISO 8601 datetime');
    } else if (refs.length > INLINE_MAX_ITEMS) {
      // Send-now batch too big for the inline loop → deliver via the scheduled
      // queue starting now. Same stagger, same order; the worker owns the sends.
      baseDeliverMs = Date.now();
    }

    const deviceId = (typeof body.deviceId === 'string' && body.deviceId ? body.deviceId : null)
      ?? (await resolveDefaultDeviceId())
      ?? '';
    if (!deviceId) return jsonError(400, 'no WhatsApp device configured to send from');

    // ── Resolve CRM file ids → signed URLs (RLS-gated lookup, service sign).
    //    Raw http(s) refs (listing photos / converted videos on public buckets)
    //    pass through untouched — WAHA fetches them directly. ──
    const isUrl = (s: string) => /^https?:\/\//i.test(s);
    const fileIds = [...new Set(refs.filter((r) => !isUrl(r) && isFileIdShape(r)))];
    const signedById: Record<string, string> = {};
    if (fileIds.length > 0) {
      const jwtClient = getJwtClient(req);
      const { data, error } = await jwtClient
        .from('files')
        .select('id, storage_bucket, storage_path')
        .in('id', fileIds);
      if (error) return jsonError(500, `file lookup failed: ${error.message}`);
      // Scheduled sends: WAHA fetches the bytes AT DELIVERY time, so the signed
      // URL must outlive the latest stagger — pad a day, cap at Supabase's 7d.
      const ttlSeconds = baseDeliverMs != null
        ? Math.min(604_800, Math.max(3_600, Math.ceil((baseDeliverMs - Date.now()) / 1000) + 86_400))
        : 3_600;
      for (const row of (data ?? []) as Array<{ id: string; storage_bucket: string; storage_path: string }>) {
        try {
          signedById[row.id] = await signFileUrl(row.storage_bucket, row.storage_path, ttlSeconds);
        } catch {
          // Leave unsigned — the send loop counts it as a failed item below.
        }
      }
    }

    // ── Sequential fan-out, preserving gallery order. Best-effort per item:
    //    one failure is tallied and the rest still send (same contract as the
    //    old client loop). ──
    let sent = 0;
    let failed = 0;
    let firstError: string | null = null;
    for (const [index, ref] of refs.entries()) {
      const url = isUrl(ref) ? ref : signedById[ref];
      try {
        if (!url) throw new Error('ref is neither a URL nor a viewable CRM file');
        const itemDeliverAt = baseDeliverMs != null
          ? new Date(baseDeliverMs + (index + 1) * STAGGER_MS).toISOString()
          : undefined;
        if (itemDeliverAt) {
          // WAHA numbers enqueue into our scheduled_whatsapp_jobs queue; a
          // legacy Haberchat number falls through to its native deliverAt.
          const scheduled = await maybeScheduleWaha(
            { deviceId, phone, mediaFileId: url, deliverAt: itemDeliverAt },
            user.userId,
          );
          if (!scheduled) {
            await sendMessage({ deviceId, phone, mediaFileId: url, deliverAt: itemDeliverAt });
          }
        } else {
          await sendMessage({ deviceId, phone, mediaFileId: url });
        }
        sent++;
      } catch (err) {
        failed++;
        if (!firstError) {
          firstError = err instanceof HaberchatError || err instanceof Error ? err.message : String(err);
        }
        console.error(`[send-media-batch] item ${index + 1}/${refs.length} failed:`, err);
      }
    }

    return jsonOk({ sent, failed, total: refs.length, ...(firstError ? { firstError } : {}) });
  });
}
