import {
  type Placement, type LocationItemDTO, type VerifierResultDTO, type DistrictInfo,
} from '@/pages/GeoGrade/lib/shared';
import { placementLine, placementSavable, sideClipStateOf, verifierMentionLine } from '@/pages/GeoGrade/lib/placementLine';
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
  /** The row's key — the FIRST mention that put this place on the map. */
  evidenceId: string;
  /**
   * Every mention that put the SAME place on the map (the customer named it
   * twice). One row is shown; un-ticking it must drop all of them, or the
   * hidden twin keeps the place in the saved expression.
   */
  evidenceIds: string[];
  span: string;
  placement: Placement;
  line: { text: string; tone: 'ok' | 'none' | 'warn' };
  /**
   * Unresolved placements are bare names, not real places — never saved. Nor is
   * a side clip with no part on that side (review.ts saves nothing for it).
   */
  savable: boolean;
  /**
   * Why a RESOLVED place is still not savable — a side clip with nothing on that
   * side ('side_empty') or whose part was never computed ('side_missing'), or a
   * road side whose side is unknown ('band_no_side', a legacy diagonal band);
   * null otherwise. The tile shows it in place of «يحتاج تأكيد».
   */
  blocked: 'side_empty' | 'side_missing' | 'band_no_side' | null;
  doubt: string | null;
}

/** Why a resolved placement cannot be saved, else null (see {@link GeoRow.blocked}). */
export function blockedReason(p: Placement): GeoRow['blocked'] {
  if (!p.resolved) return null;
  if (p.operation === 'directional_band') return placementSavable(p) ? null : 'band_no_side';
  if (p.operation !== 'district_side_clip') return null;
  const s = sideClipStateOf(p);
  return s === 'empty' ? 'side_empty' : s === 'missing' ? 'side_missing' : null;
}

/** Proposal statuses a rep can still act on / that mean "saved". */
export const GEO_OPEN = new Set(['pending', 'must_confirm']);
export const GEO_SAVED = new Set(['confirmed', 'edited', 'applied']);

/** Same place, same side, same rule — two mentions that would read as the same line. */
export function placementSignature(p: Placement): string {
  return [p.polarity, p.operation, [...p.element_ids].sort().join(','), p.side ?? '', p.radius_m ?? '', p.resolved ? '' : p.label].join('|');
}

/**
 * One row per PLACE the proposal put on the map, in mention order, with the
 * verifier's doubt when it has one. A place the customer named twice is ONE
 * row (card audit 2026-10-04: 25 of 82 places cards repeated a line —
 * «النرجس» twice, «شمال الرياض» twice); the row carries every mention's id.
 */
export function buildGeoRows(card: GeoCardDTO | null, isAr: boolean): GeoRow[] {
  const p = card?.proposal;
  if (!card || !p) return [];
  const doubts = new Map((p.verifier?.mentions ?? []).map((m) => [m.evidence_id, m]));
  const out: GeoRow[] = [];
  const bySig = new Map<string, GeoRow>();
  for (const m of card.mentions) {
    const placement = p.by_evidence[m.evidence_id];
    if (!placement) continue; // nothing on the map for this mention — nothing to save
    const sig = placementSignature(placement);
    const v = doubts.get(m.evidence_id);
    const twin = bySig.get(sig);
    if (twin) {
      twin.evidenceIds.push(m.evidence_id);
      const vt = v ? verifierMentionLine(v, isAr) : null;
      if (!twin.doubt && vt && vt.tone === 'warn') twin.doubt = vt.text;
      continue;
    }
    const vl = v ? verifierMentionLine(v, isAr) : null;
    const row: GeoRow = {
      evidenceId: m.evidence_id,
      evidenceIds: [m.evidence_id],
      span: m.mention_span,
      placement,
      line: placementLine(placement, m.preference_role, card.names, isAr),
      savable: placementSavable(placement),
      blocked: blockedReason(placement),
      doubt: vl && vl.tone === 'warn' ? vl.text : null,
    };
    bySig.set(sig, row);
    out.push(row);
  }
  return out;
}
