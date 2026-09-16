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
 *
 * `publishing` is the RELEASE budget. Putting a finished creative out is not
 * production and must not be charged to a production bucket: until 2026-09-14
 * the `scheduling` step drew on the writer's `post` slots, so imaginary
 * publishing work displaced real design work. See `releases.ts`.
 */
/**
 * EVERY load bucket, as a value — and the type is DERIVED from it.
 *
 * This is one declaration on purpose. `snapshot.ts` kept its own hand-written
 * copy (`const BUCKETS = ['post','video','approvals']`) which silently fell one
 * short of the union: `caps.publishing` was therefore never computed for
 * anybody, and no publish release could ever be assigned to a human
 * (production, 2026-09-16). A second list that must be remembered is a list
 * that will be forgotten, so there is no longer a second list — adding a bucket
 * here adds it everywhere, and forgetting is not possible.
 */
export const LOAD_BUCKETS = ['post', 'video', 'approvals', 'publishing'] as const;

export type LoadBucket = typeof LOAD_BUCKETS[number];

/**
 * The buckets a CONTENT TYPE can live in. Deliberately a named alias rather
 * than `Exclude<LoadBucket, 'approvals'>`: that exclusion silently grew to
 * include `publishing` the moment the fourth bucket was added, which would have
 * let a content type claim the release budget as its production budget.
 */
export type ProductionBucket = 'post' | 'video';

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
  bucket: ProductionBucket;
  steps: StepSpec[];
  /**
   * May consecutive steps share a calendar DAY?
   *
   * `false` (the default, and right for video): a step must END the working
   * day BEFORE its successor STARTS. Editing that takes three days really does.
   *
   * `true`: a step may finish on the same day the next one begins, so a whole
   * chain can sit inside one day. The operator's own statement of the post
   * path (2026-09-16): «a full post takes one day max — writing, designing,
   * approval, everything — and a designer does four a day». Without this, the
   * scheduler gave writing, its review, design, the writer's review and final
   * approval a day EACH, so a post could not exist in under five working days
   * and September could not start before the 22nd. That was the model's
   * assumption, never the team's.
   */
  sameDayChain?: boolean;
}

