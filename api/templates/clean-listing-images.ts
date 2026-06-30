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
  mode?: 'start' | 'redo';
  listing_id?: string;
  record_id?: string;
  entry_ids?: string[];
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

    const mode = body.mode === 'redo' ? 'redo' : 'start';

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

      const jobs = targets.map((t) => ({
        id: crypto.randomUUID(),
        record_id: recordId,
        message_id: t.id,
        generation_id: null,
        user_id: appUserId,
        kind: 'clean-text',
        status: 'queued',
        prompt: null,
        params: { source_url: t.source_url, image_index: t.image_index },
      }));
      const { error: insErr } = await svc.from('generation_jobs').insert(jobs);
      if (insErr) return jsonError(500, `failed to enqueue redo jobs: ${insErr.message}`);
      await wakeWorker(jobs.length);
      console.log(`[clean-listing-images] redo record=${recordId} jobs=${jobs.length}`);
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
    const { data: listingRow, error: listingErr } = await jwtClient
      .from('records')
      .select('data')
      .eq('id', listingId)
      .eq('model_id', marketListingsModelId)
      .single();
    if (listingErr || !listingRow) return jsonError(404, `listing not found: ${listingErr?.message ?? listingId}`);
    const ld = (listingRow.data ?? {}) as Record<string, unknown>;

    const imageUrls = Array.isArray(ld.image_urls)
      ? (ld.image_urls as unknown[]).filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u))
      : [];
    // Fall back to the single main_image_url if the heavy array is absent.
    if (imageUrls.length === 0 && typeof ld.main_image_url === 'string' && /^https?:\/\//i.test(ld.main_image_url)) {
      imageUrls.push(ld.main_image_url);
    }
    if (imageUrls.length === 0) return jsonError(400, 'this listing has no images to clean');

    const listingTitle =
      (typeof ld.title === 'string' && ld.title.trim()) ||
      (typeof ld.external_id === 'string' && `Listing ${ld.external_id}`) ||
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

    const jobs = entries.map((e) => ({
      id: crypto.randomUUID(),
      record_id: draftId,
      message_id: e.id,
      generation_id: null,
      user_id: user.userId,
      kind: 'clean-text',
      status: 'queued',
      prompt: null,
      params: { source_url: e.source_url, image_index: e.image_index },
    }));
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
    await wakeWorker(jobs.length);
    console.log(
      `[clean-listing-images] start listing=${listingId} draft=${draftId} jobs=${jobs.length}`,
    );
    return jsonOk(
      { record_id: draftId, image_count: entries.length, job_ids: jobs.map((j) => j.id) },
      202,
    );
  });
  await writeWebResponseToNode(resp, nodeRes);
}
