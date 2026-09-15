/**
 * The month compiler — one `mos_month_template` row + three project ids + a
 * month, turned into the WHOLE month's work.
 *
 * It produces FOUR `PlanInput`s for the existing `planCampaign()`:
 *
 *   • ONE organic plan covering all three projects **and** the Saturday general
 *     row — 4 weeks × 4 posting days = 16 rows of 3 posts = 48 posts, 96
 *     releases (every post is a feed post and a story);
 *   • THREE paid plans, one per project — 5 creatives on each of the four
 *     batch dates = 20 each, 60 in all.
 *
 * 108 items. No search, no alternatives, no preview-then-commit ritual:
 * `planCampaign` is called with `withAlternatives: false` and `searchBudget: 0`,
 * and every publishing day comes from the template rather than from
 * `distribute()`. "Sun أ · Tue ب · Thu ج · Sat general" is then true **by
 * construction** — there is nothing left for a distribution search to get
 * wrong, and nothing for it to fail to find.
 *
 * Everything except `compileMonth` itself is a PURE function of its arguments:
 * no Supabase client, no clock, no env. `compileMonth` is pure too — the caller
 * hands it the template row, the projects and the workload snapshot. The
 * database work (reading the template, committing the four plans in ONE
 * transaction per D8) belongs to the action that calls this, not here.
 *
 * Plan: docs/plans/monthly-operating-model-build.md §4 Group B (B1).
 */
import {
  DEFAULTS, DEFAULT_RULES, DEFAULT_CALENDAR, DEFAULT_PUBLISHING,
  addDays, addWorkingDays, weekdayOf, workingDaysIn, planCampaign,
  type LedgerRow, type LoadBucket, type PlanConflict, type PlanInput, type PlanResult,
  type RowRequirement, type RuleSet, type WorkCalendar, type WorkloadSnapshot,
} from '../../../../src/lib/marketingOS/scheduling/index.js';

/* ------------------------------------------------------------------ */
/* the standing month, as data                                         */
/* ------------------------------------------------------------------ */

/**
 * `mos_month_template` — the one row that replaces sixteen settings screens.
 *
 * Field names are the camelCase of the columns. Two fields have no column yet
 * (`organicPlatform` / `paidPlatform`); they are parsed from the row when the
 * columns appear and default meanwhile, so adding them is a migration and not a
 * code change.
 */
export interface MonthTemplate {
  /** 0 = Sunday … 6 = Saturday. Default `{0,2,4,6}` = Sun / Tue / Thu / Sat. */
  postingWeekdays: number[];
  /** Posts in one row. */
  postsPerRow: number;
  /** How many projects the month runs. */
  projectsPerMonth: number;
  /** Paid creatives per project per week — one batch per week. */
  creativesPerProjectWeek: number;
  /** The Meta campaign's own length in days (E6 creates it from this). */
  campaignLengthDays: number;
  /** Riyals per project per month. */
  budgetPerProject: number;
  /** Working days between production starting and the first row publishing. */
  leadTimeWorkingDays: number;
  /** Calendar days before that, when next month must be chosen. */
  safetyMarginDays: number;
  /** `HH:MM` — when a row's LAST-read post goes out. */
  publishTime: string;
  /** Minutes between the three feed posts of one row. */
  intraRowGapMinutes: number;
  /** §3.7's fallback for a Saturday cell nobody wrote a note on. */
  generalTopicBank: string[];
  organicPlatform: string;
  paidPlatform: string;
}

export const MONTH_TEMPLATE_DEFAULTS: MonthTemplate = {
  postingWeekdays: [0, 2, 4, 6],
  postsPerRow: 3,
  projectsPerMonth: 3,
  creativesPerProjectWeek: 5,
  campaignLengthDays: 30,
  budgetPerProject: 2000,
  leadTimeWorkingDays: 10,
  safetyMarginDays: 2,
  publishTime: '18:00',
  intraRowGapMinutes: 5,
  generalTopicBank: [],
  organicPlatform: 'instagram',
  paidPlatform: 'meta',
};

/**
 * A month's cycle is FOUR WHOLE WEEKS — settled, and deliberately not read from
 * a column. It is what makes "four batches" and "16 rows" identities rather
 * than arithmetic that a stray `campaign_length_days` could quietly change.
 */
export const WEEKS_PER_MONTH = 4;

