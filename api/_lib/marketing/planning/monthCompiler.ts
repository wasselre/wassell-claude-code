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
 * THE REST OF A MONTH (2026-09-16)
 *
 * Those counts are a WHOLE month's. A month can also be compiled part-way
 * through: `startFrom` (defaulted to today for the CURRENT month by
 * `monthStartFrom`, and `null` — the whole cycle — for any other) drops the
 * posting days and paid batch days that have already passed, floors
 * `productionStart` at that day, and turns `lead_time_working_days` from a GATE
 * into a TARGET each remaining row is measured against.
 *
 * THE MONTH STARTS WHERE IT CAN BE PRODUCED (2026-09-16, second pass)
 *
 * Dropping the days that have PASSED is not enough. A row's chain is five
 * SEQUENTIAL steps — writing, writing review, design, writer review, final
 * approval — each occupying at least one working day, plus a publish buffer. So
 * a row needs `minLeadWorkingDays` working days of lead **to exist at all**, and
 * a paid launch slate needs more (design alone is a two-day step). Compiled on
 * Wed 16 Sep, the next three posting days have 1, 2 and 3 working days of lead:
 * they are not "tight", they are impossible, and no amount of spare designer
 * capacity changes it — the constraint is the CHAIN, not the hours.
 *
 * The first pass kept those three rows, and the engine answered with the sound
 * `time_bound` proof it is supposed to: `feasible: false`, nothing staffed,
 * `monthConfirm` refusing with `month_infeasible`. The operator asked for a
 * month and got an error.
 *
 * So the month now starts at the EARLIEST DAY IT CAN ACTUALLY BE PRODUCED.
 * `monthGeometry` advances past every posting day whose lead is below the
 * minimum, keeps their reason (`'lead'`, as against `'past'`), and reports the
 * move. A day that clears the minimum but is under the TEMPLATE'S target is
 * still flagged short and still kept — that part was always right. September
 * compiled on the 16th is therefore 7 rows / 21 posts / 42 releases / 1 batch /
 * 15 creatives starting Tue 22, feasible, with no conflicts. See
 * `monthGeometry` and `monthLeadFloors`.
 *
 * Plan: docs/plans/monthly-operating-model-build.md §4 Group B (B1).
 */
import {
  DEFAULTS, DEFAULT_RULES, DEFAULT_CALENDAR, DEFAULT_PUBLISHING, ENGINE_VERSION, POST_WORKFLOW,
  addDays, addWorkingDays, daysBetween, effortWeights, nextWorkingDay, weekdayOf, workingDaysIn,
  planCampaign, conflictBlocksConfirm, conflictBlocksPlan,
  type LedgerRow, type LoadBucket, type PlanConflict, type PlanInput, type PlanResult,
  type RowRequirement, type RuleSet, type WorkCalendar, type WorkflowSpec, type WorkloadSnapshot,
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
  /**
   * One-off starts per month (`mos_month_template.month_starts`, keyed `YYYY-MM`)
   * — the operator's call for a month that does not begin on the template's own
   * rhythm. September 2026, the first real month: organic from Tue 22, ads from
   * Sun 20, and ads switched on as soon as each is ready.
   */
  monthStarts: Record<string, MonthStart>;
}

export interface MonthStart {
  /** No organic row publishes before this day. */
  organicFrom?: string;
  /** No paid batch before this day. */
  paidFrom?: string;
  /** The Meta campaign + ad sets go ACTIVE when built: each ad runs the moment it is approved. */
  adsLiveWhenReady?: boolean;
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
  monthStarts: {},
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
    monthStarts: parseMonthStarts(r.month_starts),
  };
}

