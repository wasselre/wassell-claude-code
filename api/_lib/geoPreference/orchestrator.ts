/**
 * Review-first pipeline orchestrator (v2 / v7).
 *
 * Wires the four deterministic halves of the Geography Understanding Ability into
 * one run and produces EXACTLY ONE side effect: a `pending` row in
 * `geo_pref_proposals`. It NEVER writes to a client record. Even the (currently
 * unreachable) `auto_write` decision is materialised as a pending proposal, so the
 * only path to a client's active preferences is proposal → human confirm → apply,
 * which lives entirely outside this module.
 *
 * The run (binding order — design 2026-10-04 §2.6):
 *   1. operator rules on the readings                       (companyRules.applyCompanyRules)
 *   2. per-mention anchor preparation, with the conversation (anchorPrep.prepareEvidence)
 *   3. I9: does another active mention name another city?  (invariants.conversationCityCheck)
 *   4. resolve each anchor — or ASK it when the preparation
 *      said so, without calling the resolver               (resolver.resolveAnchor)
 *   5. I5 + U1 + I8 on the resolved anchors                (invariants.enforceAnchorInvariants)
 *   6. compile + merge, and the merge checks (I4, M1, M2) to a FIXPOINT
 *      (compiler.compile, mergeResolutionsIntoPreference, invariants.checkMerged)
 *   7. satisfiability, deterministic GateSignals + AmbiguityConditions on the
 *      FINAL resolutions, decide(), and ONE pending proposal through the
 *      injected ProposalStore port
 *
 * Every check after step 2 is DEMOTE-ONLY: it turns a resolved anchor into
 * needs_confirm with a reason code, or keeps a road side from being spread
 * onto other mentions — it never picks another place (invariants.ts).
 *
 * DB access is entirely behind the injected `OrchestratorPorts` — the resolver's
 * own `ResolverDb` (via the resolution context) and the `ProposalStore`. There is
 * NO port through which this module could touch a client record; that is a
 * structural guarantee, not just a convention (see orchestrator.test.ts).
 */

import { resolveAnchor, parseDirection, placeKey, type ResolutionContext } from './resolver.js';
import { compile } from './compiler.js';
import { applyCompanyRules } from './companyRules.js';
import { prepareEvidence, offeredAsAlternative, type AnchorContext } from './anchorPrep.js';
import { classify, type SatUniverse } from './satisfiability.js';
import { decide, type GateConfig } from './gate.js';
import { geoObserver, type GeoObserver } from './observability.js';
import {
  CheckCache, checkMerged, conversationCityCheck, demoted, emitDemotion, enabled, enforceAnchorInvariants,
  resolutionOrigins, type CheckName,
} from './invariants.js';
import type { Conversation } from './extractor.js';
import { sanitizeDistanceM } from './ontology.js';
import type {
  AnchorRef,
  CardinalSide,
  Evidence,
  EvidenceRelation,
  GateSignals,
  GateDecision,
  MaximumSafeAction,
  AmbiguityCondition,
  GeoPreference,
  GeometryRecipe,
  ResolutionResult,
  SatisfiabilityFlag,
} from './ontology.js';

// ────────────────────────────────────────────────────────────────────────────
// Ports — the ONLY surfaces the orchestrator can write through. There is no
// client-record writer here BY DESIGN.
// ────────────────────────────────────────────────────────────────────────────

/** A pending proposal row — mirrors `geo_pref_proposals` (status is always pending here). */
export interface ProposalInput {
  client_id: string;
  checkpoint_id: string | null;
  proposed_action: ProposalAction;
  proposed_expression: GeoPreference;
  gate_signals: GateSignals;
  /** The evidence rows (persisted ids) this proposal was compiled from. */
  source_evidence_ids?: string[];
}

export interface ProposalRecord extends ProposalInput {
  id: string;
  status: 'pending';
}

/** The `proposed_action` enum on `geo_pref_proposals` (no 'ignore'/'auto_write'). */
export type ProposalAction =
  | 'write_soft'
  | 'write_hard'
  | 'supersede'
  | 'confirm'
  | 'human_review';

export interface ProposalStore {
  /** Insert a `status='pending'` proposal and return the stored row. */
  createProposal(input: ProposalInput): Promise<ProposalRecord>;
}

export interface OrchestratorPorts {
  proposals: ProposalStore;
}

