// Reels writing agent — workflow-driven edition.
//
// Reads the operation record from the generic `records` table, generates
// `count` reels with Claude (prompt-cached competitors block), and POSTs
// one `reel-generated` webhook per reel so the matching workflow creates
// a reel record. Fires `reels-ready` after the batch. If the posts batch
// is already done (queried via records count), also fires `content-done`.
//
// Deploy: supabase functions deploy marketing-reels --no-verify-jwt

import { getAnthropic, CLAUDE_MODEL, MAX_TOKENS, extractFinalText, extractJson } from "../_shared/anthropic.ts";
import { REELS_PROMPT } from "../_shared/prompts.ts";
import { loadCompetitors, formatCompetitorsBlock } from "../_shared/competitors.ts";
import {
  researchOutputToMarkdown,
  loadProjectPayload,
  formatProjectFieldsAsMarkdown,
} from "../_shared/projectData.ts";
import {
  loadOperationRecord,
  getModelIdBySlug,
  countChildRecords,
} from "../_shared/marketingOperation.ts";
import { postToInbox } from "../_shared/webhookOutbox.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ReelsResult {
  reels?: Array<{
    type?: string;
    duration?: string;
    platform?: string;
    voiceover?: string;
    goal?: string;
    scenes?: Array<{ number: number; description?: string; text?: string }>;
  }>;
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
    if (op.reelsCount <= 0) return json({ ok: true, skipped: "no reels requested" });

    // Reconstruct the research-output markdown the prompt expects.
    // facts live directly on the operation record's data blob (populated
    // by the research-complete workflow).
    // deno-lint-ignore no-explicit-any
    const researchOutputShape: any = {
      facts: Array.isArray(op.raw.facts)
        ? (op.raw.facts as Array<Record<string, unknown>>).map((f) => ({
            dataType: f.data_type ?? "",
            value: f.value ?? "",
            source: f.source ?? "",
            sourceUrl: f.source_url ?? "",
            confidence: f.confidence ?? "",
          }))
        : [],
    };
    let projectInfo = researchOutputToMarkdown(researchOutputShape);
    if (!projectInfo) {
      const payload = await loadProjectPayload(op.projectRecordId);
      projectInfo = payload ? formatProjectFieldsAsMarkdown(payload) : "";
    }

    const competitors = await loadCompetitors("reel_script");
    const competitorsBlock = formatCompetitorsBlock(competitors);

    const userMessage = buildUserMessage(projectInfo, {
      count: op.reelsCount,
      type: op.reelsType,
      platform: op.reelsPlatform,
      voiceover: op.reelsVoiceover,
    }, competitorsBlock);

    const anthropic = getAnthropic();
    // deno-lint-ignore no-explicit-any
    const systemBlocks: any[] = [
      { type: "text", text: REELS_PROMPT, cache_control: { type: "ephemeral" } },
    ];
    if (competitorsBlock) {
      systemBlocks.push({
        type: "text",
        text: competitorsBlock,
        cache_control: { type: "ephemeral" },
      });
    }

    // deno-lint-ignore no-explicit-any
    const response: any = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      // deno-lint-ignore no-explicit-any
      system: systemBlocks as any,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = extractFinalText(response.content);
    if (!text) throw new Error("reels agent returned no text");
    const result = extractJson<ReelsResult>(text);
    const reels = result.reels ?? [];

    // Fan-out: one webhook per reel so the matching workflow creates
    // a single records row each.
    for (let i = 0; i < reels.length; i++) {
      const r = reels[i]!;
      await postToInbox("reel-generated", {
        record_id: operationId,
        operation_id: operationId,
        reel_number: i + 1,
        type: r.type ?? op.reelsType,
        duration: r.duration ?? "",
        platform: r.platform ?? op.reelsPlatform,
        voiceover: r.voiceover ?? op.reelsVoiceover,
        goal: r.goal ?? "",
        scenes: r.scenes ?? [],
      });
    }

    // Batch-done signal — flips reels_batch_done on the operation.
    await postToInbox("reels-ready", {
      record_id: operationId,
      operation_id: operationId,
      reels_count: reels.length,
    });

    // Completion check. Agents own this because workflows can't run
    // aggregate queries (counts across records). We recompute the
    // posts side from the generic records table; if both halves
    // match the operation's requested counts, fire content-done.
    await fireContentDoneIfComplete(operationId, op.reelsCount, op.postsCount);

    return json({ ok: true, reels: reels.length });
  } catch (err) {
    const msg = (err as Error).message ?? "unknown error";
    console.error("[marketing-reels] failed:", msg);
    if (operationId) {
      try {
        await postToInbox("operation-failed", {
          record_id: operationId,
          operation_id: operationId,
          stage: "reels",
          error: msg.slice(0, 500),
        });
      } catch {
        /* ignore */
      }
    }
    return json({ ok: false, error: msg.slice(0, 500) }, 500);
  }
});

function buildUserMessage(
  projectInfo: string,
  options: { count: number; type: string; platform: string; voiceover: string },
  competitorsBlock: string,
): string {
  let msg =
    `اكتب ${options.count} ريلز للمشروع التالي.\n\n` +
    `معلومات المشروع:\n${projectInfo}\n\n` +
    `المتطلبات:\n` +
    `- نوع الريل: ${options.type || "حسب المحتوى"}\n` +
    `- منصة الاستخدام: ${options.platform || "حسابات"}\n` +
    `- التعليق الصوتي: ${options.voiceover || "رجل"}\n\n` +
    `اختر أنت مدة الريل والهدف بناءً على المحتوى المتوفر.`;
  if (!competitorsBlock) {
    msg += "\n\n(لا توجد أمثلة منافسين للاسترشاد — اعتمد على معرفتك بأسلوب التسويق العقاري الفعال.)";
  }
  return msg;
}

async function fireContentDoneIfComplete(
  operationId: string,
  reelsRequested: number,
  postsRequested: number,
): Promise<void> {
  const reelsModelId = await getModelIdBySlug("reels");
  const postsModelId = await getModelIdBySlug("posts");
  if (!reelsModelId || !postsModelId) return;

  const reelsCreated = await countChildRecords(reelsModelId, operationId);
  const postsCreated = postsRequested > 0
    ? await countChildRecords(postsModelId, operationId)
    : 0;

  const reelsDone = reelsRequested <= 0 || reelsCreated >= reelsRequested;
  const postsDone = postsRequested <= 0 || postsCreated >= postsRequested;
  if (!reelsDone || !postsDone) return;

  await postToInbox("content-done", {
    record_id: operationId,
    operation_id: operationId,
    reels_count: reelsCreated,
    posts_count: postsCreated,
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
