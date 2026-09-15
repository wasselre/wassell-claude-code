/**
 * The month compiler (B1) — three projects and a template become a month.
 *
 * The numbers asserted here are the plan's own acceptance figures (§5):
 * **16 rows · 48 posts · 96 organic releases · 60 paid creatives · 108 items**
 * for October 2026, whose 1st is a Thursday, so the four whole weeks run
 * Sun 4 Oct → Sat 31 Oct.
 *
 * The compiler lives under `api/`, but it is PURE — no Supabase client, no
 * clock — which is exactly why it can be tested here at all.
 */
import { describe, expect, it } from 'vitest';
import {
  compileMonth, monthGeometry, buildMonthRows, parseMonthTemplate,
  organicPlanInput, paidPlanInput, monthProjectSlots, monthSelectionConflicts,
  MONTH_TEMPLATE_DEFAULTS, WEEKS_PER_MONTH, type MonthProject, type MonthTemplate,
} from '../../../../../api/_lib/marketing/planning/monthCompiler';
import {
  materialisePayload, parsePlanInput, planSignature, toSnake,
} from '../../../../../api/_lib/marketing/planning/actions';
import { rowPublishingFromTemplateRow } from '../../../../../api/_lib/marketing/planning/snapshot';
import { toInstant, weekdayOf } from '../calendar';
import { planCampaign, DEFAULT_RULES, type RuleSet } from '../plan';
import { DEFAULT_PUBLISHING, DEFAULT_ROW_PUBLISHING } from '../releases';
import type { PlanInput } from '../types';
import { CAL, PROJECT_A, PROJECT_B, PROJECT_C, PROJECT_D, snapshot } from './fixtures';

const T = MONTH_TEMPLATE_DEFAULTS;

/**
 * Instagram is connected and may publish by itself — which is what the live
 * `loadRuleSet` reports since S3 gave every publication its account. Without
 * it every release would need a person and the month would open 96 tasks.
 */
const RULES: RuleSet = {
  ...DEFAULT_RULES,
  publishing: { ...DEFAULT_PUBLISHING, automatable: { instagram: true } },
};
const PROJECTS: MonthProject[] = [
  { projectId: PROJECT_A.projectId, projectName: 'أ' },
  { projectId: PROJECT_B.projectId, projectName: 'ب' },
  { projectId: PROJECT_C.projectId, projectName: 'ج' },
];

/** Confirmation happens ~the 20th of the previous month; production runs ten working days. */
const TODAY = '2026-09-15';

/* ------------------------------------------------------------------ */

describe('the month template, read from its row', () => {
  it('parses the live shape, including a Postgres time and an int[]', () => {
    const t = parseMonthTemplate({
      posting_weekdays: [0, 2, 4, 6],
      posts_per_row: 3,
      creatives_per_project_week: 5,
      budget_per_project: 2000,
      lead_time_working_days: 10,
      safety_margin_days: 2,
      publish_time: '18:00:00',
      intra_row_gap_minutes: 5,
      general_topic_bank: ['سوق الرياض', 'نصائح التمويل'],
    });
    expect(t.publishTime).toBe('18:00');
    expect(t.postingWeekdays).toEqual([0, 2, 4, 6]);
    expect(t.generalTopicBank).toHaveLength(2);
    expect(t.leadTimeWorkingDays).toBe(10);
  });

  it('falls back to the standing month when the row is missing', () => {
    expect(parseMonthTemplate(null)).toEqual(MONTH_TEMPLATE_DEFAULTS);
  });
});

describe('October 2026 — geometry', () => {
  const geo = monthGeometry('2026-10', T, CAL);

  it('runs four whole weeks from the first Sunday, Sun 4 Oct → Sat 31 Oct', () => {
    expect(geo.weeks).toHaveLength(WEEKS_PER_MONTH);
    expect(geo.weeks.map((w) => [w.start, w.end])).toEqual([
      ['2026-10-04', '2026-10-10'],
      ['2026-10-11', '2026-10-17'],
      ['2026-10-18', '2026-10-24'],
      ['2026-10-25', '2026-10-31'],
    ]);
    // 1 Oct is a Thursday and is deliberately NOT a posting day: the month's
    // cycle is four whole weeks, not "every matching weekday in October".
    expect(geo.postingDays).not.toContain('2026-10-01');
  });

  it('has sixteen posting days — Sun, Tue, Thu, Sat of each week', () => {
    expect(geo.postingDays).toHaveLength(16);
    expect(new Set(geo.postingDays.map(weekdayOf))).toEqual(new Set([0, 2, 4, 6]));
    expect(geo.firstPostingDay).toBe('2026-10-04');
    expect(geo.lastPostingDay).toBe('2026-10-31');
  });

  it('puts the four paid batches on the four Sundays', () => {
    expect(geo.paidBatchDays).toEqual(['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']);
  });

  it('computes production start and the next-month reminder, not the operator', () => {
    // Ten WORKING days back from Sun 4 Oct with Friday off.
    expect(geo.productionStart).toBe('2026-09-22');
    // Two calendar days before that: «حدّد مشاريع الشهر القادم».
    expect(geo.nextMonthReminderOn).toBe('2026-09-20');
  });
});

