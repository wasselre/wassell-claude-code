/**
 * POST /api/agent
 *
 * Runs one turn of the Wassel AI sales agent. The browser posts the full
 * conversation history; this endpoint drives Claude through a tool-use loop
 * (calling search_projects / get_project / save_lead as needed) and streams
 * the assistant's reply back as Server-Sent Events.
 *
 * Request body:
 *   { messages: Anthropic.MessageParam[] }
 *
 * SSE events the browser consumes (each `data:` line is one JSON object):
 *   { type: 'text',      delta: string }            // assistant text chunk
 *   { type: 'tool_use',  name: string, input: any } // agent is calling a tool
 *   { type: 'tool_result', name: string, result: string } // tool returned
 *   { type: 'done',      stop_reason: string }      // turn finished
 *   { type: 'error',     message: string }          // fatal error
 *
 * Conversation history lives on the client (in the `ai_chats` record).
 * Nothing is persisted server-side except leads created via save_lead.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError } from './_lib/auth.js';
import {
  AGENT_MODEL,
  AGENT_MAX_TOKENS,
  AGENT_SYSTEM_PROMPT,
  AGENT_TOOLS,
  executeAgentTool,
} from './_lib/aiAgent.js';
import { logAiAgentTurn } from './_lib/activityLogger.js';

export const config = { runtime: 'edge' };

interface AgentRequestBody {
  messages: Anthropic.MessageParam[];
}

// Safety cap on the tool-use loop. Claude rarely needs more than 3-4
// iterations for this agent; 8 is a generous ceiling before we bail out.
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
              model: AGENT_MODEL,
              max_tokens: AGENT_MAX_TOKENS,
              system: [
                {
                  type: 'text',
                  text: AGENT_SYSTEM_PROMPT,
                  cache_control: { type: 'ephemeral' },
                },
              ],
              tools: AGENT_TOOLS,
              messages: conversation,
            });

            // Forward text deltas live so the browser can type out the
            // response as Claude generates it.
            for await (const event of turn) {
              if (
                event.type === 'content_block_delta' &&
                event.delta.type === 'text_delta'
              ) {
                send({ type: 'text', delta: event.delta.text });
              }
            }

            const finalMessage = await turn.finalMessage();

            console.log('[agent] turn stop_reason', finalMessage.stop_reason, 'iter', iteration);
            if (finalMessage.stop_reason === 'tool_use') {
              const toolUses = finalMessage.content.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
              );
              console.log('[agent] tool calls', toolUses.map((t) => t.name));
              conversation.push({ role: 'assistant', content: finalMessage.content });

              const toolResults: Anthropic.ToolResultBlockParam[] = [];
              // Capture the full payload of every tool call this turn so the
              // unified /logs page can show inputs + results verbatim. Per the
              // user's "full depth" requirement we do NOT truncate — admins want
              // to see exactly what the agent searched for and what came back.
              const turnToolCalls: Array<{
                name: string;
                input: unknown;
                result: string;
                duration_ms: number;
                error?: string;
              }> = [];
              for (const toolUse of toolUses) {
                send({
                  type: 'tool_use',
                  name: toolUse.name,
                  input: toolUse.input,
                });
                const toolStartedAt = Date.now();
                let toolResult = '';
                let toolError: string | undefined;
                try {
                  toolResult = await executeAgentTool(
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

              // Persist this turn (including every tool call's full input +
              // result) to the activity log. waitUntil-style fire-and-forget
              // so the SSE stream isn't blocked on the insert.
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

            // end_turn, max_tokens, stop_sequence, refusal, etc. — terminal.
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

          // Hit the iteration cap without Claude ever saying end_turn.
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
