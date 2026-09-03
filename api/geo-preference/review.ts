/**
 * POST /api/geo-preference/review — the rep-facing REVIEW ACTIONS endpoint for the
 * Geography Understanding Ability.
 *
 * A reviewer (a rep) resolves ONE `geo_pref_proposals` row that the review-first
 * pipeline produced. Four actions:
 *
 *   confirm       — accept the proposal as-is and APPLY it to the client.
 *   edit          — accept an ADJUSTED expression (`finalExpression`) and APPLY it.
 *   reject        — discard the proposal. NEVER touches the client record.
 *   must_confirm  — defer: the customer must confirm first. NEVER touches the client.
 *
 * Every action writes ONE append-only `geo_pref_review_audit` row (reviewer =
 * auth uid, before/after, action, timestamp) and updates the proposal
 * (status, reviewed_at, reviewer_note, and final_expression on edit).
 *
 * ── The apply safety model (READ THIS) ──────────────────────────────────────
 * This human-confirmed apply is the ONLY sanctioned write to a client's location
 * preferences in the whole ability. It is allowed precisely BECAUSE a human
 * confirmed it. The global `geo_pref_gate_config.auto_write_enabled` flag gates
 * the AUTOMATIC (pipeline) write path — a path that stays OFF — and is therefore
 * DELIBERATELY NOT consulted here. This endpoint never reads that flag. A human
 * clicking "confirm" is the authorization; the master switch is about machines
 * writing without a human, which is a different question.
 *
 * The client write goes through the approved server path (`record_save`, via
 * `recordSaveWithRetry`), the same versioned RPC the SPA store uses — never a
 * raw `records` UPDATE. reject / must_confirm are structurally incapable of
 * writing the client record: the writer (`applyToClient`) is only invoked on the
 * apply branch (see `applyReview`, covered by review.test.ts).
 *
 * Depends on the schema in supabase/migrations/2026-09-03_geo_preference_ability.sql
 * plus the review-and-ops migration that adds to `geo_pref_proposals` the columns
 * (version, final_expression, reviewed_at, reviewer_note; status enum values
 * pending/confirmed/rejected/applied/must_confirm/superseded/edited) and the
 * `geo_pref_review_audit` table this endpoint writes (columns proposal_id,
 * reviewer, action, before_state, after_state, at).
 */

import { withAuth, jsonError, jsonOk, assertCanAccessRecord } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { recordSaveWithRetry } from '../_lib/recordSaveRetry.js';
import type {
  GeoPreference,
  GeoOperation,
} from '../_lib/geoPreference/ontology.js';
import {
  parseLocationItems,
  newDistrictItem,
  newElementRuleItem,
  DIRECTION_DEFAULT_M,
  type LocationItem,
  type GeoPolarity,
  type DirectionRule,
} from '../../src/lib/geo/locationItems.js';

export const config = { runtime: 'edge' };

const SERVICE_NAME = 'api:geo-preference-review';
/** Fallback radius (m) when a radius/distance recipe carries no explicit band. */
export const DEFAULT_RADIUS_M = 3000;

// ────────────────────────────────────────────────────────────────────────────
// GeoPreference → location_items translation (PURE — the core "apply" mapping).
//
// The compiled GeoPreference is a Boolean tree (groups = ranked OR, clauses =
// AND, `anyOf` = OR-within-clause, op:'exclude' = NOT). `location_items` is the
// deterministic Finder gate: a flat OR-union of items where excludes subtract.
// The two shapes are not isomorphic, so this mapping is intentionally, and
// documented-ly, best-effort:
//
//   • Each AnchorRef becomes one (or, for a multi-id recipe, several) items,
//     with polarity taken from its clause (`exclude` → an exclude item).
//   • `anyOf` alternatives within a clause flatten to independent items — exact,
//     since location_items already union.
//   • AND across clauses within a group ALSO flattens to union in v1. A group
//     that means "district A AND within 3km of the metro" therefore lands as
//     "district A" OR "within 3km of the metro". This LOOSENS the constraint;
//     the reviewer sees the resulting chips (before/after are in the audit) and
//     can prune with the `edit` action. Hard cross-clause AND geometry is a
//     known v2 item — never silently claimed as exact here.
//
// Operation → item kind:
//   district_polygon | district_union | pin_containing_district → district item
//   zone_union                                                   → inside_area rule
//   within_radius | pin_point                                    → within_radius rule
//   within_distance | corridor                                   → within_distance rule
//   directional_band                                             → a cardinal rule
//                                                (falls back to within_distance)
// ────────────────────────────────────────────────────────────────────────────

