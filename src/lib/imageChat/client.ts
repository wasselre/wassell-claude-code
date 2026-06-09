/**
 * Browser-side helper for `POST /api/image-chat/send` (Image Chats v2).
 *
 * Image-chat turns are no longer awaited end-to-end. The endpoint ENQUEUES a
 * per-message generation job and returns fast ({ job_id, message_id }); the
 * Fly.io worker fills the assistant placeholder in place and the SPA picks up
 * the result via Supabase Realtime on the record. So the composer never
 * blocks — the user can fire several turns at once and keep chatting.
 *
 * Each assistant message carries its OWN `status` (queued/generating/
 * completed/failed/cancelled); the old conversation-level blocking is gone.
 */

import { supabase } from '@/lib/supabase';

export type ChatAspectRatio = '1:1' | '9:16' | '16:9' | '4:3' | '3:4';

/** Which fal.ai image model the turn runs on. The actual fal slug is
 *  resolved server-side in api/_lib/imageGen.ts so the wire format
 *  stays stable even if we re-point a model to a different fal endpoint. */
export type ChatModelId = 'nano-banana' | 'gpt-image-2';

export type AttachmentSource = 'user' | 'preset' | 'snippet';

/** Per-message generation lifecycle. Lives on the assistant message, not the
 *  conversation. Absent on legacy messages ⇒ treat as 'completed'. */
export type MessageStatus = 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled';

export interface MessageImage {
  url: string;
  name?: string;
  source?: AttachmentSource | 'assistant';
  /** Promote-on-add cache (Image Chats v2 Part 5): the canonical Files-System
   *  `files.id` created the first time this image was added to Files or a
   *  record. Reused by every later add so the asset is deduped instead of
   *  re-copied. Absent until the first promote. */
  file_id?: string;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  images: MessageImage[];
  aspect_ratio?: ChatAspectRatio;
  num_variations?: number;
  preset_id?: string | null;
  preset_name?: string | null;
  created_at: string;
  /** Assistant-only. Drives the per-message spinner / result / error UI. */
  status?: MessageStatus;
  /** The generation_jobs row filling this message (used for cancel/retry). */
  job_id?: string;
  /** Failure reason, shown when status === 'failed'. */
  error?: string;
}

export interface SendTurnInput {
  recordId: string;
  prompt: string;
  attachmentUrls: string[];
  attachmentSources: AttachmentSource[];
  aspectRatio: ChatAspectRatio;
  numVariations: number;
  presetId: string | null;
  /** Which image model to run this turn on. Defaults to 'nano-banana'
   *  server-side if omitted. */
  modelId: ChatModelId;
  /** Auto-chain: the previous assistant image to iterate on. Null on
   * the first turn or after the user explicitly clears context. */
  prevImageUrl: string | null;
}

export interface EnqueueResponse {
  /** generation_jobs.id — used to cancel the job. */
  jobId: string;
  /** The assistant placeholder message id this job fills. */
  messageId: string;
}

/* ─── Image Chats v3 — Creative Workspace ─────────────────────────────────
 * The session's primary objects are Generations (not chat messages), and each
 * output is a first-class MediaAsset row (the `media_assets` table). */

export type GenerationStatus = MessageStatus;

/** A first-class media-library asset (one row in `media_assets`). */
export interface MediaAsset {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'document';
  public_url: string;
  storage_path?: string | null;
  mime_type?: string | null;
  width?: number | null;
  height?: number | null;
  prompt?: string | null;
  model_id?: string | null;
  settings?: Record<string, unknown> | null;
  source_session_id?: string | null;
  source_generation_id?: string | null;
  promoted_file_id?: string | null;
  created_at: string;
}

/** One generation in a Creative Session (lives in `record.data.generations`). */
export interface Generation {
  id: string;
  prompt: string;
  /** media_assets used as references ("Use as Reference"). */
  reference_asset_ids: string[];
  /** ad-hoc uploaded references (marketing-assets URLs / files.id). */
  reference_urls: string[];
  preset_id?: string | null;
  preset_name?: string | null;
  model_id: ChatModelId;
  aspect_ratio: ChatAspectRatio;
  num_variations: number;
  /** parent generation id (iteration lineage). */
  based_on?: string | null;
  status?: GenerationStatus;
  job_id?: string;
  error?: string;
  /** the media_assets this generation produced (v3 generations). */
  output_asset_ids: string[];
  /** Inline output URLs — set ONLY for generations migrated from v2 chat
   *  messages (whose outputs predate the media_assets library). The canvas
   *  prefers output_asset_ids and falls back to these. */
  output_urls?: string[];
  created_at: string;
}

export interface GenerationInput {
  sessionId: string;
  prompt: string;
  referenceUrls: string[];
  referenceAssetIds: string[];
  presetId: string | null;
  modelId: ChatModelId;
  aspectRatio: ChatAspectRatio;
  numVariations: number;
  basedOn: string | null;
}

export interface GenerationEnqueueResponse {
  jobId: string;
  generationId: string;
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Enqueue one image-chat turn. Returns as soon as the server has written the
 * user message + assistant placeholder and queued the job — NOT when the image
 * is ready. The finished image arrives via Realtime. Throws only on an
 * enqueue-time failure (bad input, auth, server error); generation failures
 * surface per-message on the placeholder.
 */
export async function enqueueImageChatTurn(input: SendTurnInput): Promise<EnqueueResponse> {
  const res = await fetch('/api/image-chat/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify({
      record_id: input.recordId,
      prompt: input.prompt,
      attachment_urls: input.attachmentUrls,
      attachment_sources: input.attachmentSources,
      aspect_ratio: input.aspectRatio,
      num_variations: input.numVariations,
      preset_id: input.presetId,
      model_id: input.modelId,
      prev_image_url: input.prevImageUrl,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `POST /api/image-chat/send failed (${res.status})`);
  }
  const json = (await res.json()) as { job_id?: string; message_id?: string };
  if (!json.job_id || !json.message_id) {
    throw new Error('enqueue succeeded but job_id/message_id missing from response');
  }
  return { jobId: json.job_id, messageId: json.message_id };
}

/**
 * Enqueue one Generation in a Creative Session (Image Chats v3). Returns as
 * soon as the server appends the queued Generation + the job — NOT when the
 * image is ready (it streams in via Realtime, and each output becomes a
 * first-class `media_assets` row). Throws only on enqueue-time failure.
 */
export async function enqueueGeneration(
  input: GenerationInput,
): Promise<GenerationEnqueueResponse> {
  const res = await fetch('/api/image-chat/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      session_id: input.sessionId,
      prompt: input.prompt,
      reference_urls: input.referenceUrls,
      reference_asset_ids: input.referenceAssetIds,
      preset_id: input.presetId,
      model_id: input.modelId,
      aspect_ratio: input.aspectRatio,
      num_variations: input.numVariations,
      based_on: input.basedOn,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `POST /api/image-chat/generate failed (${res.status})`);
  }
  const json = (await res.json()) as { job_id?: string; generation_id?: string };
  if (!json.job_id || !json.generation_id) {
    throw new Error('enqueue succeeded but job_id/generation_id missing from response');
  }
  return { jobId: json.job_id, generationId: json.generation_id };
}

/**
 * Cancel a queued or running generation job. The cancel RPC is owner-gated and
 * patches the target (message or generation) to status='cancelled' itself, so
 * the UI updates purely via Realtime. No-op offline (nothing was enqueued).
 */
export async function cancelImageJob(jobId: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.rpc('generation_job_cancel', { p_job_id: jobId });
  if (error) throw new Error(error.message);
}