// ────────────────────────────────────────────────────────────────────────────
// Run context — everything the pure stages need, all injected.
// ────────────────────────────────────────────────────────────────────────────
export interface RunContext {
  client_id: string;
  checkpoint_id?: string | null;
  /** The per-checkpoint ceiling of what a perfect system could do (v6 #5). */
  maximum_safe_action: MaximumSafeAction;
  /** Resolution context shared across every anchor in this turn. */
  resolution: ResolutionContext;
  /** Bounded universe + inventory for the satisfiability pass. */
  universe: SatUniverse;
  /** The tunable gate thresholds (typically the geo_pref_gate_config row). */
  config: GateConfig;
  /**
   * Signal overrides. Some GateSignals cannot be derived from geometry alone
   * (notably source_quality — a property of the channel/source, not the map);
   * inject those here. Any provided field overrides the derived value.
   */
  signals?: Partial<GateSignals>;
  /** Extra deterministic ambiguity conditions detected upstream (merged in). */
  ambiguity?: AmbiguityCondition[];
  /**
   * Structured-event observer for stage boundaries. Defaults to the process-wide
   * `geoObserver` (console sink, silent under Vitest). Inject a capturing observer
   * in tests, or `nullObserver` to silence entirely.
   */
  observer?: GeoObserver;
  /**
   * The conversation the evidence was read from. The customer's own turns
   * attributed to a mention join its texts (anchorPrep.ts P0): a stated
   * distance or an anchor's words found there count. Without it, each
   * mention's `mention_span` is its only text.
   */
  conversation?: Conversation;
  /**
   * TEST-ONLY: demote-only checks switched off (the monotonicity property in
   * invariants.test.ts). A non-empty set outside Vitest THROWS — production
   * can never run with a check off.
   */
  disabledChecks?: ReadonlySet<CheckName>;
}

export interface ReviewFirstResult {
  decision: GateDecision;
  /** The pending proposal, or null when the decision is 'ignore' (no side effect). */
  proposal: ProposalRecord | null;
  signals: GateSignals;
  ambiguity: AmbiguityCondition[];
  compiled: GeoPreference;
  satisfiability: SatisfiabilityFlag;
  /** The FINAL resolutions (after every demote-only check), in prepared evidence × anchor order. */
  resolutions: ResolutionResult[];
  /** The final merge's trace: every standalone band, in-mention clip and distributed clip (in memory only). */
  trace: MergeTrace[];
  /** Evidence ids whose stub the final merge replaced with a real recipe (a distributed band included). */
  resolved_evidence_ids: string[];
  /**
   * The evidence AS REVIEWED — after the company rules and the anchor
   * preparation — in input order: `resolutions` follows its anchors, mention by
   * mention. In memory only (the stored rows are never changed); read by the
   * operator harnesses to name each mention's reasons (legacyDiff.e2e.test.ts).
   */
  reviewed_evidence: Evidence[];
}

/**
 * A preparation ask whose rule a TEST switched off (`disabledChecks`) is not
 * asked: the anchor resolves as if that rule did not exist. The preparation
 * itself never reads `disabled`; this is the one place its vetoes are gated.
 */
const PREP_ASK_CHECK: Readonly<Record<string, CheckName>> = {
  anchor_not_in_text: 'grounding',
  distance_unverified: 'distance',
  direction_referent_unclear: 'bare_direction',
  zone_city_unclear: 'bare_direction',
  side_of_district: 'bare_direction',
  referent_road_word_disagrees: 'referent_disagree',
  referent_only_in_token: 'referent_disagree',
  city_role_unclear: 'merge_two_cities',
  zone_of_region: 'region_owner',
};

/** The context an anchor resolves with when its preparation ask is switched off (test-only). */
function withoutAsk(c: AnchorContext, anchorDistance: unknown): AnchorContext {
  const out: AnchorContext = { ...c };
  // P10 off: the stated number is used as if it had been found in the text.
  if (c.ask_reason === 'distance_unverified') {
    const d = sanitizeDistanceM(anchorDistance);
    if (d !== null) out.radius_m = d;
  }
  delete out.ask_reason;
  return out;
}

/**
 * Run the review-first pipeline for one checkpoint's evidence. The SOLE side
 * effect is `ports.proposals.createProposal` (skipped only for an 'ignore'
 * decision). Never writes a client record; never throws out of the pure stages
 * — but a map port that fails (a lookup, the road axis, the names-in-text or
 * city-label RPC) REJECTS the whole run: a check that could not run never
 * silently passes.
 */
