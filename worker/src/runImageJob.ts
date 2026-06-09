/**
 * runImageJob — fills one Generation (Image Chats v3) or, for legacy jobs, one
 * chat message (v2). Ported from the synchronous api/image-chat/send.ts (the
 * fal.ai call + the output re-host loop).
 *
 * DUAL PATH (cutover safety):
 *   - v3 job (job.generationId set): create a `media_assets` row per output
 *     (first-class library asset) and fill the Generation in
 *     records.data.generations[*] (status + output_asset_ids).
 *   - v2 job (job.messageId set, no generationId): fill the assistant message
 *     in records.data.messages[*] (status + images) — unchanged behavior.
 * The shared middle (resolve model, params, cancel checks, fal call, re-host)
 * is identical; only the terminal write differs. This lets the worker deploy
 * before the endpoint/UI cut over to generations.
 *
 *   1. Resolve image_chats model id.
 *   2. Stamp the target (message|generation) status='generating' (Realtime →
 *      per-item spinner).
 *   3. Cancel pre-check.
 *   4. fal.ai (imageGenChat → pollImageGen). No per-request cap; the 15-min
 *      generation_jobs_watchdog is the backstop.
 *   5. Cancel post-check.
 *   6. Re-host each fal output to marketing-assets/image-chats/outputs/... .
 *   7. v3: insert media_assets + fill the Generation. v2: fill the message.
 *
 * Errors bubble to index.ts (marks the job failed); we write status='failed' +
 * a humanized error onto the target FIRST so its spinner exits (NOT the whole
 * session/conversation — siblings + composer stay live).
 *
 * Concurrency (CRITICAL): sessions/conversations have a SHARED data array
 * (generations|messages) and the user can fire a new turn while this fills an
 * earlier one. Every write uses OPTIMISTIC CONCURRENCY via record_save's
 * p_expected_version + retry on the version-mismatch (40001); the
 * records_bump_version trigger increments `version` per UPDATE, so a stale
 * writer is bounced and re-applies onto the latest array. Safe at any worker
 * count.
 *
 * Auth: service-role client (bypasses RLS). Ownership was validated by
 * api/image-chat/send.ts before enqueue; job.userId scopes storage + assets.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import {
  imageGenChat,
  pollImageGen,
  type ChatAspectRatio,
  type ChatModelId,
} from './imageGen.js';

/** Shape of a claimed generation_jobs row (kind='image'). */
export interface ImageJob {
  /** generation_jobs.id */
  id: string;
  /** records.id — the session / conversation. */
  recordId: string;
  /** v2: records.data.messages[*].id this job fills (null for v3 jobs). */
  messageId: string | null;
  /** v3: records.data.generations[*].id this job fills (null for v2 jobs). */
  generationId: string | null;
  /** auth.users.id of the submitter (scopes the output storage path + assets). */
  userId: string;
  kind: string;
  /** Final merged prompt (brand-preset text + user prompt). */
  prompt: string | null;
  /** Frozen request snapshot — see JobParams. */
  params: Record<string, unknown>;
  attempts: number;
}

interface JobParams {
  aspect_ratio?: string;
  num_variations?: number;
  model_id?: string;
  attachments?: Array<{ url?: string; source?: string }>;
  prev_image_url?: string | null;
  preset_id?: string | null;
  preset_name?: string | null;
}

/** A record array item we patch (message or generation) — only `id` + `status`
 *  + the per-path fields matter to the patch helper. */
interface RecordArrayItem {
  id: string;
  [k: string]: unknown;
}

const BUCKET = 'marketing-assets';
const POLL_TIMEOUT_MS = 13 * 60_000;
const POLL_INTERVAL_MS = 2500;
const MAX_SAVE_ATTEMPTS = 6;

const ASPECTS: readonly ChatAspectRatio[] = ['1:1', '9:16', '16:9', '4:3', '3:4'];
const CHAT_MODELS: readonly ChatModelId[] = ['nano-banana', 'gpt-image-2'];

function isVersionConflict(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === '40001' || /version_mismatch/i.test(err.message ?? '');
}

interface RunArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: ImageJob;
}

interface RehostedOutput {
  publicUrl: string;
  storagePath: string;
  contentType: string;
  ext: string;
}

