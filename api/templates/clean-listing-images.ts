/**
 * POST /api/templates/clean-listing-images
 *
 * Drives the photo-cleaning half of the Listing Message flow. Two modes:
 *
 *   mode='start'  { listing_id }
 *     - RLS-gates the source market_listings record under the caller's JWT,
 *       reads its image_urls (the heavy full record, not the summary view).
 *     - Creates a chat_templates DRAFT record SERVER-SIDE (status='generating',
 *       cleaning[] one entry per photo, listing_id) via record_save — never the
 *       browser store, so the realtime echo-dedup can't suppress the worker's
 *       fill-ins.
 *     - Fans out ONE generation_jobs row (kind='clean-text') per photo so they
 *       clean in parallel on the Fly worker (worker/src/runCleanTextJob.ts).
 *     - Returns 202 { record_id, image_count, job_ids }.
 *
 *   mode='redo'   { record_id, entry_ids: string[] }
 *     - Resets the named cleaning entries to status='queued' (server-side) and
 *       re-enqueues a clean-text job for each. Used by the modal's per-photo /
 *       redo-all buttons. Returns 202 { job_ids }.
 *
 * The matching AI message text is produced by the SEPARATE
 * /api/templates/listing-message endpoint; the modal holds the editable text in
 * local state and writes it onto the draft only on Approve (when no worker is
 * still touching the record).
 *
 * Loud failures only (CLAUDE.md): 401 (auth), 400 (validation), 404 (listing /
 * draft), 500 (create/enqueue).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { recordSaveWithRetry } from '../_lib/recordSaveRetry.js';
import { getServiceClient } from '../_lib/files.js';
import {
  readNodeBodyLimited,
  PayloadTooLargeError,
  sendPayloadTooLarge,
  MAX_REQUEST_BODY_BYTES,
} from '../_lib/httpBody.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

interface RequestBody {
  mode?: 'start' | 'redo' | 'apply-to-listing' | 'set-text';
  listing_id?: string;
  record_id?: string;
  entry_ids?: string[];
  body_ar?: string;
  body_en?: string;
}

interface CleaningEntry {
  id: string;
  image_index: number;
  source_url: string;
  status: 'queued' | 'cleaning' | 'completed' | 'failed' | 'cancelled';
  output_url?: string;
  asset_id?: string;
  error?: string;
}

/**
 * Read a listing's scan-time photo mirror.
 *
 * data.image_mirror_map = { "<aqar url>": "<our listing-photos url>" }, written
 * by the listing-mirror worker lane (2026-07-29). Resolving it HERE — where we
 * already hold the full listing row — means the worker never has to re-read the
 * listing just to find out where the bytes live, and a job's input URL is
 * frozen at enqueue time like every other param.
 *
 * A missing entry is normal (a listing imported before the mirror lane, or a
 * photo whose mirror failed); the worker then falls back to fetching from Aqar
 * and enqueues a mirror so the next clean is covered.
 */
function readMirrorMap(ld: Record<string, unknown>): Record<string, string> {
  const raw = ld.image_mirror_map;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) out[k] = v;
  }
  return out;
}

/* ─── Node ↔ Web Request adapter (copied from image-chat/generate.ts) ── */
async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : await readNodeBodyLimited(nodeReq, MAX_REQUEST_BODY_BYTES);
  return new Request(url.toString(), { method, headers, body });
}
async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  nodeRes.end(Buffer.from(await webResp.arrayBuffer()));
}