/** Weeks start on Sunday, matching the weekday numbering (0 = Sunday). */
const WEEK_START: number = 0;

const asNum = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const asStr = (v: unknown, fallback: string): string =>
  (typeof v === 'string' && v.trim() ? v.trim() : fallback);

/** `18:00:00+03` / `18:00:00` / `18:00` → `18:00`. */
function asTime(v: unknown, fallback: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? '').trim());
  if (!m) return fallback;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

/** One `mos_month_template` row → the typed template. Unknown keys are ignored. */
export function parseMonthTemplate(row: Record<string, unknown> | null | undefined): MonthTemplate {
  const r = row ?? {};
  const weekdays = Array.isArray(r.posting_weekdays)
    ? (r.posting_weekdays as unknown[])
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && x >= 0 && x <= 6)
    : [];
  const bank = Array.isArray(r.general_topic_bank)
    ? (r.general_topic_bank as unknown[]).map(String).filter(Boolean)
    : [];
  return {
    postingWeekdays: weekdays.length
      ? Array.from(new Set(weekdays)).sort((a, b) => a - b)
      : MONTH_TEMPLATE_DEFAULTS.postingWeekdays,
    postsPerRow: Math.max(1, Math.floor(asNum(r.posts_per_row, MONTH_TEMPLATE_DEFAULTS.postsPerRow))),
    projectsPerMonth: Math.max(1, Math.floor(asNum(r.projects_per_month, MONTH_TEMPLATE_DEFAULTS.projectsPerMonth))),
    creativesPerProjectWeek: Math.max(1, Math.floor(
      asNum(r.creatives_per_project_week, MONTH_TEMPLATE_DEFAULTS.creativesPerProjectWeek))),
    campaignLengthDays: Math.max(1, Math.floor(
      asNum(r.campaign_length_days, MONTH_TEMPLATE_DEFAULTS.campaignLengthDays))),
    budgetPerProject: Math.max(0, asNum(r.budget_per_project, MONTH_TEMPLATE_DEFAULTS.budgetPerProject)),
    leadTimeWorkingDays: Math.max(1, Math.floor(
      asNum(r.lead_time_working_days, MONTH_TEMPLATE_DEFAULTS.leadTimeWorkingDays))),
    safetyMarginDays: Math.max(0, Math.floor(
      asNum(r.safety_margin_days, MONTH_TEMPLATE_DEFAULTS.safetyMarginDays))),
    publishTime: asTime(r.publish_time, MONTH_TEMPLATE_DEFAULTS.publishTime),
    intraRowGapMinutes: Math.max(0, Math.floor(
      asNum(r.intra_row_gap_minutes, MONTH_TEMPLATE_DEFAULTS.intraRowGapMinutes))),
    generalTopicBank: bank,
    organicPlatform: asStr(r.organic_platform, MONTH_TEMPLATE_DEFAULTS.organicPlatform),
    paidPlatform: asStr(r.paid_platform, MONTH_TEMPLATE_DEFAULTS.paidPlatform),
  };
}

/* ------------------------------------------------------------------ */
/* geometry — which days the month actually runs on                    */
/* ------------------------------------------------------------------ */

export interface MonthWeek {
  /** 0-based. */
  index: number;
  /** Sunday. */
  start: string;
  /** Saturday. */
  end: string;
}

