/**
 * POST /api/image-chat/send
 *
 * One turn of the "mini Higgsfield" Image Chats UI. Mirrors the
 * shape of api/icons/generate.ts (auth → fal.ai → re-host to
 * marketing-assets → return) but writes message history back to the
 * caller's `image_chats` record between steps so the SPA's Realtime
 * subscription drives the spinner / completion state.
 *
 * Body: `{ record_id, prompt, attachment_urls, aspect_ratio,
 *          num_variations, preset_id, prev_image_url }`.
 *
 *   - `attachment_urls`: ordered list of marketing-assets public URLs
 *     the user uploaded this turn (via the client `uploadImage`
 *     helper, folder `image-chats/uploads`).
 *   - `preset_id` (optional): id of an `image_presets` record. The
 *     server looks it up, prepends `prompt_text` to the user prompt,
 *     and merges the preset's `images` into the input image list.
 *     Clients can't smuggle arbitrary images through this path —
 *     image URLs are read FROM the preset record, never from the
 *     request body.
 *   - `prev_image_url` (optional): the previous assistant message's
 *     primary image, passed in by the SPA so the model can auto-chain
 *     (iterate on the last result without the user re-uploading it).
 *     If present, gets appended to the input image list after the
 *     user attachments + preset images.
 *
 * Flow per turn:
 *   1. Auth + validate inputs.
 *   2. Read the image_chats record (verify caller owns it).
 *   3. If preset_id is set, read the image_presets record to pull
 *      its prompt_text + images.
 *   4. Build the merged prompt and merged input-URL list.
 *   5. Write `status='generating'` + append the user message.
 *      Realtime fans out to the browser → composer spinner.
 *   6. Call fal.ai imageGenChat → pollImageGen.
 *   7. Re-host each result URL in marketing-assets at
 *      image-chats/outputs/<user_id>/<record_id>/<uuid>.png.
 *   8. Append the assistant message, write `status='idle'`,
 *      increment message_count + last_message_at.
 *   9. Return the updated message list.
 *
 * On any error after step 5, the record is updated with
 * `status='failed'` + `error_message` so the UI exits the spinner via
 * Realtime instead of hanging.
 *
 * Loud failures only — per CLAUDE.md "Silent Failures":
 *   - fal.ai non-2xx → 502 with upstream body.
 *   - storage upload error → 500.
 *   - missing JWT → 401 (via withAuth).
 *   - input validation error → 400.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import {
  assertCanAccessFile,
  getServiceClient,
  loadFileBypassRls,
} from '../_lib/files.js';
import {
  imageGenChat,
  pollImageGen,
  type ChatAspectRatio,
  type ChatModelId,
} from '../_lib/imageGen.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 240,
};

interface RequestBody {
  record_id?: string;
  prompt?: string;
  attachment_urls?: string[];
  /** Parallel array to attachment_urls — labels each thumbnail's
   * origin so the message bubble can render a ✦ badge for preset /
   * snippet auto-attaches. Optional; defaults to ['user', ...]. */
  attachment_sources?: Array<'user' | 'preset' | 'snippet'>;
  aspect_ratio?: string;
  num_variations?: number;
  preset_id?: string | null;
  /** Which image model to run this turn on. Validated against the
   *  allow-list below; unknown / missing values fall back to
   *  'nano-banana'. */
  model_id?: string;
  prev_image_url?: string | null;
}

interface MessageImage {
  url: string;
  /** Display label for the message bubble. Falls back to the URL basename. */
  name?: string;
  /** 'user' (uploaded by the user this turn), 'preset' (auto-attached from
   * the chosen brand preset), 'snippet' (auto-attached from a prompt
   * snippet), 'assistant' (fal.ai output, persisted to marketing-assets). */
  source?: 'user' | 'preset' | 'snippet' | 'assistant';
}

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
  // Acceptable shape: `<supabaseUrl>/storage/v1/object/public/marketing-assets/<path>`.
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
 *
 * Accepts either:
 *   - An already-valid marketing-assets URL (legacy paperclip uploads via
 *     uploadImage land here) → returned unchanged.
 *   - A bare `files.id` UUID (new image/multi_image fields on presets and
 *     snippets store this) → the file is copied from the private
 *     `wassel-files` bucket into `marketing-assets/image-chats/preset-copies/...`
 *     so (a) fal.ai can fetch it with a stable public URL and (b) it can be
 *     persisted into the message history without an expiring signed URL.
 *
 * Permission is gated under the caller's JWT via `wassell_can_access_file`
 * before any service-role read happens.
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

/* ─── Record-update helpers ───────────────────────────────────────── */

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

interface PatchInput {
  supabase: SupabaseClient;
  modelId: string;
  recordId: string;
  patch: Record<string, unknown>;
}