/** Read a recipe's concrete resolved geo ids (district ids / element external ids). */
function recipeIds(ids: unknown): string[] {
  return Array.isArray(ids) ? (ids.filter((x): x is string => typeof x === 'string' && x.length > 0)) : [];
}

function radiusM(band: number | undefined | null): number {
  return typeof band === 'number' && band > 0 ? band : DEFAULT_RADIUS_M;
}

/** First anchor span → a display label for the chip (never load-bearing). */
function anchorLabel(anchors: { span?: string; normalized_token?: string }[] | undefined): string {
  const first = Array.isArray(anchors) ? anchors[0] : undefined;
  return (first?.span || first?.normalized_token || '').trim();
}

const CARDINAL_WORD = /^(north|south|east|west|شمال|جنوب|شرق|غرب)$/i;

function detectDirectionRule(
  anchors: { anchor_type?: string; span?: string; normalized_token?: string }[] | undefined,
): DirectionRule | null {
  for (const a of anchors ?? []) {
    const t = `${a.normalized_token ?? ''} ${a.span ?? ''}`.toLowerCase();
    if (/north|شمال/.test(t)) return 'north_of';
    if (/south|جنوب/.test(t)) return 'south_of';
    if (/east|شرق/.test(t)) return 'east_of';
    if (/west|غرب/.test(t)) return 'west_of';
  }
  return null;
}

/** Drop pure cardinal tokens; what's left is the reference road/line element(s). */
function roadIdsOf(ids: string[]): string[] {
  const roads = ids.filter((id) => !CARDINAL_WORD.test(id));
  return roads.length ? roads : ids;
}

/** One resolved AnchorRef → zero or more location items at the given polarity. */
function anchorRefToItems(
  ref: { recipe?: { operation?: GeoOperation; source_anchors?: unknown; resolved_element_ids?: unknown; radius_or_band_m?: number | null } } | null | undefined,
  polarity: GeoPolarity,
): LocationItem[] {
  const recipe = ref?.recipe;
  if (!recipe) return [];
  const op = recipe.operation;
  const ids = recipeIds(recipe.resolved_element_ids);
  const anchors = (Array.isArray(recipe.source_anchors) ? recipe.source_anchors : []) as {
    anchor_type?: string; span?: string; normalized_token?: string;
  }[];
  const label = anchorLabel(anchors);
  if (ids.length === 0) return [];

  switch (op) {
    case 'district_polygon':
    case 'district_union':
    case 'pin_containing_district':
      return ids.map((id) => newDistrictItem(id, label || id, polarity));
    case 'zone_union':
      return ids.map((id) => newElementRuleItem(label || id, { rule: 'inside_area', element_id: id }, polarity));
    case 'within_radius':
    case 'pin_point': {
      const d = radiusM(recipe.radius_or_band_m);
      return ids.map((id) => newElementRuleItem(label || id, { rule: 'within_radius', element_id: id, distance_m: d }, polarity));
    }
    case 'within_distance':
    case 'corridor': {
      const d = radiusM(recipe.radius_or_band_m);
      return ids.map((id) => newElementRuleItem(label || id, { rule: 'within_distance', element_id: id, distance_m: d }, polarity));
    }
    case 'directional_band': {
      const dir = detectDirectionRule(anchors);
      const roadIds = roadIdsOf(ids);
      const d = typeof recipe.radius_or_band_m === 'number' && recipe.radius_or_band_m > 0
        ? recipe.radius_or_band_m
        : DIRECTION_DEFAULT_M;
      if (dir) {
        return roadIds.map((id) => newElementRuleItem(label || id, { rule: dir, element_id: id, distance_m: d }, polarity));
      }
      return roadIds.map((id) => newElementRuleItem(label || id, { rule: 'within_distance', element_id: id, distance_m: d }, polarity));
    }
    default:
      // Unknown/unmapped operation → best-effort district so nothing is dropped silently.
      return ids.map((id) => newDistrictItem(id, label || id, polarity));
  }
}