export interface MonthGeometry {
  /** `YYYY-MM`. */
  month: string;
  /** Exactly `WEEKS_PER_MONTH` whole weeks, Sunday → Saturday. */
  weeks: MonthWeek[];
  /** Every organic posting day, ascending. */
  postingDays: string[];
  firstPostingDay: string;
  lastPostingDay: string;
  /** One paid batch per week — the four Sundays. */
  paidBatchDays: string[];
  /** `lead_time_working_days` WORKING days before the first posting day. */
  productionStart: string;
  /** `safety_margin_days` CALENDAR days before that: «حدّد مشاريع الشهر القادم». */
  nextMonthReminderOn: string;
  /** The Meta campaign's last day, from `campaign_length_days`. */
  campaignEndsOn: string;
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/**
 * The month's four whole weeks, its posting days and its two computed dates.
 *
 * The first week starts on the first Sunday **on or after** the 1st, so a month
 * beginning mid-week (1 Oct 2026 is a Thursday) runs Sun 4 Oct → Sat 31 Oct.
 * Four whole weeks is the settled cycle, so the fourth week may end in the
 * following month when the first Sunday falls late — that is the cycle
 * behaving correctly, not an overflow to clamp.
 */
export function monthGeometry(
  month: string, template: MonthTemplate, cal: WorkCalendar = DEFAULT_CALENDAR,
): MonthGeometry {
  if (!MONTH_RE.test(month.trim())) {
    throw new Error(`monthCompiler: bad month "${month}" (expected YYYY-MM)`);
  }
  const first = `${month.trim()}-01`;
  let sunday = first;
  for (let i = 0; i < 7 && weekdayOf(sunday) !== WEEK_START; i += 1) sunday = addDays(sunday, 1);

  const weeks: MonthWeek[] = [];
  for (let i = 0; i < WEEKS_PER_MONTH; i += 1) {
    const start = addDays(sunday, i * 7);
    weeks.push({ index: i, start, end: addDays(start, 6) });
  }

  const weekdays = Array.from(new Set(template.postingWeekdays)).sort((a, b) => a - b);
  const postingDays: string[] = [];
  for (const w of weeks) {
    for (const wd of weekdays) postingDays.push(addDays(w.start, (wd - WEEK_START + 7) % 7));
  }
  postingDays.sort();

  const firstPostingDay = postingDays[0] ?? weeks[0]?.start ?? first;
  const lastPostingDay = postingDays[postingDays.length - 1] ?? weeks[WEEKS_PER_MONTH - 1]?.end ?? first;
  const paidBatchDays = weeks.map((w) => w.start);
  const productionStart = addWorkingDays(firstPostingDay, -Math.max(1, template.leadTimeWorkingDays), cal);

  return {
    month: month.trim(),
    weeks,
    postingDays,
    firstPostingDay,
    lastPostingDay,
    paidBatchDays,
    productionStart,
    // Calendar days, not working days: the reminder is a date on the operator's
    // calendar, and `safety_margin_days` is the only field here that does not
    // say "working".
    nextMonthReminderOn: addDays(productionStart, -Math.max(0, template.safetyMarginDays)),
    campaignEndsOn: addDays(paidBatchDays[0] ?? firstPostingDay, Math.max(1, template.campaignLengthDays) - 1),
  };
}

/* ------------------------------------------------------------------ */
/* rows                                                                */
/* ------------------------------------------------------------------ */

export interface MonthProject {
  projectId: string;
  projectName?: string;
}

/** One row of the month grid, before it becomes a `RowRequirement`. */
export interface MonthRowPlan {
  rowKey: string;
  kind: 'organic_row' | 'general_row';
  /** `null` for the general row. */
  projectId: string | null;
  projectName?: string;
  day: string;
  weekIndex: number;
  weekday: number;
  /** Slot 0 = أ, 1 = ب, 2 = ج. `null` for the general row. */
  slot: number | null;
  posts: number;
  platform: string;
}

const SLOT_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

/**
 * How many posting weekdays are PROJECT slots this month.
 *
 * `projects_per_month` is the template's own number — the thing that makes
 * "Sun أ · Tue ب · Thu ج · **Sat general**" a standing shape rather than an
 * accident of how many projects someone happened to pick. It was parsed and
 * then referenced nowhere, so the grid assigned a project to every posting
 * weekday it could reach positionally and the general row was only ever
 * *leftovers*. Pick a fourth project and the Saturday general row — a quarter
 * of the organic month, 4 rows and 12 posts of every 16 and 48 — vanished with
 * no conflict and no warning, and `summary.generalRows` read 0 with nothing
 * saying why.
 *
 * Capped by the posting weekdays themselves: there cannot be more project slots
 * than there are days to put them on.
 */
export function monthProjectSlots(template: MonthTemplate): number {
  const weekdays = Array.from(new Set(template.postingWeekdays)).length;
  return Math.max(0, Math.min(Math.max(0, Math.floor(template.projectsPerMonth)), weekdays));
}

/**
 * Does the operator's project selection match the template's shape?
 *
 * Conflicts, not silence: dropping a project or turning a project day into a
 * general day is a decision the operator must see before confirming a month.
 * Neither makes the month unschedulable, so these are compile-level conflicts
 * that land in `MonthSummary.conflicts` — they never touch `PlanResult.feasible`.
 */
export function monthSelectionConflicts(
  template: MonthTemplate, projects: MonthProject[],
): PlanConflict[] {
  const slots = monthProjectSlots(template);
  const out: PlanConflict[] = [];
  if (projects.length > slots) {
    const dropped = projects.slice(slots);
    out.push({
      kind: 'not_enough_slots', itemKey: null, stepKey: null, day: null,
      messageAr: `الشهر فيه ${slots} خانة مشروع (projects_per_month) واخترت ${projects.length}. لن يُنشر ${dropped.map((p) => p.projectName ?? p.projectId).join('، ')} هذا الشهر. غيّر الاختيار أو ارفع projects_per_month في قالب الشهر — ورفعه يأكل يوم «عام».`,
      messageEn: `The month has ${slots} project slot(s) (projects_per_month) and ${projects.length} project(s) were chosen. ${dropped.map((p) => p.projectName ?? p.projectId).join(', ')} will not run this month. Change the selection, or raise projects_per_month on the month template — which consumes a general-row day.`,
      detail: { slots, chosen: projects.length, dropped: dropped.map((p) => p.projectId) },
    });
  }
  if (projects.length < slots) {
    out.push({
      kind: 'not_enough_slots', itemKey: null, stepKey: null, day: null,
      messageAr: `الشهر فيه ${slots} خانة مشروع واخترت ${projects.length}. ستتحوّل ${slots - projects.length} من أيام النشر إلى صفوف «عام» بلا مشروع.`,
      messageEn: `The month has ${slots} project slot(s) and ${projects.length} project(s) were chosen, so ${slots - projects.length} posting day(s) become general rows with no project.`,
      detail: { slots, chosen: projects.length },
    });
  }
  return out;
}

/**
 * Assign the month's projects to its posting weekdays, in slot order, and make
 * every remaining posting weekday a GENERAL row.
 *
 * With the standing template that is Sun أ · Tue ب · Thu ج · **Sat general**.
 * The general row is a quarter of the organic month — 4 rows, 12 posts — and
 * carries `project_id = null` all the way to `mos_content_rows` (A8b). It is
 * never an empty string standing in for a project.
 *
 * `projects` beyond `monthProjectSlots(template)` are IGNORED here, on purpose:
 * the template decides the month's shape, and the general row is part of that
 * shape rather than whatever is left over. `monthSelectionConflicts` reports
 * the ignored ones and `MonthSummary.projectsWithoutRows` names them.
 */
export function buildMonthRows(
  geometry: MonthGeometry, template: MonthTemplate, projects: MonthProject[],
): MonthRowPlan[] {
  const weekdays = Array.from(new Set(template.postingWeekdays)).sort((a, b) => a - b);
  const assigned = projects.slice(0, monthProjectSlots(template));
  const rows: MonthRowPlan[] = [];
  for (const week of geometry.weeks) {
    weekdays.forEach((wd, slot) => {
      const day = addDays(week.start, (wd - WEEK_START + 7) % 7);
      const project = slot < assigned.length ? assigned[slot] : undefined;
      const letter = project ? (SLOT_LETTERS[slot] ?? String(slot)) : 'general';
      rows.push({
        rowKey: `${geometry.month}:w${week.index + 1}:${day}:${letter}`,
        kind: project ? 'organic_row' : 'general_row',
        projectId: project?.projectId ?? null,
        projectName: project?.projectName,
        day,
        weekIndex: week.index,
        weekday: wd,
        slot: project ? slot : null,
        posts: template.postsPerRow,
        platform: template.organicPlatform,
      });
    });
  }
  rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.rowKey < b.rowKey ? -1 : 1));
  return rows;
}