/** Best-effort fire-and-forget /wake ping to the Fly worker. */
async function wakeWorker(jobCount: number): Promise<void> {
  const workerUrl = process.env.WASSEL_DECK_WORKER_URL;
  if (!workerUrl || jobCount === 0) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    await fetch(`${workerUrl.replace(/\/$/, '')}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'clean-text' }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (err) {
    console.warn(`[clean-listing-images] wake failed (non-fatal): ${(err as Error).message}`);
  }
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  let req: Request;
  try {
    req = await nodeToWebRequest(nodeReq);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return sendPayloadTooLarge(nodeRes, err.limitBytes);
    throw err;
  }
  const resp = await withAuth(req, async (user) => {
    if (req.method !== 'POST') return jsonError(405, 'Method not allowed');
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    const auth = req.headers.get('Authorization') ?? '';
    const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!supabaseUrl || !anonKey || !jwt) return jsonError(500, 'Supabase env vars missing or JWT absent');
    const jwtClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const svc = getServiceClient();

    // withAuth.userId is the auth.uid(); records.created_by_user_id FKs to
    // public.users.id — resolve the app-user id (same pattern as
    // generate-document.ts). Used as the draft owner + the job's user_id.
    const { data: appUser, error: auErr } = await jwtClient
      .from('users')
      .select('id')
      .eq('auth_uid', user.userId)
      .maybeSingle();
    if (auErr || !appUser?.id) return jsonError(500, 'app user lookup failed');
    const appUserId = appUser.id as string;

    const mode =
      body.mode === 'redo'
        ? 'redo'
        : body.mode === 'apply-to-listing'
          ? 'apply-to-listing'
          : body.mode === 'set-text'
            ? 'set-text'
            : 'start';

    // ════════════════════════════════════════════════════════════════════
    // SET-TEXT — persist the AI-drafted message text onto the draft so it
    // survives the modal being closed AND the tab reloading (the Job Center
    // rehydrates unfinished drafts on boot). Owner-gated; optimistic-retry
    // write so it never clobbers a concurrent worker cleaning fill-in.
    // ════════════════════════════════════════════════════════════════════
    if (mode === 'set-text') {
      const recordId = body.record_id?.trim();
      if (!recordId) return jsonError(400, 'record_id is required for set-text');
      const bodyAr = typeof body.body_ar === 'string' ? body.body_ar : '';
      const bodyEn = typeof body.body_en === 'string' ? body.body_en : '';

      const { data: draftRow, error: draftErr } = await svc
        .from('records')
        .select('created_by_user_id')
        .eq('id', recordId)
        .single();
      if (draftErr || !draftRow) return jsonError(404, `draft not found: ${draftErr?.message ?? recordId}`);
      if ((draftRow.created_by_user_id as string | null) !== appUserId) {
        return jsonError(404, 'draft not found');
      }

      try {
        await recordSaveWithRetry(svc, {
          recordId,
          build: (data) => ({ ...data, body_ar: bodyAr, body_en: bodyEn }),
        });
      } catch (err) {
        return jsonError(500, `failed to persist text: ${err instanceof Error ? err.message : String(err)}`);
      }
      return jsonOk({ record_id: recordId }, 200);
    }

    // ════════════════════════════════════════════════════════════════════
    // APPLY-TO-LISTING — on approve, replace the market listing's photos with
    // the cleaned (text-removed) versions. Per-index: cleaned where available,
    // original kept for any photo whose cleaning failed. Backs up the TRUE
    // originals to original_image_urls / original_main_image_url (once) so it's
    // reversible AND so future cleans re-source from the originals (never clean
    // an already-cleaned image). Service-role: bypasses RLS + reads full data.
    // ════════════════════════════════════════════════════════════════════
    if (mode === 'apply-to-listing') {
      const recordId = body.record_id?.trim();
      const listingId = body.listing_id?.trim();
      if (!recordId || !listingId) return jsonError(400, 'record_id and listing_id are required');

      // Read the draft (owner-gated) for its cleaned outputs.
      const { data: draftRow, error: draftErr } = await svc
        .from('records')
        .select('data, created_by_user_id')
        .eq('id', recordId)
        .single();
      if (draftErr || !draftRow) return jsonError(404, `draft not found: ${draftErr?.message ?? recordId}`);
      if ((draftRow.created_by_user_id as string | null) !== appUserId) {
        return jsonError(404, 'draft not found');
      }
      const cleaning = Array.isArray((draftRow.data as Record<string, unknown>)?.cleaning)
        ? ((draftRow.data as Record<string, unknown>).cleaning as CleaningEntry[])
        : [];
      const cleanedByIndex = new Map<number, string>();
      for (const c of cleaning) {
        if (c.status === 'completed' && typeof c.output_url === 'string' && c.output_url) {
          cleanedByIndex.set(c.image_index, c.output_url);
        }
      }
      if (cleanedByIndex.size === 0) return jsonError(400, 'no cleaned images to apply');

      // Read the listing (full data + model_id). market_listings is frozen
      // (2026-08-07) — its _v view keeps the jsonb `data` shape this code reads.
      const { data: listingRow, error: listingErr } = await svc
        .from('market_listings_v')
        .select('data, model_id')
        .eq('id', listingId)
        .single();
      if (listingErr || !listingRow) return jsonError(404, `listing not found: ${listingErr?.message ?? listingId}`);
      const ld = (listingRow.data ?? {}) as Record<string, unknown>;

      // The TRUE originals — from the backup if a prior approve already set it,
      // else the current image_urls.
      const origUrls =
        Array.isArray(ld.original_image_urls) && (ld.original_image_urls as unknown[]).length > 0
          ? (ld.original_image_urls as string[])
          : Array.isArray(ld.image_urls)
            ? (ld.image_urls as string[])
            : [];
      const newUrls = origUrls.map((u, i) => cleanedByIndex.get(i) ?? u);

      const newData: Record<string, unknown> = {
        ...ld,
        image_urls: newUrls,
        main_image_url: newUrls[0] ?? ld.main_image_url ?? null,
      };
      // Back up the originals ONCE (never overwrite an existing backup).
      if (!Array.isArray(ld.original_image_urls)) newData.original_image_urls = origUrls;
      if (ld.original_main_image_url == null) {
        newData.original_main_image_url = (ld.main_image_url as string | null) ?? null;
      }

      const { error: saveErr } = await svc.rpc('record_save', {
        p_model_id: listingRow.model_id,
        p_id: listingId,
        p_data: newData,
        p_created_by: null, // COALESCE-preserves the listing's existing owner
        p_expected_version: null,
      });
      if (saveErr) return jsonError(500, `failed to update listing images: ${saveErr.message}`);

      // ── Seed the template's sendable VIDEOS (curated media, like images) ──
      // The browser can't do this: the SPA loads listings through the slim
      // market_listings_summary view, which strips video_urls/video_mp4_map.
      // Here we hold the FULL listing row, so materialize
      // data.videos = [{source_url, public_url}] on the template — direct video
      // files as-is + HLS streams through the worker's mp4 cache. The saved-
      // message modal and the template editor edit this list; the send flow
      // reads it. Best-effort: a failure never blocks the approve.
      try {
        const DIRECT_VIDEO_RE = /\.(mp4|m4v|webm|mov|3gp)(\?|#|$)/i;
        const rawVideos = Array.isArray(ld.video_urls) ? ld.video_urls : Array.isArray(ld.videos) ? ld.videos : [];
        const mp4Map = (ld.video_mp4_map ?? {}) as Record<string, unknown>;
        const videos = (rawVideos as unknown[])
          .filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u))
          .map((u) => ({
            source_url: u,
            public_url: DIRECT_VIDEO_RE.test(u)
              ? u
              : typeof mp4Map[u] === 'string' && mp4Map[u]
                ? (mp4Map[u] as string)
                : null,
          }))
          .filter((v): v is { source_url: string; public_url: string } => !!v.public_url);
        await recordSaveWithRetry(svc, {
          recordId,
          build: (data) => ({ ...data, videos }),
        });
      } catch (err) {
        console.error(
          `[clean-listing-images] template video seed failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      console.log(
        `[clean-listing-images] applied ${cleanedByIndex.size} cleaned photo(s) to listing=${listingId}`,
      );
      return jsonOk({ listing_id: listingId, replaced: cleanedByIndex.size, image_count: newUrls.length }, 200);
    }

    // ════════════════════════════════════════════════════════════════════
    // REDO — re-enqueue specific cleaning entries on an existing draft.
    // ════════════════════════════════════════════════════════════════════
    if (mode === 'redo') {
      const recordId = body.record_id?.trim();
      const entryIds = Array.isArray(body.entry_ids)
        ? body.entry_ids.filter((s) => typeof s === 'string' && s.length > 0)
        : [];
      if (!recordId) return jsonError(400, 'record_id is required for redo');
      if (entryIds.length === 0) return jsonError(400, 'entry_ids is required for redo');

      // Read the draft (service role) to recover each entry's source_url.
      const { data: draftRow, error: draftErr } = await svc
        .from('records')
        .select('data, created_by_user_id')
        .eq('id', recordId)
        .single();
      if (draftErr || !draftRow) return jsonError(404, `draft not found: ${draftErr?.message ?? recordId}`);
      // Owner gate — only the draft's creator may redo its photos.
      if ((draftRow.created_by_user_id as string | null) !== appUserId) {
        return jsonError(404, 'draft not found');
      }
      const cleaning = Array.isArray((draftRow.data as Record<string, unknown>)?.cleaning)
        ? ((draftRow.data as Record<string, unknown>).cleaning as CleaningEntry[])
        : [];
      const byId = new Map(cleaning.map((c) => [c.id, c]));
      const targets = entryIds
        .map((id) => byId.get(id))
        .filter((c): c is CleaningEntry => !!c && typeof c.source_url === 'string' && c.source_url.length > 0);
      if (targets.length === 0) return jsonError(400, 'no matching cleaning entries with a source url');

      // Reset the targeted entries to queued (server-side; clears prior output/error).
      try {
        await recordSaveWithRetry(svc, {
          recordId,
          build: (data) => {
            const arr = Array.isArray(data.cleaning) ? (data.cleaning as CleaningEntry[]) : [];
            const reset = new Set(targets.map((t) => t.id));
            return {
              ...data,
              status: 'generating',
              cleaning: arr.map((c) =>
                reset.has(c.id)
                  ? { id: c.id, image_index: c.image_index, source_url: c.source_url, status: 'queued' as const }
                  : c,
              ),
            };
          },
        });
      } catch (err) {
        return jsonError(500, `failed to reset entries: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Resolve this listing's scan-time photo mirror, same as `start` does, so
      // a redo is CDN-independent too. Redo is exactly the button a user reaches
      // for when photos failed — which, before the mirror lane, was usually the
      // Aqar 403 — so it is the LAST place that should still depend on Aqar.
      const redoListingId =
        typeof (draftRow.data as Record<string, unknown>)?.listing_id === 'string'
          ? ((draftRow.data as Record<string, unknown>).listing_id as string)
          : '';
      let redoMirrorMap: Record<string, string> = {};
      if (redoListingId) {
        const { data: lRow, error: lErr } = await svc
          .from('market_listings_v') // frozen 2026-08-07; _v keeps the jsonb data shape
          .select('data')
          .eq('id', redoListingId)
          .maybeSingle();
        if (lErr) {
          console.error(`[clean-listing-images] redo mirror lookup failed (non-fatal): ${lErr.message}`);
        } else if (lRow?.data) {
          redoMirrorMap = readMirrorMap(lRow.data as Record<string, unknown>);
        }
      }

      const jobs = targets.map((t) => ({
        id: crypto.randomUUID(),
        record_id: recordId,
        message_id: t.id,
        generation_id: null,
        user_id: appUserId,
        kind: 'clean-text',
        status: 'queued',
        prompt: null,
        params: {
          source_url: t.source_url,
          image_index: t.image_index,
          ...(redoListingId ? { listing_id: redoListingId } : {}),
          ...(redoMirrorMap[t.source_url] ? { fetch_url: redoMirrorMap[t.source_url] } : {}),
        },
      }));
      const { error: insErr } = await svc.from('generation_jobs').insert(jobs);
      if (insErr) return jsonError(500, `failed to enqueue redo jobs: ${insErr.message}`);

      const redoMirrored = targets.filter((t) => !!redoMirrorMap[t.source_url]).length;
      if (redoListingId && redoMirrored < targets.length) {
        const { error: mirrorErr } = await svc.rpc('listing_mirror_enqueue', {
          p_listing_id: redoListingId,
          p_reason: 'clean-redo',
        });
        if (mirrorErr) {
          console.error(`[clean-listing-images] redo mirror enqueue failed (non-fatal): ${mirrorErr.message}`);
        }
      }

      await wakeWorker(jobs.length);
      console.log(
        `[clean-listing-images] redo record=${recordId} jobs=${jobs.length} mirrored=${redoMirrored}/${targets.length}`,
      );
      return jsonOk({ record_id: recordId, job_ids: jobs.map((j) => j.id) }, 202);
    }

    // ════════════════════════════════════════════════════════════════════
    // START — create a draft for a listing and fan out the clean jobs.
    // ════════════════════════════════════════════════════════════════════
    const listingId = body.listing_id?.trim();
    if (!listingId) return jsonError(400, 'listing_id is required');

    // Resolve model ids.
    const { data: ctModel, error: ctErr } = await jwtClient
      .from('models').select('id').eq('name', 'chat_templates').single();
    if (ctErr || !ctModel) return jsonError(500, `chat_templates model not found: ${ctErr?.message ?? ''}`);
    const chatTemplatesModelId = ctModel.id as string;
    const { data: mlModel, error: mlErr } = await jwtClient
      .from('models').select('id').eq('name', 'market_listings').single();
    if (mlErr || !mlModel) return jsonError(500, `market_listings model not found: ${mlErr?.message ?? ''}`);
    const marketListingsModelId = mlModel.id as string;

    // RLS-gate the source listing under the caller's JWT; read its full data.
    // unified_records spans records + frozen models (market_listings froze
    // 2026-08-07) with the same jsonb `data` shape; model_id still guards the id.
    const { data: listingRow, error: listingErr } = await jwtClient
      .from('unified_records')
      .select('data')
      .eq('id', listingId)
      .eq('model_id', marketListingsModelId)
      .single();
    if (listingErr || !listingRow) return jsonError(404, `listing not found: ${listingErr?.message ?? listingId}`);
    const ld = (listingRow.data ?? {}) as Record<string, unknown>;

    // Always clean from the TRUE originals: if a prior approve replaced
    // image_urls with cleaned versions, original_image_urls holds the source —
    // re-source from it so we never clean an already-cleaned image.
    const sourceList =
      Array.isArray(ld.original_image_urls) && (ld.original_image_urls as unknown[]).length > 0
        ? (ld.original_image_urls as unknown[])
        : Array.isArray(ld.image_urls)
          ? (ld.image_urls as unknown[])
          : [];
    const imageUrls = sourceList.filter(
      (u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u),
    );
    // Fall back to the single (original) main_image_url if the heavy array is absent.
    if (imageUrls.length === 0) {
      const mainUrl =
        (typeof ld.original_main_image_url === 'string' && ld.original_main_image_url) ||
        (typeof ld.main_image_url === 'string' && ld.main_image_url) ||
        '';
      if (/^https?:\/\//i.test(mainUrl)) imageUrls.push(mainUrl);
    }
    if (imageUrls.length === 0) return jsonError(400, 'this listing has no images to clean');

    // The template's name IS the listing's Aqar ad id ("@123456") — the id is
    // how listings are referenced everywhere (finder cards, client options).
    // Title is only the fallback for the rare listing without an external_id.
    const externalId = typeof ld.external_id === 'string' ? ld.external_id.trim() : '';
    const listingTitle =
      (externalId && `@${externalId}`) ||
      (typeof ld.title === 'string' && ld.title.trim()) ||
      'Listing message';

    const draftId = crypto.randomUUID();
    const entries: CleaningEntry[] = imageUrls.map((url, i) => ({
      id: crypto.randomUUID(),
      image_index: i,
      source_url: url,
      status: 'queued',
    }));

    // Create the draft SERVER-SIDE via record_save (service role; created_by =
    // the user so they own it). Never via the browser store — echo-dedup.
    const draftData: Record<string, unknown> = {
      name: listingTitle,
      category: 'project',
      language: 'both',
      tags: ['listing'],
      listing_id: listingId,
      status: 'generating',
      cleaning: entries,
      images: [],
      body_ar: '',
      body_en: '',
    };
    const { error: saveErr } = await svc.rpc('record_save', {
      p_model_id: chatTemplatesModelId,
      p_id: draftId,
      p_data: draftData,
      p_created_by: appUserId,
      p_expected_version: null,
    });
    if (saveErr) return jsonError(500, `failed to create draft: ${saveErr.message}`);

    const mirrorMap = readMirrorMap(ld);
    const jobs = entries.map((e) => ({
      id: crypto.randomUUID(),
      record_id: draftId,
      message_id: e.id,
      generation_id: null,
      user_id: user.userId,
      kind: 'clean-text',
      status: 'queued',
      prompt: null,
      params: {
        source_url: e.source_url,
        image_index: e.image_index,
        listing_id: listingId,
        ...(mirrorMap[e.source_url] ? { fetch_url: mirrorMap[e.source_url] } : {}),
      },
    }));
    const mirroredCount = entries.filter((e) => !!mirrorMap[e.source_url]).length;
    const { error: insErr } = await svc.from('generation_jobs').insert(jobs);
    if (insErr) {
      // Mark the draft failed so it doesn't hang on "generating" (best-effort).
      try {
        await svc.rpc('record_save', {
          p_model_id: chatTemplatesModelId,
          p_id: draftId,
          p_data: { ...draftData, status: 'failed' },
          p_created_by: user.userId,
          p_expected_version: null,
        });
      } catch {
        /* best-effort cleanup — never throw */
      }
      return jsonError(500, `failed to enqueue clean jobs: ${insErr.message}`);
    }
    // ── Also convert the listing's STREAM videos to sendable .mp4s ────────
    // Aqar videos are Cloudflare Stream HLS playlists (.m3u8), which WhatsApp
    // cannot carry — the worker converts each ONCE (kind='video-convert') and
    // caches data.video_mp4_map on the LISTING; the send flow reads the cache.
    // Direct video FILES (.mp4 etc.) send natively and are skipped, as are
    // already-cached sources and sources with an active conversion job.
    // Failure here is non-fatal to the photo flow: log loudly and continue —
    // the send simply keeps skipping unconverted videos.
    let videoJobCount = 0;
    try {
      const DIRECT_VIDEO_RE = /\.(mp4|m4v|webm|mov|3gp)(\?|#|$)/i;
      const rawVideos = Array.isArray(ld.video_urls) ? ld.video_urls : Array.isArray(ld.videos) ? ld.videos : [];
      const mp4Map = (ld.video_mp4_map ?? {}) as Record<string, unknown>;
      const streamVideos = (rawVideos as unknown[]).filter(
        (u): u is string =>
          typeof u === 'string' &&
          /^https?:\/\//i.test(u) &&
          !DIRECT_VIDEO_RE.test(u) &&
          !(typeof mp4Map[u] === 'string' && mp4Map[u]),
      );
      if (streamVideos.length > 0) {
        const { data: activeRows } = await svc
          .from('generation_jobs')
          .select('params')
          .eq('record_id', listingId)
          .eq('kind', 'video-convert')
          .in('status', ['queued', 'running']);
        const activeSources = new Set(
          ((activeRows ?? []) as Array<{ params: Record<string, unknown> | null }>).map(
            (r) => r.params?.source_url as string,
          ),
        );
        const videoJobs = streamVideos
          .filter((u) => !activeSources.has(u))
          .map((u) => ({
            id: crypto.randomUUID(),
            record_id: listingId,
            message_id: null,
            generation_id: null,
            user_id: user.userId,
            kind: 'video-convert',
            status: 'queued',
            prompt: null,
            params: { source_url: u, listing_id: listingId },
          }));
        if (videoJobs.length > 0) {
          const { error: vidErr } = await svc.from('generation_jobs').insert(videoJobs);
          if (vidErr) throw new Error(vidErr.message);
          videoJobCount = videoJobs.length;
        }
      }
    } catch (err) {
      console.error(
        `[clean-listing-images] video-convert enqueue failed (photos unaffected): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // If any photo has no scan-time mirror, ask for one now. Idempotent RPC —
    // no-ops when a mirror job is already in flight or nothing is missing. The
    // clean itself doesn't wait on it (the worker falls back to Aqar for this
    // run); this just makes the NEXT clean of this listing CDN-independent.
    if (mirroredCount < entries.length) {
      const { error: mirrorErr } = await svc.rpc('listing_mirror_enqueue', {
        p_listing_id: listingId,
        p_reason: 'clean-start',
      });
      if (mirrorErr) {
        console.error(
          `[clean-listing-images] mirror enqueue failed (non-fatal): ${mirrorErr.message}`,
        );
      }
    }

    await wakeWorker(jobs.length + videoJobCount);
    console.log(
      `[clean-listing-images] start listing=${listingId} draft=${draftId} jobs=${jobs.length} mirrored=${mirroredCount}/${entries.length} video_jobs=${videoJobCount}`,
    );
    return jsonOk(
      { record_id: draftId, image_count: entries.length, job_ids: jobs.map((j) => j.id) },
      202,
    );
  });
  await writeWebResponseToNode(resp, nodeRes);
}
