import type Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { GoogleDriveOAuth } from './env.ts';
import type { PresentationToolName } from './types.ts';
import { ALL_TOOL_DEFS, executeToolCall, isClientSideTool } from './tools/index.ts';

/**
 * Manual agent loop. Picked over the SDK's `client.beta.messages.toolRunner`
 * because:
 *   - The tool runner is beta in TypeScript, and we need this code to be
 *     stable for the Phase 3 "wire builder to runtime" work.
 *   - We want a callback hook (`onStep`) so the runner can persist progress
 *     messages to the job row mid-run.
 *   - The loop is small enough that the explicit version is easier to debug
 *     than the abstraction.
 *
 * Server-side Anthropic tools (web_search, web_fetch) run on Anthropic's
 * infrastructure — they don't appear as `tool_use` blocks here. Their
 * results land directly in `response.content` and are folded into the next
 * turn's context when we push the assistant message back. Only client-side
 * tools (record_lookup) need explicit dispatch.
 *
 * `pause_turn` happens when Anthropic's server-side tool loop hits its own
 * iteration limit (default 10). Re-sending the same response back resumes
 * where it left off — no extra user message needed.
 */

export interface AgentStep {
  iteration: number;
  /** Names of CLIENT-SIDE tools executed this turn. Server-side tools
   *  (web_search etc.) don't show up here — they're invisible to the loop. */
  toolUses: Array<{ name: string; input: unknown }>;
  /** True when Anthropic's server-side loop paused (web_search hit 10
   *  iterations); we'll resume on the next turn. */
  paused: boolean;
  finalText?: string;
}

export interface AgentToolCall {
  name: string;
  input: unknown;
  result: string;
  is_error?: boolean;
}

export interface AgentLoopOptions {
  anthropic: Anthropic;
  supabase: SupabaseClient;
  /** Google OAuth credentials for the drive_upload tool. If null, drive_
   *  upload returns an error (the worker still runs; only Drive-using
   *  templates fail). */
  googleDriveOAuth: GoogleDriveOAuth | null;
  /** Drive folder ID for uploaded files. Optional — when null, uploads
   *  land in the root of the OAuth user's Drive. */
  googleDriveParentFolderId: string | null;
  /** Subset of tools the agent is allowed to use this run. When null, the
   *  agent has access to ALL_TOOL_DEFS (the Phase 1B behavior). When a
   *  list, only tools with those names are exposed. Phase 3 uses this to
   *  scope each step to its declared tool subset. */
  enabledTools?: PresentationToolName[] | null;
  systemPrompt: string;
  userMessage: string;
  /** Hard cap on agent loop iterations. Each iteration is ONE Anthropic
   *  request. Default 20 — generous for Phase 1 smoke tests, plenty of
   *  headroom for tool-heavy templates later. */
  maxIterations?: number;
  /** Override the default model. Mostly useful for cheaper smoke tests. */
  model?: string;
  /** Tokens cap PER iteration. Server-side tool loops eat into this; if
   *  you're running web_search heavy you probably want 8000+. */
  maxTokens?: number;
  /** Called after every iteration, before the next request fires. Use this
   *  to write progress messages to the job row. */
  onStep?: (step: AgentStep) => Promise<void> | void;
}

