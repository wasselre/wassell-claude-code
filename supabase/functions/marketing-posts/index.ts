// Posts writing agent — workflow-driven edition.
//
// Mirror of marketing-reels for Instagram post copy. Reads the operation
// record, generates `count` posts with Claude, POSTs one `post-generated`
// webhook per post + one `posts-ready` batch signal, and fires
// `content-done` when BOTH halves (reels + posts) are complete.
//
// Deploy: supabase functions deploy marketing-posts --no-verify-jwt

import { getAnthropic, CLAUDE_MODEL, MAX_TOKENS, extractFinalText, extractJson } from "../_shared/anthropic.ts";
import { POSTS_PROMPT } from "../_shared/prompts.ts";
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

interface PostsResult {
  posts?: Array<{
    type?: string;
    components?: string;
    visual?: string;
    usage?: string;
    title?: string;
    designText1?: string;
    designText2?: string;
    designText3?: string;
    caption?: string;
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
    if (op.postsCount <= 0) return json({ ok: true, skipped: "no posts requested" });

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

    const competitors = await loadCompetitors("post_example");
    const competitorsBlock = formatCompetitorsBlock(competitors);

    const userMessage = buildUserMessage(projectInfo, {
      count: op.postsCount,
      type: op.postsType,
      usage: op.postsUsage,
    }, competitorsBlock);

    const anthropic = getAnthropic();
    // deno-lint-ignore no-explicit-any
    const systemBlocks: any[] = [
      { type: "text", text: POSTS_PROMPT, cache_control: { type: "ephemeral" } },
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
    if (!text) throw new Error("posts agent returned no text");
    const result = extractJson<PostsResult>(text);
    const posts = result.posts ?? [];

    for (let i = 0; i < posts.length; i++) {
      const p = posts[i]!;
      await postToInbox("post-generated", {
        record_id: operationId,
        operation_id: operationId,
        post_number: i + 1,
        type: p.type ?? op.postsType,
        components: p.components ?? "",
        visual: p.visual ?? "",
        usage: p.usage ?? op.postsUsage,
        title: p.title ?? "",
        design_text_1: p.designText1 ?? "",
        design_text_2: p.designText2 ?? "",
        design_text_3: p.designText3 ?? "",
        caption: p.caption ?? "",
      });
    }

    await postToInbox("posts-ready", {
      record_id: operationId,
      operation_id: operationId,
      posts_count: posts.length,
    });

    await fireContentDoneIfComplete(operationId, op.reelsCount, op.postsCount);

    return json({ ok: true, posts: posts.length });
  } catch (err) {
    const msg = (err as Error).message ?? "unknown error";
    console.error("[marketing-posts] failed:", msg);
    if (operationId) {
      try {
        await postToInbox("operation-failed", {
          record_id: operationId,
          operation_id: operationId,
          stage: "posts",
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
  options: { count: number; type: string; usage: string },
  competitorsBlock: string,
): string {
  let msg =
    `اكتب ${options.count} منشورات انستقرام للمشروع التالي.\n\n` +
    `معلومات المشروع:\n${projectInfo}\n\n` +
    `المتطلبات:\n` +
    `- نوع المنشور: ${options.type || "حسب المحتوى"}\n` +
    `- استخدامات المنشور: ${options.usage || "الحسابات"}\n\n` +
    `اختر أنت مكونات المنشور والعنصر البصري المطلوب بناءً على المحتوى.`;
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

  const reelsCreated = reelsRequested > 0
    ? await countChildRecords(reelsModelId, operationId)
    : 0;
  const postsCreated = await countChildRecords(postsModelId, operationId);

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
