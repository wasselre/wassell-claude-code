// Research agent — workflow-driven edition.
//
// This function is idempotent: it NEVER writes to Postgres. It reads the
// trigger operation record from the generic `records` table, runs the
// Anthropic tool-use loop (web_search + fetch_url), and POSTs webhooks
// back into the app. User-editable workflows then turn those webhooks
// into record writes via the workflow engine.
//
// Input body: `{ "record_id": "<operation uuid>" }`. Accepts the legacy
// `{ operationId }` alias for convenience when the workflow action uses
// the older token name.
//
// Deploy: supabase functions deploy marketing-research --no-verify-jwt
// (Called from the frontend via a workflow `http_request` action.)

import { getAnthropic, CLAUDE_MODEL, MAX_TOKENS, extractFinalText, extractJson } from "../_shared/anthropic.ts";
import { RESEARCH_PROMPT } from "../_shared/prompts.ts";
import { loadProjectPayload, buildResearchMessage } from "../_shared/projectData.ts";
import { FETCH_URL_TOOL_SCHEMA, fetchUrl } from "../_shared/web.ts";
import { loadOperationRecord } from "../_shared/marketingOperation.ts";
import { postToInbox } from "../_shared/webhookOutbox.ts";

// Supabase free-tier edge functions are killed at 150 s of wall clock. A
// full tool-use loop with web_search + several fetch_url rounds per
// iteration can blow past that on complex projects, so we cap iterations
// conservatively. The agent returns early as soon as Claude emits an
// `end_turn` — this is just the upper bound before we force a JSON
// submission.
const MAX_AGENT_ITERATIONS = 6;

// Structured-output tool — used as a forced-tool retry when the model
// ignores "JSON only" and emits prose on the first pass. Anthropic
// guarantees the tool input matches the schema, which is equivalent to
// guaranteed JSON.
const SUBMIT_RESEARCH_TOOL = {
  name: "submit_research_findings",
  description:
    "Submit the final, structured research findings about the project. Call this when you are done gathering information. The input shape is the JSON output format specified in the system prompt.",
  input_schema: {
    type: "object",
    properties: {
      projectInfo: {
        type: "array",
        items: {
          type: "object",
          properties: {
            dataType: { type: "string" },
            value: { type: "string" },
            source: { type: "string" },
            sourceUrl: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["dataType", "value"],
        },
      },
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            type: { type: "string" },
            reliability: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["url"],
        },
      },
      contradictions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            version1: {
              type: "object",
              properties: {
                value: { type: "string" },
                source: { type: "string" },
                sourceUrl: { type: "string" },
              },
            },
            version2: {
              type: "object",
              properties: {
                value: { type: "string" },
                source: { type: "string" },
                sourceUrl: { type: "string" },
              },
            },
            question: { type: "string" },
          },
          required: ["question"],
        },
      },
      notFound: { type: "array", items: { type: "string" } },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      researchNotes: { type: "string" },
    },
    required: ["projectInfo"],
  },
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ResearchResult {
  projectInfo?: Array<{
    dataType: string;
    value: string;
    source?: string;
    sourceUrl?: string;
    confidence?: string;
  }>;
  sources?: Array<{ url: string; title?: string; type?: string; reliability?: string }>;
  contradictions?: Array<{
    field: string;
    version1?: { value: string; source: string; sourceUrl?: string };
    version2?: { value: string; source: string; sourceUrl?: string };
    question: string;
  }>;
  notFound?: string[];
  confidence?: string;
  researchNotes?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: corsHeaders });

  let operationId = "";
  try {
    const body = await req.json();
    operationId = body.record_id ?? body.recordId ?? body.operationId ?? body.operation_id ?? "";
    if (!operationId) return json({ ok: false, error: "record_id missing" }, 400);

    const op = await loadOperationRecord(operationId);
    if (!op) return json({ ok: false, error: "operation record not found" }, 404);

    const payload = await loadProjectPayload(op.projectRecordId);
    if (!payload) {
      await failOperation(operationId, "project record not found");
      return json({ ok: false, error: "project record not found" }, 404);
    }

    // Run the tool-use loop in the BACKGROUND and return the HTTP response
    // immediately. Two reasons:
    //   1. Research takes 30-120 s for complex projects. Supabase free-tier
    //      edge functions get 502'd by the gateway at ~150 s of wall clock,
    //      so we can't afford to hold the response open that long.
    //   2. The workflow engine's http_request action has a 60 s timeout and
    //      was marking every research invocation as "failed" even though
    //      the agent eventually finished and fired webhooks out-of-band.
    // EdgeRuntime.waitUntil keeps the isolate alive for the background work
    // so it can finish and POST webhooks after the response has returned.
    const work = runAndDispatch(operationId, payload);
    // deno-lint-ignore no-explicit-any
    const runtime = (globalThis as any).EdgeRuntime;
    if (runtime && typeof runtime.waitUntil === "function") {
      runtime.waitUntil(work);
    } else {
      // Local dev fallback — no EdgeRuntime, just await inline.
      await work;
    }

    return json({ ok: true, status: "queued" });
  } catch (err) {
    const msg = (err as Error).message ?? "unknown error";
    console.error("[marketing-research] failed:", msg);
    if (operationId) await failOperation(operationId, msg.slice(0, 500));
    return json({ ok: false, error: msg.slice(0, 500) }, 500);
  }
});

