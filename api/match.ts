/**
 * POST /api/match
 *
 * Runs one turn of the Wassel Project Matching Assistant (the live-call sales
 * co-pilot). The browser posts the full conversation history; this endpoint
 * drives Claude through a tool-use loop (match_projects / get_project over the
 * project portfolio, emit_recommendation for the structured card) and streams
 * the reply back as Server-Sent Events.
 *
 * Mirrors api/copywriter.ts exactly — same SSE wire format, same tool loop —
 * only the prompt / tools / executor differ (see api/_lib/matchAgent.ts). The
 * one extra event type is `recommendation` (the structured final card).
 *
 * Conversation history lives on the client (in the `matching_chats` record).
 * Nothing is persisted server-side.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError } from './_lib/auth.js';
import {
  MATCH_MODEL,
  MATCH_MAX_TOKENS,
  MATCH_SYSTEM_PROMPT,
  MATCH_TOOLS,
  executeMatchTool,
  collectAuthoritativeMeta,
  reconcileRecommendationPayload,
  type AuthoritativeMeta,
} from './_lib/matchAgent.js';
import { logAiAgentTurn } from './_lib/activityLogger.js';

export const config = { runtime: 'edge' };

interface AgentRequestBody {
  messages: Anthropic.MessageParam[];
}

// The co-pilot may chain match_projects → get_project (×1-2) → emit_recommendation;
// 8 is a generous ceiling on the tool-use loop.
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

    // Authenticated Supabase client scoped to the caller's JWT, so tools respect
    // row-level security (the salesperson only matches projects they can see).
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
          // Authoritative ranking metadata (score/band/type/source/verify) keyed
          // by project_id, accumulated from every match_projects result this
          // request. emit_recommendation's payload is reconciled against this so
          // the model can never alter the deterministic score/band (Phase 1.1).
          const authMeta = new Map<string, AuthoritativeMeta>();

          for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
            const turnStartedAt = Date.now();
            const turn = client.messages.stream({
              model: MATCH_MODEL,
              max_tokens: MATCH_MAX_TOKENS,
              system: [
                {
                  type: 'text',
                  text: MATCH_SYSTEM_PROMPT,
                  cache_control: { type: 'ephemeral' },
                },
              ],
              tools: MATCH_TOOLS,
              messages: conversation,
            });

            // Forward text deltas live so the browser types out the reply.
            for await (const event of turn) {
              if (
                event.type === 'content_block_delta' &&
                event.delta.type === 'text_delta'
              ) {
                send({ type: 'text', delta: event.delta.text });
              }
            }

            const finalMessage = await turn.finalMessage();

            console.log('[match] turn stop_reason', finalMessage.stop_reason, 'iter', iteration);
            if (finalMessage.stop_reason === 'tool_use') {
              const toolUses = finalMessage.content.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
              );
              console.log('[match] tool calls', toolUses.map((t) => t.name));
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
                if (toolUse.name === 'emit_recommendation') {
                  // Surface the structured recommendation to the browser as a
                  // dedicated event the thread renders as a card. FORCE the
                  // deterministic ranking metadata (score/band/type/source/verify)
                  // from the authoritative match_projects results — the model
                  // cannot upgrade/downgrade/rename a match. Narrative fields pass
                  // through (normalized client-side). Still runs through the loop
                  // below so the model gets an ack and writes a closing line.
                  const { payload, corrections } = reconcileRecommendationPayload(
                    toolUse.input ?? {},
                    authMeta,
                  );
                  if (corrections.length > 0) {
                    console.log('[match] forced deterministic metadata', JSON.stringify(corrections));
                  }
                  send({ type: 'recommendation', data: payload });
                }
                // Other structured cards — same chat, different card types. The
                // payload is the raw tool input (untrusted; normalized client-side).
                if (toolUse.name === 'emit_comparison') {
                  send({ type: 'comparison', data: toolUse.input ?? {} });
                }
                if (toolUse.name === 'emit_next_action') {
                  send({ type: 'next_action', data: toolUse.input ?? {} });
                }
                if (toolUse.name === 'emit_message') {
                  send({ type: 'message_draft', data: toolUse.input ?? {} });
                }
                if (toolUse.name === 'propose_task') {
                  // Confirmation-gated: the browser renders a Confirm/Cancel card.
                  // The record is created CLIENT-SIDE only after the user confirms.
                  send({ type: 'task_proposal', data: toolUse.input ?? {} });
                }
                const toolStartedAt = Date.now();
                let toolResult = '';
                let toolError: string | undefined;
                try {
                  toolResult = await executeMatchTool(
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
                // Capture the authoritative ranking metadata so a later
                // emit_recommendation in this request can be reconciled against it.
                if (toolUse.name === 'match_projects' && !toolError) {
                  collectAuthoritativeMeta(toolResult, authMeta);
                }
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
