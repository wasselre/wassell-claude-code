/**
 * Browser-side helper for streaming chat turns from `/api/copywriter`.
 *
 * Identical wire format to `/api/agent` (see src/lib/aiAgent/client.ts) — opens
 * an SSE stream, decodes `data: <json>` events, invokes per-type callbacks.
 */

import { supabase } from '@/lib/supabase';

export type CopywriterEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: string }
  // Structured final reel script emitted via the emit_reel_script tool. `data`
  // is the raw tool input (untrusted) — normalize with normalizeReelScript.
  | { type: 'reel_script'; data: unknown }
  | { type: 'done'; stop_reason: string }
  | { type: 'error'; message: string };

export interface CopywriterApiMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function streamCopywriterTurn(
  messages: CopywriterApiMessage[],
  onEvent: (event: CopywriterEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/copywriter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `POST /api/copywriter failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const raw of chunks) {
      const line = raw.replace(/^data:\s?/, '').trim();
      if (!line) continue;
      let parsed: CopywriterEvent;
      try {
        parsed = JSON.parse(line) as CopywriterEvent;
      } catch {
        continue;
      }
      onEvent(parsed);
    }
  }
}