/* ------------------------------------------------------------------ */
/* the four plan inputs                                                */
/* ------------------------------------------------------------------ */

/** The organic half: ONE plan covering every project row and every general row. */
export function organicPlanInput(
  geometry: MonthGeometry, template: MonthTemplate, projects: MonthProject[], rows: MonthRowPlan[],
): PlanInput {
  const rowReqs: RowRequirement[] = rows.map((r) => ({
    rowKey: r.rowKey,
    projectId: r.projectId,
    projectName: r.projectName,
    day: r.day,
    platform: r.platform,
    posts: r.posts,
    contentTypeKey: 'post',
    labelAr: r.projectId ? undefined : 'عام',
  }));
  return {
    campaignId: null,
    campaignRef: `${geometry.month}:organic`,
    kind: 'organic',
    // Carried for the commit's campaign record and for the month page. The ROWS
    // are authoritative for what gets built: `posts`/`videos` are ignored
    // whenever `rows` is present.
    projects: projects.map((p) => ({ ...p, posts: 0, videos: 0 })),
    rows: rowReqs,
    platforms: [template.organicPlatform],
    rangeStart: geometry.firstPostingDay,
    rangeEnd: geometry.lastPostingDay,
    frequency: [{
      platform: template.organicPlatform,
      perDay: template.postsPerRow,
      weekdays: Array.from(new Set(template.postingWeekdays)).sort((a, b) => a - b),
      times: [template.publishTime],
    }],
    crossPost: false,
    publishBufferDays: DEFAULTS.publishBufferDays,
  };
}