describe('October 2026 — the grid', () => {
  const geo = monthGeometry('2026-10', T, CAL);
  const rows = buildMonthRows(geo, T, PROJECTS);

  it('assigns projects to weekdays in slot order — أ Sunday, ب Tuesday, ج Thursday', () => {
    expect(rows).toHaveLength(16);
    const bySlot = (wd: number) => rows.filter((r) => r.weekday === wd);
    expect(bySlot(0).every((r) => r.projectId === PROJECT_A.projectId)).toBe(true);
    expect(bySlot(2).every((r) => r.projectId === PROJECT_B.projectId)).toBe(true);
    expect(bySlot(4).every((r) => r.projectId === PROJECT_C.projectId)).toBe(true);
    expect(bySlot(0)).toHaveLength(4);
  });

  it('makes every Saturday a GENERAL row with a null project', () => {
    const general = rows.filter((r) => r.weekday === 6);
    expect(general).toHaveLength(4);
    for (const r of general) {
      expect(r.projectId).toBeNull();
      expect(r.kind).toBe('general_row');
      expect(r.slot).toBeNull();
    }
    // A quarter of the organic month: 4 rows of 16, 12 posts of 48.
    expect(general.reduce((a, r) => a + r.posts, 0)).toBe(12);
  });

  it('gives every row a stable, distinct key', () => {
    const keys = rows.map((r) => r.rowKey);
    expect(new Set(keys).size).toBe(16);
    expect(buildMonthRows(geo, T, PROJECTS).map((r) => r.rowKey)).toEqual(keys);
  });
});

describe('October 2026 — the four plan inputs', () => {
  const geo = monthGeometry('2026-10', T, CAL);
  const rows = buildMonthRows(geo, T, PROJECTS);

  it('organic is ONE input carrying all sixteen rows', () => {
    const input = organicPlanInput(geo, T, PROJECTS, rows);
    expect(input.kind).toBe('organic');
    expect(input.rows).toHaveLength(16);
    expect(input.rows!.reduce((a, r) => a + r.posts, 0)).toBe(48);
    expect(input.rows!.filter((r) => r.projectId === null)).toHaveLength(4);
    // The rows are authoritative; the loose-item counts stay at zero.
    expect(input.projects.every((p) => p.posts === 0 && p.videos === 0)).toBe(true);
  });

  it('paid is one input per project, five creatives on each of four batches', () => {
    const input = paidPlanInput(geo, T, PROJECTS[0]!);
    expect(input.kind).toBe('paid');
    expect(input.rangeStart).toBe('2026-10-04');
    expect(input.rangeEnd).toBe('2026-10-31');
    expect(input.paid![0]!.policy.slateSize).toBe(5);
    expect(input.paid![0]!.policy.cycleDays).toBe(7);
  });

  it('survives the round-trip through `mos_campaign_plans.input`', () => {
    // The commit RE-PLANS from the stored input. Until this was fixed both
    // `toSnake` and `parsePlanInput` dropped `rows` on the floor, which would
    // have turned a committed month back into loose items — a plan that could
    // never match its own signature, and rows that were never created.
    const input = organicPlanInput(geo, T, PROJECTS, rows);
    const stored = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const back = parsePlanInput(toSnake(stored), 1);
    expect(typeof back).not.toBe('string');
    const parsed = back as typeof input;
    expect(parsed.rows).toHaveLength(16);
    expect(parsed.rows).toEqual(input.rows);
    // …including the general row's null, which must never become ''.
    expect(parsed.rows!.filter((r) => r.projectId === null)).toHaveLength(4);
  });
});

