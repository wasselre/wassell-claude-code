/**
 * Shapes returned by /api/geo-preference/proposals and consumed by the GeoReview
 * page. These MIRROR the `ProposalView` / helper types the two endpoints build
 * server-side (api/geo-preference/{proposals,review}.ts) — the page only renders
 * what the server already computed.
 */
import type { LocationItem } from '@/lib/geo/locationItems';

/** A compiled Boolean preference expression (mirror of api ontology GeoPreference). */
export interface GeoPreferenceDTO {
  schema_version: string;
  groups: GeoGroupDTO[];
}
export interface GeoGroupDTO {
  id: string;
  role: string;
  strength: string;
  priority: number;
  clauses: GeoClauseDTO[];
}
export interface GeoClauseDTO {
  op: 'include' | 'exclude';
  anyOf: unknown[];
}

export interface EvidenceView {
  id: string;
  mention_span: string;
  anchors: { span?: string; anchor_type?: string; normalized_token?: string }[];
  channel: string | null;
  ref: string | null;
  timestamp: string | null;
  preference_role: string | null;
  holder_role: string | null;
  applicability: string | null;
}

export interface GeometrySummaryEntry {
  operation: string;
  polarity: 'include' | 'exclude';
  element_ids: string[];
  radius_m: number | null;
  label: string;
  group_role: string;
  group_strength: string;
}

export interface GateReason {
  key: string;
  label_en: string;
  label_ar: string;
  value: number | null;
  ok: boolean;
}

export interface ProposalView {
  id: string;
  client_id: string;
  client_name: string | null;
  checkpoint_id: string | null;
  proposed_action: string;
  status: string;
  reviewer_note: string | null;
  version: number | null;
  created_at: string;
  expression: GeoPreferenceDTO;
  edited: boolean;
  preview_items: LocationItem[];
  geometry_summary: GeometrySummaryEntry[];
  gate_signals: Record<string, unknown> | null;
  gate_reasons: GateReason[];
  evidence: EvidenceView[];
}

export type ReviewAction = 'confirm' | 'edit' | 'reject' | 'must_confirm';

export interface ReviewOutcome {
  proposalId: string;
  clientId: string;
  action: ReviewAction;
  status: string;
  applied: boolean;
}