/** One project's paid half: five creatives on each of the four batch dates. */
export function paidPlanInput(
  geometry: MonthGeometry, template: MonthTemplate, project: MonthProject,
): PlanInput {
  const start = geometry.paidBatchDays[0] ?? geometry.firstPostingDay;
  const executionKey = `exec:${template.paidPlatform}:${project.projectId}`;
  return {
    campaignId: null,
    campaignRef: `${geometry.month}:paid:${project.projectId}`,
    kind: 'paid',
    projects: [{ ...project, posts: 0, videos: 0 }],
    platforms: [template.paidPlatform],
    rangeStart: start,
    // The month's four whole weeks — NOT `campaign_length_days`. The batch
    // count is a settled identity (four), and reading it off a length column
    // would let a 35-day campaign quietly produce a fifth batch.
    rangeEnd: geometry.weeks[geometry.weeks.length - 1]?.end ?? geometry.lastPostingDay,
    frequency: [],
    crossPost: false,
    publishBufferDays: DEFAULTS.publishBufferDays,
    paid: [{
      executionKey,
      executionId: null,
      platform: template.paidPlatform,
      policy: {
        slateSize: template.creativesPerProjectWeek,
        keepMin: DEFAULTS.paid.keepMin,
        cycleDays: 7,
        minRemainingDays: DEFAULTS.paid.minRemainingDays,
        leadTimeWorkingDays: template.leadTimeWorkingDays,
        // 'A': every batch is a full slate, so "replace all five" is available
        // on every refresh date.
        fifthPolicy: 'A',
        bankedSpares: [],
      },
    }],
  };
}

/* ------------------------------------------------------------------ */
/* compile                                                             */
/* ------------------------------------------------------------------ */

export interface MonthCapacityLine {
  userId: string;
  bucket: LoadBucket;
  capacityPerDay: number;
  /** Slots this month adds, across every day. */
  totalSlots: number;
  /** The worst day, counting work already on the plate plus this month's. */
  peakDay: string | null;
  peakLoad: number;
  /** This month's slots ÷ working days it spans. The number §0 asks for. */
  averagePerWorkingDay: number;
  /** Did any day exceed the person's own daily throughput? */
  over: boolean;
}

export interface MonthSummary {
  month: string;
  /**
   * Rows the PLAN actually holds — not the template grid.
   *
   * These used to be counted from `buildMonthRows`'s output while `posts` came
   * from `organicPlan.items`, so a row the planner dropped left the month page
   * reporting 16 rows and fewer than 48 posts: two numbers that cannot both be
   * true. Both sides now read the same plan, and `templateRows` below keeps the
   * template's own count visible so a divergence is a number you can see rather
   * than one you have to notice.
   */
  rows: number;
  generalRows: number;
  /** Rows the template asked for. Equal to `rows` unless the planner dropped one. */
  templateRows: number;
  posts: number;
  /** Two per post: the feed post and the story. */
  organicReleases: number;
  feedReleases: number;
  storyReleases: number;
  paidCreatives: number;
  /** Everything a person has to make: posts + paid creatives. */
  items: number;
  firstPostingDay: string;
  lastPostingDay: string;
  productionStart: string;
  nextMonthReminderOn: string;
  campaignEndsOn: string;
  budgetTotal: number;
  /** Project slots the template provides (`projects_per_month`, capped by posting days). */
  projectSlots: number;
  /** Projects with no organic row — chosen, but with no slot to run in. */
  projectsWithoutRows: string[];
  /**
   * False when a chosen project got NO rows. Separate from `feasible` on
   * purpose: such a month schedules perfectly, it just is not the month the
   * operator asked for, and the two failures need different words on the page.
   */
  selectionOk: boolean;
  feasible: boolean;
  capacityOk: boolean;
  conflicts: PlanConflict[];
  load: MonthCapacityLine[];
}