describe('October 2026 — compiled', () => {
  const out = compileMonth({
    month: '2026-10', template: T, projects: PROJECTS, snapshot: snapshot(TODAY), rules: RULES,
  });

  it('produces 16 rows, 48 posts, 96 organic releases, 60 paid creatives, 108 items', () => {
    expect(out.summary.rows).toBe(16);
    expect(out.summary.posts).toBe(48);
    expect(out.summary.organicReleases).toBe(96);
    expect(out.summary.feedReleases).toBe(48);
    expect(out.summary.storyReleases).toBe(48);
    expect(out.summary.paidCreatives).toBe(60);
    expect(out.summary.items).toBe(108);
  });

  it('is four plans — one organic, three paid — and every one of them fits', () => {
    expect(out.plans).toHaveLength(4);
    expect(out.paid).toHaveLength(3);
    expect(out.summary.feasible).toBe(true);
    expect(out.summary.capacityOk).toBe(true);
    for (const p of out.plans) {
      expect(p.feasible).toBe(true);
      expect(p.infeasibleProof).toBeNull();
      expect(p.searchIncomplete).toBe(false);
    }
  });

  it('searches for nothing and offers no alternatives', () => {
    for (const p of out.plans) {
      expect(p.alternatives).toEqual({
        earliestFeasibleStart: null, earliestFeasibleEnd: null, maxItemsInRange: null,
      });
    }
  });

  it('carries the general row through to the plan with a null project', () => {
    const general = out.organic.plan.rows.filter((r) => r.projectId === null);
    expect(general).toHaveLength(4);
    expect(general.every((r) => r.kind === 'general_row')).toBe(true);
    expect(out.organic.plan.items.filter((i) => i.projectId === null)).toHaveLength(12);
  });

  it('charges each row three slots on one day, sixteen times over', () => {
    const rowRes = out.organic.plan.reservations;
    // Five steps per row, sixteen rows.
    expect(rowRes).toHaveLength(80);
    for (const r of rowRes) {
      expect(r.rowKey).not.toBeNull();
      expect(r.weight).toBe(3);
      expect(r.plannedStart).toBe(r.plannedEnd);
    }
  });

  it('reports the per-person daily load against each person\'s own capacity', () => {
    expect(out.summary.load.length).toBeGreaterThan(0);
    for (const line of out.summary.load) {
      expect(line.capacityPerDay).toBeGreaterThan(0);
      expect(line.peakLoad).toBeLessThanOrEqual(line.capacityPerDay + 1e-9);
      expect(line.over).toBe(false);
      expect(line.averagePerWorkingDay).toBeGreaterThan(0);
      expect(line.averagePerWorkingDay).toBeLessThanOrEqual(line.capacityPerDay);
    }
    // The three paid plans see the organic plan's load, not a fresh ledger, so
    // the production bucket is the sum of both halves counted exactly once:
    //   16 rows × (writing + design) × 3 members            =  96
    //   60 creatives × (writing 1 day + design 2 days)      = 180
    const production = out.summary.load
      .filter((l) => l.bucket === 'post')
      .reduce((a, l) => a + l.totalSlots, 0);
    expect(production).toBe(96 + 180);
  });

  it('answers the month page: dates, budget and nothing left unassigned', () => {
    expect(out.summary.firstPostingDay).toBe('2026-10-04');
    expect(out.summary.productionStart).toBe('2026-09-22');
    expect(out.summary.nextMonthReminderOn).toBe('2026-09-20');
    expect(out.summary.budgetTotal).toBe(6000);
    expect(out.summary.projectsWithoutRows).toEqual([]);
    expect(out.summary.conflicts).toEqual([]);
  });

  it('is deterministic — the same month twice is the same month', () => {
    const again = compileMonth({
      month: '2026-10', template: T, projects: PROJECTS, snapshot: snapshot(TODAY), rules: RULES,
    });
    expect(JSON.stringify(again.summary)).toBe(JSON.stringify(out.summary));
    expect(JSON.stringify(again.plans)).toBe(JSON.stringify(out.plans));
  });

  it('counts the rows the PLAN holds, not the rows the template drew', () => {
    // `posts` has always come from the plan. Counting `rows` from the template
    // grid meant a dropped row left the page reporting 16 rows and fewer than
    // 48 posts — two numbers that cannot both be true.
    expect(out.summary.rows).toBe(out.organic.plan.rows.length);
    expect(out.summary.generalRows)
      .toBe(out.organic.plan.rows.filter((r) => r.projectId === null).length);
    expect(out.summary.templateRows).toBe(out.rows.length);
    expect(out.summary.rows).toBe(out.summary.templateRows);
  });
});

/* ------------------------------------------------------------------ */
/* D6 — projects_per_month is the month's shape, not a decoration       */
/* ------------------------------------------------------------------ */

