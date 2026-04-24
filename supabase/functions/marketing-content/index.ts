// Content orchestrator — workflow-driven edition.
//
// Invoked by a workflow `http_request` action once research-complete has
// landed. Reads the operation record to see which sub-agents to fire,
// then invokes marketing-reels / marketing-posts. Neither this function
// nor the sub-agents write to Postgres — all writes flow through
// workflows. Operation status tracking lives in the workflow layer.
//
// Deploy: supabase functions deploy marketing-content --no-verify-jwt

import { invokeFunction } from "../_shared/supabase.ts";
import {
  loadOperationRecord,
  getModelIdBySlug,
  countChildRecords,
} from "../_shared/marketingOperation.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: corsHeaders });

  try {
    const body = await req.json();
    const operationId = body.record_id ?? body.recordId ?? body.operationId ?? body.operation_id ?? "";
    if (!operationId) return json({ ok: false, error: "record_id missing" }, 400);

    const op = await loadOperationRecord(operationId);
    if (!op) return json({ ok: false, error: "operation not found" }, 404);

    // Re-entrancy guard — the workflow that calls us fires on every
    // research-complete webhook (clean pass AND resume pass), and
    // re-invoking when content already exists would duplicate every
    // reel/post. If any child records exist, skip.
    const reelsModelId = await getModelIdBySlug("reels");
    const postsModelId = await getModelIdBySlug("posts");
    if (reelsModelId && postsModelId) {
      const existingReels = await countChildRecords(reelsModelId, operationId);
      const existingPosts = await countChildRecords(postsModelId, operationId);
      if (existingReels > 0 || existingPosts > 0) {
        return json({ ok: true, skipped: "content already generated" });
      }
    }

    const tasks: Promise<void>[] = [];
    if (op.reelsCount > 0) {
      tasks.push(invokeFunction("marketing-reels", { record_id: operationId }));
    }
    if (op.postsCount > 0) {
      tasks.push(invokeFunction("marketing-posts", { record_id: operationId }));
    }
    await Promise.all(tasks);

    return json({ ok: true, fired: tasks.length });
  } catch (err) {
    console.error("[marketing-content] failed:", err);
    return json({ ok: false, error: (err as Error).message }, 500);
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
