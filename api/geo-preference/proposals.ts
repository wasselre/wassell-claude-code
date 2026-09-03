/**
 * GET /api/geo-preference/proposals — the rep-facing REVIEW QUEUE for the
 * Geography Understanding Ability.
 *
 * Lists every open (`pending` / `must_confirm`) `geo_pref_proposals` row, each
 * joined to:
 *   • the client's display name (via `unified_records`, RLS-scoped to the caller),
 *   • its source evidence rows (the exact quoted spans + anchors the AI read), and
 *   • a resolved-geometry summary + a preview of the location_items the proposal
 *     would apply, plus the per-signal gate pass/fail the reviewer needs to decide.
 *
 * Everything the review page shows is computed HERE, server-side, from the same
 * pure helpers `review.ts` uses to apply — so what the reviewer previews is
 * exactly what an apply would write. Read-only: this endpoint never writes.
 *
 * Reads run through an anon client carrying the CALLER's JWT, so RLS decides
 * which clients' names resolve — a reviewer only sees names for clients they can
 * access (others fall back to a generic label), and the proposals themselves are
 * gated by the table's `authenticated` select policy.
 */

import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { serviceIdentityHeaders } from '../_lib/serviceClient.js';
import type { GeoPreference } from '../_lib/geoPreference/ontology.js';
import {
  geoPreferenceToLocationItems,
  summarizeGeometry,
  deriveGateReasons,
  type GeometrySummaryEntry,
  type GateReason,
} from './review.js';
import type { LocationItem } from '../../src/lib/geo/locationItems.js';

export const config = { runtime: 'edge' };

const SERVICE_NAME = 'api:geo-preference-proposals';
const MAX_PROPOSALS = 200;

interface RawProposal {
  id: string;
  client_id: string;
  checkpoint_id: string | null;
  proposed_action: string;
  proposed_expression: GeoPreference;
  final_expression: GeoPreference | null;
  gate_signals: Record<string, unknown> | null;
  status: string;
  reviewer_note: string | null;
  source_evidence_ids: string[] | null;
  version: number | null;
  created_at: string;
}

interface EvidenceView {
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

interface ProposalView {
  id: string;
  client_id: string;
  client_name: string | null;
  checkpoint_id: string | null;
  proposed_action: string;
  status: string;
  reviewer_note: string | null;
  version: number | null;
  created_at: string;
  expression: GeoPreference;
  edited: boolean;
  preview_items: LocationItem[];
  geometry_summary: GeometrySummaryEntry[];
  gate_signals: Record<string, unknown> | null;
  gate_reasons: GateReason[];
  evidence: EvidenceView[];
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return jsonError(405, 'method not allowed');
  return withAuth(req, async () => {
    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anonKey) return jsonError(500, 'Supabase env not configured');
    const authHeader = req.headers.get('Authorization') ?? '';
    const scoped = createClient(url, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader, ...serviceIdentityHeaders(SERVICE_NAME) } },
    });

    const { data: rows, error } = await scoped
      .from('geo_pref_proposals')
      .select('id, client_id, checkpoint_id, proposed_action, proposed_expression, final_expression, gate_signals, status, reviewer_note, source_evidence_ids, version, created_at')
      .in('status', ['pending', 'must_confirm'])
      .order('created_at', { ascending: false })
      .limit(MAX_PROPOSALS);
    if (error) return jsonError(500, `proposals read failed: ${error.message}`);
    const proposals = (rows ?? []) as RawProposal[];

    // Resolve client display names (RLS-scoped — unknowns stay null).
    const clientIds = [...new Set(proposals.map((p) => p.client_id).filter(Boolean))];
    const nameById = new Map<string, string>();
    if (clientIds.length) {
      const { data: clientRows } = await scoped
        .from('unified_records')
        .select('id, data')
        .in('id', clientIds);
      for (const r of (clientRows ?? []) as { id: string; data: Record<string, unknown> | null }[]) {
        const name = typeof r.data?.client_name === 'string' ? r.data.client_name : '';
        if (name) nameById.set(r.id, name);
      }
    }

    // Fetch the source evidence rows behind every proposal.
    const evidenceIds = [...new Set(proposals.flatMap((p) => p.source_evidence_ids ?? []).filter(Boolean))];
    const evidenceById = new Map<string, EvidenceView>();
    if (evidenceIds.length) {
      const { data: evRows } = await scoped
        .from('geo_pref_evidence')
        .select('id, mention_span, anchors, source_channel, source_ref, source_timestamp, preference_role, holder_role, preference_applicability')
        .in('id', evidenceIds);
      for (const e of (evRows ?? []) as Record<string, unknown>[]) {
        const id = e.id as string;
        evidenceById.set(id, {
          id,
          mention_span: (e.mention_span as string) ?? '',
          anchors: Array.isArray(e.anchors) ? (e.anchors as EvidenceView['anchors']) : [],
          channel: (e.source_channel as string) ?? null,
          ref: (e.source_ref as string) ?? null,
          timestamp: (e.source_timestamp as string) ?? null,
          preference_role: (e.preference_role as string) ?? null,
          holder_role: (e.holder_role as string) ?? null,
          applicability: (e.preference_applicability as string) ?? null,
        });
      }
    }

    const views: ProposalView[] = proposals.map((p) => {
      const expression = p.final_expression ?? p.proposed_expression;
      return {
        id: p.id,
        client_id: p.client_id,
        client_name: nameById.get(p.client_id) ?? null,
        checkpoint_id: p.checkpoint_id,
        proposed_action: p.proposed_action,
        status: p.status,
        reviewer_note: p.reviewer_note,
        version: p.version,
        created_at: p.created_at,
        expression,
        edited: p.final_expression != null,
        preview_items: geoPreferenceToLocationItems(expression),
        geometry_summary: summarizeGeometry(expression),
        gate_signals: p.gate_signals,
        gate_reasons: deriveGateReasons(p.gate_signals),
        evidence: (p.source_evidence_ids ?? [])
          .map((id) => evidenceById.get(id))
          .filter((e): e is EvidenceView => !!e),
      };
    });

    return jsonOk({ proposals: views });
  });
}
