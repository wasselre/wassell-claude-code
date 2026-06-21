/**
 * Browser-side helper for streaming chat turns from `/api/match` (the Project
 * Matching Assistant). Identical wire format to `/api/copywriter` and
 * `/api/agent` — opens an SSE stream, decodes `data: <json>` events, invokes
 * per-type callbacks. The one extra event type is `recommendation` (the
 * structured final card).
 */

import { supabase } from '@/lib/supabase';

export type MatchEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: string }
  // Structured cards (all rendered inside the SAME chat). `data` is the raw tool
  // input (untrusted) — normalize with the matching lib normalizer.
  | { type: 'recommendation'; data: unknown }
  | { type: 'comparison'; data: unknown }
  | { type: 'next_action'; data: unknown }
  | { type: 'message_draft'; data: unknown }
  | { type: 'task_proposal'; data: unknown }
  | { type: 'done'; stop_reason: string }
  | { type: 'error'; message: string };

export interface MatchApiMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function streamMatchTurn(
  messages: MatchApiMessage[],
  onEvent: (event: MatchEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/match', {
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
    throw new Error(body?.error ?? `POST /api/match failed (${res.status})`);
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
      let parsed: MatchEvent;
      try {
        parsed = JSON.parse(line) as MatchEvent;
      } catch {
        continue;
      }
      onEvent(parsed);
    }
  }
}
