// Reads a marketing-operations record out of the generic `records` table.
// The old pipeline used a dedicated `marketing_operations` Postgres table;
// this helper is the single-source adapter for the workflow-driven pipeline
// where every domain model (marketing_operations, reels, posts, …) lives in
// the shared `records` JSONB table keyed by `model_id`.
//
// Agents never write to records — they only READ to gather context and then
// POST webhooks. All record writes happen through user-editable workflows
// in src/lib/workflowEngine.ts.

import { getServiceClient } from "./supabase.ts";

export interface OperationRecord {
  id: string;
  model_id: string;
  // Flat mirror of `record.data` for the fields the agents consume.
  projectRecordId: string;
  status: string;
  reelsCount: number;
  reelsType: string;
  reelsPlatform: string;
  reelsVoiceover: string;
  postsCount: number;
  postsType: string;
  postsUsage: string;
  reelsBatchDone: boolean;
  postsBatchDone: boolean;
  // Raw `data` blob — agents can scan it for fields not surfaced above.
  raw: Record<string, unknown>;
}

export async function loadOperationRecord(operationId: string): Promise<OperationRecord | null> {
  const sb = getServiceClient();
  const { data, error } = await sb
    .from("records")
    .select("id, model_id, data")
    .eq("id", operationId)
    .single();
  if (error || !data) {
    console.error("[loadOperationRecord]", error?.message ?? "not found");
    return null;
  }
  const d = (data.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    id: data.id,
    model_id: data.model_id,
    projectRecordId: str(d.project),
    status: str(d.status),
    reelsCount: num(d.reels_count),
    reelsType: str(d.reels_type),
    reelsPlatform: str(d.reels_platform),
    reelsVoiceover: str(d.reels_voiceover),
    postsCount: num(d.posts_count),
    postsType: str(d.posts_type),
    postsUsage: str(d.posts_usage),
    reelsBatchDone: d.reels_batch_done === true,
    postsBatchDone: d.posts_batch_done === true,
    raw: d,
  };
}

/**
 * Look up the model id for a given system-model slug (name). We keep agent
 * code free of hardcoded model UUIDs because those are per-install — the
 * seed loader in `src/data/seedModels.ts` re-generates them on first boot.
 * The `name` column in `models` is UNIQUE and stable, so it's the right
 * lookup key.
 */
export async function getModelIdBySlug(slug: string): Promise<string | null> {
  const sb = getServiceClient();
  const { data, error } = await sb
    .from("models")
    .select("id")
    .eq("name", slug)
    .single();
  if (error || !data) {
    console.error(`[getModelIdBySlug:${slug}]`, error?.message ?? "not found");
    return null;
  }
  return data.id as string;
}

/**
 * Count records of a given model_id whose `data.operation` field equals the
 * given operation id. Used by the content agents to decide whether BOTH
 * halves of a batch are complete so they can fire the `content-done` webhook.
 */
export async function countChildRecords(modelId: string, operationId: string): Promise<number> {
  const sb = getServiceClient();
  const { count, error } = await sb
    .from("records")
    .select("id", { count: "exact", head: true })
    .eq("model_id", modelId)
    .contains("data", { operation: operationId });
  if (error) {
    console.error("[countChildRecords]", error.message);
    return 0;
  }
  return count ?? 0;
}
