/**
 * runImageJob — the per-message half of Image Chats v2 generation.
 *
 * Ported from the synchronous api/image-chat/send.ts (the fal.ai call + the
 * output re-host loop), restructured to fill ONE assistant placeholder message
 * inside an `image_chats` conversation rather than block a whole HTTP request.
 *
 *   1. Resolve the image_chats model id (one round-trip).
 *   2. Stamp the placeholder message status='generating' (SPA shows a
 *      per-message spinner via Realtime).
 *   3. Cancel pre-check — if the user already cancelled, bail before spending
 *      a fal.ai call.
 *   4. Submit to fal.ai (imageGenChat) and poll until terminal (pollImageGen).
 *      No per-request timeout cap — the 15-min generation_jobs_watchdog is the
 *      backstop. (This is the whole reason we moved off Vercel's 300s ceiling.)
 *   5. Cancel post-check — skip the re-host if the user cancelled mid-run.
 *   6. Re-host each fal output to marketing-assets/image-chats/outputs/... so
 *      the URLs are stable + public forever (fal URLs expire).
 *   7. Fill the placeholder: status='completed' + images. The SPA reconciles
 *      the whole record via Realtime and the bubble swaps spinner → grid.
 *
 * Errors bubble to index.ts which marks the generation_jobs row failed; we
 * write status='failed' + a humanized error onto the MESSAGE first so the
 * bubble exits its spinner (NOT the conversation — siblings + composer stay
 * live). Per CLAUDE.md "Silent Failures": never swallow; the message `error`
 * field IS the surfaced failure.
 *
 * Concurrency (CRITICAL): unlike decks (one record per job), image turns append
 * to a SHARED records.data.messages array, and the user can fire a new turn (a
 * new endpoint append) while this worker is filling an earlier message. So
 * every write here uses OPTIMISTIC CONCURRENCY through record_save's
 * p_expected_version + retry on the version-mismatch (SQLSTATE 40001). The
 * records_bump_version trigger increments `version` on each UPDATE, so a
 * stale-read writer is reliably bounced and re-applies onto the latest array
 * instead of clobbering a concurrently-appended turn.
 *
 * Auth model: service-role Supabase client (bypasses RLS). Ownership was
 * validated by api/image-chat/send.ts (under the caller's JWT) before the job
 * was enqueued; the job's user_id scopes the storage path.
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
  /** records.id — the image_chats conversation. */
  recordId: string;
  /** records.data.messages[*].id — the assistant placeholder this job fills. */
  messageId: string;
  /** auth.users.id of the submitter (scopes the output storage path). */
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

/** Keep in sync with MessageImage in src/lib/imageChat/client.ts. */
interface MessageImage {
  url: string;
  name?: string;
  source?: string;
  /** Promote-on-add cache (Image Chats v2 Part 5). Set by the SPA, not here;
   *  carried through so worker writes never drop it. */
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
  status?: 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled';
  job_id?: string;
  error?: string;
}

const BUCKET = 'marketing-assets';
/** No fal per-request cap — sit just under the 15-min watchdog. */
const POLL_TIMEOUT_MS = 13 * 60_000;
const POLL_INTERVAL_MS = 2500;
/** Bounded retry budget for optimistic-concurrency version conflicts. */
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