export interface CompiledMonth {
  month: string;
  template: MonthTemplate;
  geometry: MonthGeometry;
  rows: MonthRowPlan[];
  organic: { input: PlanInput; plan: PlanResult };
  paid: Array<{ projectId: string; input: PlanInput; plan: PlanResult }>;
  /** The four inputs and the four plans, in commit order (organic first). */
  inputs: PlanInput[];
  plans: PlanResult[];
  summary: MonthSummary;
}

export interface CompileMonthArgs {
  /** `YYYY-MM`. */
  month: string;
  template: MonthTemplate;
  projects: MonthProject[];
  snapshot: WorkloadSnapshot;
  rules?: RuleSet;
}

/**
 * Compile one month. Pure: everything it needs is in `args`.
 *
 * The four plans are compiled IN SEQUENCE against a growing ledger — each one
 * sees the load the previous ones proposed. Four independent calls would each
 * book the same designer day and none of them would notice; the month would
 * look feasible four times over and break on the first commit.
 */
export function compileMonth(args: CompileMonthArgs): CompiledMonth {
  const { month, template, projects, snapshot } = args;
  const baseRules = args.rules ?? DEFAULT_RULES;
  const cal = snapshot.calendar;
  const geometry = monthGeometry(month, template, cal);
  // The projects that actually RUN this month — the template's own
  // `projects_per_month`, not however many were handed in. A project with no
  // organic slot must not get a paid campaign either: a fourth project used to
  // silently take the Saturday general row on the organic side AND open a
  // fourth 2,000-riyal campaign on the paid side. `summariseMonth` reports the
  // ones left out; it is given the full list for exactly that.
  const running = projects.slice(0, monthProjectSlots(template));
  const rows = buildMonthRows(geometry, template, running);

  const rules: RuleSet = {
    ...baseRules,
    publishing: {
      ...(baseRules.publishing ?? DEFAULT_PUBLISHING),
      rowPublishing: {
        publishTime: template.publishTime,
        intraRowGapMinutes: template.intraRowGapMinutes,
      },
    },
    // No search. Every day is the template's; the month is not a question the
    // engine has to answer, only work it has to staff.
    searchBudget: 0,
  };

  const organicInput = organicPlanInput(geometry, template, running, rows);
  let ledger = snapshot.ledger;
  const organicPlan = planCampaign(
    organicInput, { ...snapshot, ledger }, rules, { withAlternatives: false },
  );
  ledger = extendLedger(ledger, organicPlan);

  const paid: CompiledMonth['paid'] = [];
  for (const project of running) {
    const input = paidPlanInput(geometry, template, project);
    const plan = planCampaign(input, { ...snapshot, ledger }, rules, { withAlternatives: false });
    ledger = extendLedger(ledger, plan);
    paid.push({ projectId: project.projectId, input, plan });
  }

  const inputs = [organicInput, ...paid.map((p) => p.input)];
  const plans = [organicPlan, ...paid.map((p) => p.plan)];
  return {
    month: geometry.month,
    template,
    geometry,
    rows,
    organic: { input: organicInput, plan: organicPlan },
    paid,
    inputs,
    plans,
    summary: summariseMonth({ geometry, template, projects, rows, organicPlan, paidPlans: paid.map((p) => p.plan), snapshot }),
  };
}

/**
 * Fold a plan's PROPOSED load into the ledger the next plan will read.
 *
 * `LoadCell.proposed` is exactly what this plan added on top of what was
 * already there, so summing proposed across the four plans is the month's own
 * load and nothing is double-counted.
 */
function extendLedger(ledger: LedgerRow[], plan: PlanResult): LedgerRow[] {
  const added: LedgerRow[] = [];
  for (const cell of plan.load) {
    if (cell.proposed <= 0) continue;
    added.push({
      userId: cell.userId,
      day: cell.day,
      bucket: cell.bucket,
      weight: cell.proposed,
      source: 'reservation',
      refId: null,
    });
  }
  return added.length ? [...ledger, ...added] : ledger;
}