export async function runReviewFirst(
  evidence: Evidence[],
  relations: EvidenceRelation[],
  ctx: RunContext,
  ports: OrchestratorPorts,
): Promise<ReviewFirstResult> {
  // A check can be switched off only inside the test runner — never in production.
  const disabled = ctx.disabledChecks && ctx.disabledChecks.size > 0 ? ctx.disabledChecks : undefined;
  if (disabled && process.env.VITEST !== 'true') throw new Error('disabledChecks is test-only');
  const obs = ctx.observer ?? geoObserver;
  const meta = { client_id: ctx.client_id, checkpoint_id: ctx.checkpoint_id ?? null };

  // 1. Operator rules on the extracted readings (companyRules.ts) — e.g. a
  //    customer's question about a place is interest. Shapes the proposal only;
  //    the stored evidence rows are untouched.
  evidence = applyCompanyRules(evidence);

  // 2. Per-mention anchor preparation (anchorPrep.ts): fold «جنوب» + «سلمان»
  //    into one road side (by adjacency in the text), attach a stated distance
  //    the customer's words confirm / proximity / the named scope city to the
  //    anchors they qualify, and ASK what the text cannot decide. The
  //    customer's attributed turns join each mention's texts.
  //    The PREPARED evidence is what resolves AND what compiles + merges (the
  //    merge slices resolutions by e.anchors.length). Stored rows are untouched.
  const prep = prepareEvidence(evidence, { conversation: ctx.conversation });
  evidence = prep.evidence;
  const prepared = prep.prepared;
  const origins = resolutionOrigins(evidence);
  const rctx: ResolutionContext = { ...ctx.resolution, ...(disabled ? { disabled } : {}) };

  // 3. I9 — another active mention names another city: the established city
  //    may not be ASSUMED anywhere in this run.
  const forbid = await conversationCityCheck(evidence, prepared, rctx);

  // 4. Resolve every anchor across every mention against the map, each with the
  //    run context plus its own mention's companions — or ASK it, without the
  //    resolver, when the preparation said so. (timed stage)
  const anchorCount = evidence.reduce((n, e) => n + e.anchors.length, 0);
  const resolved: ResolutionResult[] = await obs.time(
    'resolution',
    { ...meta, detail: { anchors: anchorCount, mentions: evidence.length } },
    async () => {
      const out: ResolutionResult[] = [];
      for (let i = 0; i < evidence.length; i++) {
        const e = evidence[i]!;
        const contexts = prepared[i]?.contexts ?? [];
        for (let j = 0; j < e.anchors.length; j++) {
          const anchor = e.anchors[j]!;
          let c: AnchorContext = contexts[j] ?? {};
          const askCheck = c.ask_reason ? PREP_ASK_CHECK[c.ask_reason] : undefined;
          if (c.ask_reason && askCheck && !enabled(disabled, askCheck)) c = withoutAsk(c, anchor.distance_m);
          if (c.ask_reason) {
            out.push({ status: 'needs_confirm', reason: c.ask_reason });
            emitDemotion(obs, meta, origins[out.length - 1], 'prep_ask', c.ask_reason);
            continue;
          }
          out.push(await resolveAnchor(anchor, { ...rctx, ...c, forbid_established: forbid }));
        }
      }
      return out;
    },
  );

  // 5. I5 + U1 + I8 — demote-only checks on the resolved anchors.
  const cache = new CheckCache(rctx.db);
  let resolutions = await enforceAnchorInvariants(evidence, prepared, resolved, ctx.conversation, rctx.db, obs, {
    disabled, meta, cache,
  });

  // 6. Compile adjudicated evidence + relations into a Boolean expression, then
  //    overwrite each mention's STUB recipe (names, geo_data_version='stub') with
  //    the resolver's REAL recipe (district / element ids) wherever every anchor
  //    of that mention resolved — and run the merge checks (I4, M1, M2) on what
  //    the merge built, to a FIXPOINT: a failing band / clip is demoted (and the
  //    mention re-merged as a stub); a failing DISTRIBUTED clip only keeps its
  //    band standalone, which the next round checks with I4. Every round
  //    demotes at least one resolution or adds at least one new key, so it ends.
  const compileResult = compile(evidence, relations);
  const disjunctive = new Set(evidence.filter((_, i) => prepared[i]?.disjunctive).map((e) => e.id));
  const turnDisjunctive = new Set(evidence
    .filter((e) => offeredAsAlternative(e, ctx.conversation))
    .map((e) => e.id));
  const noDistribute = new Set<string>();
  let merged = mergeResolutionsIntoPreference(compileResult.preference, evidence, resolutions, {
    established_city: ctx.resolution.established_city, noDistribute, disjunctive, turnDisjunctive, disabled,
  });
  for (let iter = 0; ; iter++) {
    if (iter > resolutions.length + 16) throw new Error('geo merge checks did not converge'); // impossible by construction
    const v = await checkMerged(merged.trace, resolutions, rctx.db, { disabled, cache });
    const demote = v.demote.filter((d) => resolutions[d.index]?.status === 'resolved');
    const fresh = v.noDistribute.filter((n) => !noDistribute.has(n.key));
    if (demote.length === 0 && fresh.length === 0) break;
    resolutions = resolutions.slice();
    for (const d of demote) {
      resolutions[d.index] = demoted(resolutions[d.index], d.reason);
      emitDemotion(obs, meta, origins[d.index], d.rule, d.reason);
    }
    for (const n of fresh) {
      noDistribute.add(n.key);
      emitDemotion(obs, meta, origins[n.band_index], n.rule, n.reason, 'not_distributed');
    }
    merged = mergeResolutionsIntoPreference(compileResult.preference, evidence, resolutions, {
      established_city: ctx.resolution.established_city, noDistribute, disjunctive, turnDisjunctive, disabled,
    });
  }
  const compiled = merged.preference;
  obs.event({
    stage: 'resolution', outcome: 'ok', ...meta, result: 'merged',
    detail: { resolved_mentions: merged.resolved_evidence, unresolved_mentions: merged.unresolved_evidence },
  });

  // 7. Static satisfiability of the compiled expression against the universe,
  //    then deterministic signals + ambiguity from the FINAL resolutions (+
  //    injected overrides). A mention the merge left unresolved although every
  //    anchor resolved (several element rules, a held region / two cities, «او»
  //    in a clip) is an unresolved reference too.
  const satisfiability = classify(compiled, ctx.universe);
  const ambiguity = buildAmbiguity(resolutions, compileResult.needs_confirm, [
    ...(ctx.ambiguity ?? []),
    ...(merged.multi_rule_evidence > 0 ? (['unresolved_reference'] as AmbiguityCondition[]) : []),
  ]);
  const signals = buildGateSignals(evidence, resolutions, compileResult.needs_confirm, ctx.signals);

  // The deterministic gate names the action.
  const decision = decide(signals, ctx.maximum_safe_action, ctx.config, ambiguity);
  obs.event({
    stage: 'gating',
    outcome: 'ok',
    ...meta,
    result: decision,
    detail: { ambiguity: ambiguity.length, satisfiability, max_safe_action: ctx.maximum_safe_action },
  });

  // Materialise the decision as ONE pending proposal (the only side effect).
  // 'ignore' has no side effect — nothing to propose. Timed so a failing
  // proposal write is recorded loudly (and still propagates — time() re-throws).
  let proposal: ProposalRecord | null = null;
  if (decision !== 'ignore') {
    const action = toProposalAction(decision, ctx.maximum_safe_action);
    proposal = await obs.time(
      'review_outcome',
      { ...meta, result: action, detail: { decision } },
      () =>
        ports.proposals.createProposal({
          client_id: ctx.client_id,
          checkpoint_id: ctx.checkpoint_id ?? null,
          proposed_action: action,
          proposed_expression: compiled,
          gate_signals: signals,
          source_evidence_ids: evidence.map((e) => e.id),
        }),
    );
  } else {
    obs.event({ stage: 'review_outcome', outcome: 'ok', ...meta, result: 'ignore' });
  }

  return {
    decision, proposal, signals, ambiguity, compiled, satisfiability, resolutions,
    trace: merged.trace, resolved_evidence_ids: merged.resolved_evidence_ids, reviewed_evidence: evidence,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Resolution → compiled expression. PURE.
// ────────────────────────────────────────────────────────────────────────────

/** Operations whose geometry is a union of admin polygons (mergeable into one district_union). */
const ADMIN_UNION_OPS = new Set<string>(['district_polygon', 'district_union', 'zone_union', 'pin_containing_district']);
/** Admin ops a road side said in ANOTHER mention may be distributed onto: district
 *  lists and a pin's district. NOT zone_union (2026-10-04): a bare «شمال» zone
 *  and a «جنوب سلمان» said elsewhere in the same call are two separate wishes —
 *  clipping north Riyadh to "south of King Salman Road" turned a graded-right
 *  zone into a different place (legacy-diff blocker 34eebb5d). */
const CLIPPABLE_OPS = new Set<string>(['district_polygon', 'district_union', 'pin_containing_district']);

const CARDINALS = new Set(['north', 'south', 'east', 'west']);
type Cardinal = CardinalSide;

/** The cardinal side a directional_band recipe asks for, from its direction anchor(s). */
function sideOf(recipe: GeometryRecipe): Cardinal | null {
  if (recipe.side && CARDINALS.has(recipe.side)) return recipe.side as Cardinal;
  for (const a of recipe.source_anchors ?? []) {
    const z = parseDirection(a.normalized_token || a.span || '').zone;
    if (z && CARDINALS.has(z)) return z as Cardinal;
  }
  return null;
}

/** Turn a district-list recipe into "those districts, clipped to `side` of `road`". */
function clipRecipe(admin: GeometryRecipe, road: string, side: Cardinal, bandAnchors: GeometryRecipe['source_anchors']): GeometryRecipe {
  const districtIds = admin.resolved_element_ids.filter((id) => id !== road);
  return {
    ...admin,
    operation: 'district_side_clip',
    resolved_element_ids: [...districtIds, road],
    side,
    source_anchors: [...admin.source_anchors, ...bandAnchors.filter((b) => !admin.source_anchors.some((a) => a.span === b.span))],
    clip_geojson: undefined,
    clip_parts: undefined,
  };
}

/**
 * What the merge built that the merge checks (invariants.checkMerged) must
 * see — IN MEMORY ONLY. One entry per standalone `directional_band` ref (either
 * polarity), per in-mention clip (a district + a road side), and per clip
 * {@link distributeRoadSide} made. Indices point into the run's `resolutions`.
 */
export interface MergeTrace {
  evidence_id: string;
  kind: 'band' | 'clip' | 'distributed_clip';
  /** Index into `resolutions` of the directional_band. */
  band_index: number;
  /** Clip kinds: indices of the admin resolutions clipped. */
  admin_indices: number[];
  road: string;
  /** The band's cardinal side; null only for a legacy band with none (the checks ask on it). */
  side: Cardinal | null;
  /** Clip kinds: the ids that will be clipped (never a city / region record id). */
  district_ids: string[];
  /** distributed_clip only: `${road}|${side}`. */
  distribute_key?: string;
}

export interface MergeOptions {
  established_city?: string;
  /** Road sides (`${road}|${side}`) whose distribution failed a merge check: their bands stay standalone. */
  noDistribute?: ReadonlySet<string>;
  /** Evidence ids whose mention is a disjunction («او»): V8, or is not and. */
  disjunctive?: ReadonlySet<string>;
  /** Evidence ids the customer OFFERED AS AN ALTERNATIVE (a disjunction word right
   *  before the mention in their words — {@link offeredAsAlternative}): a road side
   *  among them is never distributed across mentions («النرجس او شمال طريق الملك
   *  سلمان» said as two mentions is Narjis OR the band — never only the part of
   *  Narjis north of the road). */
  turnDisjunctive?: ReadonlySet<string>;
  /** TEST-ONLY: checks switched off (C1, V8). */
  disabled?: ReadonlySet<CheckName>;
}

export interface MergedPreference {
  preference: GeoPreference;
  /** Mentions whose stub recipe was replaced by resolver output. */
  resolved_evidence: number;
  /** Mentions left as stubs (some anchor needs_confirm / unresolvable, or several element rules). */
  unresolved_evidence: number;
  /** Of those: mentions whose anchors ALL resolved but the merge held (several element rules, C1, V8). */
  multi_rule_evidence: number;
  /** See {@link MergeTrace}. */
  trace: MergeTrace[];
  /** The ids of the mentions counted in `resolved_evidence`. */
  resolved_evidence_ids: string[];
}

/** Where a merged ref came from: its mention, and the resolutions behind it. */
interface RefInfo {
  eid: string;
  /** A standalone directional_band ref: its resolution. */
  band_index?: number;
  /** An admin ref: the resolutions unioned into it. */
  admin_indices: number[];
  /** An admin ref: its district / zone ids (no city / region record id). */
  district_ids: string[];
}

const isCityOrRegion = (t: string | undefined): boolean => t === 'city' || t === 'region';

/**
 * Overwrite the compiler's per-mention stub recipes with the resolver's recipes.
 * `resolutions` is in evidence × anchor order (exactly how runReviewFirst
 * produced it). A mention is replaced only when EVERY anchor resolved — a
 * partial result is never mixed (ids beside names) so consumers can trust that
 * `geo_data_version !== 'stub'` means "real ids". Never mutates its inputs.
 *
 * Held as a stub even when every anchor resolved (counted multi-rule):
 *  - two DIFFERENT element rules in one mention;
 *  - C1: a REGION beside anything else, or two different named cities beside
 *    a non-city place (whose city would the place be in?);
 *  - V8: a district AND a road side joined by «او» (or is not and: «النرجس او
 *    شمال طريق الملك سلمان» is not "the part of Narjis north of the road").
 * C2: a CITY record id is never kept beside another place of the mention.
 */
export function mergeResolutionsIntoPreference(
  pref: GeoPreference,
  evidence: Evidence[],
  resolutions: ResolutionResult[],
  opts: MergeOptions = {},
): MergedPreference {
  const perEvidence = new Map<string, ResolutionResult[]>();
  const base = new Map<string, number>();
  let cursor = 0;
  for (const e of evidence) {
    perEvidence.set(e.id, resolutions.slice(cursor, cursor + e.anchors.length));
    base.set(e.id, cursor);
    cursor += e.anchors.length;
  }
  const evById = new Map(evidence.map((e) => [e.id, e] as const));

  const out = JSON.parse(JSON.stringify(pref)) as GeoPreference;
  const info = new Map<AnchorRef, RefInfo>();
  const clipTrace: MergeTrace[] = [];
  const resolvedIds: string[] = [];
  let resolved = 0;
  let unresolved = 0;
  let multiRule = 0;
  for (const group of out.groups ?? []) {
    for (const clause of group.clauses ?? []) {
      for (const ref of clause.anyOf ?? []) {
        const eid = typeof ref.geometry_id === 'string' && ref.geometry_id.startsWith('geo:') ? ref.geometry_id.slice(4) : '';
        const ev = eid ? evById.get(eid) : undefined;
        const rs = eid ? perEvidence.get(eid) : undefined;
        if (!ev || !rs || rs.length === 0) continue;
        const at = base.get(eid) ?? 0;
        const allResolved = rs.every((r) => r.status === 'resolved' && r.recipe);
        if (!allResolved) { unresolved += 1; continue; }
        // C1 — a region beside anything else, or two different named cities
        // beside a place that is not a city: there is no honest single shape
        // (whose city is the road / district in?). Ask.
        const types = ev.anchors.map((a) => a.anchor_type);
        const cityTokens = new Set(ev.anchors.filter((a) => a.anchor_type === 'city')
          .map((a) => placeKey(a.normalized_token || a.span || '')).filter(Boolean));
        const regionHold = enabled(opts.disabled, 'merge_region_hold') && types.includes('region') && ev.anchors.length > 1;
        const twoCityHold = enabled(opts.disabled, 'merge_two_cities') && cityTokens.size >= 2
          && types.some((t) => !isCityOrRegion(t));
        if (regionHold || twoCityHold) { unresolved += 1; multiRule += 1; continue; }
        const recipes = rs.map((r) => r.recipe!);
        const adminIdx = recipes.map((r, i) => (ADMIN_UNION_OPS.has(r.operation) ? i : -1)).filter((i) => i >= 0);
        const bandIdx = recipes.map((r, i) => (ADMIN_UNION_OPS.has(r.operation) ? -1 : i)).filter((i) => i >= 0);
        // Two DIFFERENT element rules in one mention («غرب طريق الملك فهد قريب من
        // الجامعة خلال 2 كيلو»): the merge used to keep the first and silently
        // drop the rest. There is no honest single shape for both, so the
        // mention stays unresolved (the rep is asked) — never half of it.
        if (new Set(bandIdx.map((i) => elementRuleKey(recipes[i]!))).size > 1) {
          unresolved += 1;
          multiRule += 1;
          continue;
        }
        const bandInfo = (i: number): RefInfo => ({ eid, band_index: at + i, admin_indices: [], district_ids: [] });
        const adminInfo = (idx: readonly number[]): RefInfo => ({
          eid,
          admin_indices: idx.map((i) => at + i),
          district_ids: Array.from(new Set(idx.filter((i) => !isCityOrRegion(ev.anchors[i]?.anchor_type))
            .flatMap((i) => recipes[i]!.resolved_element_ids))),
        });
        if (recipes.length === 1) {
          ref.recipe = { ...recipes[0]!, source_anchors: ev.anchors };
          if (recipes[0]!.operation === 'directional_band') info.set(ref, bandInfo(0));
          else if (ADMIN_UNION_OPS.has(recipes[0]!.operation)) info.set(ref, adminInfo([0]));
        } else if (bandIdx.length === 0) {
          // Several admin places in one mention («المهدية أو الجبيلة») → one union.
          // C2: a city's recipe is its record id (not a district) and is the
          // SCOPE of the mention's other places («شمال الرياض» = the zone; «الروضة
          // بجدة» = Jeddah's الروضة): whenever anything else is left, the city
          // recipes are dropped from the union. source_anchors keeps ALL anchors
          // for provenance either way.
          const nonCity = recipes.map((_, i) => i).filter((i) => ev.anchors[i]?.anchor_type !== 'city');
          const keptIdx = nonCity.length > 0 ? nonCity : recipes.map((_, i) => i);
          const kept = keptIdx.map((i) => recipes[i]!);
          const ids = Array.from(new Set(kept.flatMap((r) => r.resolved_element_ids)));
          const operation = kept.every((r) => r.operation === 'zone_union') ? 'zone_union' : 'district_union';
          ref.recipe = { ...kept[0]!, operation, source_anchors: ev.anchors, resolved_element_ids: ids };
          info.set(ref, adminInfo(keptIdx));
        } else if (adminIdx.length === 0) {
          // The same element rule twice (a repeated anchor) → that rule once.
          ref.recipe = { ...recipes[bandIdx[0]!]!, source_anchors: ev.anchors };
          if (ref.recipe.operation === 'directional_band') info.set(ref, bandInfo(bandIdx[0]!));
        } else {
          // MIXED — «العليا (غرب الملك فهد)»: a district AND a side of a road =
          // the part of the district on that side. When the non-admin recipe is
          // a road side, the mention becomes ONE district_side_clip (a custom
          // shape computed at proposal time). Any other mix (district + radius…)
          // stays unresolved — see below.
          const band = recipes[bandIdx[0]!]!;
          // A CITY beside a road side / distance rule is the scope, not a
          // district to clip («شمال طريق الملك سلمان بالرياض»): its single id is
          // the city record, which is not a district. Without any other admin
          // anchor the mention is the element rule alone. anchorPrep.ts passed
          // that city to the element lookup as `city`, so the road / venue was
          // searched in the place the customer NAMED. (A REGION beside anything
          // never reaches here: C1 holds it.) The element's anchors come FIRST
          // in source_anchors: the chip is labelled from the first one, and
          // must not read as the whole city.
          const districtAdmin = adminIdx.filter((i) => !isCityOrRegion(ev.anchors[i]?.anchor_type));
          if (districtAdmin.length === 0) {
            ref.recipe = { ...band, source_anchors: [...bandIdx, ...adminIdx].map((i) => ev.anchors[i]!) };
            if (band.operation === 'directional_band') info.set(ref, bandInfo(bandIdx[0]!));
            resolved += 1;
            resolvedIds.push(eid);
            continue;
          }
          // V8 — «او» between the district and the road side: two alternatives,
          // not "the part of the district on that side". Ask.
          if (enabled(opts.disabled, 'or_not_and') && opts.disjunctive?.has(eid)) {
            unresolved += 1;
            multiRule += 1;
            continue;
          }
          const side = band.operation === 'directional_band' ? sideOf(band) : null;
          const road = band.resolved_element_ids[0];
          if (!side || !road) {
            // «النرجس قريب من الرياض بارك خلال 2 كيلو» = the district AND near the
            // venue. There is no single shape for that, and the client's
            // location_items are an OR-union: saving the district and the
            // distance rule as two items (the old hidden `geo:<id>:admin`
            // clause) would save the WHOLE district — a clause the card never
            // showed and unticking the mention never removed. Ask instead.
            unresolved += 1;
            multiRule += 1;
            continue;
          }
          const adminIds = Array.from(new Set(districtAdmin.flatMap((i) => recipes[i]!.resolved_element_ids)));
          const adminRecipe: GeometryRecipe = {
            ...recipes[districtAdmin[0]!]!,
            operation: adminIds.length > 1 ? 'district_union' : recipes[districtAdmin[0]!]!.operation,
            source_anchors: districtAdmin.map((i) => ev.anchors[i]!),
            resolved_element_ids: adminIds,
          };
          ref.recipe = clipRecipe(adminRecipe, road, side, bandIdx.map((i) => ev.anchors[i]!));
          clipTrace.push({
            evidence_id: eid, kind: 'clip', band_index: at + bandIdx[0]!,
            admin_indices: districtAdmin.map((i) => at + i), road, side,
            district_ids: adminIds.filter((id) => id !== road),
          });
        }
        resolved += 1;
        resolvedIds.push(eid);
      }
    }
  }
  const distributed = distributeRoadSide(out, info, opts);
  // Every road side left standalone (either polarity) — distributed bands are gone.
  const bandTrace: MergeTrace[] = [];
  for (const g of out.groups) {
    for (const c of g.clauses) {
      for (const r of c.anyOf) {
        const rec = r.recipe;
        const ri = info.get(r);
        if (!rec || rec.geo_data_version === 'stub' || rec.operation !== 'directional_band' || !ri || ri.band_index === undefined) continue;
        bandTrace.push({
          evidence_id: ri.eid, kind: 'band', band_index: ri.band_index, admin_indices: [],
          road: rec.resolved_element_ids[0] ?? '', side: sideOf(rec), district_ids: [],
        });
      }
    }
  }
  return {
    preference: out, resolved_evidence: resolved, unresolved_evidence: unresolved, multi_rule_evidence: multiRule,
    trace: [...bandTrace, ...clipTrace, ...distributed], resolved_evidence_ids: resolvedIds,
  };
}

/** Identity of an element rule: two recipes with the same key are the same rule. */
function elementRuleKey(r: GeometryRecipe): string {
  return JSON.stringify([r.operation, [...r.resolved_element_ids].sort(), r.radius_or_band_m ?? null, r.side ?? null]);
}

/**
 * A preference that says "these districts" and "west of King Fahd Road" means
 * the parts of those districts on that side — NOT the districts plus a 5 km band
 * along the whole road as a separate alternative (operator, 2026-09-15: "not
 * the entire length of the road"). The compiler puts every independent mention
 * in its OWN group (OR), so the standalone band lands in a different group
 * from the districts; the qualifier therefore applies across the whole
 * expression: when it holds ≥1 include district-list ref and include road-side
 * band(s) all on ONE road+side, every clippable include ref (in any group)
 * becomes a district_side_clip on that road/side, the standalone band refs are
 * removed, and groups left empty are dropped. Exclude clauses are untouched.
 * Two different roads/sides are ambiguous by design → nothing is changed.
 *
 * A band is never distributed when its road side is in `opts.noDistribute` (a
 * clip of it failed the merge checks: the districts are in another city than
 * the road — «او شمال طريق الملك فهد بالخبر» beside Riyadh's العليا — or the
 * road does not run that way inside them), or when its own mention is a
 * disjunction («او …», V8). Such a band stays its own alternative. Returns
 * the trace of every clip it made.
 */
function distributeRoadSide(pref: GeoPreference, info: ReadonlyMap<AnchorRef, RefInfo>, opts: MergeOptions): MergeTrace[] {
  const bands: Array<{ gi: number; ci: number; ri: number; road: string; side: Cardinal; anchors: GeometryRecipe['source_anchors']; band_index: number }> = [];
  let clippable = 0;
  pref.groups.forEach((g, gi) => g.clauses.forEach((c, ci) => {
    if (c.op !== 'include') return;
    c.anyOf.forEach((r, ri) => {
      const rec = r.recipe;
      if (!rec || rec.geo_data_version === 'stub') return;
      if (rec.operation === 'directional_band' && rec.resolved_element_ids.length === 1) {
        const side = sideOf(rec);
        if (!side) return;
        const road = rec.resolved_element_ids[0]!;
        const own = info.get(r);
        if (opts.noDistribute?.has(`${road}|${side}`)) return;
        if (enabled(opts.disabled, 'or_not_and') && own && opts.disjunctive?.has(own.eid)) return;
        bands.push({ gi, ci, ri, road, side, anchors: rec.source_anchors, band_index: own?.band_index ?? -1 });
      } else if (CLIPPABLE_OPS.has(rec.operation)) {
        clippable += 1;
      }
    });
  }));
  if (bands.length === 0 || clippable === 0) return [];
  if (enabled(opts.disabled, 'or_not_and') && opts.turnDisjunctive?.size) {
    for (const b of bands) {
      const own = info.get(pref.groups[b.gi]!.clauses[b.ci]!.anyOf[b.ri]!);
      if (own && opts.turnDisjunctive.has(own.eid)) return [];
    }
  }
  const first = bands[0]!;
  if (!bands.every((b) => b.road === first.road && b.side === first.side)) return [];

  const key = `${first.road}|${first.side}`;
  const trace: MergeTrace[] = [];
  for (const g of pref.groups) {
    for (const c of g.clauses) {
      if (c.op !== 'include') continue;
      for (const r of c.anyOf) {
        const rec = r.recipe;
        if (!rec || rec.geo_data_version === 'stub' || !CLIPPABLE_OPS.has(rec.operation)) continue;
        const own = info.get(r);
        r.recipe = clipRecipe(rec, first.road, first.side, first.anchors);
        trace.push({
          evidence_id: own?.eid ?? (r.geometry_id.startsWith('geo:') ? r.geometry_id.slice(4) : r.geometry_id),
          kind: 'distributed_clip', band_index: first.band_index,
          admin_indices: own?.admin_indices ?? [], road: first.road, side: first.side,
          district_ids: (own?.district_ids ?? []).filter((id) => id !== first.road),
          distribute_key: key,
        });
      }
    }
  }
  // Remove the standalone band refs; drop clauses and groups left empty; renumber.
  const bandKeys = new Set(bands.map((b) => `${b.gi}:${b.ci}:${b.ri}`));
  pref.groups = pref.groups
    .map((g, gi) => ({
      ...g,
      clauses: g.clauses
        .map((c, ci) => ({ ...c, anyOf: c.anyOf.filter((_, ri) => !bandKeys.has(`${gi}:${ci}:${ri}`)) }))
        .filter((c) => c.anyOf.length > 0),
    }))
    .filter((g) => g.clauses.length > 0);
  pref.groups.forEach((g, i) => { g.priority = i + 1; });
  if (pref.groups.length && !pref.groups.some((g) => g.role === 'primary')) pref.groups[0]!.role = 'primary';
  return trace;
}

// ────────────────────────────────────────────────────────────────────────────
// Deterministic derivations.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Map a gate decision to the proposals table's `proposed_action`. An `auto_write`
 * decision is recorded as its underlying WRITE action (write_soft/write_hard/
 * supersede) with status 'pending' — it still routes through proposal → apply,
 * never a direct client write.
 */
export function toProposalAction(
  decision: GateDecision,
  action: MaximumSafeAction,
): ProposalAction {
  if (decision === 'auto_write') {
    // The gate only returns auto_write for a write action (see gate.canAutoWrite),
    // so this narrowing always succeeds; fall back to human_review defensively.
    if (action === 'write_soft' || action === 'write_hard' || action === 'supersede') {
      return action;
    }
    return 'human_review';
  }
  if (decision === 'human_review') return 'human_review';
  // 'confirm' (and any residual) ⇒ customer confirmation.
  return 'confirm';
}

/** Resolver reason → deterministic ambiguity condition. */
function ambiguityForReason(reason: string | undefined): AmbiguityCondition {
  switch (reason) {
    case 'ambiguous_entity':
      return 'multiple_plausible_entities';
    case 'missing_radius':
    case 'distance_unverified': // a number the customer's words do not state = no radius
      return 'missing_radius';
    default:
      // outside_admin, corridor_underspecified, pin_scope_unclear, tie, the
      // demote-only checks (side_not_along_road, place_is_part_of_name, …) all
      // mean "we could not pin the reference down" → confirm with the customer.
      return 'unresolved_reference';
  }
}

/**
 * Build the deterministic ambiguity list: any anchor that did not resolve cleanly
 * contributes a condition, a structurally-uncertain compile adds
 * `contradiction_without_replacement`, and any caller-supplied conditions merge
 * in. De-duplicated, order-stable.
 */
export function buildAmbiguity(
  resolutions: ResolutionResult[],
  compileNeedsConfirm: boolean,
  extra: AmbiguityCondition[] = [],
): AmbiguityCondition[] {
  const out: AmbiguityCondition[] = [];
  const seen = new Set<AmbiguityCondition>();
  const add = (c: AmbiguityCondition) => {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  };
  for (const r of resolutions) {
    if (r.status !== 'resolved') add(ambiguityForReason(r.reason));
  }
  if (compileNeedsConfirm) add('contradiction_without_replacement');
  for (const c of extra) add(c);
  return out;
}

/**
 * Derive GateSignals from resolution outcomes + compile result + evidence, with
 * caller overrides applied last. The recipe is deterministic:
 *  - interpretation_confidence: min over model-emitted evidence confidences
 *    (absent ⇒ 1; e.g. gold-derived evidence never carries a model confidence).
 *  - lexical_candidate_quality / geo_resolution_margin: any unresolved anchor
 *    zeroes both (nothing is safely writable); otherwise geo margin is the min
 *    candidate margin and lexical quality is 1 (the resolver's exact-match gate
 *    guarantees the selected place was an exact official/alias hit).
 *  - context_consistency: 1 when everything resolved, else 0.
 *  - contradiction_signal: 0 when the compile flagged needs_confirm, else 1.
 *  - source_quality: defaults to 1 (a channel property — inject to override).
 */
export function buildGateSignals(
  evidence: Evidence[],
  resolutions: ResolutionResult[],
  compileNeedsConfirm: boolean,
  overrides: Partial<GateSignals> = {},
): GateSignals {
  const anyUnresolved = resolutions.some((r) => r.status !== 'resolved');
  const margins = resolutions
    .filter((r) => r.status === 'resolved')
    .map((r) => (typeof r.candidate_margin === 'number' ? r.candidate_margin : 1));

  const confs = evidence
    .map((e) => e.interpretation_confidence)
    .filter((c): c is number => typeof c === 'number');

  const derived: GateSignals = {
    interpretation_confidence: confs.length ? Math.min(...confs) : 1,
    lexical_candidate_quality: anyUnresolved ? 0 : 1,
    geo_resolution_margin: anyUnresolved ? 0 : margins.length ? Math.min(...margins) : 0,
    context_consistency: anyUnresolved ? 0 : 1,
    contradiction_signal: compileNeedsConfirm ? 0 : 1,
    source_quality: 1,
  };

  return { ...derived, ...overrides };
}
