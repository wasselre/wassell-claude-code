/**
 * Browser-side helper for `POST /api/image-chat/send`.
 *
 * Image-chat turns aren't streamed — fal.ai is a fire-and-poll queue
 * and the worst case is ~3 minutes, well inside `maxDuration: 240`.
 * The composer just awaits the response. The deck record's `status`
 * field flips to 'generating' immediately (server-side) so any other
 * tab watching via Realtime sees the spinner.
 */

import { supabase } from '@/lib/supabase';

export type ChatAspectRatio = '1:1' | '9:16' | '16:9' | '4:3' | '3:4';

/** Which fal.ai image model the turn runs on. The actual fal slug is
 *  resolved server-side in api/_lib/imageGen.ts so the wire format
 *  stays stable even if we re-point a model to a different fal endpoint. */
export type ChatModelId = 'nano-banana' | 'gpt-image-2';

export type AttachmentSource = 'user' | 'preset' | 'snippet';

export interface MessageImage {
  url: string;
  name?: string;
  source?: AttachmentSource | 'assistant';
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

export interface SendTurnResponse {
  messages: StoredMessage[];
  assistant: StoredMessage;
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function sendImageChatTurn(
  input: SendTurnInput,
  signal?: AbortSignal,
): Promise<SendTurnResponse> {
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
    signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `POST /api/image-chat/send failed (${res.status})`);
  }
  return (await res.json()) as SendTurnResponse;
}
