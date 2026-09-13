/**
 * Contracts for the campaign scheduling engine.
 *
 * PURE types + a few constants. Imported by the SPA, `api/**` and the tests.
 * The database mirrors these shapes; `api/_lib/marketing/planning/snapshot.ts`
 * is the only place that translates SQL rows into them.
 */
import type { WorkCalendar } from './calendar';

/* ------------------------------------------------------------------ */
/* people, capacity, ledger                                            */
/* ------------------------------------------------------------------ */

/** The five role keys a workflow step can point at (mos_ prefix stripped). */
export type PathRole = 'ceo' | 'marketing_manager' | 'ops_supervisor' | 'writer' | 'montage';

/**
 * A capacity bucket. `post` / `video` are the production buckets that already
 * exist (`mos_load_buckets`); `approvals` is new — every APPROVAL step consumes
 * it instead of a production bucket, so a manager's four reviews a day do not
 * eat the designer-shaped budget and, more importantly, so the planner can see
 * when the single marketing manager is the bottleneck.
 */
export type LoadBucket = 'post' | 'video' | 'approvals';

export interface PersonCapacity {
  userId: string;
  /** Marketing roles the person holds (union — the app never gates on one active role). */
  roles: PathRole[];
  /** Slots per working day per bucket. Missing bucket = 0 (cannot take that work). */
  caps: Partial<Record<LoadBucket, number>>;
  /** Approved leave, inclusive civil dates. No slots on those days. */
  leaves: Array<{ from: string; to: string }>;
}

/**
 * One unit of *remaining* work already on someone's plate.
 *
 * The database view `mos_work_ledger_v` is the single definition (see the plan
 * §4.3): open workflow tasks, reserved/stale reservations, and open manual
 * tasks — each unit of work appearing exactly once, never on a past day.
 */
export interface LedgerRow {
  userId: string;
  day: string;
  bucket: LoadBucket;
  weight: number;
  /** For explaining a conflict to a human. */
  source: 'task' | 'reservation' | 'manual';
  refId: string | null;
}

export interface WorkloadSnapshot {
  /** "Today" in the calendar's zone. Nothing is ever scheduled before it. */
  today: string;
  calendar: WorkCalendar;
  people: PersonCapacity[];
  ledger: LedgerRow[];
  /**
   * Fingerprint of everything above, computed by the DATABASE
   * (`mos_workload_snapshot_hash()`). Commit refuses when it has moved.
   */
  hash: string;
}

/* ------------------------------------------------------------------ */
/* workflow shape                                                      */
/* ------------------------------------------------------------------ */

/**
 * One production stage, as the planner sees it.
 *
 * `workingDays` comes from `mos_step_effort` — an EXPLICIT estimate of how long
 * the work takes. It is deliberately NOT the step's `due_days`, which is a
 * deadline allowance ("you have two days to get to it"), not effort. Conflating
 * the two was corrected in plan v2.1.
 */
export interface StepSpec {
  key: string;
  roleKey: PathRole;
  isApproval: boolean;
  workingDays: number;
  /** Steps after the final approval (scheduling / publish_check) are planned forward from ready. */
  afterReady: boolean;
  labelAr: string;
  labelEn: string;
}

/** The production path for one content type, in order. */
export interface WorkflowSpec {
  workflowKey: string;
  bucket: Exclude<LoadBucket, 'approvals'>;
  steps: StepSpec[];
}

/** The capacity bucket a step consumes: approvals are their own budget. */
export function bucketOfStep(step: StepSpec, contentBucket: Exclude<LoadBucket, 'approvals'>): LoadBucket {
  return step.isApproval ? 'approvals' : contentBucket;
}

/* ------------------------------------------------------------------ */
/* platform rules                                                      */
/* ------------------------------------------------------------------ */

export interface PlatformRules {
  platform: string;
  /** 3 for a grid platform (Instagram); null when the feed is a plain stream. */
  gridColumns: number | null;
  /** Hard ceiling per day regardless of the requested frequency. */
  maxPerDay: number | null;
  /** May the same project appear twice on one publishing day? */
  allowSameProjectSameDay: boolean;
  /** May two consecutive posts (in publish order) be the same project? */
  allowConsecutiveSameProject: boolean;
  /** Must every project inside one grid row be distinct? */
  distinctProjectsPerGridRow: boolean;
  /** Which content buckets this platform accepts. */
  buckets: Array<Exclude<LoadBucket, 'approvals'>>;
  /** Default publishing times, `HH:MM` in the calendar's zone, one per daily slot. */
  defaultTimes: string[];
  /** Does a video/reel occupy a grid cell? (Instagram: yes. Stories never reach here.) */
  videosOccupyGrid: boolean;
}

