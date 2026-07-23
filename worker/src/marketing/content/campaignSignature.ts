// ============================================================================
// Deterministic campaign-grouping signature (Phase 6, pure + unit-tested).
//
// A campaign key = sha256(org | project | distinguishing-signal). The
// distinguishing signal is the normalized OFFER, else the campaign MESSAGE, else
// the OBJECTIVE — so two different offers for the same project are two campaigns
// and "same org/project alone" is NEVER enough to group. Items with no project
// (general branding) produce no signature (not campaigned).
// ============================================================================
import { sha256Hex } from '../adIntel.js';

/** Normalize a free-text signal for stable hashing (lowercase, strip punctuation, collapse ws). */
export function normalizeSignal(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKC')
    .replace(/[ـً-ْ]/g, '')                 // Arabic tatweel + harakat
    .replace(/[^\p{L}\p{N}\s%]/gu, ' ')       // keep letters/numbers/%/space
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 120);
}

export interface EnrichmentLike {
  is_general_branding?: boolean;
  offer?: string | null;
  payment_plan?: string | null;
  campaign_message?: string | null;
  objective?: string | null;
  content_type?: string | null;
  ctas?: string[] | null;
}

/** The single distinguishing signal used in the signature, or null if none. */
export function distinguishingSignal(e: EnrichmentLike): { kind: string; value: string } | null {
  for (const [kind, raw] of [['offer', e.offer], ['payment_plan', e.payment_plan], ['message', e.campaign_message], ['objective', e.objective]] as const) {
    const n = normalizeSignal(raw);
    if (n.length >= 4) return { kind, value: n };
  }
  return null;
}

/**
 * Campaign signature for an item, or null if it cannot be campaigned (no project,
 * or general branding, or no distinguishing signal — a lone project with nothing
 * distinctive must NOT collapse unrelated posts into one campaign).
 */
export function campaignSignature(orgId: string, projectId: string | null, e: EnrichmentLike): { signature: string; distinguishing: { kind: string; value: string } } | null {
  if (!projectId || e.is_general_branding) return null;
  const d = distinguishingSignal(e);
  if (!d) return null;
  return { signature: sha256Hex(Buffer.from(`${orgId}|${projectId}|${d.kind}:${d.value}`, 'utf8')).slice(0, 24), distinguishing: d };
}

/** Confidence from the corroborating signals present in a campaign. */
export function groupingConfidence(opts: { members: number; platforms: number; reusedCreatives: number; hasOffer: boolean }): number {
  let c = 0.5;                          // project + a distinguishing signal
  if (opts.members >= 2) c += 0.2;      // corroborated by ≥2 items
  if (opts.platforms >= 2) c += 0.2;    // genuinely cross-platform
  if (opts.reusedCreatives > 0) c += 0.15; // an identical creative reused
  if (opts.hasOffer) c += 0.05;
  return Math.min(1, Math.round(c * 100) / 100);
}