async function runAndDispatch(
  operationId: string,
  payload: ReturnType<typeof loadProjectPayload> extends Promise<infer T> ? T : never,
): Promise<void> {
  try {
    const result = await runResearchLoop(payload);

    const contradictions = result.contradictions ?? [];
    const facts = (result.projectInfo ?? []).map((f) => ({
      data_type: f.dataType,
      value: f.value,
      source: f.source ?? "",
      source_url: f.sourceUrl ?? "",
      confidence: f.confidence ?? "medium",
    }));
    const sources = (result.sources ?? []).map((s) => ({
      url: s.url,
      title: s.title ?? "",
      type: s.type ?? "",
      reliability: s.reliability ?? "medium",
    }));
    const notFoundText = (result.notFound ?? []).join("\n");

    if (contradictions.length > 0) {
      for (let i = 0; i < contradictions.length; i++) {
        const c = contradictions[i]!;
        await postToInbox("research-question", {
          record_id: operationId,
          operation_id: operationId,
          question_number: i + 1,
          question: c.question,
          source_conflict: formatContradictionSources(c),
        });
      }
      await postToInbox("research-contradictions", {
        record_id: operationId,
        operation_id: operationId,
        contradictions_count: contradictions.length,
        facts,
        sources,
        not_found: notFoundText,
        confidence: result.confidence ?? "medium",
        research_notes: result.researchNotes ?? "",
      });
      return;
    }

    await postToInbox("research-complete", {
      record_id: operationId,
      operation_id: operationId,
      facts,
      sources,
      not_found: notFoundText,
      confidence: result.confidence ?? "medium",
      research_notes: result.researchNotes ?? "",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[marketing-research] background failed:", msg);
    await failOperation(operationId, msg.slice(0, 500));
  }
}

async function runResearchLoop(payload: ReturnType<typeof loadProjectPayload> extends Promise<infer T> ? T : never): Promise<ResearchResult> {
  if (!payload) throw new Error("payload null");
  const anthropic = getAnthropic();
  const userMessage = buildResearchMessage(payload);

  // deno-lint-ignore no-explicit-any
  const messages: any[] = [{ role: "user", content: userMessage }];

  for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
    // deno-lint-ignore no-explicit-any
    const response: any = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: RESEARCH_PROMPT,
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 10 },
        FETCH_URL_TOOL_SCHEMA,
        // deno-lint-ignore no-explicit-any
      ] as any,
      messages,
    });

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });
      // deno-lint-ignore no-explicit-any
      const results: any[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        if (block.name === "fetch_url") {
          const url = (block.input as { url?: string }).url ?? "";
          const text = await fetchUrl(url);
          results.push({ type: "tool_result", tool_use_id: block.id, content: text });
        } else if (block.name === "web_search") {
          // Server-side tool — API echoes results automatically.
          continue;
        } else {
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `[unknown tool: ${block.name}]`,
            is_error: true,
          });
        }
      }
      if (results.length > 0) {
        messages.push({ role: "user", content: results });
      }
      continue;
    }

    const text = extractFinalText(response.content);
    if (!text) throw new Error("research agent returned no text");
    try {
      return extractJson<ResearchResult>(text);
    } catch (parseErr) {
      console.warn(
        "[marketing-research] final text was not JSON, retrying with tool_choice. First 200 chars:",
        text.slice(0, 200),
      );
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content:
          "Your previous reply was not valid JSON. Re-emit the SAME findings by calling submit_research_findings. Do not repeat the research — just wrap the information you already have in the tool call.",
      });
      // deno-lint-ignore no-explicit-any
      const forced: any = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: RESEARCH_PROMPT,
        // deno-lint-ignore no-explicit-any
        tools: [SUBMIT_RESEARCH_TOOL] as any,
        // deno-lint-ignore no-explicit-any
        tool_choice: { type: "tool", name: "submit_research_findings" } as any,
        messages,
      });
      const submitBlock = forced.content.find(
        (b: { type: string; name?: string }) =>
          b.type === "tool_use" && b.name === "submit_research_findings",
      );
      if (submitBlock && typeof submitBlock === "object" && "input" in submitBlock) {
        return submitBlock.input as ResearchResult;
      }
      throw new Error(
        `Research agent did not return valid JSON and forced-tool retry also failed. Original: ${(parseErr as Error).message}`,
      );
    }
  }

  throw new Error("research agent exceeded max iterations");
}

function formatContradictionSources(c: {
  version1?: { value: string; source: string };
  version2?: { value: string; source: string };
}): string {
  const parts: string[] = [];
  if (c.version1) parts.push(`${c.version1.source}: ${c.version1.value}`);
  if (c.version2) parts.push(`${c.version2.source}: ${c.version2.value}`);
  return parts.join(" | ");
}

async function failOperation(operationId: string, error: string): Promise<void> {
  try {
    await postToInbox("operation-failed", {
      record_id: operationId,
      operation_id: operationId,
      stage: "research",
      error,
    });
  } catch {
    /* ignore */
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
