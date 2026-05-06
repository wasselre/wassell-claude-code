// Loads competitor reference content from the generic `records` table
// (model.name = 'competitors') and formats it for injection into agent
// system prompts. Agents read this on each run so the library stays
// app-managed — admins edit via the standard record UI at
// /model/competitors, no redeploy needed.

import { getServiceClient } from "./supabase.ts";
import { getModelIdBySlug } from "./marketingOperation.ts";

export type CompetitorType = "reel_script" | "post_example";

export interface CompetitorRow {
  id: string;
  name: string;
  content: string;
}

/**
 * Load all competitors of the given type. Returns `[]` when none — callers
 * should treat that as "no competitor style reference this run" and fall
 * back to the agent's own knowledge.
 */
export async function loadCompetitors(type: CompetitorType): Promise<CompetitorRow[]> {
  const modelId = await getModelIdBySlug("competitors");
  if (!modelId) {
    console.warn("[loadCompetitors] competitors model not seeded");
    return [];
  }
  const sb = getServiceClient();
  // unified_records UNIONs JSONB records + frozen models' <name>_v views,
  // so this read keeps working whether `competitors` has been frozen or not.
  const { data, error } = await sb
    .from("unified_records")
    .select("id, data")
    .eq("model_id", modelId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error(`[loadCompetitors:${type}]`, error.message);
    return [];
  }
  return ((data ?? []) as Array<{ id: string; data: Record<string, unknown> }>)
    .filter((r) => String(r.data?.type ?? "") === type)
    .map((r) => ({
      id: r.id,
      name: String(r.data?.name ?? ""),
      content: String(r.data?.content ?? ""),
    }));
}

/**
 * Format competitors as a single text block suitable for the system prompt.
 * Returns `""` when there are no competitors — caller can conditionally
 * skip the extra system block.
 */
export function formatCompetitorsBlock(rows: CompetitorRow[]): string {
  if (!rows.length) return "";
  const parts: string[] = ["--- أمثلة من المنافسين للاسترشاد بالأسلوب فقط ---", ""];
  for (const row of rows) {
    parts.push(`### ${row.name}`);
    parts.push(row.content.trim());
    parts.push("");
  }
  parts.push("--- نهاية أمثلة المنافسين ---");
  return parts.join("\n");
}
