// ============================================================================
// DETERMINISTIC project narrowing for content enrichment. The publisher org's
// linked projects are matched against the combined evidence (caption +
// transcript + visual text) with the existing matcher (attributeCaption) to
// build a SMALL candidate set.
//
// The DECISION step (choose among candidates / general-branding / structured
// fields) is NOT here: it runs on the Claude Code runner (paid subscription) via
// the content-enrichment Skill — see scripts/claude-study-runner.mjs. The old
// Anthropic-API enrichContent() was DELETED on 2026-07-29 so the migrated path
// cannot silently fall back to paid API usage; if Claude Code is unavailable the
// posts simply stay 'awaiting_intelligence' and operations shows why.
// ============================================================================
import { attributeCaption, type ProjectAlias } from '../pipeline.js';

export const RULE_VERSION = 'enrich-v1';

export interface NarrowedCandidate { projectId: string; nameAr: string | null; nameEn: string | null; confidence: number; matchedAliases: string[] }

/** Deterministic narrowing: match combined evidence against the publisher's projects only. */
export function narrowProjects(combinedText: string, index: ProjectAlias[], pubProjectIds: string[], commonTokens: Set<string>): NarrowedCandidate[] {
  const cands = attributeCaption(combinedText, index, { publisherProjectIds: pubProjectIds, commonTokens });
  const byId = new Map<string, ProjectAlias>(index.map((p) => [p.projectId, p]));
  return cands.map((c) => {
    const p = byId.get(c.projectId);
    return { projectId: c.projectId, nameAr: p?.nameAr ?? null, nameEn: p?.nameEn ?? null, confidence: c.confidence, matchedAliases: c.matchedAliases };
  }).sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}