describe('a fourth project does not eat the Saturday general row', () => {
  const FOUR: MonthProject[] = [...PROJECTS, { projectId: PROJECT_D.projectId, projectName: 'د' }];
  const out = compileMonth({
    month: '2026-10', template: T, projects: FOUR, snapshot: snapshot(TODAY), rules: RULES,
  });

  it('knows how many project slots the template provides', () => {
    expect(monthProjectSlots(T)).toBe(3);
    // Never more slots than there are posting days to put them on.
    expect(monthProjectSlots({ ...T, projectsPerMonth: 9 })).toBe(4);
  });

  it('keeps all four general rows and all twelve general posts', () => {
    // Positional assignment used to give the fourth project the Saturday
    // weekday, producing 16 rows and ZERO general rows with no warning —
    // a quarter of the organic month gone in silence.
    expect(out.summary.rows).toBe(16);
    expect(out.summary.generalRows).toBe(4);
    expect(out.organic.plan.items.filter((i) => i.projectId === null)).toHaveLength(12);
    const saturdays = out.rows.filter((r) => r.weekday === 6);
    expect(saturdays).toHaveLength(4);
    expect(saturdays.every((r) => r.projectId === null && r.kind === 'general_row')).toBe(true);
  });

  it('says out loud which project will not run, and is not silently "ok"', () => {
    expect(out.summary.selectionOk).toBe(false);
    expect(out.summary.projectSlots).toBe(3);
    expect(out.summary.projectsWithoutRows).toEqual([PROJECT_D.projectId]);
    const c = out.summary.conflicts.filter((x) => x.kind === 'not_enough_slots');
    expect(c).toHaveLength(1);
    expect(c[0]!.detail).toMatchObject({ slots: 3, chosen: 4, dropped: [PROJECT_D.projectId] });
    expect(c[0]!.messageAr).toContain('د');
  });

  it('does not open a paid campaign for a project with no rows', () => {
    // Three organic project columns and four 2,000-riyal campaigns would have
    // been a real 8,000-riyal month for three projects' worth of work.
    expect(out.paid).toHaveLength(3);
    expect(out.paid.map((p) => p.projectId)).not.toContain(PROJECT_D.projectId);
    expect(out.summary.paidCreatives).toBe(60);
    expect(out.summary.budgetTotal).toBe(6000);
  });

  it('reports the opposite case too — two projects turn a project day general', () => {
    const two = compileMonth({
      month: '2026-10', template: T, projects: PROJECTS.slice(0, 2),
      snapshot: snapshot(TODAY), rules: RULES,
    });
    expect(two.summary.generalRows).toBe(8);
    expect(two.summary.selectionOk).toBe(true);
    expect(two.summary.conflicts.filter((x) => x.kind === 'not_enough_slots')).toHaveLength(1);
  });

  it('says nothing when the selection matches the template', () => {
    expect(monthSelectionConflicts(T, PROJECTS)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* D2 — the template's publishing moment must survive the commit        */
/* ------------------------------------------------------------------ */

describe('the publishing moment survives the round-trip to the commit', () => {
  const LATE: MonthTemplate = { ...T, publishTime: '19:30', intraRowGapMinutes: 10 };

  it('reads the Postgres `time` off the template row', () => {
    expect(rowPublishingFromTemplateRow({ publish_time: '19:30:00+03', intra_row_gap_minutes: 10 }))
      .toEqual({ publishTime: '19:30', intraRowGapMinutes: 10 });
    expect(rowPublishingFromTemplateRow({ publish_time: '09:05:00', intra_row_gap_minutes: 0 }))
      .toEqual({ publishTime: '09:05', intraRowGapMinutes: 0 });
    // A missing row is a legitimate state: the month model is not switched on.
    expect(rowPublishingFromTemplateRow(null)).toEqual(DEFAULT_ROW_PUBLISHING);
  });

  it('passes a BAD time through verbatim instead of quietly defaulting it', () => {
    // The engine refuses it with a `publish_time` conflict; swallowing it here
    // would make that impossible and put 18:00 in the database instead.
    expect(rowPublishingFromTemplateRow({ publish_time: '25:00', intra_row_gap_minutes: 5 }))
      .toEqual({ publishTime: '25:00', intraRowGapMinutes: 5 });
  });

  it('previews the operator\'s time, not the engine default', () => {
    const late = compileMonth({
      month: '2026-10', template: LATE, projects: PROJECTS, snapshot: snapshot(TODAY), rules: RULES,
    });
    const first = late.organic.plan.rows[0]!;
    const members = late.organic.plan.items.filter((i) => i.rowKey === first.rowKey);
    expect(members.map((m) => m.placements[0]!.plannedAt).sort()).toEqual([
      toInstant(first.batchDay, '19:30', CAL),
      toInstant(first.batchDay, '19:40', CAL),
      toInstant(first.batchDay, '19:50', CAL),
    ]);
  });

  it('the commit gate SEES a moment that moved — it used to sign off on 18:00', () => {
    // The exact shape of the live defect: the preview compiled with the
    // template's 19:30, and `campaignPlanCommit` re-planned through
    // `loadRuleSet`, whose `publishing` had no `rowPublishing` at all. The
    // commit therefore re-planned at 18:00/5 — and the signature, which keyed
    // on (day, slotIndex) only, declared the two plans identical. No 409, no
    // diff, no toast, and the database stored a time nobody approved.
    const late = compileMonth({
      month: '2026-10', template: LATE, projects: PROJECTS, snapshot: snapshot(TODAY), rules: RULES,
    });
    const stored = JSON.parse(JSON.stringify(late.organic.input)) as Record<string, unknown>;
    const parsed = parsePlanInput(toSnake(stored), 1) as PlanInput;

    // (a) a rule set WITHOUT the template's moment re-plans at 18:00 …
    const blind = planCampaign(parsed, snapshot(TODAY), RULES, { withAlternatives: false });
    expect(blind.items[0]!.placements[0]!.plannedAt)
      .not.toBe(late.organic.plan.items[0]!.placements[0]!.plannedAt);
    // … and the gate now refuses it instead of waving it through.
    expect(planSignature(blind)).not.toBe(planSignature(late.organic.plan));

    // (b) the rule set the fixed `loadRuleSet` builds re-plans identically, so
    //     a clean commit is still a clean commit.
    const seeing = planCampaign(
      parsed, snapshot(TODAY),
      {
        ...RULES,
        publishing: {
          ...RULES.publishing!,
          rowPublishing: rowPublishingFromTemplateRow({
            publish_time: '19:30:00', intra_row_gap_minutes: 10,
          }),
        },
        searchBudget: 0,
      },
      { withAlternatives: false },
    );
    expect(planSignature(seeing)).toBe(planSignature(late.organic.plan));
  });
});

/* ------------------------------------------------------------------ */
/* D5 — the story half must reach the commit payload                    */
/* ------------------------------------------------------------------ */

describe('the commit payload carries both halves of every pair', () => {
  const out = compileMonth({
    month: '2026-10', template: T, projects: PROJECTS, snapshot: snapshot(TODAY), rules: RULES,
  });
  const payload = materialisePayload(out.organic.input, out.organic.plan);
  const releases = payload.releases as Array<Record<string, unknown>>;

  it('emits one entry per RELEASE, not one per placement', () => {
    // The payload had no `releases` key at all, so the commit built
    // publications from `items[].placements[]` — 48 feed rows and no stories,
    // with nothing anywhere reporting the loss.
    expect(releases).toHaveLength(96);
    expect(releases.filter((r) => r.placement_variant === 'feed')).toHaveLength(48);
    expect(releases.filter((r) => r.placement_variant === 'story')).toHaveLength(48);
    expect(new Set(releases.map((r) => r.key)).size).toBe(96);
  });

  it('a story carries no caption and points at its feed post', () => {
    const feeds = new Map(releases.filter((r) => r.placement_variant === 'feed')
      .map((r) => [r.item_key as string, r]));
    for (const story of releases.filter((r) => r.placement_variant === 'story')) {
      const feed = feeds.get(story.item_key as string)!;
      expect(story.carries_caption).toBe(false);
      expect(feed.carries_caption).toBe(true);
      // The pair key is the FEED release's own key, the same convention
      // `mos_ad_sets` uses, so the weekly ranking can sum feed + story (E2).
      expect(story.pair_id).toBe(feed.key);
      expect(feed.pair_id).toBe(feed.key);
      expect(story.planned_at).toBe(feed.planned_at);
      expect(story.account_id).toBe(feed.account_id);
    }
  });

  it('every release agrees with the placement it came from', () => {
    const placementAt = new Map<string, unknown>();
    for (const item of payload.items as Array<Record<string, unknown>>) {
      for (const pl of item.placements as Array<Record<string, unknown>>) {
        placementAt.set(`${item.key as string}@${pl.platform as string}`, pl.planned_at);
      }
    }
    for (const r of releases) {
      expect(r.planned_at).toBe(placementAt.get(`${r.item_key as string}@${r.platform as string}`));
    }
  });
});