/* ------------------------------------------------------------------ */
/* plan input                                                          */
/* ------------------------------------------------------------------ */

export interface ProjectRequirement {
  projectId: string;
  /** Display name, carried through so the preview and the grid can label cells. */
  projectName?: string;
  posts: number;
  videos: number;
}

export interface PlatformFrequency {
  platform: string;
  /** Publishing slots per allowed day. */
  perDay: number;
  /** Allowed weekdays (0=Sun…6=Sat). `null` = every day — publishing runs 7 days. */
  weekdays: number[] | null;
  /** `HH:MM` times; when shorter than `perDay` the last one repeats hourly. */
  times?: string[];
}

/**
 * The paid refresh policy.
 *
 * `fifthPolicy: 'A'` produces `slateSize` creatives for every refresh so
 * "replace all five" is available on every refresh date — EXCEPT where a
 * *banked* spare is a known fact at that cycle's production start (its cycle
 * was already decided). `'B'` produces `slateSize - keepMin` and makes the
 * fifth conditional with its real, later ready date.
 */
export interface PaidPolicy {
  slateSize: number;
  keepMin: number;
  cycleDays: number;
  minRemainingDays: number;
  leadTimeWorkingDays: number;
  fifthPolicy: 'A' | 'B';
  /**
   * Spares already banked on this child and NOT earmarked for another cycle.
   * `availableFrom` is the day the spare became a KNOWN fact (its source
   * cycle's decision day); a cycle may only draw on it when its own production
   * start is strictly after that — a forecast never counts as a bank.
   * The planner earmarks at most ONE spare per cycle and the database enforces
   * exclusivity (`mos_creative_slots.bank_reserved_for_cycle_id`, unique), so a
   * second cycle or another campaign can never consume the same spare
   * (plan v2.1 correction 2).
   */
  bankedSpares: Array<{ slotId: string; availableFrom: string }>;
}

export interface PlanOverrides {
  /** Grid positions the user dragged: item key → its fixed placement. */
  lockedPlacements?: Array<{ itemKey: string; platform: string; day: string; index: number }>;
  /** Stage assignments the user pinned: `${itemKey}:${stepKey}` → userId. */
  lockedAssignees?: Record<string, string>;
  /** Items the user dropped from the plan. */
  droppedItemKeys?: string[];
}

export interface PlanInput {
  campaignId: string | null;
  campaignRef?: string;
  kind: 'organic' | 'paid';
  projects: ProjectRequirement[];
  /** One child campaign (execution) per platform. */
  platforms: string[];
  rangeStart: string;
  rangeEnd: string;
  frequency: PlatformFrequency[];
  /** One creative reused on every platform (production once, distribution N). */
  crossPost: boolean;
  /** Working days between the final approval and the publish day. Default 1. */
  publishBufferDays: number;
  /** Paid-only. One entry per paid child. */
  paid?: Array<{ executionKey: string; executionId: string | null; platform: string; policy: PaidPolicy }>;
  overrides?: PlanOverrides;
}

/* ------------------------------------------------------------------ */
/* plan output                                                         */
/* ------------------------------------------------------------------ */

export interface PlannedStage {
  stepKey: string;
  roleKey: PathRole;
  bucket: LoadBucket;
  assigneeUserId: string | null;
  /** Inclusive working-day window actually chosen. */
  start: string;
  end: string;
  /** The latest end the backward pass allowed. `end <= deadline` always holds. */
  deadline: string;
  workingDays: number;
}

export interface PlannedPlacement {
  platform: string;
  executionKey: string;
  /** ISO instant, built from the civil day + the platform slot time. */
  plannedAt: string;
  day: string;
  batchKey: string;
  /** Position inside the day, 0-based, in publish order. */
  slotIndex: number;
  gridRow: number | null;
  gridCol: number | null;
}

export interface PlannedItem {
  /** Stable synthetic key — survives revise/commit, becomes `content_key`. */
  key: string;
  title: string;
  contentTypeKey: string;
  bucket: Exclude<LoadBucket, 'approvals'>;
  projectId: string;
  projectName?: string;
  workflowKey: string;
  /** Earliest moment the creative is needed = min over its placements. */
  needAt: string;
  requiredReadyAt: string;
  productionStart: string;
  /** Lower is more urgent. Batch sequence then position; drives placement order. */
  priority: number;
  stages: PlannedStage[];
  placements: PlannedPlacement[];
  /** Paid only. */
  slot?: { executionKey: string; cycleRound: number; slotIndex: number; kind: CreativeSlotKind };
}

