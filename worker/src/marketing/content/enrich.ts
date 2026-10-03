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
  /**
   * The WHOLE project catalog. A marketer (ريفا) posts about any developer's
   * project, and its relationship rows are a static seed — «أكنان 23» was in
   * the catalog but not in ريفا's 20-project scope, so it could never be a
   * candidate. Projects outside the publisher's scope join the candidate list
   * ONLY on a full-name match (or a series-word + number phrase): a lone word
   * or a bare number across 1,000 projects would be noise. Not every whole
   * name qualifies — see the catalog pass below. Pass brandPhrases with this:
   * it is how the matcher keeps «عزوم النرجس» (an organization's name + a
   * district) while refusing «مشروع النرجس» (generic + district).
   */
  catalog?: ProjectAlias[];
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
  if (opts.catalog && opts.catalog.length > 0) {
    const inScope = new Set(index.map((p) => p.projectId));
    const outside = opts.catalog.filter((p) => !inScope.has(p.projectId));
    // Empty scope on purpose: the matcher then refuses the names that are only
    // safe from their own publisher — a one-word name without a marker
    // («مشروع مدار», «Madar Tower») comes back as a weak 'word' (dropped by the
    // filter below), and a name of generic + place words («مشروع النرجس») or
    // generic words + a short number («ادوار 9») does not match at all. A name
    // carrying an organization's name («عزوم النرجس») still does.
    const extra = attributeCaption(combinedText, outside, {
      publisherProjectIds: [],
      commonTokens: opts.commonTokens,
      excludedTokens: opts.excludedTokens,
      brandPhrases: opts.brandPhrases,
    }).filter((c) => c.strength === 'full_name' || (c.strength === 'number' && c.matchedAliases.some((m) => /\D/.test(m))));
    for (const c of extra) { cands.push(c); }
    for (const p of outside) byId.set(p.projectId, p);
  }
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