export async function runImageJob({ supabase, job }: RunArgs): Promise<Record<string, unknown>> {
  const isV3 = !!job.generationId;
  const targetKey: 'generations' | 'messages' = isV3 ? 'generations' : 'messages';
  const targetId = isV3 ? job.generationId! : job.messageId;
  if (!targetId) {
    throw new Error(`job ${job.id} has neither generationId nor messageId — cannot run`);
  }

  // ── Resolve image_chats model id ────────────────────────────────────
  const { data: modelRow, error: modelErr } = await supabase
    .from('models')
    .select('id')
    .eq('name', 'image_chats')
    .single();
  if (modelErr || !modelRow) {
    throw new Error(`image_chats model not found: ${modelErr?.message ?? 'unknown'}`);
  }
  const modelId = modelRow.id as string;

  // ── Patch ONE item in records.data[targetKey] (optimistic concurrency) ─
  // Reads (data, version, created_by) → merges `patch` into the item with the
  // matching id → record_save with p_expected_version. Retries on 40001 by
  // re-reading the latest array. Preserves created_by_user_id.
  const patchTarget = async (
    patch: Record<string, unknown>,
    extraRecordFields: Record<string, unknown> = {},
  ): Promise<void> => {
    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
      const { data: current, error: readErr } = await supabase
        .from('records')
        .select('data, version, created_by_user_id')
        .eq('id', job.recordId)
        .single();
      if (readErr || !current) {
        throw new Error(
          `failed to read session record ${job.recordId}: ${readErr?.message ?? 'not found'}`,
        );
      }
      const data = ((current.data as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      const arr: RecordArrayItem[] = Array.isArray(data[targetKey])
        ? (data[targetKey] as RecordArrayItem[])
        : [];
      let found = false;
      const newArr = arr.map((it) => {
        if (it.id === targetId) {
          found = true;
          return { ...it, ...patch };
        }
        return it;
      });
      if (!found) {
        // The session (or this item) is gone — e.g. deleted mid-run. Abort
        // loudly; never silently no-op (CLAUDE.md).
        throw new Error(
          `${targetKey} item ${targetId} not present in record ${job.recordId} — aborting`,
        );
      }
      const newData = { ...data, [targetKey]: newArr, ...extraRecordFields };
      const { error: saveErr } = await supabase.rpc('record_save', {
        p_model_id: modelId,
        p_id: job.recordId,
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
      `record_save failed after ${MAX_SAVE_ATTEMPTS} version-conflict retries (record ${job.recordId})`,
    );
  };

  // ── Parse frozen params (shared) ─────────────────────────────────────
  const params = (job.params ?? {}) as JobParams;
  const aspectRatio: ChatAspectRatio = ASPECTS.includes(params.aspect_ratio as ChatAspectRatio)
    ? (params.aspect_ratio as ChatAspectRatio)
    : '1:1';
  const numVariations = Math.max(1, Math.min(4, Number(params.num_variations) || 1));
  const modelIdChat: ChatModelId = CHAT_MODELS.includes(params.model_id as ChatModelId)
    ? (params.model_id as ChatModelId)
    : 'nano-banana';
  const attachmentUrls = Array.isArray(params.attachments)
    ? params.attachments
        .map((a) => a?.url)
        .filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];
  const prevImageUrl =
    typeof params.prev_image_url === 'string' && params.prev_image_url.length > 0
      ? params.prev_image_url
      : null;
  const mergedImageUrls = [...attachmentUrls, ...(prevImageUrl ? [prevImageUrl] : [])];

  const isCancelled = async (): Promise<boolean> => {
    const { data } = await supabase
      .from('generation_jobs')
      .select('status')
      .eq('id', job.id)
      .single();
    return (data?.status as string | undefined) === 'cancelled';
  };

  // ── Stamp generating ─────────────────────────────────────────────────
  await patchTarget({ status: 'generating' });
  console.log(
    `[run-image] generating job=${job.id} record=${job.recordId} ${targetKey.slice(0, -1)}=${targetId}`,
  );

  // ── Cancel pre-check ─────────────────────────────────────────────────
  if (await isCancelled()) {
    await patchTarget({ status: 'cancelled' });
    console.log(`[run-image] cancelled-before-start job=${job.id}`);
    return { cancelled: true };
  }

  // ── fal.ai turn ──────────────────────────────────────────────────────
  let outputUrls: string[];
  try {
    const start = await imageGenChat({
      prompt: job.prompt && job.prompt.trim() ? job.prompt : 'Edit the attached image.',
      imageUrls: mergedImageUrls,
      aspectRatio,
      numVariations,
      modelId: modelIdChat,
    });
    const result = await pollImageGen(start, {
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
    });
    if (result.status !== 'completed' || !result.imageUrls || result.imageUrls.length === 0) {
      const detail = result.rawError ? `: ${result.rawError}` : '';
      throw new Error(`image generation ${result.status}${detail}`);
    }
    outputUrls = result.imageUrls;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    await patchTarget({ status: 'failed', error: humanizeImageError(raw) }).catch((e) =>
      console.error(`[run-image] could not mark target failed: ${(e as Error).message}`),
    );
    throw err;
  }

  // ── Cancel post-check ────────────────────────────────────────────────
  if (await isCancelled()) {
    await patchTarget({ status: 'cancelled' });
    console.log(`[run-image] cancelled-after-generate job=${job.id}`);
    return { cancelled: true };
  }

  // ── Re-host outputs to marketing-assets (service-role, public bucket) ─
  const outputs: RehostedOutput[] = [];
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
      const msg = `output fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      await patchTarget({ status: 'failed', error: msg }).catch(() => undefined);
      throw new Error(msg);
    }
    const ext = contentType.includes('jpeg')
      ? 'jpg'
      : contentType.includes('webp')
        ? 'webp'
        : 'png';
    const storagePath = `image-chats/outputs/${job.userId}/${job.recordId}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, bytes, { contentType, upsert: false });
    if (upErr) {
      const msg = `output upload failed: ${upErr.message}`;
      await patchTarget({ status: 'failed', error: msg }).catch(() => undefined);
      throw new Error(msg);
    }
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    const publicUrl = pub?.publicUrl;
    if (!publicUrl) {
      const msg = 'output uploaded but public URL not resolved';
      await patchTarget({ status: 'failed', error: msg }).catch(() => undefined);
      throw new Error(msg);
    }
    outputs.push({ publicUrl, storagePath, contentType, ext });
  }

  // ── Terminal write — v3 (media_assets + generation) or v2 (message) ──
  if (isV3) {
    // Insert one first-class media_assets row per output.
    const assetRows = outputs.map((o) => ({
      kind: 'image',
      storage_bucket: BUCKET,
      storage_path: o.storagePath,
      public_url: o.publicUrl,
      mime_type: o.contentType,
      prompt: job.prompt,
      model_id: modelIdChat,
      settings: { aspect_ratio: aspectRatio, num_variations: numVariations },
      source_session_id: job.recordId,
      source_generation_id: job.generationId,
      created_by_user_id: job.userId,
    }));
    const { data: insertedAssets, error: assetErr } = await supabase
      .from('media_assets')
      .insert(assetRows)
      .select('id');
    if (assetErr || !insertedAssets) {
      const msg = `media_assets insert failed: ${assetErr?.message ?? 'unknown'}`;
      await patchTarget({ status: 'failed', error: msg }).catch(() => undefined);
      throw new Error(msg);
    }
    const assetIds = insertedAssets.map((r) => r.id as string);
    await patchTarget(
      { status: 'completed', output_asset_ids: assetIds, error: null },
      {
        last_generation_at: new Date().toISOString(),
        // Session thumbnail = the latest generation's first output. We stamp
        // both the asset id (for linking) and the public_url (so the session
        // list renders a thumbnail without fetching media_assets).
        thumbnail_asset_id: assetIds[0] ?? null,
        thumbnail_url: outputs[0]?.publicUrl ?? null,
      },
    );
    console.log(
      `[run-image] completed v3 job=${job.id} assets=${assetIds.length} record=${job.recordId}`,
    );
    return { asset_ids: assetIds };
  }

  // v2 legacy: fill the assistant message with images.
  const persisted = outputs.map((o, i) => ({
    url: o.publicUrl,
    name: `variation-${i + 1}.${o.ext}`,
    source: 'assistant',
  }));
  await patchTarget(
    { status: 'completed', images: persisted },
    { last_message_at: new Date().toISOString(), status: 'idle', error_message: null },
  );
  console.log(
    `[run-image] completed v2 job=${job.id} variations=${persisted.length} record=${job.recordId}`,
  );
  return { images: persisted };
}

/**
 * Translate raw fal.ai / network errors into plain text for the per-item error
 * box. Preserves the original wording for debugging.
 */
function humanizeImageError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('nsfw') || lower.includes('content_policy') || lower.includes('content policy')) {
    return 'The image service flagged this prompt or image as disallowed content. Try rephrasing or using a different reference image.';
  }
  if (lower.includes('poll timed out')) {
    return 'The image took too long to generate and timed out. Please try again — GPT Image 2 can be slow under load.';
  }
  if (lower.includes('start failed (4') || lower.includes('start failed (5') || lower.includes('poll failed')) {
    return `The image service returned an error. Please try again in a moment.\n\n(${raw})`;
  }
  return `Image generation failed: ${raw}`;
}
