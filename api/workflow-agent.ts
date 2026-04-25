/**
 * POST /api/workflow-agent
 *
 * Streaming endpoint for the natural-language workflow builder. The browser
 * posts the full conversation history; this endpoint drives Claude through
 * a tool-use loop (calling get_app_context / create_workflow as needed)
 * and streams the assistant's reply back as Server-Sent Events.
 *
 * Mirrors `/api/agent` (the sales agent) but with a different system prompt
 * and tool surface — see api/_lib/workflowAgent.ts.
 *
 * Request body: { messages: Anthropic.MessageParam[] }
 * Response: SSE with the same event shapes as /api/agent.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError } from './_lib/auth.js';
import {
  WORKFLOW_AGENT_MODEL,
  WORKFLOW_AGENT_MAX_TOKENS,
  WORKFLOW_AGENT_SYSTEM_PROMPT,
  WORKFLOW_AGENT_TOOLS,
  executeWorkflowAgentTool,
} from './_lib/workflowAgent.js';

export const config = { runtime: 'edge' };

interface AgentRequestBody {
  messages: Anthropic.MessageParam[];
}

// Same safety cap as the sales agent — Claude rarely needs more than two
// or three iterations (one to fetch context, one to confirm, one to
// create), but a runaway loop should bail out instead of burning credits.
const MAX_TOOL_ITERATIONS = 8;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async () => {
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

    // Build the public-facing base URL so the agent can return clickable
    // links to the workflows it creates. Trust the request's own host
    // header — the agent runs as an Edge function on the same domain.
    const url = new URL(req.url);
    const baseUrl = `${url.protocol}//${url.host}`;

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
            const turn = client.messages.stream({
              model: WORKFLOW_AGENT_MODEL,
              max_tokens: WORKFLOW_AGENT_MAX_TOKENS,
              system: [
                {
                  type: 'text',
                  text: WORKFLOW_AGENT_SYSTEM_PROMPT,
                  cache_control: { type: 'ephemeral' },
                },
              ],
              tools: WORKFLOW_AGENT_TOOLS,
              messages: conversation,
            });

            for await (const event of turn) {
              if (
                event.type === 'content_block_delta' &&
                event.delta.type === 'text_delta'
              ) {
                send({ type: 'text', delta: event.delta.text });
              }
            }

            const finalMessage = await turn.finalMessage();

            if (finalMessage.stop_reason === 'tool_use') {
              const toolUses = finalMessage.content.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
              );
              conversation.push({ role: 'assistant', content: finalMessage.content });

              const toolResults: Anthropic.ToolResultBlockParam[] = [];
              for (const toolUse of toolUses) {
                send({ type: 'tool_use', name: toolUse.name, input: toolUse.input });
                const result = await executeWorkflowAgentTool(
                  toolUse.name,
                  toolUse.input,
                  supabase,
                  baseUrl,
                );
                send({ type: 'tool_result', name: toolUse.name, result });
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: result,
                });
              }

              conversation.push({ role: 'user', content: toolResults });
              continue;
            }

            send({ type: 'done', stop_reason: finalMessage.stop_reason ?? 'end_turn' });
            controller.close();
            return;
          }

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