export type CreativeSlotKind = 'initial' | 'replacement' | 'fifth';

export interface PlanBatch {
  key: string;
  executionKey: string;
  platform: string;
  day: string;
  /** 1-based publishing sequence within the campaign, ordered by day then platform. */
  sequence: number;
  itemKeys: string[];
}

export interface PlannedReservation {
  itemKey: string;
  stepKey: string;
  roleKey: PathRole;
  bucket: LoadBucket;
  assigneeUserId: string | null;
  plannedStart: string;
  plannedEnd: string;
  weight: number;
}

export interface PlannedCycle {
  executionKey: string;
  round: number;
  refreshOn: string | null;
  readyBy: string | null;
  productionStartOn: string | null;
  decisionDueOn: string | null;
  produced: number;
  /** The banked slot this cycle is allowed to draw on, exclusively. */
  bankedSpareSlotId: string | null;
  note: string;
}

export interface LoadCell {
  userId: string;
  day: string;
  bucket: LoadBucket;
  /** Already committed or reserved before this plan. */
  existing: number;
  /** Added by this plan. */
  proposed: number;
  capacity: number;
}

export type ConflictKind =
  | 'no_capacity'
  | 'time_bound'
  | 'no_eligible_person'
  | 'not_enough_slots'
  | 'platform_rule'
  | 'search_incomplete'
  | 'range_in_past';

export interface PlanConflict {
  kind: ConflictKind;
  itemKey: string | null;
  stepKey: string | null;
  day: string | null;
  messageAr: string;
  messageEn: string;
  detail?: Record<string, unknown>;
}

export interface PlanTotals {
  items: number;
  posts: number;
  videos: number;
  placements: number;
  batches: number;
  slotDaysByBucket: Record<string, number>;
  perProject: Array<{ projectId: string; projectName?: string; items: number }>;
  perPlatform: Array<{ platform: string; placements: number }>;
  /** Paid: the creative forecast. */
  creatives?: { initial: number; replacements: number; fifths: number; total: number; cycles: number };
}

export interface PlanResult {
  feasible: boolean;
  /**
   * Why infeasible, when we can PROVE it:
   *   `time_bound`     — even with infinite people the chain cannot finish in time.
   *   `capacity_bound` — required slot-days exceed every free slot-day before the deadline.
   * `null` while `feasible === false` means the search did not find a schedule
   * within its budget. That is NOT a proof of impossibility and must never be
   * presented as one (plan v2.1 correction 1).
   */
  infeasibleProof: 'time_bound' | 'capacity_bound' | null;
  /** True when the placement search hit its budget rather than exhausting the space. */
  searchIncomplete: boolean;
  searchStats: { expansions: number; backtracks: number; budget: number };
  items: PlannedItem[];
  batches: PlanBatch[];
  reservations: PlannedReservation[];
  cycles: PlannedCycle[];
  load: LoadCell[];
  conflicts: PlanConflict[];
  totals: PlanTotals;
  alternatives: {
    /** Smallest forward shift of the whole publishing window that plans cleanly. */
    earliestFeasibleStart: string | null;
    earliestFeasibleEnd: string | null;
    /** Largest item count that fits the requested range (drops from the last batches). */
    maxItemsInRange: number | null;
  };
  productionWindow: { start: string | null; end: string | null };
  snapshotHash: string;
  /** Engine version — stamped on the stored plan so a re-plan can detect drift. */
  engineVersion: string;
}

export const ENGINE_VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/* defaults (all overridable as DATA — see docs/plans/…, §21)          */
/* ------------------------------------------------------------------ */

export const DEFAULTS = {
  publishBufferDays: 1,
  manualTaskWeight: 0.5,
  approvalsCapPerDay: 20,
  paid: {
    slateSize: 5,
    keepMin: 1,
    cycleDays: 7,
    minRemainingDays: 3,
    leadTimeWorkingDays: 7,
    fifthPolicy: 'A' as const,
  },
  /** Ranking gates for the weekly refresh decision (PROPOSED — §7.6). */
  ranking: {
    minSpendSar: 150,
    minImpressions: 2000,
    fatigueFrequency: 3.0,
    fatigueCtrDropPct: 40,
  },
  /** Placement search budget. Exceeding it yields `searchIncomplete`, never "impossible". */
  searchBudget: 400_000,
} as const;