export async function runImageJob({ supabase, job }: RunArgs): Promise<Record<string, unknown>> {
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

  // ── Per-message update helper (optimistic concurrency + retry) ───────
  // Read (data, version, created_by) → patch ONLY the target message in
  // data.messages → record_save with p_expected_version=version. On a
  // version conflict (a concurrent turn appended meanwhile) re-read and
  // re-apply onto the latest array. Preserves created_by_user_id.
  const updateMessage = async (
    patch: Partial<StoredMessage>,
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
          `failed to read image_chats record ${job.recordId}: ${readErr?.message ?? 'not found'}`,
        );
      }
      const data = ((current.data as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      const messages: StoredMessage[] = Array.isArray(data.messages)
        ? (data.messages as StoredMessage[])
        : [];
      let found = false;
      const newMessages = messages.map((m) => {
        if (m.id === job.messageId) {
          found = true;
          return { ...m, ...patch };
        }
        return m;
      });
      if (!found) {
        // The conversation (or this message) is gone — e.g. user deleted the
        // chat mid-run. Abort loudly; never silently no-op (CLAUDE.md).
        throw new Error(
          `message ${job.messageId} not present in record ${job.recordId} — aborting`,
        );
      }
      const newData = { ...data, messages: newMessages, ...extraRecordFields };
      const { error: saveErr } = await supabase.rpc('record_save', {
        p_model_id: modelId,
        p_id: job.recordId,
        p_data: newData,
        p_created_by:
          (current as { created_by_user_id: string | null }).created_by_user_id ?? null,
        p_expected_version: (current as { version: number | null }).version ?? null,
      });
      if (!saveErr) return;
      if (isVersionConflict(saveErr as { code?: string; message?: string })) {
        // A concurrent turn bumped the version — re-read and retry.
        continue;
      }
      throw new Error(`record_save failed: ${saveErr.message}`);
    }
    throw new Error(
      `record_save failed after ${MAX_SAVE_ATTEMPTS} version-conflict retries (record ${job.recordId})`,
    );
  };

  // ── Parse frozen params ──────────────────────────────────────────────
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
  // Order matters: nano-banana-pro/edit treats the first image as the primary
  // subject. User-curated attachments first, then the auto-chain reference.
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
  await updateMessage({ status: 'generating' });
  console.log(`[run-image] generating job=${job.id} record=${job.recordId} msg=${job.messageId}`);

  // ── Cancel pre-check ─────────────────────────────────────────────────
  if (await isCancelled()) {
    await updateMessage({ status: 'cancelled' });
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
    const friendly = humanizeImageError(raw);
    await updateMessage({ status: 'failed', error: friendly }).catch((e) =>
      console.error(`[run-image] could not mark message failed: ${(e as Error).message}`),
    );
    throw err; // index.ts marks the job failed with the raw message
  }

  // ── Cancel post-check (skip re-host if cancelled mid-generation) ──────
  if (await isCancelled()) {
    await updateMessage({ status: 'cancelled' });
    console.log(`[run-image] cancelled-after-generate job=${job.id}`);
    return { cancelled: true };
  }

  // ── Re-host outputs to marketing-assets (service-role, public bucket) ─
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
      const msg = `output fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      await updateMessage({ status: 'failed', error: msg }).catch(() => undefined);
      throw new Error(msg);
    }
    const ext = contentType.includes('jpeg')
      ? 'jpg'
      : contentType.includes('webp')
        ? 'webp'
        : 'png';
    const path = `image-chats/outputs/${job.userId}/${job.recordId}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType, upsert: false });
    if (upErr) {
      const msg = `output upload failed: ${upErr.message}`;
      await updateMessage({ status: 'failed', error: msg }).catch(() => undefined);
      throw new Error(msg);
    }
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const publicUrl = pub?.publicUrl;
    if (!publicUrl) {
      const msg = 'output uploaded but public URL not resolved';
      await updateMessage({ status: 'failed', error: msg }).catch(() => undefined);
      throw new Error(msg);
    }
    persisted.push({ url: publicUrl, name: `variation-${i + 1}.${ext}`, source: 'assistant' });
  }

  // ── Fill the placeholder + bump conversation rollups ─────────────────
  // status:'idle' / last_message_at are the legacy conversation-level fields
  // kept for back-compat (the UI now derives "generating" from per-message
  // status). `error` is omitted from the patch (undefined would be dropped by
  // JSONB anyway) so a fresh placeholder stays clean.
  await updateMessage(
    { status: 'completed', images: persisted },
    { last_message_at: new Date().toISOString(), status: 'idle', error_message: null },
  );
  console.log(
    `[run-image] completed job=${job.id} variations=${persisted.length} record=${job.recordId}`,
  );
  return { images: persisted };
}

/**
 * Translate raw fal.ai / network errors into plain text for the per-message
 * red error box. Always preserves the original wording so a screenshot is
 * still debuggable. Mirrors the posture of runDeckJob.humanizeErrorMessage.
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
