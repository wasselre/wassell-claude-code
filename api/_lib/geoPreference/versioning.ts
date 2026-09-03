/**
 * Proposal versioning + STALE handling (operational safeguard).
 *
 * The review-first pipeline (orchestrator.ts) emits ONE `pending` proposal in
 * `geo_pref_proposals` per checkpoint. A conversation, though, keeps moving: the
 * customer says something NEWER a minute later that changes what the correct
 * preference is. If the earlier `pending` proposal is still sitting in a rep's
 * review queue, the rep could confirm a reading the customer has already revised —
 * writing a STALE preference to the client. This module closes that hole.
 *
 * The rule (pure, deterministic):
 *   When newer client evidence arrives for a subject (a client, optionally scoped
 *   to one conversation) that already has an OPEN (`pending`) proposal, the older
 *   open proposal is marked `superseded` with `superseded_by` pointing at the
 *   fresh proposal. Only STRICTLY older opens are superseded; a proposal that is
 *   already closed (confirmed/rejected/applied/superseded) is never touched, and a
 *   proposal at least as fresh as the incoming one is left alone.
 *
 * Recency is expressed as a single comparable `as_of` number per proposal — the
 * epoch-ms of the checkpoint's `as_of_timestamp`, or any monotonic generation
 * counter. The module never reads a clock and never reads the DB directly: the
 * store is injected (a thin adapter maps the SQL columns), so the decision logic
 * is fully unit-testable offline.
 *
 * SQL note (for the review-and-ops migration, kept in sync with the runbook):
 * `geo_pref_proposals.status` must include `'superseded'` and the table must gain
 * a `superseded_by uuid REFERENCES geo_pref_proposals(id)` column for this to
 * persist. This module is the authority on WHEN a supersession happens; the
 * migration only provides the columns. Nothing here writes to a client record.
 */

// ────────────────────────────────────────────────────────────────────────────
// Status vocabulary. 'pending' is the ONLY open (confirmable) status; every
// other status is terminal for versioning purposes.
// ────────────────────────────────────────────────────────────────────────────
export type ProposalStatus =
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'applied'
  | 'superseded';

/** The minimal proposal shape versioning needs (a projection of geo_pref_proposals). */
export interface ProposalVersionRow {
  id: string;
  /** Recency of the client evidence this proposal was built from — higher = newer. */
  as_of: number;
  status: ProposalStatus;
  /** Set once the row is superseded; points at the replacing proposal. */
  superseded_by?: string | null;
}

/** A proposal is OPEN — reviewable/confirmable by a rep — only while `pending`. */
export function isOpen(p: Pick<ProposalVersionRow, 'status'>): boolean {
  return p.status === 'pending';
}

/**
 * Can a rep safely confirm this proposal? Only an OPEN proposal may be confirmed;
 * a `superseded` one has been overtaken by fresher evidence and must be blocked at
 * the confirm boundary (belt-and-braces with the versioning sweep). Returns a
 * reason so the UI/caller can explain the block.
 */
export interface Confirmability {
  ok: boolean;
  reason?: 'superseded' | 'already_confirmed' | 'already_applied' | 'rejected';
}

export function confirmability(p: Pick<ProposalVersionRow, 'status'>): Confirmability {
  switch (p.status) {
    case 'pending':
      return { ok: true };
    case 'superseded':
      return { ok: false, reason: 'superseded' };
    case 'confirmed':
      return { ok: false, reason: 'already_confirmed' };
    case 'applied':
      return { ok: false, reason: 'already_applied' };
    case 'rejected':
      return { ok: false, reason: 'rejected' };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// The pure planner. Given the proposals already on record for a subject and the
// incoming (fresh) proposal, decide exactly which open proposals to supersede.
// ────────────────────────────────────────────────────────────────────────────
export interface SupersessionPlan {
  /** Open proposals overtaken by the incoming one — mark each superseded_by=incoming.id. */
  supersede: Array<{ id: string; superseded_by: string }>;
  /** Non-pending rows left untouched (already terminal). Reported for observability/tests. */
  kept_closed: string[];
  /** Pending rows that are NOT stale (as_of >= incoming.as_of, or the incoming itself). */
  kept_current: string[];
}

/**
 * Decide the supersessions. PURE — no I/O, no clock, no throw.
 *
 * A row is superseded iff ALL hold:
 *   - it is `pending` (open),
 *   - it is NOT the incoming proposal itself (id differs),
 *   - its evidence is STRICTLY older than the incoming's (as_of < incoming.as_of).
 * Equal `as_of` is deliberately NOT superseded — "newer" means strictly newer, so
 * two same-generation siblings never cannibalise each other.
 */
export function planSupersessions(
  existing: ProposalVersionRow[],
  incoming: { id: string; as_of: number },
): SupersessionPlan {
  const supersede: Array<{ id: string; superseded_by: string }> = [];
  const kept_closed: string[] = [];
  const kept_current: string[] = [];

  for (const row of existing) {
    if (row.id === incoming.id) {
      // The freshly-created proposal — never supersede itself.
      kept_current.push(row.id);
      continue;
    }
    if (!isOpen(row)) {
      kept_closed.push(row.id);
      continue;
    }
    if (row.as_of < incoming.as_of) {
      supersede.push({ id: row.id, superseded_by: incoming.id });
    } else {
      kept_current.push(row.id);
    }
  }

  return { supersede, kept_closed, kept_current };
}

// ────────────────────────────────────────────────────────────────────────────
// Injected store + orchestration. The store is the ONLY side-effect surface.
// ────────────────────────────────────────────────────────────────────────────

/** Identifies the "same subject" across turns. Conversation scope is optional. */
export interface SubjectKey {
  client_id: string;
  conversation_id?: string | null;
}

export interface ProposalVersionStore {
  /**
   * All proposals for this subject, ANY status (the planner filters). The adapter
   * decides whether conversation scoping is applied — pass it through the query.
   */
  listForSubject(subject: SubjectKey): Promise<ProposalVersionRow[]>;
  /**
   * Mark ONE proposal superseded, pointing at its replacement. Must be idempotent
   * (re-superseding an already-superseded row is a no-op) and must NOT flip a
   * terminal confirmed/applied row — the planner already excludes those, but the
   * adapter should also guard with `WHERE status='pending'` for safety.
   */
  markSuperseded(id: string, superseded_by: string): Promise<void>;
}

/**
 * Sweep stale open proposals for a subject after a fresh proposal is created.
 *
 * Call this AFTER the orchestrator has inserted the new `pending` proposal (so its
 * id exists to point `superseded_by` at). Lists the subject's proposals, plans the
 * supersessions deterministically, and applies them through the store. Returns the
 * plan for logging/tests. Never throws for a "nothing to do" case — an empty plan
 * is a valid, common result.
 */
export async function supersedeStaleOpenProposals(
  store: ProposalVersionStore,
  subject: SubjectKey,
  incoming: { id: string; as_of: number },
): Promise<SupersessionPlan> {
  const existing = await store.listForSubject(subject);
  const plan = planSupersessions(existing, incoming);
  for (const s of plan.supersede) {
    await store.markSuperseded(s.id, s.superseded_by);
  }
  return plan;
}

/**
 * Convenience: convert a checkpoint's ISO `as_of_timestamp` into the comparable
 * `as_of` number the planner expects. Returns 0 for an unparseable value (an
 * undated proposal is treated as the OLDEST possible, so any dated fresh proposal
 * supersedes it — fail toward not leaving a stale row confirmable).
 */
export function asOfFromTimestamp(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}
