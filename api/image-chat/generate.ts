/**
 * POST /api/image-chat/generate  (Image Chats v3 — Creative Workspace)
 *
 * Enqueues one Generation in a Creative Session. The v3 twin of
 * /api/image-chat/send: instead of appending a chat user+assistant message
 * pair, it appends ONE Generation (status='queued') to records.data.generations
 * and inserts a generation_jobs row carrying `generation_id`. The dual-path Fly
 * worker (worker/src/runImageJob.ts) then creates a first-class `media_assets`
 * row per output and fills the Generation. Results stream to the SPA via
 * Realtime on the session record.
 *
 * Body: {
 *   session_id, prompt,
 *   reference_urls: string[],        // ad-hoc uploads (marketing-assets URLs / files.id)
 *   reference_asset_ids: string[],   // media_assets used as references ("Use as Reference")
 *   preset_id, model_id, aspect_ratio, num_variations, based_on
 * }
 *
 * References are resolved to stable marketing-assets public URLs HERE (under
 * the caller's JWT): media_asset ids → their public_url (RLS-scoped to the
 * owner); upload refs → pass-through or files.id copy (same as v2). The worker
 * just forwards the resolved URLs to fal.ai.
 *
 * Loud failures only (CLAUDE.md): 401 (auth), 400 (validation/resolution),
 * 404 (session), 500 (append/enqueue).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { recordSaveWithRetry } from '../_lib/recordSaveRetry.js';
import {
  assertCanAccessFile,
  getServiceClient,
  loadFileBypassRls,
} from '../_lib/files.js';
import type { ChatAspectRatio, ChatModelId } from '../_lib/imageGen.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const BUCKET = 'marketing-assets';

interface RequestBody {
  session_id?: string;
  prompt?: string;
  reference_urls?: string[];
  reference_asset_ids?: string[];
  preset_id?: string | null;
  model_id?: string;
  aspect_ratio?: string;
  num_variations?: number;
  based_on?: string | null;
}

interface Generation {
  id: string;
  prompt: string;
  reference_asset_ids: string[];
  reference_urls: string[];
  preset_id: string | null;
  preset_name: string | null;
  model_id: ChatModelId;
  aspect_ratio: ChatAspectRatio;
  num_variations: number;
  based_on: string | null;
  status: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled';
  job_id: string;
  error?: string;
  output_asset_ids: string[];
  created_at: string;
}

const ASPECTS: readonly ChatAspectRatio[] = ['1:1', '9:16', '16:9', '4:3', '3:4'];
const CHAT_MODELS: readonly ChatModelId[] = ['nano-banana', 'gpt-image-2'];
const isAspectRatio = (s: unknown): s is ChatAspectRatio =>
  typeof s === 'string' && (ASPECTS as readonly string[]).includes(s);
const isChatModelId = (s: unknown): s is ChatModelId =>
  typeof s === 'string' && (CHAT_MODELS as readonly string[]).includes(s);

/* ─── Node ↔ Web Request adapter ───────────────────────────────────── */
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
  nodeRes.end(Buffer.from(await webResp.arrayBuffer()));
}