export function summariseMonth(args: {
  geometry: MonthGeometry;
  template: MonthTemplate;
  projects: MonthProject[];
  rows: MonthRowPlan[];
  organicPlan: PlanResult;
  paidPlans: PlanResult[];
  snapshot: WorkloadSnapshot;
}): MonthSummary {
  const { geometry, template, projects, rows, organicPlan, paidPlans, snapshot } = args;
  const cal = snapshot.calendar;
  const posts = organicPlan.items.length;
  const paidCreatives = paidPlans.reduce((a, p) => a + p.items.length, 0);
  const rel = organicPlan.totals.releases;

  // Per (person, day, bucket): what this month ADDS, over what was already there.
  const proposed = new Map<string, number>();
  for (const plan of [organicPlan, ...paidPlans]) {
    for (const cell of plan.load) {
      if (cell.proposed <= 0) continue;
      const k = `${cell.userId}|${cell.day}|${cell.bucket}`;
      proposed.set(k, (proposed.get(k) ?? 0) + cell.proposed);
    }
  }
  const existing = new Map<string, number>();
  for (const row of snapshot.ledger) {
    const k = `${row.userId}|${row.day}|${row.bucket}`;
    existing.set(k, (existing.get(k) ?? 0) + row.weight);
  }
  const capacityOf = new Map<string, number>();
  for (const p of snapshot.people) {
    for (const [bucket, cap] of Object.entries(p.caps)) capacityOf.set(`${p.userId}|${bucket}`, cap ?? 0);
  }

  // Production runs from the month's production start to its last posting day.
  const span = workingDaysIn(geometry.productionStart, geometry.lastPostingDay, cal).length || 1;

  const lines = new Map<string, MonthCapacityLine>();
  for (const [k, add] of proposed) {
    const [userId = '', day = '', bucket = 'post'] = k.split('|');
    const lk = `${userId}|${bucket}`;
    const capacity = capacityOf.get(lk) ?? 0;
    const load = add + (existing.get(k) ?? 0);
    const line = lines.get(lk) ?? {
      userId,
      bucket: bucket as LoadBucket,
      capacityPerDay: capacity,
      totalSlots: 0,
      peakDay: null,
      peakLoad: 0,
      averagePerWorkingDay: 0,
      over: false,
    };
    line.totalSlots = round2(line.totalSlots + add);
    if (load > line.peakLoad) { line.peakLoad = round2(load); line.peakDay = day; }
    if (load > capacity + 1e-9) line.over = true;
    lines.set(lk, line);
  }
  for (const line of lines.values()) line.averagePerWorkingDay = round2(line.totalSlots / span);
  const load = Array.from(lines.values()).sort((a, b) =>
    (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : a.bucket < b.bucket ? -1 : 1));

  // Counted off the PLAN, which is what will actually be built and what `posts`
  // has always come from. `rows` (the template grid) is kept only as
  // `templateRows`, so the two can be compared instead of silently substituted.
  const planRows = organicPlan.rows;
  const withRows = new Set(planRows.map((r) => r.projectId).filter((id): id is string => Boolean(id)));
  const projectsWithoutRows = projects.map((p) => p.projectId).filter((id) => !withRows.has(id));

  return {
    month: geometry.month,
    rows: planRows.length,
    generalRows: planRows.filter((r) => r.projectId === null).length,
    templateRows: rows.length,
    posts,
    organicReleases: rel.total,
    feedReleases: rel.feed,
    storyReleases: rel.story,
    paidCreatives,
    items: posts + paidCreatives,
    firstPostingDay: geometry.firstPostingDay,
    lastPostingDay: geometry.lastPostingDay,
    productionStart: geometry.productionStart,
    nextMonthReminderOn: geometry.nextMonthReminderOn,
    campaignEndsOn: geometry.campaignEndsOn,
    // What will actually be SPENT: one standing budget per project that runs.
    // Multiplying by the number chosen promised 8,000 riyals for four projects
    // while three ran.
    budgetTotal: template.budgetPerProject * withRows.size,
    projectSlots: monthProjectSlots(template),
    projectsWithoutRows,
    selectionOk: projectsWithoutRows.length === 0,
    feasible: [organicPlan, ...paidPlans].every((p) => p.feasible),
    capacityOk: load.every((l) => !l.over),
    conflicts: [
      ...monthSelectionConflicts(template, projects),
      ...[organicPlan, ...paidPlans].flatMap((p) => p.conflicts),
    ],
    load,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