export interface AgentLoopResult {
  finalText: string;
  iterations: number;
  toolCalls: AgentToolCall[];
  /** Cumulative usage across all iterations. Useful for cost reporting. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: opts.userMessage },
  ];
  const maxIterations = opts.maxIterations ?? 20;
  const model = opts.model ?? 'claude-opus-4-7';
  const maxTokens = opts.maxTokens ?? 8000;
  const toolCalls: AgentToolCall[] = [];
  const usage: AgentLoopResult['usage'] = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  // The newer `web_search_20260209` / `web_fetch_20260209` tools use code
  // execution internally for "dynamic filtering". When the response has any
  // pending code-execution tool-use blocks, the next iteration MUST pass
  // `container` so the API can resume that code execution. We capture the
  // container from the first response that has one and thread it through.
  let containerId: string | null = null;

  // Build the tool list ONCE per loop — same set for every iteration so
  // prompt caching stays warm. When `enabledTools` is null we expose all
  // tools (Phase 1B default); otherwise filter by name.
  const enabledNames = opts.enabledTools ?? null;
  const toolsForThisRun = enabledNames === null
    ? ALL_TOOL_DEFS
    : ALL_TOOL_DEFS.filter((t) => enabledNames.includes(t.name as PresentationToolName));

  for (let i = 0; i < maxIterations; i++) {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system: opts.systemPrompt,
      tools: toolsForThisRun,
      messages,
    };
    if (containerId !== null) {
      params.container = containerId;
    }
    const response = await opts.anthropic.messages.create(params);

    if (response.container?.id) {
      containerId = response.container.id;
    }

    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    usage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens ?? 0;
    usage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;

    // End-of-turn: extract final text and return.
    if (response.stop_reason === 'end_turn') {
      const finalText = extractText(response.content);
      await opts.onStep?.({
        iteration: i + 1,
        toolUses: [],
        paused: false,
        finalText,
      });
      return { finalText, iterations: i + 1, toolCalls, usage };
    }

    // Server-side tool hit its iteration limit. Re-send the assistant turn
    // and let the API resume. We do NOT add a user message here.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      await opts.onStep?.({
        iteration: i + 1,
        toolUses: [],
        paused: true,
      });
      continue;
    }

    // tool_use case (or refusal / max_tokens — both also fall through here
    // if there are tool_use blocks, otherwise we exit the loop with
    // whatever text we have).
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0) {
      // No more tool calls and not end_turn — likely refusal or max_tokens.
      // Treat the existing text as the final answer.
      const finalText = extractText(response.content);
      await opts.onStep?.({
        iteration: i + 1,
        toolUses: [],
        paused: false,
        finalText,
      });
      return { finalText, iterations: i + 1, toolCalls, usage };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUseBlocks) {
      let result: string;
      let isError = false;
      if (isClientSideTool(tool.name)) {
        try {
          result = await executeToolCall(
            {
              supabase: opts.supabase,
              anthropic: opts.anthropic,
              driveOAuth: opts.googleDriveOAuth,
              parentFolderId: opts.googleDriveParentFolderId,
            },
            tool.name,
            tool.input,
          );
        } catch (err) {
          result = `Tool execution threw: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
      } else {
        // Defensive: a tool_use with an unknown name shouldn't happen
        // because we only declare tools we handle. But if it does, return
        // a clear error so the agent can recover instead of hanging.
        result = `Error: tool "${tool.name}" is not registered as a client-side tool.`;
        isError = true;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tool.id,
        content: result,
        is_error: isError,
      });
      toolCalls.push({ name: tool.name, input: tool.input, result, is_error: isError });
    }

    // Surface file_ids written by code_execution as plain text in the next
    // user turn. Reason: file_ids live nested inside
    // bash_code_execution_tool_result.content.content[].file_id, and Claude
    // can't reliably read that nested shape — it tends to see only the
    // stdout text and hallucinate file_ids when asked. Re-stating them in
    // a flat list here gives drive_upload a fighting chance.
    const fileIds = extractCodeExecutionFileIds(response.content);
    const userContent: Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam> = [
      ...toolResults,
    ];
    if (fileIds.length > 0) {
      userContent.push({
        type: 'text',
        text:
          `[system-reminder] Anthropic's code_execution captured ${fileIds.length} file(s) ` +
          `during this turn. Their Files API ids — use these verbatim when calling drive_upload, ` +
          `do NOT use filenames or request_ids:\n` +
          fileIds.map((id) => `  - ${id}`).join('\n'),
      });
    }
    messages.push({ role: 'user', content: userContent });

    await opts.onStep?.({
      iteration: i + 1,
      toolUses: toolUseBlocks.map((b) => ({ name: b.name, input: b.input })),
      paused: false,
    });
  }

  throw new Error(
    `Agent loop exceeded maxIterations=${maxIterations} without ending. ` +
      `Tool calls so far: ${toolCalls.length}.`,
  );
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Walk the response and pull out every `file_id` from any
 *  `bash_code_execution_output` entry nested inside a
 *  `bash_code_execution_tool_result` block. Returns a deduped, ordered list. */
function extractCodeExecutionFileIds(content: Anthropic.ContentBlock[]): string[] {
  const ids = new Set<string>();
  for (const block of content) {
    if (block.type !== 'bash_code_execution_tool_result') continue;
    // The success branch is BashCodeExecutionResultBlock; the error branch
    // (BashCodeExecutionToolResultError) has no .content[]. Discriminate
    // before reading.
    const inner = block.content;
    if (!inner || inner.type !== 'bash_code_execution_result') continue;
    for (const out of inner.content ?? []) {
      if (out.type === 'bash_code_execution_output' && typeof out.file_id === 'string') {
        ids.add(out.file_id);
      }
    }
  }
  return [...ids];
}