/** `month_starts` jsonb → typed map. Bad days are dropped, never guessed. */
export function parseMonthStarts(v: unknown): Record<string, MonthStart> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, MonthStart> = {};
  for (const [month, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}$/.test(month) || !raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const day = (x: unknown): string | undefined =>
      (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : undefined);
    out[month] = {
      organicFrom: day(o.organic_from),
      paidFrom: day(o.paid_from),
      adsLiveWhenReady: o.ads_live_when_ready === true,
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* the lead a production chain actually needs                          */
/* ------------------------------------------------------------------ */

/**
 * Working days the production chain OCCUPIES, end to end.
 *
 * Two shapes, because the month has two kinds of subject:
 *
 *   • a ROW is three posts worked in one sitting per step, so each step takes
 *     exactly ONE day whatever its estimate says — that is what
 *     `ScheduleItem.sameDaySlots` / `effortWeightsSameDay` mean, and the step's
 *     day-estimate is deliberately ignored there;
 *   • a PAID creative is the classic path, where each step occupies its own
 *     estimate — design alone is two working days.
 *
 * Read off the PINNED workflow, never a constant: change the path in Settings
 * and the month's minimum lead changes with it.
 */
export function chainWorkingDays(wf: WorkflowSpec, sameDay: boolean): number {
  const steps = wf.steps.filter((s) => !s.afterReady);
  if (steps.length === 0) return 0;
  const spans = steps.map((s) => (sameDay ? 1 : effortWeights(s.workingDays).length));
  // On a same-day path each step starts the day the previous one ends, so
  // adjacent steps SHARE a day: the chain is 1 + Σ(span − 1). Otherwise every
  // step takes its own days in turn: Σ span. This is the forward statement of
  // exactly what `scheduleProduction`'s `earliestEnds` proves — keep them equal.
  return wf.sameDayChain === true
    ? 1 + spans.reduce((total, x) => total + (x - 1), 0)
    : spans.reduce((total, x) => total + x, 0);
}

/**
 * The fewest WORKING DAYS OF LEAD a subject needs in order to exist at all.
 *
 * "Lead" here is counted the way `MonthPostingDay.leadWorkingDays` counts it:
 * working days in `[productionStart, publishDay)` — the publish day itself is
 * not one of them. The chain's first step sits ON `productionStart`, so a chain
 * of `span` days ends on the `span − 1`-th lead day, and the publish buffer
 * pushes the required-ready date that many working days earlier again. Hence
 * `span − 1 + buffer`, which is exactly the bound `scheduleProduction` proves
 * with `time_bound` — the same arithmetic, stated forwards.
 *
 * With the shipped post path and the default one-day buffer that is **5** for a
 * row and **6** for a paid creative. Neither number is written down anywhere:
 * both fall out of the workflow.
 */
export function minLeadWorkingDays(
  wf: WorkflowSpec, sameDay: boolean, publishBufferDays: number,
): number {
  const span = chainWorkingDays(wf, sameDay);
  if (span <= 0) return 0;
  return Math.max(0, span - 1 + Math.max(0, publishBufferDays));
}

/** The two minimums a month is bounded by, derived from the rules it compiles under. */
export interface MonthLeadFloors {
  /** An ORGANIC row — one sitting per step. */
  organic: number;
  /** A PAID launch slate — every step takes its own estimate. */
  paid: number;
  /** Working days between the final approval and the publishing day. */
  publishBufferDays: number;
}

/**
 * Derive both minimums from the rule set the month will actually be planned
 * with. Organic rows and paid creatives both run the `post` content type's
 * workflow, and differ only in whether the subject is a row.
 */
export function monthLeadFloors(
  rules: RuleSet = DEFAULT_RULES,
  publishBufferDays: number = DEFAULTS.publishBufferDays,
): MonthLeadFloors {
  const key = rules.contentTypeWorkflow.post ?? 'post_std';
  const wf = rules.workflows[key] ?? POST_WORKFLOW;
  const buffer = Math.max(0, publishBufferDays);
  return {
    organic: minLeadWorkingDays(wf, true, buffer),
    paid: minLeadWorkingDays(wf, false, buffer),
    publishBufferDays: buffer,
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

/** One REMAINING posting day, with the slack production actually has for it. */
export interface MonthPostingDay {
  day: string;
  /**
   * Working days available in `[productionStart, day)` — what production
   * ACTUALLY has, not what the template wishes it had.
   */
  leadWorkingDays: number;
  /**
   * Below `lead_time_working_days`. A WARNING, never a reason to drop the row:
   * the lead is a scheduling BUFFER (slack for approvals and revisions), not a
   * claim that a post takes ten days to make.
   */
  short: boolean;
  /** The row publishes on the very day the month starts from — no slack at all. */
}

/**
 * Why a posting day (or a paid batch day) is not part of this month.
 *
 *   `past` — the day is already behind the day the month is compiled from.
 *   `lead` — the day is still ahead, but production cannot REACH it: its lead
 *            is below the chain's own minimum. Not "tight" — impossible.
 *
 * The distinction is the whole point of reporting them: one is the calendar,
 * the other is a decision the operator should understand.
 */
export type MonthSkipReason = 'past' | 'lead' | 'capacity' | 'operator';

export interface MonthSkippedDay {
  day: string;
  reason: MonthSkipReason;
  /**
   * Working days of lead the day actually had. `null` for a day already gone
   * (`'past'`), and for a `'capacity'` skip, whose lead was fine — the team
   * simply could not make that batch in the days left.
   */
  leadWorkingDays: number | null;
}

export interface MonthGeometry {
  /** `YYYY-MM`. */
  month: string;
  /** Exactly `WEEKS_PER_MONTH` whole weeks, Sunday → Saturday. */
  weeks: MonthWeek[];
  /** Every REMAINING organic posting day, ascending. */
  postingDays: string[];
  firstPostingDay: string;
  lastPostingDay: string;
  /** One paid batch per week — the REMAINING Sundays. */
  paidBatchDays: string[];
  /** `lead_time_working_days` WORKING days before the first posting day, floored at `startFrom`. */
  productionStart: string;
  /** `safety_margin_days` CALENDAR days before that: «حدّد مشاريع الشهر القادم». */
  nextMonthReminderOn: string;
  /** The Meta campaign's last day, from `campaign_length_days`. */
  campaignEndsOn: string;
  /** The day the month was ASKED to start from, or `null` for the whole cycle. */
  startedFrom: string | null;
  /**
   * The day it ACTUALLY starts — the first posting day production can reach.
   * Equal to `firstPostingDay` whenever the month has any day left at all;
   * `null` when it has none.
   */
  startsOn: string | null;
  /** True when the minimum-lead rule pushed the start past `startedFrom`. */
  startMoved: boolean;
  /**
   * NO posting day is left that production can reach. A clean, reportable
   * state — «لم يعد بالإمكان بدء هذا الشهر» — never a throw and never an
   * infeasible compile.
   */
  exhausted: boolean;
  /** True when `startFrom` actually cut something off the cycle. */
  isPartial: boolean;
  /** Posting days this month does NOT run, each with its reason. */
  skippedPostingDays: MonthSkippedDay[];
  /** Paid batch days this month does NOT buy, each with its reason. */
  skippedPaidBatchDays: MonthSkippedDay[];
  /** `lead_time_working_days` — the TARGET each row's lead is measured against. */
  targetLeadWorkingDays: number;
  /** Working days of lead an organic ROW needs to exist at all — derived, not set. */
  minLeadWorkingDays: number;
  /** Working days of lead a PAID launch slate needs. */
  minPaidLeadWorkingDays: number;
  /** One entry per REMAINING posting day, ascending — the per-day lead. */
  postingDayLeads: MonthPostingDay[];
  /** Working days in `[productionStart, lastPostingDay]` — what the work is spread over. */
  productionWorkingDays: number;
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Later of two civil dates. `YYYY-MM-DD` sorts lexicographically. */
const laterDay = (a: string, b: string): string => (a > b ? a : b);

/**
 * `startFrom` for a month, defaulted from the clock: TODAY when `month` is the
 * CURRENT month, `null` otherwise.
 *
 * A future month is untouched — it gets its whole cycle, exactly as before.
 */
export function monthStartFrom(month: string, today: string): string | null {
  return month.trim().slice(0, 7) === today.trim().slice(0, 7) ? today.trim() : null;
}

/**
 * The month's four whole weeks, its posting days and its two computed dates.
 *
 * The first week starts on the first Sunday **on or after** the 1st, so a month
 * beginning mid-week (1 Oct 2026 is a Thursday) runs Sun 4 Oct → Sat 31 Oct.
 * Four whole weeks is the settled cycle, so the fourth week may end in the
 * following month when the first Sunday falls late — that is the cycle
 * behaving correctly, not an overflow to clamp.
 *
 * **`startFrom` (a `YYYY-MM-DD`) compiles the REST of a month.** Until it
 * existed, a month could only ever be compiled whole: `productionStart` was
 * `firstPostingDay − lead` unconditionally, so asking on 16 Sep for September
 * produced a production start of 6 Sep — a fortnight in the past — and every
 * row it drew was already gone. With `startFrom`:
 *
 *   • posting days and paid batch days STRICTLY BEFORE it are dropped and
 *     reported with the reason `'past'`;
 *   • the month then starts at the first REMAINING day production can actually
 *     reach — the first whose lead is at least `leads.organic`. The days in
 *     between are dropped too, with the reason `'lead'` and the lead they had,
 *     and `startMoved` says so. Offering a start that cannot work and then
 *     refusing it is not a month, it is an error message;
 *   • `productionStart` is `max(startFrom, firstPostingDay − aim)`, so
 *     production can never be asked to have started in the past — nor later
 *     than the chain itself allows, which is why `aim` is at least the minimum;
 *   • `lead_time_working_days` stays a TARGET: each remaining day carries the
 *     slack it actually has (`postingDayLeads`), and a day that clears the
 *     minimum but is under the target is FLAGGED, never dropped.
 *
 * The day `startFrom` itself is never a posting day: it has zero working days
 * of lead, which no chain clears. A month with no reachable posting day at all
 * is a real, reportable state (`exhausted`, empty `postingDays`), not a throw.
 *
 * `leads` is the pair of minimums, derived from the rule set the month will be
 * planned with (`monthLeadFloors`). It is a parameter rather than a constant so
 * that editing the workflow in Settings moves the month's start with it.
 */
export function monthGeometry(
  month: string, template: MonthTemplate, cal: WorkCalendar = DEFAULT_CALENDAR,
  startFrom?: string | null, leads: MonthLeadFloors = monthLeadFloors(),
): MonthGeometry {
  if (!MONTH_RE.test(month.trim())) {
    throw new Error(`monthCompiler: bad month "${month}" (expected YYYY-MM)`);
  }
  const from = typeof startFrom === 'string' && startFrom.trim() ? startFrom.trim() : null;
  if (from !== null && !DAY_RE.test(from)) {
    throw new Error(`monthCompiler: bad startFrom "${startFrom}" (expected YYYY-MM-DD)`);
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
  const everyPostingDay: string[] = [];
  for (const w of weeks) {
    for (const wd of weekdays) everyPostingDay.push(addDays(w.start, (wd - WEEK_START + 7) % 7));
  }
  everyPostingDay.sort();
  const everyBatchDay = weeks.map((w) => w.start);

  // The FLOOR — the first day production can physically begin on. It is what
  // the minimum-lead test measures from, deliberately NOT `productionStart`:
  // that one is an AIM (the template's buffer) and may sit later, which would
  // make the test answer a question about the wish rather than about the clock.
  const floor = from === null ? null : nextWorkingDay(from, cal);
  const leadFromFloor = (day: string): number => (
    floor === null || daysBetween(floor, day) <= 0
      ? 0
      : workingDaysIn(floor, addDays(day, -1), cal).length
  );

  // `>= from` — the start day itself is kept. Dropping it would throw away a
  // whole row because the clock struck midnight, not because the slot passed.
  const ahead = from === null ? everyPostingDay : everyPostingDay.filter((d) => d >= from);
  // Where the month actually begins: the first day whose lead reaches the
  // chain's own minimum. `undefined` — nothing reachable — is the `exhausted`
  // state, not an error.
  const startsOn = from === null
    ? (everyPostingDay[0] ?? null)
    : (ahead.find((d) => leadFromFloor(d) >= leads.organic) ?? null);

  const override = template.monthStarts?.[month.trim()];
  const organicFrom = override?.organicFrom ?? null;
  const paidFrom = override?.paidFrom ?? null;
  const postingDaysByClock = from === null
    ? everyPostingDay
    : (startsOn === null ? [] : ahead.filter((d) => d >= startsOn));
  // The operator's start for this month: nothing publishes before it.
  const postingDays = organicFrom ? postingDaysByClock.filter((d) => d >= organicFrom) : postingDaysByClock;
  const skippedPostingDays: MonthSkippedDay[] = [
    ...(from === null ? [] : [
      ...everyPostingDay.filter((d) => d < from)
        .map((day): MonthSkippedDay => ({ day, reason: 'past', leadWorkingDays: null })),
      ...ahead.filter((d) => startsOn === null || d < startsOn)
        .map((day): MonthSkippedDay => ({ day, reason: 'lead', leadWorkingDays: leadFromFloor(day) })),
    ]),
    ...(organicFrom ? postingDaysByClock.filter((d) => d < organicFrom)
      .map((day): MonthSkippedDay => ({ day, reason: 'operator', leadWorkingDays: null })) : []),
  ];

  // A paid batch is bound by its OWN minimum, which is larger: a launch slate
  // runs the classic path, where design alone is two working days.
  const paidBatchDaysByClock = from === null
    ? everyBatchDay
    : (startsOn === null
      ? []
      : everyBatchDay.filter((d) => d >= startsOn && leadFromFloor(d) >= leads.paid));
  const paidBatchDays = paidFrom ? paidBatchDaysByClock.filter((d) => d >= paidFrom) : paidBatchDaysByClock;
  const keptBatch = new Set(paidBatchDays);
  const skippedPaidBatchDays: MonthSkippedDay[] = everyBatchDay
    .filter((d) => !keptBatch.has(d))
    .filter((d) => from !== null || (paidFrom !== null && d < paidFrom))
    .map((day): MonthSkippedDay => (paidFrom !== null && day < paidFrom && (from === null || day >= from)
      && paidBatchDaysByClock.includes(day)
      ? { day, reason: 'operator', leadWorkingDays: null }
      : from !== null && day < from
        ? { day, reason: 'past', leadWorkingDays: null }
        : { day, reason: from === null ? 'operator' : 'lead', leadWorkingDays: from === null ? null : leadFromFloor(day) }));

  const firstPostingDay = postingDays[0] ?? from ?? weeks[0]?.start ?? first;
  const lastPostingDay = postingDays[postingDays.length - 1]
    ?? from ?? weeks[WEEKS_PER_MONTH - 1]?.end ?? first;

  const target = Math.max(1, template.leadTimeWorkingDays);
  // Aim for the template's buffer — but never later than the chain can survive.
  // A template whose `lead_time_working_days` is SHORTER than the minimum would
  // otherwise place `productionStart` after the last day the work could start,
  // and every row would report a lead below the minimum the geometry just
  // guaranteed. The aim is a wish; the minimum is arithmetic.
  const aim = Math.max(target, leads.organic);
  const byLead = addWorkingDays(firstPostingDay, -aim, cal);
  // The lead is what we AIM for; `startFrom` is the floor reality imposes.
  const productionStart = floor === null ? byLead : laterDay(floor, byLead);

  const leadOf = (day: string): number => (
    daysBetween(productionStart, day) <= 0
      ? 0
      : workingDaysIn(productionStart, addDays(day, -1), cal).length
  );
  const postingDayLeads: MonthPostingDay[] = postingDays.map((day) => {
    const leadWorkingDays = leadOf(day);
    return {
      day,
      leadWorkingDays,
      short: leadWorkingDays < target,
    };
  });

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
    startedFrom: from,
    startsOn,
    startMoved: skippedPostingDays.some((d) => d.reason === 'lead'),
    exhausted: from !== null && startsOn === null,
    isPartial: from !== null && (skippedPostingDays.length > 0 || skippedPaidBatchDays.length > 0),
    skippedPostingDays,
    skippedPaidBatchDays,
    targetLeadWorkingDays: target,
    minLeadWorkingDays: leads.organic,
    minPaidLeadWorkingDays: leads.paid,
    postingDayLeads,
    productionWorkingDays: workingDaysIn(productionStart, lastPostingDay, cal).length,
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
  /** Working days production actually has before this row publishes. */
  leadWorkingDays: number;
  /** Less slack than `lead_time_working_days` asks for — a warning, not a refusal. */
  shortLead: boolean;
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
 *
 * Only the geometry's REMAINING posting days get rows: a partial month's gone
 * days are already absent from `geometry.postingDays`, and drawing a row on a
 * day that has passed is drawing work nobody can do. The weekday → slot
 * assignment is unchanged, so «الأحد أ · الثلاثاء ب · الخميس ج · السبت عام»
 * still holds for whatever is left of the month.
 */
export function buildMonthRows(
  geometry: MonthGeometry, template: MonthTemplate, projects: MonthProject[],
): MonthRowPlan[] {
  const weekdays = Array.from(new Set(template.postingWeekdays)).sort((a, b) => a - b);
  const assigned = projects.slice(0, monthProjectSlots(template));
  const remaining = new Set(geometry.postingDays);
  const leadOf = new Map(geometry.postingDayLeads.map((d) => [d.day, d] as const));
  const rows: MonthRowPlan[] = [];
  for (const week of geometry.weeks) {
    weekdays.forEach((wd, slot) => {
      const day = addDays(week.start, (wd - WEEK_START + 7) % 7);
      if (!remaining.has(day)) return;
      const project = slot < assigned.length ? assigned[slot] : undefined;
      const letter = project ? (SLOT_LETTERS[slot] ?? String(slot)) : 'general';
      const lead = leadOf.get(day);
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
        leadWorkingDays: lead?.leadWorkingDays ?? 0,
        shortLead: lead?.short ?? false,
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
  /**
   * Paid batches this compile actually buys. `budget_per_project` is a MONTHLY
   * figure and a partial month buys fewer batches — this REPORTS that and
   * changes nothing. Silently prorating the budget would be the app making a
   * spending decision on the operator's behalf.
   */
  paidBatchesRemaining: number;
  /** Everything a person has to make: posts + paid creatives. */
  items: number;
  firstPostingDay: string;
  lastPostingDay: string;
  productionStart: string;
  /**
   * Working days from `productionStart` to `lastPostingDay` — what this
   * month's work is spread over, and the divisor under every
   * `averagePerWorkingDay` below. A partial month has fewer of them AND fewer
   * rows, so both sides of that ratio move together.
   */
  productionWorkingDays: number;
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
  /** The month runs from `startedFrom`, not from its first week. */
  isPartial: boolean;
  /** The day the month was ASKED to start from, or `null` for the whole cycle. */
  startedFrom: string | null;
  /** The day it actually starts — the first posting day production can reach. */
  startsOn: string | null;
  /**
   * The start MOVED: at least one day that is still ahead was dropped because
   * production could not reach it. A warning, not a failure — the work fits,
   * the first few days simply could not be produced in time.
   */
  startMoved: boolean;
  /**
   * NOTHING is left that production can reach. Reported here as its own state:
   * such a month is not "infeasible" — there is no work in it to fail to fit —
   * and `monthConfirm` refuses it with its own words, not `month_infeasible`.
   */
  exhausted: boolean;
  /** Posting days this month does not run, each with its reason and its lead. */
  skippedPostingDays: MonthSkippedDay[];
  /** `lead_time_working_days` — the target, not a gate. */
  targetLeadWorkingDays: number;
  /** Working days of lead a row needs to exist at all — the gate, derived from the workflow. */
  minLeadWorkingDays: number;
  /**
   * Rows that publish with LESS slack than the target lead. Kept in the month,
   * flagged here. A warning tone on the page: the work is the same size, it
   * simply has less room for a revision.
   */
  shortLeadRows: Array<{ day: string; leadWorkingDays: number }>;
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
  /**
   * `YYYY-MM-DD` — compile only what is LEFT of the month from this day on.
   *
   * OMIT it and it is defaulted from the clock (`monthStartFrom`): today when
   * `month` is the current month, `null` for any other month — so a future
   * month is compiled whole, exactly as before. Pass `null` explicitly to force
   * the whole cycle regardless.
   */
  startFrom?: string | null;
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
  // `undefined` means "decide for me"; an explicit `null` means "the whole
  // cycle". The default is what makes the CURRENT month compilable at all —
  // before it, today's compile drew a production start a fortnight in the past.
  const startFrom = args.startFrom === undefined
    ? monthStartFrom(month, snapshot.today)
    : args.startFrom;
  // The minimums come from the SAME rules the four plans are compiled with, so
  // the day the geometry promises is reachable is the day the engine agrees is
  // reachable. Deriving them from `DEFAULT_RULES` here while planning against an
  // edited workflow would put the two back out of step.
  const geometry = monthGeometry(
    month, template, cal, startFrom, monthLeadFloors(baseRules, DEFAULTS.publishBufferDays),
  );
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

  // ── A month that can no longer be STARTED is not planned at all ──────
  //
  // Not an error and not an infeasible plan: there is no work in it, so there
  // is nothing that fails to fit. Running the engine here would produce a
  // `not_enough_slots` conflict on the organic side ("the campaign requires no
  // content") and a `range_in_past` on the paid side — two refusals describing
  // a state that is simply empty. `inputs`/`plans` are empty so nothing can be
  // committed by accident; `summary.exhausted` is what the page and
  // `monthConfirm` read.
  if (geometry.exhausted) {
    const plan = noPlan(snapshot);
    return {
      month: geometry.month,
      template,
      geometry,
      rows,
      organic: { input: organicInput, plan },
      paid: [],
      inputs: [],
      plans: [],
      summary: summariseMonth({
        geometry, template, projects, rows, organicPlan: plan, paidPlans: [], snapshot,
      }),
    };
  }

  const organicPlan = planCampaign(
    organicInput, { ...snapshot, ledger: snapshot.ledger }, rules, { withAlternatives: false },
  );
  const afterOrganic = extendLedger(snapshot.ledger, organicPlan);

  // The three paid plans, compiled in sequence against a GROWING ledger so each
  // sees the load the previous ones proposed.
  const compilePaid = (geo: MonthGeometry): CompiledMonth['paid'] => {
    let ledger = afterOrganic;
    const out: CompiledMonth['paid'] = [];
    for (const project of running) {
      const input = paidPlanInput(geo, template, project);
      const plan = planCampaign(input, { ...snapshot, ledger }, rules, { withAlternatives: false });
      ledger = extendLedger(ledger, plan);
      out.push({ projectId: project.projectId, input, plan });
    }
    return out;
  };

  /*
   * THE ADS START AT THE FIRST BATCH THE TEAM CAN ACTUALLY MAKE.
   *
   * The posting days already follow this rule: a month begun partway through
   * opens at the first day production can reach, and says why. Ad batches did
   * not. Measured on production 2026-09-16: September from the 16th put its
   * first batch on Sun 20, whose fifteen creatives had to be designed by Sat
   * 19 while the only designer's twelve slots that week were nine-tenths taken
   * by the organic rows due the same days. Every paid plan came back
   * infeasible, `month_confirm` refused, and the operator was told to «move the
   * first ads to the 27th» by a page with no control to do it.
   *
   * So a LEADING batch the team cannot staff is skipped — reason `'capacity'` —
   * and the ads open at the next one. Deliberately narrow:
   *
   *   • only in a month started partway through (`startedFrom` set). A whole
   *     month that cannot staff its ads has a real capacity problem, and the
   *     operator must see it, not have it quietly shrunk;
   *   • only the FIRST batch, and only when EVERY blocking conflict falls before
   *     the second batch day — i.e. the failure is that batch's own window. A
   *     later batch that does not fit is still a conflict;
   *   • never the LAST batch: a month whose ads cannot be made at all keeps its
   *     conflict rather than silently buying no ads.
   *
   * `monthConfirm` compiles through this same function, so what the page
   * offers is exactly what the confirm commits.
   */
  let geo = geometry;
  let paid = compilePaid(geo);
  // A month whose ads go live as each is ready (month_starts) keeps the
  // operator's first batch: an ad not finished by the batch day simply goes
  // live when it is — that is the rule, not a capacity failure.
  const liveWhenReady = template.monthStarts?.[geometry.month]?.adsLiveWhenReady === true;
  while (!liveWhenReady && geo.startedFrom !== null && geo.paidBatchDays.length > 1) {
    const failed = paid.filter((x) => !x.plan.feasible);
    if (failed.length === 0) break;
    const second = geo.paidBatchDays[1]!;
    const blocking = failed.flatMap((x) => x.plan.conflicts.filter(conflictBlocksConfirm));
    const ownWindow = blocking.length > 0
      && blocking.every((c) => c.day !== null && daysBetween(c.day, second) > 0);
    if (!ownWindow) break;
    const first = geo.paidBatchDays[0]!;
    geo = {
      ...geo,
      paidBatchDays: geo.paidBatchDays.slice(1),
      skippedPaidBatchDays: [
        ...geo.skippedPaidBatchDays,
        { day: first, reason: 'capacity', leadWorkingDays: null },
      ],
    };
    paid = compilePaid(geo);
  }

  // Ads that go live as each is ready: an ad the forecast cannot fit before its
  // batch day is not an impossible month — it starts as early as the team can
  // and goes live when finished (the dispatcher hands work out by capacity, in
  // publish order). Such an item keeps its need date, starts at the month's
  // production start, and carries no booked stages; the capacity conflicts that
  // said "not all by the batch day" are dropped, because under this rule they
  // are not a refusal. Only no_capacity / time_bound are forgiven — a platform
  // or publishing-time conflict still blocks.
  if (liveWhenReady) {
    paid = paid.map((p) => {
      if (p.plan.feasible) return p;
      if (p.plan.conflicts.some(conflictBlocksPlan)) return p;
      const items = p.plan.items.map((it) => (it.productionStart
        ? it
        : { ...it, productionStart: geo.productionStart, requiredReadyAt: it.requiredReadyAt || it.needAt.slice(0, 10) }));
      const conflicts = p.plan.conflicts.filter((c) => c.kind !== 'no_capacity' && c.kind !== 'time_bound');
      return { ...p, plan: { ...p.plan, items, conflicts, feasible: true } };
    });
  }

  const inputs = [organicInput, ...paid.map((p) => p.input)];
  const plans = [organicPlan, ...paid.map((p) => p.plan)];
  return {
    month: geo.month,
    template,
    geometry: geo,
    rows,
    organic: { input: organicInput, plan: organicPlan },
    paid,
    inputs,
    plans,
    summary: summariseMonth({ geometry: geo, template, projects, rows, organicPlan, paidPlans: paid.map((p) => p.plan), snapshot }),
  };
}

/**
 * The plan of a month with nothing in it.
 *
 * `feasible: true` is not optimism — it is the only honest answer to "does this
 * fit?" when there is nothing to fit. The thing the operator must be told is
 * `summary.exhausted`, and it is told in its own words rather than borrowed
 * from the scheduler's vocabulary of refusals.
 */
function noPlan(snapshot: WorkloadSnapshot): PlanResult {
  return {
    feasible: true,
    infeasibleProof: null,
    searchIncomplete: false,
    searchStats: { expansions: 0, backtracks: 0, budget: 0 },
    items: [], rows: [], batches: [], releases: [], reservations: [], cycles: [], load: [],
    conflicts: [],
    totals: {
      items: 0, posts: 0, videos: 0, placements: 0, batches: 0,
      slotDaysByBucket: {}, perProject: [], perPlatform: [],
      releases: { total: 0, automatic: 0, manual: 0, feed: 0, story: 0 },
    },
    alternatives: { earliestFeasibleStart: null, earliestFeasibleEnd: null, maxItemsInRange: null },
    productionWindow: { start: null, end: null },
    snapshotHash: snapshot.hash,
    engineVersion: ENGINE_VERSION,
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

  // Production runs from the month's production start to its last posting day —
  // for a partial month that is the REMAINING span, so every average below is
  // this month's own work over this month's own days.
  const span = geometry.productionWorkingDays || 1;

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

  // Short leads are read off the PLAN's rows, so a row the planner dropped
  // cannot be warned about and a row it kept cannot be hidden.
  const leadOf = new Map(geometry.postingDayLeads.map((d) => [d.day, d] as const));
  const shortLeadRows: Array<{ day: string; leadWorkingDays: number }> = [];
  const seenShort = new Set<string>();
  for (const r of planRows) {
    const lead = leadOf.get(r.batchDay);
    if (!lead || !lead.short || seenShort.has(lead.day)) continue;
    seenShort.add(lead.day);
    shortLeadRows.push({ day: lead.day, leadWorkingDays: lead.leadWorkingDays });
  }
  shortLeadRows.sort((a, b) => (a.day < b.day ? -1 : 1));

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
    paidBatchesRemaining: geometry.paidBatchDays.length,
    items: posts + paidCreatives,
    firstPostingDay: geometry.firstPostingDay,
    lastPostingDay: geometry.lastPostingDay,
    productionStart: geometry.productionStart,
    productionWorkingDays: span,
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
    isPartial: geometry.isPartial,
    startedFrom: geometry.startedFrom,
    startsOn: geometry.startsOn,
    startMoved: geometry.startMoved,
    exhausted: geometry.exhausted,
    skippedPostingDays: geometry.skippedPostingDays,
    targetLeadWorkingDays: geometry.targetLeadWorkingDays,
    minLeadWorkingDays: geometry.minLeadWorkingDays,
    shortLeadRows,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
