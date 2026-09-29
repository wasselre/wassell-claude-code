import {
  type Placement, type LocationItemDTO, type VerifierResultDTO, type DistrictInfo,
} from '@/pages/GeoGrade/lib/shared';
import { placementLine, verifierMentionLine } from '@/pages/GeoGrade/lib/placementLine';
import type { PrunableExpression } from '@/lib/geo/pruneGeoExpression';

/**
 * The geography card's lines — ONE implementation shared by the chat's own
 * places (GeoPrefCard) and the call audit's places (CallAuditSection), so a
 * rep reads the same sentence for the same placement in both. PURE.
 */

export type GeoCardStatus =
  | 'none' | 'empty'
  | 'pending' | 'confirmed' | 'edited' | 'rejected' | 'applied' | 'superseded' | 'must_confirm';

/** api/_lib/geoPreference/chatCard.ts ChatCardProposal. */
export interface GeoCardProposalDTO {
  id: string;
  version: number | null;
  status: string;
  proposed_action: string;
  expression: PrunableExpression;
  by_evidence: Record<string, Placement>;
  items: LocationItemDTO[];
  items_by_evidence: Record<string, LocationItemDTO[]>;
  verifier: VerifierResultDTO | null;
}

/** api/_lib/geoPreference/chatCard.ts ChatCard. */
export interface GeoCardDTO {
  status: GeoCardStatus;
  checkpoint_id: string | null;
  proposal: GeoCardProposalDTO | null;
  mentions: Array<{ evidence_id: string; mention_span: string; preference_role: string }>;
  names: Record<string, DistrictInfo>;
  analyzed_at: string | null;
  stale: boolean;
  graded: boolean;
  can_reanalyze: boolean;
  customer_messages: number;
}

export interface GeoRow {
  evidenceId: string;
  span: string;
  placement: Placement;
  line: { text: string; tone: 'ok' | 'none' | 'warn' };
  /** Unresolved placements are bare names, not real places — never saved. */
  savable: boolean;
  doubt: string | null;
}

/** Proposal statuses a rep can still act on / that mean "saved". */
export const GEO_OPEN = new Set(['pending', 'must_confirm']);
export const GEO_SAVED = new Set(['confirmed', 'edited', 'applied']);

/** One row per mention the proposal put on the map, in mention order, with the verifier's doubt when it has one. */
export function buildGeoRows(card: GeoCardDTO | null, isAr: boolean): GeoRow[] {
  const p = card?.proposal;
  if (!card || !p) return [];
  const doubts = new Map((p.verifier?.mentions ?? []).map((m) => [m.evidence_id, m]));
  const out: GeoRow[] = [];
  for (const m of card.mentions) {
    const placement = p.by_evidence[m.evidence_id];
    if (!placement) continue; // nothing on the map for this mention — nothing to save
    const v = doubts.get(m.evidence_id);
    const vl = v ? verifierMentionLine(v, isAr) : null;
    out.push({
      evidenceId: m.evidence_id,
      span: m.mention_span,
      placement,
      line: placementLine(placement, m.preference_role, card.names, isAr),
      savable: placement.resolved,
      doubt: vl && vl.tone === 'warn' ? vl.text : null,
    });
  }
  return out;
}
