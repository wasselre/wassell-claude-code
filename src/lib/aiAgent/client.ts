/**
 * Browser-side helper for streaming chat turns from `/api/agent`.
 *
 * Opens an SSE stream, decodes `data: <json>` events, and invokes per-type
 * callbacks. Keeps the UI decoupled from the wire format.
 */

import { supabase } from '@/lib/supabase';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'done'; stop_reason: string }
  | { type: 'error'; message: string };

export interface AgentApiMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function streamAgentTurn(
  messages: AgentApiMessage[],
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/agent', {
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
    throw new Error(body?.error ?? `POST /api/agent failed (${res.status})`);
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
      let parsed: AgentEvent;
      try {
        parsed = JSON.parse(line) as AgentEvent;
      } catch {
        continue;
      }
      onEvent(parsed);
    }
  }
}
