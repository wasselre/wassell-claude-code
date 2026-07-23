// ============================================================================
// Content enrichment (Phase 7) + project selection. DETERMINISTIC-FIRST: we
// never send the whole project catalog to the LLM. The publisher org's linked
// projects are matched against the combined evidence (caption + transcript +
// visual text) with the existing deterministic matcher (attributeCaption) to
// build a SMALL candidate set; Claude only STRUCTURES the content and CHOOSES
// among the already-narrowed candidates (or picks none for general branding).
// ============================================================================
import Anthropic from '@anthropic-ai/sdk';
import { attributeCaption, type ProjectAlias } from '../pipeline.js';

const MODEL = process.env.MKT_ENRICH_MODEL ?? 'claude-sonnet-4-6';
export const RULE_VERSION = 'enrich-v1';

export interface NarrowedCandidate { projectId: string; nameAr: string | null; nameEn: string | null; confidence: number; matchedAliases: string[] }
export interface EnrichmentResult {
  primaryProjectId: string | null;
  candidates: NarrowedCandidate[];
  result: Record<string, unknown>;
  model: string; costUsd: number;
}

/** Deterministic narrowing: match combined evidence against the publisher's projects only. */
export function narrowProjects(combinedText: string, index: ProjectAlias[], pubProjectIds: string[], commonTokens: Set<string>): NarrowedCandidate[] {
  const cands = attributeCaption(combinedText, index, { publisherProjectIds: pubProjectIds, commonTokens });
  const byId = new Map<string, ProjectAlias>(index.map((p) => [p.projectId, p]));
  return cands.map((c) => {
    const p = byId.get(c.projectId);
    return { projectId: c.projectId, nameAr: p?.nameAr ?? null, nameEn: p?.nameEn ?? null, confidence: c.confidence, matchedAliases: c.matchedAliases };
  }).sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

const TOOL: Anthropic.Tool = {
  name: 'record_enrichment',
  description: 'Structure the marketing content and choose which of the provided candidate projects (if any) it promotes.',
  input_schema: {
    type: 'object',
    properties: {
      primary_project_index: { type: 'integer', description: 'Index into the provided candidate project list that this content primarily promotes, or -1 if it is general company branding with no specific project.' },
      content_type: { type: 'string', description: 'e.g. project_launch, offer, walkthrough, testimonial, brand, event, teaser' },
      objective: { type: 'string', description: 'What the content is trying to achieve.' },
      is_general_branding: { type: 'boolean' },
      offer: { type: 'string' },
      financing: { type: 'string' },
      payment_plan: { type: 'string' },
      price: { type: 'string' },
      unit_types: { type: 'array', items: { type: 'string' } },
      location: { type: 'string' },
      district: { type: 'string' },
      amenities: { type: 'array', items: { type: 'string' } },
      selling_points: { type: 'array', items: { type: 'string' } },
      ctas: { type: 'array', items: { type: 'string' } },
      audience: { type: 'string' },
      language: { type: 'string', description: 'ar | en | mixed' },
      campaign_message: { type: 'string', description: 'One-line core message.' },
    },
    required: ['primary_project_index', 'content_type', 'is_general_branding', 'language'],
  },
};

/** Enrich one post. Claude only picks among the narrowed candidates — never invents a project. */
export async function enrichContent(input: {
  accountIdentity: string; platform: string; caption: string; transcript: string; visualText: string;
  candidates: NarrowedCandidate[];
}): Promise<EnrichmentResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const { candidates } = input;
  if (!apiKey || apiKey === 'stub') {
    return { primaryProjectId: candidates[0]?.projectId ?? null, candidates, result: { content_type: 'brand', is_general_branding: candidates.length === 0, language: 'ar' }, model: 'stub', costUsd: 0 };
  }
  const client = new Anthropic({ apiKey });
  const candList = candidates.map((c, i) => `${i}: ${c.nameAr ?? ''} / ${c.nameEn ?? ''}`).join('\n') || '(none)';
  const prompt = [
    `Publisher: ${input.accountIdentity} on ${input.platform}.`,
    `Candidate projects (choose primary_project_index among these, or -1 for general branding):`,
    candList,
    `\nCaption:\n${input.caption.slice(0, 2000)}`,
    `\nTranscript:\n${input.transcript.slice(0, 4000)}`,
    `\nVisible text from images/frames:\n${input.visualText.slice(0, 3000)}`,
    `\nStructure this content. Only choose a primary_project_index that appears in the candidate list above; if the evidence does not clearly point to one of them, return -1 (general branding). Do not invent projects, prices, or offers not present in the evidence.`,
    `IMPORTANT: national days (يوم التأسيس / اليوم الوطني / Founding Day), sports/match support, leadership/allegiance, quality certifications, and pure brand-value posts are GENERAL BRANDING (primary_project_index = -1, is_general_branding = true) EVEN IF a candidate project name appears in the media. Many developers name their projects after their own brand, so a brand logo or tagline that merely echoes the developer's name (as in "${input.accountIdentity}") is NOT evidence of a specific numbered project — require a CONCRETE project reference (a project-specific name that is not just the brand word, a unit/price/offer/payment plan, or a district tied to that project) before choosing a primary_project_index.`,
  ].join('\n');

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 1500,
    tools: [TOOL], tool_choice: { type: 'tool', name: 'record_enrichment' },
    messages: [{ role: 'user', content: prompt }],
  });
  const block = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const out = (block?.input ?? {}) as Record<string, unknown> & { primary_project_index?: number };
  const idx = typeof out.primary_project_index === 'number' ? out.primary_project_index : -1;
  const primaryProjectId = idx >= 0 && idx < candidates.length ? candidates[idx]!.projectId : null;
  const costUsd = Math.round((msg.usage.input_tokens * 3e-6 + msg.usage.output_tokens * 1.5e-5) * 10000) / 10000;
  const { primary_project_index: _drop, ...result } = out;
  return { primaryProjectId, candidates, result, model: MODEL, costUsd };
}