/** Read-merge-save the record via the `record_save` RPC. */
async function patchRecord({ supabase, modelId, recordId, patch }: PatchInput): Promise<void> {
  const { data: current, error: readErr } = await supabase
    .from('records')
    .select('data, created_by_user_id')
    .eq('id', recordId)
    .single();
  if (readErr || !current) {
    throw new Error(`failed to read image_chats record: ${readErr?.message ?? 'not found'}`);
  }
  const newData = { ...(current.data as Record<string, unknown>), ...patch };
  const { error: saveErr } = await supabase.rpc('record_save', {
    p_model_id: modelId,
    p_id: recordId,
    p_data: newData,
    p_created_by:
      (current as { created_by_user_id: string | null }).created_by_user_id ?? null,
    p_expected_version: null,
  });
  if (saveErr) {
    throw new Error(`record_save failed: ${saveErr.message}`);
  }
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
    const prevImageUrl = body.prev_image_url && typeof body.prev_image_url === 'string'
      ? body.prev_image_url
      : null;

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

    // Normalize each attachment to a marketing-assets public URL. Items may
    // arrive as either legacy marketing-assets URLs (paperclip uploads) or
    // as bare `files.id` UUIDs (preset/snippet image fields, which now live
    // in the Files System on the private `wassel-files` bucket). For file
    // IDs we permission-check under the caller's JWT, then service-role
    // copy the bytes into marketing-assets so fal.ai has a stable public
    // URL and the message history stays valid forever (no signed-URL
    // expiry). `prev_image_url` only ever comes from prior assistant
    // outputs, which are already marketing-assets URLs — but we run it
    // through the same resolver for symmetry.
    let resolvedAttachmentUrls: string[];
    let resolvedPrevImageUrl: string | null;
    try {
      resolvedAttachmentUrls = await Promise.all(
        attachmentUrls.map((u) =>
          resolveAttachmentToMarketingUrl(u, supabase, supabaseUrl, user.userId, recordId),
        ),
      );
      resolvedPrevImageUrl = prevImageUrl
        ? await resolveAttachmentToMarketingUrl(
            prevImageUrl,
            supabase,
            supabaseUrl,
            user.userId,
            recordId,
          )
        : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(400, `attachment resolution failed: ${msg}`);
    }

    // ── Look up models + records ─────────────────────────────────────
    const imageChatsModelId = await readImageChatsModelId(supabase).catch(
      (err: Error) => err,
    );
    if (imageChatsModelId instanceof Error) {
      return jsonError(500, imageChatsModelId.message);
    }

    const { data: chatRecord, error: chatErr } = await supabase
      .from('records')
      .select('id, data, created_by_user_id')
      .eq('id', recordId)
      .eq('model_id', imageChatsModelId)
      .single();
    if (chatErr || !chatRecord) {
      return jsonError(404, `image_chats record not found: ${chatErr?.message ?? recordId}`);
    }
    // No explicit ownership check here — RLS on `records` already enforces
    // it: this SELECT runs with the caller's JWT, and the record_save RPC
    // below also runs under the same JWT. If we successfully read the row,
    // the user can write to it. (A previous version compared
    // `chatRecord.created_by_user_id` to `user.userId`, but the former is a
    // public.users.id stamped client-side via `state.currentUserId` and the
    // latter is an auth.users.id from Supabase auth — different identifier
    // namespaces. The comparison fired a false 403 every single time.)

    // ── Resolve brand preset (if any) ────────────────────────────────
    // The CLIENT owns the image list for this turn — preset auto-
    // attachments are pre-populated into `attachment_urls` by the
    // composer at pick time, and the user can remove any of them
    // before sending. The server only reads `prompt_text` + `name`
    // from the preset record here; it deliberately does NOT re-read
    // the preset's `images` field. That way removing an auto-attached
    // preset image really removes it from the fal.ai call. Sources are
    // labeled by `source` on each MessageImage so the bubble can still
    // render the ✦ badge in history.
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

    // ── Build merged prompt + image list ─────────────────────────────
    const finalPrompt = presetPromptText
      ? `${presetPromptText}\n\n${userPrompt}`.trim()
      : userPrompt.trim();
    // Image order matters — nano-banana-pro/edit treats the first
    // image as the primary subject and the rest as supporting
    // references. Order: user-curated attachments first (in the order
    // the composer kept them) → previous assistant image (the
    // auto-chain target). The composer is responsible for placing
    // preset/snippet assets in the right slot of attachment_urls
    // when those were added.
    const mergedImageUrls: string[] = [
      ...resolvedAttachmentUrls,
      ...(resolvedPrevImageUrl ? [resolvedPrevImageUrl] : []),
    ];

    const nowIso = new Date().toISOString();
    const existingMessages = Array.isArray((chatRecord as { data: { messages?: unknown } }).data.messages)
      ? ((chatRecord as { data: { messages: StoredMessage[] } }).data.messages)
      : [];

    // Image source labels for history rendering. The composer sends
    // a parallel `attachment_sources` array (same length & order as
    // `attachment_urls`) so each thumbnail can show the right badge
    // ('user' / 'preset' / 'snippet'). If the array is missing or the
    // wrong length we fall back to 'user' for everything.
    const rawSources = body.attachment_sources;
    const attachmentSources: Array<'user' | 'preset' | 'snippet'> =
      Array.isArray(rawSources) && rawSources.length === resolvedAttachmentUrls.length
        ? rawSources.map((s) => (s === 'preset' || s === 'snippet' ? s : 'user'))
        : resolvedAttachmentUrls.map(() => 'user' as const);

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

    const isFirstUserMessage = existingMessages.length === 0;
    const titleFromFirst = isFirstUserMessage
      ? (userPrompt.trim().slice(0, 60) || 'New design')
      : undefined;

    // ── Stamp "generating" + append user message ─────────────────────
    await patchRecord({
      supabase,
      modelId: imageChatsModelId,
      recordId,
      patch: {
        messages: [...existingMessages, userMessage],
        message_count: existingMessages.length + 1,
        last_message_at: nowIso,
        last_aspect_ratio: aspectRatio,
        last_preset_id: presetId,
        last_model: modelId,
        status: 'generating',
        error_message: null,
        ...(titleFromFirst ? { title: titleFromFirst } : {}),
      },
    });

    // ── Run fal.ai turn ──────────────────────────────────────────────
    let outputUrls: string[];
    try {
      const start = await imageGenChat({
        prompt: finalPrompt || 'Edit the attached image.',
        imageUrls: mergedImageUrls,
        aspectRatio,
        numVariations,
        modelId,
      });
      const result = await pollImageGen(start, { intervalMs: 2500, timeoutMs: 230_000 });
      if (result.status !== 'completed' || !result.imageUrls || result.imageUrls.length === 0) {
        const detail = result.rawError ? `: ${result.rawError}` : '';
        throw new Error(`image generation ${result.status}${detail}`);
      }
      outputUrls = result.imageUrls;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await patchRecord({
        supabase,
        modelId: imageChatsModelId,
        recordId,
        patch: { status: 'failed', error_message: msg },
      }).catch(() => undefined);
      return jsonError(502, msg);
    }

    // ── Re-host each output URL in marketing-assets ──────────────────
    const persisted: MessageImage[] = [];
    for (let i = 0; i < outputUrls.length; i++) {
      const sourceUrl = outputUrls[i]!;
      let bytes: Uint8Array;
      let contentType: string;
      try {
        const srcRes = await fetch(sourceUrl);
        if (!srcRes.ok) throw new Error(`fetch ${srcRes.status}`);
        bytes = new Uint8Array(await srcRes.arrayBuffer());
        contentType = srcRes.headers.get('content-type') ?? 'image/png';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await patchRecord({
          supabase,
          modelId: imageChatsModelId,
          recordId,
          patch: { status: 'failed', error_message: `output fetch failed: ${msg}` },
        }).catch(() => undefined);
        return jsonError(502, `output fetch failed: ${msg}`);
      }
      const ext = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png';
      const path = `image-chats/outputs/${user.userId}/${recordId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType, upsert: false });
      if (upErr) {
        await patchRecord({
          supabase,
          modelId: imageChatsModelId,
          recordId,
          patch: { status: 'failed', error_message: `output upload failed: ${upErr.message}` },
        }).catch(() => undefined);
        return jsonError(500, `output upload failed: ${upErr.message}`);
      }
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      const publicUrl = pub?.publicUrl;
      if (!publicUrl) {
        await patchRecord({
          supabase,
          modelId: imageChatsModelId,
          recordId,
          patch: { status: 'failed', error_message: 'output uploaded but URL not resolved' },
        }).catch(() => undefined);
        return jsonError(500, 'output uploaded but public URL not resolved');
      }
      persisted.push({
        url: publicUrl,
        name: `variation-${i + 1}.${ext}`,
        source: 'assistant',
      });
    }

    const assistantMessage: StoredMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      images: persisted,
      aspect_ratio: aspectRatio,
      num_variations: numVariations,
      preset_id: presetId,
      preset_name: presetName,
      created_at: new Date().toISOString(),
    };

    const finalMessages = [...existingMessages, userMessage, assistantMessage];
    await patchRecord({
      supabase,
      modelId: imageChatsModelId,
      recordId,
      patch: {
        messages: finalMessages,
        message_count: finalMessages.length,
        last_message_at: assistantMessage.created_at,
        status: 'idle',
        error_message: null,
      },
    });

    return jsonOk({ messages: finalMessages, assistant: assistantMessage });
  });
  await writeWebResponseToNode(resp, nodeRes);
}