/** Translate a confirmed GeoPreference into a flat list of client location items. */
export function geoPreferenceToLocationItems(pref: GeoPreference | null | undefined): LocationItem[] {
  const out: LocationItem[] = [];
  if (!pref || !Array.isArray(pref.groups)) return out;
  for (const group of pref.groups) {
    if (!group || !Array.isArray(group.clauses)) continue;
    for (const clause of group.clauses) {
      if (!clause || !Array.isArray(clause.anyOf)) continue;
      const polarity: GeoPolarity = clause.op === 'exclude' ? 'exclude' : 'include';
      for (const ref of clause.anyOf) out.push(...anchorRefToItems(ref, polarity));
    }
  }
  return out;
}

/** Stable signature ignoring the item's uuid + display-only labels. */
export function locationItemSignature(item: LocationItem): string {
  if (item.kind === 'district') return `d:${item.polarity}:${item.district_id}`;
  if (item.kind === 'drawn_area') return `a:${item.polarity}:${JSON.stringify(item.coordinates)}`;
  const conds = (item.conditions ?? [])
    .map((c) => {
      const eid = 'element_id' in c ? c.element_id : '';
      const dist = 'distance_m' in c && typeof c.distance_m === 'number' ? c.distance_m : '';
      return `${c.rule}:${eid}:${dist}`;
    })
    .sort()
    .join('|');
  return `e:${item.polarity}:${conds}`;
}

