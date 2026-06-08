/**
 * POST /api/image-chat/send  (Image Chats v2 — slim enqueue)
 *
 * One turn of the "mini Higgsfield" Image Chats UI. This used to run the whole
 * fal.ai generation synchronously (awaiting up to 300s and blocking the entire
 * conversation). It now ENQUEUES a per-message job and returns fast; the
 * always-on Fly.io worker drains the `generation_jobs` queue and fills the
 * assistant placeholder in place. Status flows to the SPA via Supabase
 * Realtime on the record — no held HTTP, no SSE. This mirrors the decks
 * pipeline (api/generate-deck.ts + worker/src/runImageJob.ts).
 *
 * Body: `{ record_id, prompt, attachment_urls, attachment_sources,
 *          aspect_ratio, num_variations, preset_id, model_id, prev_image_url }`.
 *
 * Flow per turn:
 *   1. Auth + validate inputs.
 *   2. Resolve each attachment to a stable marketing-assets public URL UNDER
 *      THE CALLER'S JWT (bare files.id UUIDs from preset/snippet image fields
 *      are permission-checked + copied out of the private wassel-files bucket).
 *      This stays in the endpoint because it needs the JWT for the RLS gate;
 *      the worker only has service-role.
 *   3. Resolve brand-preset prompt_text + name (the client owns the image
 *      list; we never re-read preset images here).
 *   4. Append the user message AND an assistant PLACEHOLDER (status='queued')
 *      to records.data.messages via record_save — SERVER-SIDE, so the realtime
 *      echo-dedup never suppresses it. Uses optimistic concurrency
 *      (p_expected_version + retry on the 40001 version-mismatch) because rapid
 *      successive sends + the worker's fill-in all write the shared messages
 *      array.
 *   5. Insert ONE generation_jobs row (service-role; RLS blocks user inserts)
 *      with the frozen request params.
 *   6. Best-effort POST /wake to the worker (skip its ~3s poll latency).
 *   7. Return 202 { job_id, message_id }.
 *
 * If the job insert fails after the placeholder is written, we flip that
 * placeholder to status='failed' so the bubble doesn't hang on "queued"
 * forever (the watchdog only sweeps 'running' jobs, not 'queued' messages).
 *
 * Loud failures only — per CLAUDE.md "Silent Failures":
 *   - missing JWT → 401 (via withAuth).
 *   - input validation error → 400.
 *   - attachment resolution failure → 400.
 *   - enqueue/storage error → 500.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import {
  assertCanAccessFile,
  getServiceClient,
  loadFileBypassRls,
} from '../_lib/files.js';
import type { ChatAspectRatio, ChatModelId } from '../_lib/imageGen.js';

// Slim enqueue — one attachment-resolution pass + a couple of DB writes + a
// fire-and-forget /wake. 60s is plenty (down from 300s; the long fal.ai poll
// moved to the Fly.io worker). Keeping nodejs runtime: the JWT-scoped
// attachment permission check uses the Node↔Web adapter below.
export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

/** Bounded retry budget for optimistic-concurrency version conflicts. */
const MAX_SAVE_ATTEMPTS = 6;

interface RequestBody {
  record_id?: string;
  prompt?: string;
  attachment_urls?: string[];
  attachment_sources?: Array<'user' | 'preset' | 'snippet'>;
  aspect_ratio?: string;
  num_variations?: number;
  preset_id?: string | null;
  model_id?: string;
  prev_image_url?: string | null;
}

interface MessageImage {
  url: string;
  name?: string;
  source?: 'user' | 'preset' | 'snippet' | 'assistant';
  /** Promote-on-add cache (Part 5) — set by the SPA, carried through here. */
  file_id?: string;
}

/** Keep in sync with StoredMessage in src/lib/imageChat/client.ts. */
interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  images: MessageImage[];
  aspect_ratio?: ChatAspectRatio;
  num_variations?: number;
  preset_id?: string | null;
  preset_name?: string | null;
  created_at: string;
  /** Assistant-only generation lifecycle. Absent ⇒ legacy completed. */
  status?: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled';
  job_id?: string;
  error?: string;
}

const ASPECTS: readonly ChatAspectRatio[] = ['1:1', '9:16', '16:9', '4:3', '3:4'];

function isAspectRatio(s: unknown): s is ChatAspectRatio {
  return typeof s === 'string' && (ASPECTS as readonly string[]).includes(s);
}

const CHAT_MODELS: readonly ChatModelId[] = ['nano-banana', 'gpt-image-2'];