/** The capacity bucket a step consumes: approvals are their own budget. */
export function bucketOfStep(step: StepSpec, contentBucket: ProductionBucket): LoadBucket {
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
  buckets: ProductionBucket[];
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

/**
 * ONE ROW of organic posts — the month model's unit of work.
 *
 * A row is a whole posting day: three posts written in one sitting, approved
 * together, and published as one batch. It is **one task to work, one to
 * approve, and three slots on ONE day** in the capacity ledger — never three
 * items scheduled independently (see `effortWeightsSameDay`).
 *
 * The row carries its own `day`, taken from `mos_month_template.posting_weekdays`.
 * That is the whole point: the month model's project-separation rule is
 * satisfied **by construction** (Sun أ · Tue ب · Thu ج · Sat general), so
 * `distribute()` — a backtracking search — is not run at all.
 *
 * Read that rule carefully, because it is NOT the one `PlatformRules` enforces.
 * `allowConsecutiveSameProject` is per POST: no two posts published back to
 * back may share a project. A row is three posts of the SAME project five
 * minutes apart, so the row model breaks that rule deliberately and cannot be
 * run through `distribute()` at all. What the month guarantees instead is per
 * DAY: **one project owns a whole posting day, and no two consecutive posting
 * days share a project.** Do not "fix" the row back into `distribute()` on the
 * strength of the per-post wording.
 *
 * `projectId` is NULLABLE: the Saturday row is the GENERAL row and belongs to no
 * project (A8b). It is a quarter of the organic month — 4 rows and 12 posts of
 * every 16 and 48 — so "no project" is a first-class state, never an empty
 * string standing in for one.
 */
export interface RowRequirement {
  /** Stable synthetic key — becomes `mos_content_rows.row_key`. */
  rowKey: string;
  /** `null` = the general row. */
  projectId: string | null;
  projectName?: string;
  /** The civil publishing day. From the template; NEVER searched for. */
  day: string;
  /** The one destination this row publishes to. */
  platform: string;
  /** Members in the row (`mos_month_template.posts_per_row`, 3). */
  posts: number;
  /** Content type of every member. Default `post`. */
  contentTypeKey?: string;
  /** Arabic label used to title members when there is no project. */
  labelAr?: string;
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
  /**
   * The month model's ROW-AWARE organic path (B2). When present — and only
   * then — `projects[].posts` / `[].videos` are ignored, every item is built
   * from a row, and the publishing day comes from the row instead of from
   * `distribute()`. Absent = the wizard's original loose-item path, unchanged.
   */
  rows?: RowRequirement[];
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
  /**
   * The step's EFFORT ESTIMATE (`mos_step_effort.working_days`) — what the work
   * is thought to take, copied straight off `StepSpec`.
   *
   * It is **not** the window this stage occupies and must never be used to
   * derive one. A ROW's stage spans ONE day whatever its step estimate says, so
   * a `design` stage on a row reports `2` while `start === end`. Read
   * `slotWeights` for what was actually booked.
   */
  workingDays: number;
  /**
   * What this stage ACTUALLY reserved: one entry per working day of
   * `[start, end]`, in order, each the slots charged on that day.
   *
   *   classic post, 2-day design → `[1, 1]` over two days
   *   a 3-post ROW's design      → `[3]`    on one day
   *
   * `slotWeights.length` is the span really booked and `sum(slotWeights)` is
   * the reservation weight. Every reservation is built from this, so the
   * planner's load table, `PlannedReservation.weight` and the SQL re-check can
   * no longer disagree about a stage by re-deriving it three different ways.
   */
  slotWeights: number[];
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
  bucket: ProductionBucket;
  /** `null` only for a member of the GENERAL row, which has no project (A8b). */
  projectId: string | null;
  projectName?: string;
  workflowKey: string;
  /**
   * The row this post belongs to (`mos_content_rows.row_key`), when the plan
   * took the row-aware path. `undefined` for a loose wizard item.
   */
  rowKey?: string;
  /**
   * The WRITER's order inside the row, 0-based (`mos_content.row_order`).
   * Publish order is its REVERSE: Instagram shows newest first, so the post
   * placed first is published last and ends up read first.
   */
  rowOrder?: number;
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

/**
 * ONE release of a finished creative to ONE destination on ONE date.
 *
 * A release is deliberately NOT a step of the creative's workflow. Making a
 * design and putting it out are different jobs, done by different people, and a
 * creative can be released many times: two platforms, two dates, or the same
 * post run again next quarter. Until 2026-09-14 the workflow ended in a single
 * `scheduling` + `publish_check` pair, so N destinations shared one task with
 * one owner and one completion, and closing it declared the whole creative
 * published.
 *
 * `needsPerson` is the load-bearing field. Most releases go out by themselves:
 * where a connected account can publish, the system schedules the post and
 * nobody is asked to do anything. A task is raised only when a human is
 * genuinely required. Without that rule this split would just manufacture more
 * of the orphaned publish-check tasks it exists to remove.
 */
export interface PlannedRelease {
  /** Stable synthetic key — `<itemKey>@<platform>#<day>`; survives revise/commit. */
  key: string;
  itemKey: string;
  /** `organic` = a post on a social account. `ad` = one ad inside an ad set. */
  kind: ReleaseKind;
  platform: string;
  executionKey: string;
  /** Civil publishing day. */
  day: string;
  /** ISO instant, from the civil day + the platform's slot time. */
  plannedAt: string;
  /** The account it lands on, when the plan already knows one. */
  accountId: string | null;
  /** Whether a PERSON has to act for this release to happen. */
  needsPerson: boolean;
  /** Why a person is needed. `null` exactly when `needsPerson` is false. */
  reason: ReleaseReason | null;
  /** Chosen owner, when one is eligible and free. `null` opens the task unassigned. */
  assigneeUserId: string | null;
  /** Effort charged to the `publishing` bucket. Always 0 when automatic. */
  workingDays: number;
  /**
   * Which placement of the destination this release is
   * (`mos_publications.placement_variant`). `null` for an ad and for the legacy
   * one-release-per-placement path.
   *
   * Every organic post publishes TWICE: the square design as a FEED post
   * carrying the caption, and the vertical design as a STORY carrying no
   * caption at all — same moment, same account.
   */
  placementVariant: PlacementVariant | null;
  /**
   * The creative both halves of a pair share (`mos_publications.pair_id`).
   *
   * Convention copied from the paid side (`mos_ad_sets`) so the weekly ranking
   * can sum a creative's feed and story on one key: **the feed release's
   * `pairId` is its own key** and the story carries the feed's. `null` when the
   * release is not part of a pair.
   */
  pairId: string | null;
  /** Does this release carry the approved caption? A story never does. */
  carriesCaption: boolean;
}

/** Feed (square, caption) vs story (vertical, no caption). Mirrors `mos_publications.placement_variant`. */
export type PlacementVariant = 'feed' | 'story';

export type ReleaseKind = 'organic' | 'ad';

/**
 * Why a release needs a person.
 *
 * These are the reasons the PLAN can know: whether the destination can publish
 * by itself. Reasons discovered later at run time — the platform preflight
 * blocked it, the platform rejected it, the ad failed — are not plan-time
 * facts and must never be guessed here; the release sweep opens a task for
 * those when they actually happen.
 */
export type ReleaseReason =
  /** No connected account on this platform that is allowed to publish. */
  | 'account_not_connected'
  /** The platform has no publishing integration at all (x, website). */
  | 'platform_not_automatable'
  /** Automation is switched off for this platform by the operator. */
  | 'manual_by_policy';

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
  /** The SUBJECT's key: an item key, or the row key when `rowKey` is set. */
  itemKey: string;
  /**
   * Set when the subject is a ROW (`mos_content_rows.row_key`), null for a
   * single item. `mos_plan_consume_reservation` matches on this (C1) — a row
   * task whose reservation cannot be found opens with no assignee and no
   * window, silently.
   */
  rowKey: string | null;
  /**
   * The refresh cycle this reservation's subject belongs to, as
   * `` `${executionKey}#${round}` `` — the SAME composite key
   * `mos_campaign_plan_commit` builds `v_cycle_map` with. NULL for every
   * organic reservation and for every row.
   *
   * A COMPOSITE KEY, NOT A UUID, AND THAT IS NOT A SHORTCUT.
   * `mos_refresh_cycles` rows do not exist when the plan is made — the commit
   * creates them in the same transaction that writes these reservations, so
   * there is no id for the planner to carry. The commit resolves this key
   * against `v_cycle_map` and writes the real
   * `mos_task_reservations.cycle_id`.
   *
   * WHY IT HAS TO BE CARRIED AT ALL. A paid item whose creative slot belongs
   * to a LATER refresh round gets no content shell at commit time — the shell
   * is created lazily by `mos_plan_start_due` at `production_start_on` — so
   * its reservation lands with `content_id IS NULL AND row_id IS NULL`. The
   * sweep binds it with
   * `WHERE content_id IS NULL AND row_id IS NULL AND cycle_id = <cycle>
   *    AND content_key = <slot.content_key>`.
   * Until 2026-09-15 nothing ever populated `cycle_id`, so the bind matched
   * NOTHING and every deferred reservation — 75 of each paid plan's 100 —
   * charged its assignee's capacity forever while `mos_plan_repair` re-dated
   * it onto today, every day. Do not drop this field.
   */
  cycleKey: string | null;
  stepKey: string;
  roleKey: PathRole;
  bucket: LoadBucket;
  assigneeUserId: string | null;
  plannedStart: string;
  plannedEnd: string;
  weight: number;
  /**
   * HOW `weight` spreads across `[plannedStart, plannedEnd]` — stated, never
   * inferred.
   *
   *   `per_day`  — one slot on each working day of the window
   *                (`mos_spread_effort`, JS `effortWeights`).
   *   `same_day` — the whole weight on `plannedStart`, which always equals
   *                `plannedEnd` (`mos_spread_effort_same_day`,
   *                JS `effortWeightsSameDay`).
   *
   * The preview computes the load in JS and `mos_campaign_plan_commit`'s
   * conflict test recomputes it in SQL. With only `(start, end, weight)` on the
   * wire, SQL has to GUESS which spread was meant — and it guesses `per_day`
   * for everything today, so a row booked as three slots on Monday is
   * re-checked as one slot on Mon/Tue/Wed: a spurious WS409 on two days the
   * planner never touched, and a missed overbook on the day it did. Naming the
   * mode removes the guess. Consumed since B4: the commit's capacity re-check
   * calls `mos_spread_effort_mode(start, weight, spread = 'same_day')`.
   */
  spread: 'per_day' | 'same_day';
  /** The per-day weights, in order — `slotWeights` of the stage this came from. */
  weights: number[];
}

/** `mos_content_rows.kind`. A paid batch is NOT a row of three — see the plan §2. */
export type ContentRowKind = 'organic_row' | 'general_row';

/**
 * A scheduled ROW — the subject that carries the task, the reservation and the
 * pinned workflow version (`mos_content_rows`).
 *
 * Its members are `PlannedItem`s carrying the same `rowKey`. The row owns ONE
 * production chain: each stage is ONE day charging `slotsPerStage` slots, so
 * "three posts written in one sitting" is three slots on one day and not one
 * slot on each of three days.
 */
export interface PlannedRow {
  rowKey: string;
  kind: ContentRowKind;
  /** `null` for the general row (A8b). */
  projectId: string | null;
  projectName?: string;
  platform: string;
  executionKey: string;
  /** The publishing day, from the template. */
  batchDay: string;
  batchKey: string;
  /** Members in the WRITER's order (`row_order` 0…n−1). Publish order is its reverse. */
  itemKeys: string[];
  /** The row's one production chain — shared by every member. */
  stages: PlannedStage[];
  requiredReadyAt: string;
  productionStart: string;
  /** Slots ONE stage of this row charges, all on a single day (= member count). */
  slotsPerStage: number;
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
  | 'range_in_past'
  /**
   * The row's publishing moment is unusable operator data
   * (`mos_month_template.publish_time` / `intra_row_gap_minutes`): either it is
   * not a real `HH:MM`, or the row no longer fits before midnight and its
   * members would collide on 23:59 in the wrong order. Both used to be
   * swallowed inside `rowSlotTime`; both now REFUSE the plan, because a month
   * that publishes two posts at the same second is worse than a month the
   * operator has to fix one number in.
   */
  | 'publish_time';

export interface PlanConflict {
  kind: ConflictKind;
  itemKey: string | null;
  stepKey: string | null;
  day: string | null;
  messageAr: string;
  messageEn: string;
  detail?: Record<string, unknown>;
}

/**
 * The kinds that refuse a plan OUTRIGHT, whatever the scheduler managed.
 *
 * This is the engine's own filter — `planCampaign`'s
 * `feasible = sched.ok && !conflicts.some(conflictBlocksPlan)` — and its
 * semantics are deliberately unchanged. It answers "does this KIND refuse?",
 * which is NOT the same question as "is this what stops me confirming?". For
 * that, read `conflictBlocksConfirm` below.
 */
export function conflictBlocksPlan(c: PlanConflict): boolean {
  return c.kind === 'not_enough_slots' || c.kind === 'platform_rule' || c.kind === 'publish_time';
}

/**
 * Does this conflict stand between the operator and a confirmed month?
 *
 * A plan is infeasible for TWO reasons, and a conflict list must show both:
 *
 *   1. a refusing KIND (`conflictBlocksPlan`), or
 *   2. the SCHEDULER FAILED. `scheduleProduction` emits its proof — a
 *      `no_capacity` or `time_bound` with `stepKey: null` — immediately before
 *      it returns `ok: false` (schedule.ts: the time bound, the capacity bound,
 *      and the exhausted search). Such a conflict IS the reason `sched.ok` is
 *      false, so it blocks just as surely as a refusing kind.
 *
 * What never blocks is a RELEASE conflict (`stepKey: 'release'`). An
 * unassigned publish is a late post, not an impossible month.
 *
 * WHY TWO FUNCTIONS. On 2026-09-16 the page's list was `conflicts.slice(0, 6)`,
 * so six non-blocking release notes hid the one conflict refusing the month.
 * The first fix ranked by `conflictBlocksPlan` alone — which classes the real
 * blocker, a scheduler `no_capacity` proof («montage has 6 free slot-days but 10
 * are required»), as NOT blocking. Measured against live production: the page
 * would have shown the true reason without its «يمنع الاعتماد» label, the exact
 * failure the fix existed to end. This one is built ON the engine's rule rather
 * than beside it, so the two cannot drift apart.
 */
export function conflictBlocksConfirm(c: PlanConflict): boolean {
  if (conflictBlocksPlan(c)) return true;
  if (c.stepKey === 'release') return false;
  return c.kind === 'no_capacity' || c.kind === 'time_bound';
}

export interface PlanTotals {
  items: number;
  posts: number;
  videos: number;
  placements: number;
  batches: number;
  slotDaysByBucket: Record<string, number>;
  /** `projectId` is `null` for the general row's posts — they belong to no project. */
  perProject: Array<{ projectId: string | null; projectName?: string; items: number }>;
  perPlatform: Array<{ platform: string; placements: number }>;
  /**
   * Releases, split by who does them (`automatic + manual === total`) and by
   * placement (`feed + story <= total`; an ad is neither).
   */
  releases: { total: number; automatic: number; manual: number; feed: number; story: number };
  /** Rows, when the plan took the row-aware path. */
  rows?: { total: number; general: number; posts: number };
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
  /** The rows the items belong to. Empty on the loose-item (wizard) path. */
  rows: PlannedRow[];
  batches: PlanBatch[];
  /** One per destination per date — TWO per organic post in a row (feed + story). */
  releases: PlannedRelease[];
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