/** Union `incoming` onto `existing`, dropping duplicates by signature. Non-destructive. */
export function mergeLocationItems(existing: LocationItem[], incoming: LocationItem[]): LocationItem[] {
  const seen = new Set(existing.map(locationItemSignature));
  const out = [...existing];
  for (const it of incoming) {
    const sig = locationItemSignature(it);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(it);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Geometry + gate summaries (PURE) — used by the list endpoint's read-only view.
// ────────────────────────────────────────────────────────────────────────────

export interface GeometrySummaryEntry {
  operation: GeoOperation | string;
  polarity: GeoPolarity;
  element_ids: string[];
  radius_m: number | null;
  label: string;
  group_role: string;
  group_strength: string;
}

/** Flatten a GeoPreference's resolved geometry into a display-ready list. */
export function summarizeGeometry(pref: GeoPreference | null | undefined): GeometrySummaryEntry[] {
  const out: GeometrySummaryEntry[] = [];
  if (!pref || !Array.isArray(pref.groups)) return out;
  for (const group of pref.groups) {
    if (!group || !Array.isArray(group.clauses)) continue;
    for (const clause of group.clauses) {
      if (!clause || !Array.isArray(clause.anyOf)) continue;
      const polarity: GeoPolarity = clause.op === 'exclude' ? 'exclude' : 'include';
      for (const ref of clause.anyOf) {
        const recipe = ref?.recipe;
        if (!recipe) continue;
        const anchors = (Array.isArray(recipe.source_anchors) ? recipe.source_anchors : []) as {
          span?: string; normalized_token?: string;
        }[];
        out.push({
          operation: recipe.operation ?? 'unknown',
          polarity,
          element_ids: recipeIds(recipe.resolved_element_ids),
          radius_m: typeof recipe.radius_or_band_m === 'number' ? recipe.radius_or_band_m : null,
          label: anchorLabel(anchors),
          group_role: group.role ?? 'primary',
          group_strength: group.strength ?? 'soft',
        });
      }
    }
  }
  return out;
}

export interface GateReason {
  key: string;
  label_en: string;
  label_ar: string;
  value: number | null;
  ok: boolean;
}

const GATE_THRESHOLD = 0.9;

/** Turn the stored `gate_signals` into a per-signal pass/fail list for the reviewer. */
export function deriveGateReasons(signals: Record<string, unknown> | null | undefined): GateReason[] {
  const s = signals ?? {};
  const num = (k: string): number | null => (typeof s[k] === 'number' ? (s[k] as number) : null);
  const geq = (v: number | null, t: number): boolean => v === null ? true : v >= t;
  const rows: GateReason[] = [
    { key: 'interpretation_confidence', label_en: 'Interpretation confidence', label_ar: 'ثقة التفسير', value: num('interpretation_confidence'), ok: geq(num('interpretation_confidence'), GATE_THRESHOLD) },
    { key: 'geo_resolution_margin', label_en: 'Geo resolution margin', label_ar: 'هامش تحديد الموقع', value: num('geo_resolution_margin'), ok: geq(num('geo_resolution_margin'), GATE_THRESHOLD) },
    { key: 'lexical_candidate_quality', label_en: 'Name-match quality', label_ar: 'جودة مطابقة الاسم', value: num('lexical_candidate_quality'), ok: geq(num('lexical_candidate_quality'), GATE_THRESHOLD) },
    { key: 'context_consistency', label_en: 'Context consistency', label_ar: 'اتساق السياق', value: num('context_consistency'), ok: geq(num('context_consistency'), 1) },
    // contradiction_signal: 1 = clean, 0 = a contradiction was flagged.
    { key: 'contradiction_signal', label_en: 'No contradiction', label_ar: 'لا يوجد تعارض', value: num('contradiction_signal'), ok: num('contradiction_signal') === null ? true : num('contradiction_signal') === 1 },
    { key: 'source_quality', label_en: 'Source quality', label_ar: 'جودة المصدر', value: num('source_quality'), ok: geq(num('source_quality'), GATE_THRESHOLD) },
  ];
  return rows;
}

// ────────────────────────────────────────────────────────────────────────────
// Review action core (PURE over injected ports — the unit-tested seam).
// ────────────────────────────────────────────────────────────────────────────

export type ReviewAction = 'confirm' | 'edit' | 'reject' | 'must_confirm';

/** The subset of a `geo_pref_proposals` row this logic reads. */
export interface ProposalRow {
  id: string;
  client_id: string;
  status: string;
  proposed_action: string;
  proposed_expression: GeoPreference;
  final_expression: GeoPreference | null;
  reviewer_note: string | null;
  version: number | null;
}

export interface ClientWriteResult {
  before: LocationItem[];
  after: LocationItem[];
}

/**
 * The LOGICAL audit record. The HTTP `insertAudit` port maps it onto the physical
 * append-only `geo_pref_review_audit` columns (proposal_id, reviewer, action,
 * before_state, after_state, at) — the rich before/after fields here are packed
 * into the two jsonb state snapshots.
 */
export interface AuditRow {
  proposal_id: string;
  reviewer_id: string;
  action: ReviewAction;
  status_before: string;
  status_after: string;
  expression_before: GeoPreference | null;
  expression_after: GeoPreference | null;
  location_items_before: LocationItem[] | null;
  location_items_after: LocationItem[] | null;
  applied: boolean;
  note: string | null;
  created_at: string;
}

export interface ProposalPatch {
  status: string;
  reviewed_by: string;
  reviewed_at: string;
  reviewer_note: string | null;
  final_expression?: GeoPreference;
}

/**
 * The injected ports. `applyToClient` is the SOLE client-record writer; the
 * reject / must_confirm branches never reach it. This is the seam review.test.ts
 * exercises to prove the safety property.
 */
export interface ReviewDeps {
  getProposal(id: string): Promise<ProposalRow | null>;
  /** The ONLY write to a client's location preferences. Returns before/after. */
  applyToClient(clientId: string, items: LocationItem[]): Promise<ClientWriteResult>;
  updateProposal(id: string, patch: ProposalPatch, expectedStatus: string): Promise<void>;
  insertAudit(row: AuditRow): Promise<void>;
  /** Access gate for the apply branch; throw to deny. Optional (tests omit it). */
  assertCanApply?(clientId: string): Promise<void>;
  now(): string;
}

export interface ReviewInput {
  proposalId: string;
  action: ReviewAction;
  reviewerId: string;
  note?: string | null;
  finalExpression?: GeoPreference | null;
  /** Optimistic guard: the proposal.version the reviewer loaded. */
  expectedVersion?: number | null;
}

export interface ReviewOutcome {
  proposalId: string;
  clientId: string;
  action: ReviewAction;
  status: string;
  applied: boolean;
  location_items_before: LocationItem[] | null;
  location_items_after: LocationItem[] | null;
  audit: AuditRow;
}

export class ReviewError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const OPEN_STATUSES = new Set(['pending', 'must_confirm']);

/**
 * Apply ONE review decision. Pure over `deps`:
 *   1. load + guard the proposal (exists, open, version)
 *   2. on confirm/edit: gate access, translate the expression, and call the ONLY
 *      client writer (`applyToClient`) — BEFORE marking the proposal, so a failed
 *      write leaves the proposal open and unaudited.
 *   3. update the proposal row (status/reviewed_at/reviewer_note, +final_expression on edit)
 *   4. append exactly one audit row (always — including reject/must_confirm).
 */
export async function applyReview(deps: ReviewDeps, input: ReviewInput): Promise<ReviewOutcome> {
  const proposal = await deps.getProposal(input.proposalId);
  if (!proposal) throw new ReviewError(404, `proposal ${input.proposalId} not found`);
  if (input.expectedVersion != null && proposal.version != null && proposal.version !== input.expectedVersion) {
    throw new ReviewError(409, 'proposal changed since you loaded it — reload and try again');
  }
  if (!OPEN_STATUSES.has(proposal.status)) {
    throw new ReviewError(409, `proposal is already ${proposal.status}`);
  }
  if (input.action === 'edit' && !input.finalExpression) {
    throw new ReviewError(400, 'edit requires finalExpression');
  }

  const statusBefore = proposal.status;
  const isApply = input.action === 'confirm' || input.action === 'edit';
  const expressionBefore = proposal.final_expression ?? proposal.proposed_expression;
  const expressionAfter: GeoPreference | null = input.action === 'edit'
    ? (input.finalExpression as GeoPreference)
    : input.action === 'confirm'
      ? (proposal.final_expression ?? proposal.proposed_expression)
      : null;

  let statusAfter: string;
  let applied = false;
  let before: LocationItem[] | null = null;
  let after: LocationItem[] | null = null;

  if (isApply) {
    if (deps.assertCanApply) await deps.assertCanApply(proposal.client_id);
    const items = geoPreferenceToLocationItems(expressionAfter);
    const res = await deps.applyToClient(proposal.client_id, items);
    before = res.before;
    after = res.after;
    applied = true;
    statusAfter = 'applied';
  } else {
    statusAfter = input.action === 'reject' ? 'rejected' : 'must_confirm';
  }

  const note = input.note ?? null;
  const patch: ProposalPatch = {
    status: statusAfter,
    reviewed_by: input.reviewerId,
    reviewed_at: deps.now(),
    reviewer_note: note,
    ...(input.action === 'edit' ? { final_expression: input.finalExpression as GeoPreference } : {}),
  };
  await deps.updateProposal(proposal.id, patch, statusBefore);

  const audit: AuditRow = {
    proposal_id: proposal.id,
    reviewer_id: input.reviewerId,
    action: input.action,
    status_before: statusBefore,
    status_after: statusAfter,
    expression_before: expressionBefore ?? null,
    expression_after: expressionAfter,
    location_items_before: before,
    location_items_after: after,
    applied,
    note,
    created_at: deps.now(),
  };
  await deps.insertAudit(audit);

  return {
    proposalId: proposal.id,
    clientId: proposal.client_id,
    action: input.action,
    status: statusAfter,
    applied,
    location_items_before: before,
    location_items_after: after,
    audit,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP handler — wires the real Supabase-backed ports into applyReview().
// ────────────────────────────────────────────────────────────────────────────

interface RawBody {
  proposalId?: unknown;
  action?: unknown;
  note?: unknown;
  finalExpression?: unknown;
  expectedVersion?: unknown;
}

const VALID_ACTIONS: ReviewAction[] = ['confirm', 'edit', 'reject', 'must_confirm'];

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed');
  return withAuth(req, async (user) => {
    let body: RawBody;
    try {
      body = (await req.json()) as RawBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const proposalId = typeof body.proposalId === 'string' ? body.proposalId : '';
    const action = body.action as ReviewAction;
    if (!proposalId) return jsonError(400, 'proposalId is required');
    if (!VALID_ACTIONS.includes(action)) return jsonError(400, `action must be one of ${VALID_ACTIONS.join(', ')}`);
    const note = typeof body.note === 'string' ? body.note : null;
    const finalExpression = (body.finalExpression ?? null) as GeoPreference | null;
    const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : null;

    const service = makeServiceClient(SERVICE_NAME);
    if (!service) return jsonError(500, 'Supabase service env not configured');

    const deps: ReviewDeps = {
      async getProposal(id) {
        const { data, error } = await service
          .from('geo_pref_proposals')
          .select('id, client_id, status, proposed_action, proposed_expression, final_expression, reviewer_note, version')
          .eq('id', id)
          .maybeSingle();
        if (error) throw new ReviewError(500, `proposal read failed: ${error.message}`);
        return (data as ProposalRow | null) ?? null;
      },
      // The reviewer must be able to ACCESS the client under RLS (their own JWT).
      // service role bypasses RLS, so this gate is what stops a reviewer applying
      // to a client they cannot see.
      async assertCanApply(clientId) {
        await assertCanAccessRecord(req, clientId, SERVICE_NAME);
      },
      async applyToClient(clientId, items) {
        // Read the current client record for the audit "before" snapshot.
        const { data: cur, error: readErr } = await service
          .from('records')
          .select('data')
          .eq('id', clientId)
          .maybeSingle();
        if (readErr) throw new ReviewError(500, `client read failed: ${readErr.message}`);
        if (!cur) throw new ReviewError(404, `client ${clientId} not found`);
        const before = parseLocationItems((cur.data as Record<string, unknown> | null)?.location_items);
        const after = mergeLocationItems(before, items);
        // Write through the approved versioned RPC. recordSaveWithRetry re-reads
        // the fresh row each attempt and unions our items onto the CURRENT
        // location_items — never wiping a concurrent manual edit.
        await recordSaveWithRetry(service, {
          recordId: clientId,
          build: (freshData) => {
            const existing = parseLocationItems(freshData.location_items);
            return { ...freshData, location_items: mergeLocationItems(existing, items) };
          },
        });
        return { before, after };
      },
      async updateProposal(id, patch, expectedStatus) {
        const { data, error } = await service
          .from('geo_pref_proposals')
          .update(patch)
          .eq('id', id)
          .eq('status', expectedStatus) // optimistic guard against a concurrent reviewer
          .select('id')
          .maybeSingle();
        if (error) throw new ReviewError(500, `proposal update failed: ${error.message}`);
        if (!data) throw new ReviewError(409, 'proposal was resolved by someone else');
      },
      async insertAudit(row) {
        // Map the rich logical audit record onto the physical append-only table
        // (geo_pref_review_audit: proposal_id, reviewer, action, before_state,
        // after_state, at — see 2026-09-03a_geo_preference_review_and_ops.sql).
        // The before/after snapshots pack the full picture — status, the exact
        // expression, and (on apply) the client's location_items before vs after.
        const { error } = await service.from('geo_pref_review_audit').insert({
          proposal_id: row.proposal_id,
          reviewer: row.reviewer_id,
          action: row.action,
          before_state: {
            status: row.status_before,
            expression: row.expression_before,
            location_items: row.location_items_before,
          },
          after_state: {
            status: row.status_after,
            expression: row.expression_after,
            location_items: row.location_items_after,
            applied: row.applied,
            note: row.note,
          },
          at: row.created_at,
        });
        if (error) throw new ReviewError(500, `audit write failed: ${error.message}`);
      },
      now: () => new Date().toISOString(),
    };

    try {
      const outcome = await applyReview(deps, {
        proposalId,
        action,
        reviewerId: user.userId,
        note,
        finalExpression,
        expectedVersion,
      });
      return jsonOk(outcome);
    } catch (err) {
      if (err instanceof ReviewError) return jsonError(err.status, err.message);
      throw err; // AuthError from assertCanAccessRecord + unknowns → withAuth maps to 401/500
    }
  });
}