function isChatModelId(s: unknown): s is ChatModelId {
  return typeof s === 'string' && (CHAT_MODELS as readonly string[]).includes(s);
}

/* ─── Node ↔ Web Request adapter (mirrors icons/generate.ts) ──────── */

async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBody(nodeReq);
  return new Request(url.toString(), { method, headers, body });
}

async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  const buf = Buffer.from(await webResp.arrayBuffer());
  nodeRes.end(buf);
}

/* ─── Marketing-assets URL helpers ────────────────────────────────── */

const BUCKET = 'marketing-assets';

function isMarketingAssetsUrl(s: string, supabaseUrl: string): boolean {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  return s.startsWith(supabaseUrl) && s.includes(marker);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isFileId(s: string): boolean {
  return UUID_RE.test(s);
}

function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    return parts[parts.length - 1] ?? 'image';
  } catch {
    return 'image';
  }
}

function extFromContentType(ct: string): string {
  const m = ct.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

/**
 * Normalize one attachment-list item into a marketing-assets public URL.
 * Accepts an already-valid marketing-assets URL (returned unchanged) or a bare
 * `files.id` UUID (preset/snippet image fields), which is permission-checked
 * under the caller's JWT then service-role copied out of the private
 * `wassel-files` bucket into marketing-assets so fal.ai can fetch a stable
 * public URL. Unchanged from the synchronous version.
 */
async function resolveAttachmentToMarketingUrl(
  raw: string,
  jwtClient: SupabaseClient,
  supabaseUrl: string,
  userId: string,
  recordId: string,
): Promise<string> {
  if (isMarketingAssetsUrl(raw, supabaseUrl)) return raw;
  if (!isFileId(raw)) {
    throw new Error(`attachment must be a marketing-assets URL or a files.id UUID: ${raw}`);
  }

  await assertCanAccessFile(jwtClient, raw, 'view');
  const file = await loadFileBypassRls(raw);
  if (!file) throw new Error(`file not found: ${raw}`);
  if (!file.mime_type.startsWith('image/')) {
    throw new Error(`file is not an image: ${file.original_name} (${file.mime_type})`);
  }

  const svc = getServiceClient();
  const { data: blob, error: dlErr } = await svc.storage
    .from(file.storage_bucket)
    .download(file.storage_path);
  if (dlErr || !blob) {
    throw new Error(`download from ${file.storage_bucket} failed: ${dlErr?.message ?? 'no body'}`);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const contentType = file.mime_type || 'image/png';
  const ext = extFromContentType(contentType);
  const path = `image-chats/preset-copies/${userId}/${recordId}/${crypto.randomUUID()}.${ext}`;

  const { error: upErr } = await jwtClient.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType, upsert: false });
  if (upErr) throw new Error(`re-host to ${BUCKET} failed: ${upErr.message}`);

  const { data: pub } = jwtClient.storage.from(BUCKET).getPublicUrl(path);
  const publicUrl = pub?.publicUrl;
  if (!publicUrl) throw new Error('re-host succeeded but public URL not resolved');
  return publicUrl;
}

/* ─── Record helpers ──────────────────────────────────────────────── */

async function readImageChatsModelId(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase
    .from('models')
    .select('id')
    .eq('name', 'image_chats')
    .single();
  if (error || !data) {
    throw new Error(`image_chats model not found: ${error?.message ?? 'unknown'}`);
  }
  return data.id as string;
}

function isVersionConflict(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === '40001' || /version_mismatch/i.test(err.message ?? '');
}

/**
 * Read-transform-save the record via record_save with optimistic concurrency.
 * The `build` callback receives the CURRENT data and returns the new data. On
 * a version-mismatch (40001) — meaning another rapid send or the worker's
 * fill-in bumped the row — we re-read and re-apply onto the latest state, so
 * no concurrent turn is clobbered. Runs under the caller's JWT (RLS-correct).
 */