/* ─── Reference resolution (→ stable marketing-assets URLs) ─────────── */
function isMarketingAssetsUrl(s: string, supabaseUrl: string): boolean {
  return s.startsWith(supabaseUrl) && s.includes(`/storage/v1/object/public/${BUCKET}/`);
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function extFromContentType(ct: string): string {
  const m = ct.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}
/** Upload ref → marketing-assets URL (pass-through or files.id copy). */
async function resolveUploadRef(
  raw: string,
  jwtClient: SupabaseClient,
  supabaseUrl: string,
  userId: string,
  sessionId: string,
): Promise<string> {
  if (isMarketingAssetsUrl(raw, supabaseUrl)) return raw;
  if (!UUID_RE.test(raw)) throw new Error(`reference must be a marketing-assets URL or files.id: ${raw}`);
  await assertCanAccessFile(jwtClient, raw, 'view');
  const file = await loadFileBypassRls(raw);
  if (!file) throw new Error(`file not found: ${raw}`);
  if (!file.mime_type.startsWith('image/')) throw new Error(`file is not an image: ${file.original_name}`);
  const svc = getServiceClient();
  const { data: blob, error: dlErr } = await svc.storage.from(file.storage_bucket).download(file.storage_path);
  if (dlErr || !blob) throw new Error(`download failed: ${dlErr?.message ?? 'no body'}`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const contentType = file.mime_type || 'image/png';
  const path = `image-chats/preset-copies/${userId}/${sessionId}/${crypto.randomUUID()}.${extFromContentType(contentType)}`;
  const { error: upErr } = await jwtClient.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: false });
  if (upErr) throw new Error(`re-host failed: ${upErr.message}`);
  const { data: pub } = jwtClient.storage.from(BUCKET).getPublicUrl(path);
  if (!pub?.publicUrl) throw new Error('re-host succeeded but no public URL');
  return pub.publicUrl;
}

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

    const sessionId = body.session_id?.trim();
    if (!sessionId) return jsonError(400, 'session_id is required');
    const userPrompt = (body.prompt ?? '').toString();
    const referenceUrls = Array.isArray(body.reference_urls)
      ? body.reference_urls.filter((s) => typeof s === 'string' && s.length > 0)
      : [];
    const referenceAssetIds = Array.isArray(body.reference_asset_ids)
      ? body.reference_asset_ids.filter((s) => typeof s === 'string' && UUID_RE.test(s))
      : [];
    const aspectRatio: ChatAspectRatio = isAspectRatio(body.aspect_ratio) ? body.aspect_ratio : '1:1';
    const numVariations = Math.max(1, Math.min(4, Number(body.num_variations) || 1));
    const presetId = body.preset_id && typeof body.preset_id === 'string' ? body.preset_id : null;
    const modelId: ChatModelId = isChatModelId(body.model_id) ? body.model_id : 'nano-banana';
    const basedOn = body.based_on && typeof body.based_on === 'string' ? body.based_on : null;
    if (userPrompt.trim().length === 0 && referenceUrls.length === 0 && referenceAssetIds.length === 0) {
      return jsonError(400, 'prompt or a reference is required');
    }
    if (userPrompt.length > 4000) return jsonError(400, 'prompt is too long (max 4000 chars)');

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    const auth = req.headers.get('Authorization') ?? '';
    const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!supabaseUrl || !anonKey || !jwt) return jsonError(500, 'Supabase env vars missing or JWT absent');
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    // ── Resolve references → stable marketing-assets URLs ────────────────
    let resolvedRefs: string[];
    try {
      // media_asset references (RLS owner-scoped) → their public_url
      let assetUrls: string[] = [];
      if (referenceAssetIds.length > 0) {
        const { data: assets, error: aErr } = await supabase
          .from('media_assets')
          .select('id, public_url')
          .in('id', referenceAssetIds);
        if (aErr) throw new Error(`media_asset lookup failed: ${aErr.message}`);
        const byId = new Map((assets ?? []).map((a) => [a.id as string, a.public_url as string]));
        assetUrls = referenceAssetIds.map((id) => byId.get(id)).filter((u): u is string => !!u);
      }
      const uploadUrls = await Promise.all(
        referenceUrls.map((u) => resolveUploadRef(u, supabase, supabaseUrl, user.userId, sessionId)),
      );
      resolvedRefs = [...assetUrls, ...uploadUrls];
    } catch (err) {
      return jsonError(400, `reference resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Resolve image_chats model id + verify session is readable ────────
    const { data: modelRow, error: modelErr } = await supabase
      .from('models').select('id').eq('name', 'image_chats').single();
    if (modelErr || !modelRow) return jsonError(500, `image_chats model not found: ${modelErr?.message ?? ''}`);
    const imageChatsModelId = modelRow.id as string;
    const { data: sessionRow, error: sErr } = await supabase
      .from('records').select('id').eq('id', sessionId).eq('model_id', imageChatsModelId).single();
    if (sErr || !sessionRow) return jsonError(404, `session not found: ${sErr?.message ?? sessionId}`);

    // ── Resolve preset (prompt_text + name) ──────────────────────────────
    let presetPromptText = '';
    let presetName: string | null = null;
    if (presetId) {
      const { data: pm } = await supabase.from('models').select('id').eq('name', 'image_presets').single();
      if (pm) {
        const { data: presetRow } = await supabase
          .from('records').select('data').eq('id', presetId).eq('model_id', pm.id as string).single();
        const pd = (presetRow as { data?: Record<string, unknown> } | null)?.data;
        if (pd) {
          presetPromptText = (pd.prompt_text as string | undefined)?.trim() ?? '';
          presetName = (pd.name as string | undefined) ?? null;
        }
      }
    }
    const finalPrompt = presetPromptText ? `${presetPromptText}\n\n${userPrompt}`.trim() : userPrompt.trim();

    // ── Build the Generation + append it (optimistic concurrency) ────────
    const jobId = crypto.randomUUID();
    const generationId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const generation: Generation = {
      id: generationId,
      prompt: userPrompt.trim(),
      reference_asset_ids: referenceAssetIds,
      reference_urls: resolvedRefs,
      preset_id: presetId,
      preset_name: presetName,
      model_id: modelId,
      aspect_ratio: aspectRatio,
      num_variations: numVariations,
      based_on: basedOn,
      status: 'queued',
      job_id: jobId,
      output_asset_ids: [],
      created_at: nowIso,
    };

    try {
      await recordSaveWithRetry(supabase, {
        recordId: sessionId,
        build: (data) => {
          const existing = Array.isArray(data.generations) ? (data.generations as Generation[]) : [];
          return {
            ...data,
            generations: [...existing, generation],
            generation_count: existing.length + 1,
            last_generation_at: nowIso,
            last_aspect_ratio: aspectRatio,
            last_preset_id: presetId,
            last_model: modelId,
            ...(existing.length === 0 && userPrompt.trim()
              ? { title: userPrompt.trim().slice(0, 60) }
              : {}),
          };
        },
      });
    } catch (err) {
      return jsonError(500, `failed to append generation: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Enqueue the job (service-role; RLS blocks user inserts) ──────────
    const svc = getServiceClient();
    const { error: insErr } = await svc.from('generation_jobs').insert({
      id: jobId,
      record_id: sessionId,
      message_id: null,
      generation_id: generationId,
      user_id: user.userId,
      kind: 'image',
      status: 'queued',
      prompt: finalPrompt,
      params: {
        aspect_ratio: aspectRatio,
        num_variations: numVariations,
        model_id: modelId,
        attachments: resolvedRefs.map((url) => ({ url, source: 'user' })),
        prev_image_url: null,
      },
    });
    if (insErr) {
      // Flip the generation to failed so it doesn't hang on "queued".
      await failGeneration(supabase, imageChatsModelId, sessionId, generationId, insErr.message).catch(() => undefined);
      return jsonError(500, `failed to enqueue generation job: ${insErr.message}`);
    }
    console.log(`[image-chat/generate] queued job=${jobId} session=${sessionId} gen=${generationId}`);

    // ── Best-effort wake ────────────────────────────────────────────────
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
        console.warn(`[image-chat/generate] wake failed (non-fatal): ${(err as Error).message}`);
      }
    }

    return jsonOk({ job_id: jobId, generation_id: generationId, status: 'queued' }, 202);
  });
  await writeWebResponseToNode(resp, nodeRes);
}

/** Best-effort: mark a generation failed (optimistic concurrency). */
async function failGeneration(
  supabase: SupabaseClient,
  _modelId: string,
  sessionId: string,
  generationId: string,
  message: string,
): Promise<void> {
  // Best-effort: mark the generation failed under the standard retry contract.
  // Swallow any terminal error (conflict_storm_blocked / record gone) — this is
  // cleanup and must NEVER throw into the caller.
  try {
    await recordSaveWithRetry(supabase, {
      recordId: sessionId,
      build: (data) => {
        const gens = Array.isArray(data.generations) ? (data.generations as Generation[]) : [];
        return {
          ...data,
          generations: gens.map((g) =>
            g.id === generationId
              ? { ...g, status: 'failed' as const, error: `could not enqueue: ${message}` }
              : g,
          ),
        };
      },
    });
  } catch {
    /* best-effort cleanup — never throw */
  }
}
