// Research resume agent — workflow-driven edition.
//
// Triggered by an `on_update research_questions` workflow when the user
// fills in an answer. The workflow can fire repeatedly (once per answer)
// because this function is idempotent: if any question is still
// unanswered it returns a 400 and does nothing. Only the final call —
// when the last answer is saved — does real work.
//
// Pure read-only on Postgres. All state changes happen via the
// `research-complete` webhook (same slug as the clean-research path, so
// the downstream workflow is shared).
//
// Deploy: supabase functions deploy marketing-research-resume --no-verify-jwt

import { getServiceClient } from "../_shared/supabase.ts";
import { getAnthropic, CLAUDE_MODEL, MAX_TOKENS, extractFinalText, extractJson } from "../_shared/anthropic.ts";
import { RESEARCH_RESUME_PROMPT } from "../_shared/prompts.ts";
import { loadOperationRecord, getModelIdBySlug } from "../_shared/marketingOperation.ts";
import { postToInbox } from "../_shared/webhookOutbox.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ResumeResult {
  projectInfo?: Array<{
    dataType: string;
    value: string;
    source?: string;
    sourceUrl?: string;
    confidence?: string;
  }>;
  sources?: Array<{ url: string; title?: string; type?: string; reliability?: string }>;
  notFound?: string[];
  confidence?: string;
  researchNotes?: string;
}

interface QuestionRow {
  data: {
    operation?: string;
    question?: string;
    source_conflict?: string;
    answer?: string;
    status?: string;
    question_number?: number;
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: corsHeaders });

  let operationId = "";
  try {
    const body = await req.json();
    operationId = body.record_id ?? body.recordId ?? body.operationId ?? body.operation_id ?? "";
    if (!operationId) return json({ ok: false, error: "record_id missing" }, 400);

    // When the workflow fires on `on_update research_questions`, it passes
    // the updated question record's `operation` lookup value as record_id —
    // that's already the operation id. When triggered directly via a
    // webhook with the operation id, it's the same value. Either way we
    // look up the operation by id.
    const op = await loadOperationRecord(operationId);
    if (!op) return json({ ok: false, error: "operation record not found" }, 404);

    // Pull all research_questions records tied to this operation and
    // check whether any answer is still blank. This is the idempotency
    // gate: the workflow fires once per answered question, and only the
    // LAST firing passes here.
    const questionsModelId = await getModelIdBySlug("research_questions");
    if (!questionsModelId) return json({ ok: false, error: "research_questions model not seeded" }, 500);

    const sb = getServiceClient();
    const { data: questions, error: qErr } = await sb
      .from("records")
      .select("data")
      .eq("model_id", questionsModelId)
      .contains("data", { operation: operationId });
    if (qErr) return json({ ok: false, error: qErr.message }, 500);

    const rows = ((questions ?? []) as QuestionRow[])
      .map((r) => r.data)
      .sort((a, b) => (a.question_number ?? 0) - (b.question_number ?? 0));
    if (rows.length === 0) return json({ ok: false, error: "no questions for operation" }, 400);

    const unanswered = rows.filter((q) => !q.answer || String(q.answer).trim() === "");
    if (unanswered.length > 0) {
      // Not an error — the workflow will fire again when the next
      // answer arrives. We just noop.
      return json({ ok: true, skipped: `${unanswered.length} unanswered questions` });
    }

    // Reconstruct the draft research JSON from the existing operation
    // record so the resume prompt has the same context it had in the
    // old pipeline (facts + sources + notes that survived contradictions).
    const draftJson = JSON.stringify(
      {
        facts: op.raw.facts ?? [],
        sources: op.raw.sources ?? [],
        notFound: op.raw.not_found ?? "",
        confidence: op.raw.confidence ?? "medium",
        researchNotes: op.raw.research_notes ?? "",
      },
      null,
      2,
    );
    const answersText = rows
      .map((q) => `سؤال: ${q.question ?? ""}\nالمصدر: ${q.source_conflict ?? ""}\nالإجابة: ${q.answer ?? ""}`)
      .join("\n\n");

    const userMessage =
      `هذا هو البحث الأولي عن المشروع:\n\n${draftJson}\n\nوهذه إجابات الأسئلة التي طرحتها:\n\n${answersText}\n\nأنتج الآن الملف النهائي لمعلومات المشروع بدون أي تعارضات أو ملاحظات.`;

    const anthropic = getAnthropic();
    // deno-lint-ignore no-explicit-any
    const response: any = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: RESEARCH_RESUME_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = extractFinalText(response.content);
    if (!text) throw new Error("resume agent returned no text");
    const result = extractJson<ResumeResult>(text);

    const facts = (result.projectInfo ?? []).map((f) => ({
      data_type: f.dataType,
      value: f.value,
      source: f.source ?? "",
      source_url: f.sourceUrl ?? "",
      confidence: f.confidence ?? "high",
    }));
    const sources = (result.sources ?? []).map((s) => ({
      url: s.url,
      title: s.title ?? "",
      type: s.type ?? "",
      reliability: s.reliability ?? "high",
    }));

    // Reuse the same webhook slug as the clean-research path — the
    // workflow downstream doesn't care whether the facts came from the
    // first pass or the resume pass.
    await postToInbox("research-complete", {
      record_id: operationId,
      operation_id: operationId,
      stage: "resume",
      facts,
      sources,
      not_found: (result.notFound ?? []).join("\n"),
      confidence: result.confidence ?? "high",
      research_notes: result.researchNotes ?? "",
    });

    return json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message ?? "unknown error";
    console.error("[marketing-research-resume] failed:", msg);
    if (operationId) {
      try {
        await postToInbox("operation-failed", {
          record_id: operationId,
          operation_id: operationId,
          stage: "resume",
          error: msg.slice(0, 500),
        });
      } catch {
        /* ignore */
      }
    }
    return json({ ok: false, error: msg.slice(0, 500) }, 500);
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