async function mutateRecordWithRetry(
  jwtClient: SupabaseClient,
  modelId: string,
  recordId: string,
  build: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
    const { data: current, error: readErr } = await jwtClient
      .from('records')
      .select('data, version, created_by_user_id')
      .eq('id', recordId)
      .single();
    if (readErr || !current) {
      throw new Error(`failed to read image_chats record: ${readErr?.message ?? 'not found'}`);
    }
    const data = ((current.data as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    const newData = build(data);
    const { error: saveErr } = await jwtClient.rpc('record_save', {
      p_model_id: modelId,
      p_id: recordId,
      p_data: newData,
      p_created_by:
        (current as { created_by_user_id: string | null }).created_by_user_id ?? null,
      p_expected_version: (current as { version: number | null }).version ?? null,
    });
    if (!saveErr) return;
    if (isVersionConflict(saveErr as { code?: string; message?: string })) continue;
    throw new Error(`record_save failed: ${saveErr.message}`);
  }
  throw new Error(
    `record_save failed after ${MAX_SAVE_ATTEMPTS} version-conflict retries`,
  );
}

/* ─── Main handler ─────────────────────────────────────────────────── */

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const req = await nodeToWebRequest(nodeReq);
  const resp = await withAuth(req, async (user) => {
    if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const recordId = body.record_id?.trim();
    if (!recordId) return jsonError(400, 'record_id is required');
    const userPrompt = (body.prompt ?? '').toString();
    const attachmentUrls = Array.isArray(body.attachment_urls)
      ? body.attachment_urls.filter((s) => typeof s === 'string' && s.length > 0)
      : [];
    const aspectRatio: ChatAspectRatio = isAspectRatio(body.aspect_ratio) ? body.aspect_ratio : '1:1';
    const numVariations = Math.max(1, Math.min(4, Number(body.num_variations) || 1));
    const presetId = body.preset_id && typeof body.preset_id === 'string' ? body.preset_id : null;
    const modelId: ChatModelId = isChatModelId(body.model_id) ? body.model_id : 'nano-banana';
    const prevImageUrl =
      body.prev_image_url && typeof body.prev_image_url === 'string' ? body.prev_image_url : null;

    if (userPrompt.trim().length === 0 && attachmentUrls.length === 0 && !prevImageUrl) {
      return jsonError(400, 'prompt, attachment_urls, or prev_image_url is required');
    }
    if (userPrompt.length > 4000) {
      return jsonError(400, 'prompt is too long (max 4000 chars)');
    }

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    const auth = req.headers.get('Authorization') ?? '';
    const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!supabaseUrl || !anonKey || !jwt) {
      return jsonError(500, 'Supabase env vars missing or JWT absent');
    }
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    // ── Resolve attachments → stable marketing-assets URLs (JWT-scoped) ──
    let resolvedAttachmentUrls: string[];
    let resolvedPrevImageUrl: string | null;
    try {
      resolvedAttachmentUrls = await Promise.all(
        attachmentUrls.map((u) =>
          resolveAttachmentToMarketingUrl(u, supabase, supabaseUrl, user.userId, recordId),
        ),
      );
      resolvedPrevImageUrl = prevImageUrl
        ? await resolveAttachmentToMarketingUrl(prevImageUrl, supabase, supabaseUrl, user.userId, recordId)
        : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(400, `attachment resolution failed: ${msg}`);
    }

    // ── Resolve model + verify the record exists & is readable ───────────
    const imageChatsModelId = await readImageChatsModelId(supabase).catch((err: Error) => err);
    if (imageChatsModelId instanceof Error) {
      return jsonError(500, imageChatsModelId.message);
    }

    const { data: chatRecord, error: chatErr } = await supabase
      .from('records')
      .select('id')
      .eq('id', recordId)
      .eq('model_id', imageChatsModelId)
      .single();
    if (chatErr || !chatRecord) {
      return jsonError(404, `image_chats record not found: ${chatErr?.message ?? recordId}`);
    }

    // ── Resolve brand preset (prompt_text + name only) ───────────────────
    let presetPromptText = '';
    let presetName: string | null = null;
    if (presetId) {
      const { data: presetModel, error: pmErr } = await supabase
        .from('models')
        .select('id')
        .eq('name', 'image_presets')
        .single();
      if (pmErr || !presetModel) {
        return jsonError(500, `image_presets model not found: ${pmErr?.message ?? ''}`);
      }
      const { data: presetRow, error: pErr } = await supabase
        .from('records')
        .select('data')
        .eq('id', presetId)
        .eq('model_id', presetModel.id as string)
        .single();
      if (pErr || !presetRow) {
        return jsonError(400, `preset not found: ${presetId}`);
      }
      const pd = (presetRow as { data: Record<string, unknown> }).data;
      presetPromptText = (pd.prompt_text as string | undefined)?.trim() ?? '';
      presetName = (pd.name as string | undefined) ?? null;
    }

    // ── Build merged prompt + image source labels ────────────────────────
    const finalPrompt = presetPromptText
      ? `${presetPromptText}\n\n${userPrompt}`.trim()
      : userPrompt.trim();

    const rawSources = body.attachment_sources;
    const attachmentSources: Array<'user' | 'preset' | 'snippet'> =
      Array.isArray(rawSources) && rawSources.length === resolvedAttachmentUrls.length
        ? rawSources.map((s) => (s === 'preset' || s === 'snippet' ? s : 'user'))
        : resolvedAttachmentUrls.map(() => 'user' as const);

    // ── Build the user message + assistant placeholder ───────────────────
    const jobId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const userMessage: StoredMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: userPrompt.trim() || undefined,
      images: resolvedAttachmentUrls.map<MessageImage>((url, i) => ({
        url,
        name: basenameFromUrl(url),
        source: attachmentSources[i] ?? 'user',
      })),
      aspect_ratio: aspectRatio,
      num_variations: numVariations,
      preset_id: presetId,
      preset_name: presetName,
      created_at: nowIso,
    };

    const placeholder: StoredMessage = {
      id: assistantId,
      role: 'assistant',
      images: [],
      aspect_ratio: aspectRatio,
      num_variations: numVariations,
      preset_id: presetId,
      preset_name: presetName,
      created_at: nowIso,
      status: 'queued',
      job_id: jobId,
    };

    // ── Append both messages (server-side, optimistic concurrency) ───────
    try {
      await mutateRecordWithRetry(supabase, imageChatsModelId, recordId, (data) => {
        const existing: StoredMessage[] = Array.isArray(data.messages)
          ? (data.messages as StoredMessage[])
          : [];
        const isFirst = existing.length === 0;
        const messages = [...existing, userMessage, placeholder];
        return {
          ...data,
          messages,
          message_count: messages.length,
          last_message_at: nowIso,
          last_aspect_ratio: aspectRatio,
          last_preset_id: presetId,
          last_model: modelId,
          // Legacy conversation-level rollup — kept for back-compat; the UI now
          // derives "generating" from per-message status.
          status: 'generating',
          error_message: null,
          ...(isFirst ? { title: userPrompt.trim().slice(0, 60) || 'New design' } : {}),
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(500, `failed to append message: ${msg}`);
    }

    // ── Enqueue the generation job (service-role; RLS blocks user inserts) ─
    const svc = getServiceClient();
    const { error: insErr } = await svc.from('generation_jobs').insert({
      id: jobId,
      record_id: recordId,
      message_id: assistantId,
      user_id: user.userId,
      kind: 'image',
      status: 'queued',
      prompt: finalPrompt,
      params: {
        aspect_ratio: aspectRatio,
        num_variations: numVariations,
        model_id: modelId,
        attachments: resolvedAttachmentUrls.map((url, i) => ({
          url,
          source: attachmentSources[i] ?? 'user',
        })),
        prev_image_url: resolvedPrevImageUrl,
        preset_id: presetId,
        preset_name: presetName,
      },
    });
    if (insErr) {
      // The placeholder is already in the record showing "queued" but no job
      // will ever run it — flip it to failed so the bubble doesn't hang
      // (the watchdog only sweeps 'running' jobs). Best-effort.
      await mutateRecordWithRetry(supabase, imageChatsModelId, recordId, (data) => {
        const msgs: StoredMessage[] = Array.isArray(data.messages)
          ? (data.messages as StoredMessage[])
          : [];
        return {
          ...data,
          messages: msgs.map((m) =>
            m.id === assistantId
              ? { ...m, status: 'failed', error: `could not enqueue generation: ${insErr.message}` }
              : m,
          ),
        };
      }).catch(() => undefined);
      return jsonError(500, `failed to enqueue image job: ${insErr.message}`);
    }
    console.log(`[image-chat/send] queued job=${jobId} record=${recordId} msg=${assistantId}`);

    // ── Best-effort wake ping (worker polls every ~3s regardless) ────────
    const workerUrl = process.env.WASSEL_DECK_WORKER_URL;
    if (workerUrl) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        await fetch(`${workerUrl.replace(/\/$/, '')}/wake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job_id: jobId, kind: 'image' }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
      } catch (err) {
        console.warn(`[image-chat/send] wake ping failed (non-fatal): ${(err as Error).message}`);
      }
    }

    return jsonOk({ job_id: jobId, message_id: assistantId, status: 'queued' }, 202);
  });
  await writeWebResponseToNode(resp, nodeRes);
}
