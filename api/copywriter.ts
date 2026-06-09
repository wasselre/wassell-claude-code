/**
 * POST /api/copywriter
 *
 * Runs one turn of the Wassel real-estate copywriter agent. The browser posts
 * the full conversation history; this endpoint drives Claude through a tool-use
 * loop (search_reels / get_reel over the competitor knowledge base, plus the
 * reused search_projects / get_project over our projects) and streams the
 * assistant's reply back as Server-Sent Events.
 *
 * Mirrors api/agent.ts exactly — same SSE wire format, same tool loop — only
 * the prompt / tools / executor differ (see api/_lib/copywriterAgent.ts).
 *
 * Conversation history lives on the client (in the `copywriter_chats` record).
 * Nothing is persisted server-side.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError } from './_lib/auth.js';
import {
  COPYWRITER_MODEL,
  COPYWRITER_MAX_TOKENS,
  COPYWRITER_SYSTEM_PROMPT,
  COPYWRITER_TOOLS,
  executeCopywriterTool,
} from './_lib/copywriterAgent.js';
import { logAiAgentTurn } from './_lib/activityLogger.js';

export const config = { runtime: 'edge' };

interface AgentRequestBody {
  messages: Anthropic.MessageParam[];
}

// Safety cap on the tool-use loop — the copywriter may chain a couple of
// reel/project searches before writing, but 8 is a generous ceiling.
const MAX_TOOL_ITERATIONS = 8;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    let body: AgentRequestBody;
    try {
      body = (await req.json()) as AgentRequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return jsonError(400, 'messages must be a non-empty array');
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return jsonError(500, 'ANTHROPIC_API_KEY is not configured');
    }

    // Authenticated Supabase client scoped to the caller's JWT, so tools
    // respect row-level security.
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return jsonError(500, 'Supabase env vars missing');
    }
    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const client = new Anthropic({ apiKey });
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        try {
          const conversation: Anthropic.MessageParam[] = [...body.messages];

          for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
            const turnStartedAt = Date.now();
            const turn = client.messages.stream({
              model: COPYWRITER_MODEL,
              max_tokens: COPYWRITER_MAX_TOKENS,
              system: [
                {
                  type: 'text',
                  text: COPYWRITER_SYSTEM_PROMPT,
                  cache_control: { type: 'ephemeral' },
                },
              ],
              tools: COPYWRITER_TOOLS,
              messages: conversation,
            });

            // Forward text deltas live so the browser types out the script
            // as Claude generates it.
            for await (const event of turn) {
              if (
                event.type === 'content_block_delta' &&
                event.delta.type === 'text_delta'
              ) {
                send({ type: 'text', delta: event.delta.text });
              }
            }

            const finalMessage = await turn.finalMessage();

            console.log('[copywriter] turn stop_reason', finalMessage.stop_reason, 'iter', iteration);
            if (finalMessage.stop_reason === 'tool_use') {
              const toolUses = finalMessage.content.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
              );
              console.log('[copywriter] tool calls', toolUses.map((t) => t.name));
              conversation.push({ role: 'assistant', content: finalMessage.content });

              const toolResults: Anthropic.ToolResultBlockParam[] = [];
              const turnToolCalls: Array<{
                name: string;
                input: unknown;
                result: string;
                duration_ms: number;
                error?: string;
              }> = [];
              for (const toolUse of toolUses) {
                send({ type: 'tool_use', name: toolUse.name, input: toolUse.input });
                const toolStartedAt = Date.now();
                let toolResult = '';
                let toolError: string | undefined;
                try {
                  toolResult = await executeCopywriterTool(
                    toolUse.name,
                    toolUse.input,
                    supabase,
                    user.userId,
                  );
                } catch (err) {
                  toolError = err instanceof Error ? err.message : String(err);
                  toolResult = `Error: ${toolError}`;
                }
                const toolDuration = Date.now() - toolStartedAt;
                send({ type: 'tool_result', name: toolUse.name, result: toolResult });
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: toolResult,
                });
                turnToolCalls.push({
                  name: toolUse.name,
                  input: toolUse.input,
                  result: toolResult,
                  duration_ms: toolDuration,
                  ...(toolError ? { error: toolError } : {}),
                });
              }

              void logAiAgentTurn({
                user: { userId: user.userId, email: user.email },
                iteration,
                stop_reason: 'tool_use',
                duration_ms: Date.now() - turnStartedAt,
                tool_calls: turnToolCalls,
                message_count: conversation.length,
              });

              conversation.push({ role: 'user', content: toolResults });
              continue;
            }

            void logAiAgentTurn({
              user: { userId: user.userId, email: user.email },
              iteration,
              stop_reason: finalMessage.stop_reason ?? 'end_turn',
              duration_ms: Date.now() - turnStartedAt,
              tool_calls: [],
              message_count: conversation.length,
            });
            send({ type: 'done', stop_reason: finalMessage.stop_reason ?? 'end_turn' });
            controller.close();
            return;
          }

          void logAiAgentTurn({
            user: { userId: user.userId, email: user.email },
            iteration: MAX_TOOL_ITERATIONS,
            stop_reason: 'iteration_limit',
            duration_ms: 0,
            tool_calls: [],
            message_count: conversation.length,
            error: 'tool iteration limit reached',
          });
          send({ type: 'error', message: 'tool iteration limit reached' });
          controller.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          try {
            send({ type: 'error', message });
          } catch {
            // Controller may already be closed.
          }
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });
}
