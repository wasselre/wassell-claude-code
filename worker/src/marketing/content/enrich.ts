// ============================================================================
// DETERMINISTIC project narrowing for content enrichment. The publisher org's
// projects are matched against the combined evidence (caption + transcript +
// visual text) with the shared matcher (attributeCaption) to build a SMALL
// candidate set, each candidate labelled with HOW it matched (strength).
//
// The DECISION step (choose among candidates / general-branding / structured
// fields) is NOT here: it runs on the Claude Code runner (paid subscription) via
// the content-enrichment Skill — see scripts/claude-study-runner.mjs. The old
// Anthropic-API enrichContent() was DELETED on 2026-07-29 so the migrated path
// cannot silently fall back to paid API usage; if Claude Code is unavailable the
// posts simply stay 'awaiting_intelligence' and operations shows why.
//
// 2026-09-13: candidates now carry `strength` and `ambiguous`, brand / place /
// generic words are excluded as lone evidence, and the full project name is
// matched as a phrase first. The runner's validator refuses a pick on a weak
// candidate unless the skill quotes a concrete reference from the evidence.
// ============================================================================
import { attributeCaption, type AttributionCandidate, type ProjectAlias } from '../pipeline.js';

export const RULE_VERSION = 'enrich-v2';

export interface NarrowedCandidate {
  projectId: string;
  nameAr: string | null;
  nameEn: string | null;
  confidence: number;
  matchedAliases: string[];
  /** full_name | number | word — see AttributionCandidate.strength. */
  strength: AttributionCandidate['strength'];
  /** True when the match is a lone word (weak) OR several projects matched —
   *  the reader must find a concrete reference before choosing this one. */
  ambiguous: boolean;
}

export interface NarrowOptions {
  publisherProjectIds: string[];
  commonTokens: Set<string>;
  excludedTokens?: Set<string>;
  brandPhrases?: string[];
}

/** Deterministic narrowing: match combined evidence against the publisher's projects only. */
export function narrowProjects(combinedText: string, index: ProjectAlias[], opts: NarrowOptions): NarrowedCandidate[] {
  const cands = attributeCaption(combinedText, index, {
    publisherProjectIds: opts.publisherProjectIds,
    commonTokens: opts.commonTokens,
    excludedTokens: opts.excludedTokens,
    brandPhrases: opts.brandPhrases,
  });
  const byId = new Map<string, ProjectAlias>(index.map((p) => [p.projectId, p]));
  const strongCount = cands.filter((c) => c.strength !== 'word').length;
  return cands.map((c) => {
    const p = byId.get(c.projectId);
    return {
      projectId: c.projectId,
      nameAr: p?.nameAr ?? null,
      nameEn: p?.nameEn ?? null,
      confidence: c.confidence,
      matchedAliases: c.matchedAliases,
      strength: c.strength,
      ambiguous: c.strength === 'word' || strongCount >= 2,
    };
  }).sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

/** Legacy narrowing signature kept for callers that pre-date the shared
 *  context; identical to narrowProjects with no exclusions. */
export function narrowProjectsLegacy(combinedText: string, index: ProjectAlias[], pubProjectIds: string[], commonTokens: Set<string>): NarrowedCandidate[] {
  return narrowProjects(combinedText, index, { publisherProjectIds: pubProjectIds, commonTokens });
}
