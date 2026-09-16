/**
 * The ROW — the month model's unit of work (Group B, B2 + B3).
 *
 * Every case here is a rule the operator settled, not a hypothetical:
 *   • a row is ONE task, ONE approval and THREE slots on ONE day;
 *   • the post the writer places FIRST publishes LAST, because Instagram shows
 *     newest first and the reader must meet it first;
 *   • every post goes out twice — a feed post with the caption and a story
 *     with none;
 *   • Saturday's row belongs to no project at all.
 */
import { describe, expect, it } from 'vitest';
import { planCampaign, DEFAULT_RULES, type RuleSet } from '../plan';
import { DEFAULT_PUBLISHING, checkRowPublishing, rowSlotTime } from '../releases';
import { effortWeightsSameDay } from '../ledger';
import { toInstant } from '../calendar';
import type { PlanInput, PlanResult, PlannedRelease } from '../types';
import { CAL, PROJECT_A, PROJECT_B, snapshot } from './fixtures';
import { withClassicPost } from './classicWorkflow';

const rules = (): RuleSet => ({
  ...DEFAULT_RULES,
  publishing: {
    ...DEFAULT_PUBLISHING,
    automatable: { instagram: true },
    rowPublishing: { publishTime: '18:00', intraRowGapMinutes: 5 },
  },
});

/** One project row on a Sunday and the general row on the Saturday after it. */
const monthLike = (over: Partial<PlanInput> = {}): PlanInput => ({
  campaignId: null,
  kind: 'organic',
  projects: [{ ...PROJECT_A, posts: 0, videos: 0 }],
  rows: [
    {
      rowKey: 'r:a', projectId: PROJECT_A.projectId, projectName: 'A',
      day: '2026-10-04', platform: 'instagram', posts: 3,
    },
    {
      rowKey: 'r:general', projectId: null, labelAr: 'عام',
      day: '2026-10-10', platform: 'instagram', posts: 3,
    },
  ],
  platforms: ['instagram'],
  rangeStart: '2026-10-04',
  rangeEnd: '2026-10-10',
  frequency: [{ platform: 'instagram', perDay: 3, weekdays: [0, 6] }],
  crossPost: false,
  publishBufferDays: 1,
  ...over,
});

const oneRow = (over: Partial<PlanInput> = {}): PlanInput => monthLike({
  rows: [{
    rowKey: 'r:a', projectId: PROJECT_A.projectId, projectName: 'A',
    day: '2026-10-04', platform: 'instagram', posts: 3,
  }],
  rangeEnd: '2026-10-04',
  ...over,
});

const feedOf = (rels: PlannedRelease[], itemKey: string): PlannedRelease =>
  rels.find((r) => r.itemKey === itemKey && r.placementVariant === 'feed')!;
const storyOf = (rels: PlannedRelease[], itemKey: string): PlannedRelease =>
  rels.find((r) => r.itemKey === itemKey && r.placementVariant === 'story')!;

/**
 * THE invariant of the row's publishing moment: the placement and every release
 * of the same post agree, because there is exactly ONE producer of that moment
 * and everyone else reads it. Asserted on every plan in this file rather than
 * on one, since the divergence it guards was invisible on the happy path.
 */
const momentsAgree = (res: PlanResult): void => {
  for (const it of res.items) {
    const pl = it.placements[0]!;
    for (const rel of res.releases.filter((r) => r.itemKey === it.key)) {
      expect(rel.plannedAt).toBe(pl.plannedAt);
      expect(rel.day).toBe(pl.day);
    }
  }
};

/* ------------------------------------------------------------------ */

describe('a row is one task and three slots on ONE day', () => {
  const res = planCampaign(oneRow(), snapshot('2026-09-15'), rules());

  it('plans', () => {
    expect(res.feasible).toBe(true);
    expect(res.items).toHaveLength(3);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.itemKeys).toHaveLength(3);
    expect(res.totals.rows).toEqual({ total: 1, general: 0, posts: 3 });
  });

  it('books ONE reservation per step for the whole row, weighing three, on a single day', () => {
    // Five steps in `post_std`, not fifteen: the row is the subject.
    expect(res.reservations).toHaveLength(5);
    for (const r of res.reservations) {
      expect(r.rowKey).toBe('r:a');
      expect(r.itemKey).toBe('r:a');
      expect(r.weight).toBe(3);
      // ONE day. `effortWeights(3)` would have spread it over three.
      expect(r.plannedStart).toBe(r.plannedEnd);
    }
    // The JS spread and its SQL twin `mos_spread_effort_same_day` must agree.
    expect(effortWeightsSameDay(3)).toEqual([3]);
  });

  it('charges the writer three slots on exactly one day — never one on each of three', () => {
    const writing = res.rows[0]!.stages.find((s) => s.stepKey === 'writing')!;
    expect(writing.start).toBe(writing.end);
    const cells = res.load.filter((c) =>
      c.userId === writing.assigneeUserId && c.bucket === 'post' && c.proposed > 0);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.day).toBe(writing.start);
    expect(cells[0]!.proposed).toBe(3);
  });

  it('gives all three members the row\'s one chain, one owner and one window', () => {
    const rowStages = res.rows[0]!.stages;
    for (const it of res.items) {
      expect(it.rowKey).toBe('r:a');
      expect(it.stages).toEqual(rowStages);
      expect(it.requiredReadyAt).toBe(res.rows[0]!.requiredReadyAt);
    }
    expect(new Set(res.items.map((i) => i.rowOrder))).toEqual(new Set([0, 1, 2]));
  });

  it('satisfies the day BY CONSTRUCTION — the template day, not a search', () => {
    expect(res.searchIncomplete).toBe(false);
    for (const it of res.items) {
      expect(it.placements).toHaveLength(1);
      expect(it.placements[0]!.day).toBe('2026-10-04');
    }
  });
});

describe('the first-read post publishes LAST', () => {
  const res = planCampaign(oneRow(), snapshot('2026-09-15'), rules());
  const byOrder = (n: number) => res.items.find((i) => i.rowOrder === n)!;

  it('reverses row_order across the intra-row gap', () => {
    // 18:00 + 5-minute gap, reversed: the writer's first post takes 18:10.
    expect(rowSlotTime(0, 3, { publishTime: '18:00', intraRowGapMinutes: 5 })).toBe('18:10');
    expect(rowSlotTime(1, 3, { publishTime: '18:00', intraRowGapMinutes: 5 })).toBe('18:05');
    expect(rowSlotTime(2, 3, { publishTime: '18:00', intraRowGapMinutes: 5 })).toBe('18:00');
  });

  it('publishes row_order 0 at the LATEST moment of the batch', () => {
    const first = feedOf(res.releases, byOrder(0).key);
    const middle = feedOf(res.releases, byOrder(1).key);
    const last = feedOf(res.releases, byOrder(2).key);
    expect(first.plannedAt).toBe(toInstant('2026-10-04', '18:10', CAL));
    expect(middle.plannedAt).toBe(toInstant('2026-10-04', '18:05', CAL));
    expect(last.plannedAt).toBe(toInstant('2026-10-04', '18:00', CAL));
    expect(first.plannedAt > last.plannedAt).toBe(true);
  });

  it('gives the same order to the placement, so the release and the plan agree', () => {
    for (const it of res.items) {
      const pl = it.placements[0]!;
      expect(pl.plannedAt).toBe(feedOf(res.releases, it.key).plannedAt);
      // Publish position inside the day is the REVERSE of the writer's order.
      expect(pl.slotIndex).toBe(2 - (it.rowOrder ?? 0));
      // The profile grid still reads in the writer's order, left to right.
      expect(pl.gridCol).toBe(it.rowOrder);
    }
  });
});

describe('every post is two releases — a feed post and a story', () => {
  const res = planCampaign(oneRow(), snapshot('2026-09-15'), rules());

  it('emits two per post, paired, at the same moment', () => {
    expect(res.releases).toHaveLength(6);
    expect(res.totals.releases).toEqual({
      total: 6, automatic: 6, manual: 0, feed: 3, story: 3,
    });
    for (const it of res.items) {
      const feed = feedOf(res.releases, it.key);
      const story = storyOf(res.releases, it.key);
      expect(story.plannedAt).toBe(feed.plannedAt);
      expect(story.day).toBe(feed.day);
      // The pair key is the FEED release's own key — the same convention the
      // paid side uses, so the weekly ranking can sum feed + story on one key.
      expect(feed.pairId).toBe(feed.key);
      expect(story.pairId).toBe(feed.key);
    }
  });

  it('a story carries NO caption; the feed post carries it', () => {
    for (const it of res.items) {
      expect(storyOf(res.releases, it.key).carriesCaption).toBe(false);
      expect(feedOf(res.releases, it.key).carriesCaption).toBe(true);
    }
  });

  it('keys stay unique and stable across a re-plan', () => {
    const again = planCampaign(oneRow(), snapshot('2026-09-15'), rules());
    const keys = res.releases.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(again.releases.map((r) => r.key));
    expect(JSON.stringify(res)).toBe(JSON.stringify(again));
  });
});

describe('the Saturday general row', () => {
  const res = planCampaign(monthLike(), snapshot('2026-09-15'), rules());

  it('belongs to NO project — null, never an empty string', () => {
    const general = res.rows.find((r) => r.rowKey === 'r:general')!;
    expect(general.projectId).toBeNull();
    expect(general.kind).toBe('general_row');
    const members = res.items.filter((i) => i.rowKey === 'r:general');
    expect(members).toHaveLength(3);
    for (const m of members) expect(m.projectId).toBeNull();
    expect(res.totals.rows).toEqual({ total: 2, general: 1, posts: 6 });
  });

  it('still publishes, is still counted, and still carries a null in the totals', () => {
    expect(res.feasible).toBe(true);
    expect(res.releases.filter((r) => r.day === '2026-10-10')).toHaveLength(6);
    const line = res.totals.perProject.find((p) => p.projectId === null)!;
    expect(line.items).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* D1 — the placement and the release must be ONE moment                */
/* ------------------------------------------------------------------ */

describe('dropping a member closes the gap it left', () => {
  // §3.3's standing exception: "a row is not complete by its batch date →
  // drop the late post and go with a new one". `campaignPlanRevise` merges
  // caller overrides straight into the stored input, so this is reachable, and
  // it is the ONE case where a member's stored `row_order` stops being its
  // position among the live members.
  const res = planCampaign(
    oneRow({ overrides: { droppedItemKeys: ['r:a:post:1'] } }),
    snapshot('2026-09-15'),
    rules(),
  );
  const byOrder = (n: number) => res.items.find((i) => i.rowOrder === n)!;

  it('plans the survivors as a row of two', () => {
    expect(res.feasible).toBe(true);
    expect(res.items).toHaveLength(2);
    expect(res.items.map((i) => i.rowOrder).sort()).toEqual([1, 2]);
    expect(res.totals.rows).toEqual({ total: 1, general: 0, posts: 2 });
  });

  it('gives the two survivors DIFFERENT moments — they used to collide', () => {
    // Computing the moment from the stored `row_order` against a size of 2
    // clamped both survivors onto 18:00: two posts at the same second, in the
    // wrong order, with the plan still reporting itself fine.
    const a = feedOf(res.releases, byOrder(1).key);
    const b = feedOf(res.releases, byOrder(2).key);
    expect(a.plannedAt).not.toBe(b.plannedAt);
    expect(new Set(res.releases.map((r) => r.plannedAt)).size).toBe(2);
  });

  it('re-indexes positionally: the row still starts at publish_time and steps by the gap', () => {
    expect(feedOf(res.releases, byOrder(1).key).plannedAt).toBe(toInstant('2026-10-04', '18:05', CAL));
    expect(feedOf(res.releases, byOrder(2).key).plannedAt).toBe(toInstant('2026-10-04', '18:00', CAL));
  });

  it('keeps the reverse rule among the survivors — earlier row_order publishes later', () => {
    expect(feedOf(res.releases, byOrder(1).key).plannedAt > feedOf(res.releases, byOrder(2).key).plannedAt)
      .toBe(true);
    expect(byOrder(1).placements[0]!.slotIndex).toBe(1);
    expect(byOrder(2).placements[0]!.slotIndex).toBe(0);
  });

  it('the placement and BOTH releases of a post are the same moment', () => {
    // Before the fix the placements read 18:05 / 18:00 while the releases both
    // read 18:00, so mos_content_placements.planned_at and
    // mos_publications.planned_at held different times for the same post.
    momentsAgree(res);
  });
});

describe('the placement is the single source of the moment', () => {
  it('holds for a full row and for the general row', () => {
    momentsAgree(planCampaign(oneRow(), snapshot('2026-09-15'), rules()));
    momentsAgree(planCampaign(monthLike(), snapshot('2026-09-15'), rules()));
  });

  it('holds when the template moves the time — nothing is recomputed from a default', () => {
    const res = planCampaign(oneRow(), snapshot('2026-09-15'), {
      ...rules(),
      publishing: {
        ...DEFAULT_PUBLISHING,
        automatable: { instagram: true },
        rowPublishing: { publishTime: '19:30', intraRowGapMinutes: 10 },
      },
    });
    expect(res.feasible).toBe(true);
    momentsAgree(res);
    expect(res.releases.map((r) => r.plannedAt).sort()).toEqual([
      toInstant('2026-10-04', '19:30', CAL), toInstant('2026-10-04', '19:30', CAL),
      toInstant('2026-10-04', '19:40', CAL), toInstant('2026-10-04', '19:40', CAL),
      toInstant('2026-10-04', '19:50', CAL), toInstant('2026-10-04', '19:50', CAL),
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* D11 — a publishing time is operator data and can be wrong            */
/* ------------------------------------------------------------------ */

describe('an unusable publishing time is refused, never swallowed', () => {
  const withPub = (publishTime: string, intraRowGapMinutes: number): RuleSet => ({
    ...rules(),
    publishing: {
      ...DEFAULT_PUBLISHING, automatable: { instagram: true },
      rowPublishing: { publishTime, intraRowGapMinutes },
    },
  });

  it('reports a time that is not a real HH:MM', () => {
    expect(checkRowPublishing({ publishTime: '25:00', intraRowGapMinutes: 5 }, 3).invalidTime).toBe(true);
    expect(checkRowPublishing({ publishTime: '18:70', intraRowGapMinutes: 5 }, 3).invalidTime).toBe(true);
    expect(checkRowPublishing({ publishTime: '6pm', intraRowGapMinutes: 5 }, 3).invalidTime).toBe(true);
    expect(checkRowPublishing({ publishTime: '18:00', intraRowGapMinutes: 5 }, 3).invalidTime).toBe(false);
    // ABSENT is not INVALID: no template means the engine default, which is
    // valid. Reporting absence would refuse every plan built from the defaults.
    expect(checkRowPublishing(undefined, 3).invalidTime).toBe(false);
    expect(checkRowPublishing(null, 3)).toMatchObject({ publishTime: '18:00', gap: 5 });
  });

  it('does not refuse a row plan that carries no template at all', () => {
    const res = planCampaign(oneRow(), snapshot('2026-09-15'), {
      ...DEFAULT_RULES,
      publishing: { ...DEFAULT_PUBLISHING, automatable: { instagram: true } },
    });
    expect(res.conflicts.filter((x) => x.kind === 'publish_time')).toHaveLength(0);
    expect(res.feasible).toBe(true);
  });

  it('reports a row that no longer fits before midnight', () => {
    const chk = checkRowPublishing({ publishTime: '23:00', intraRowGapMinutes: 60 }, 3);
    expect(chk.clamped).toBe(true);
    expect(chk.wouldEndAt).toBe('25:00');
    // And the clamp really does collapse the order, which is why it must be loud.
    expect(rowSlotTime(0, 3, { publishTime: '23:00', intraRowGapMinutes: 60 })).toBe('23:59');
    expect(rowSlotTime(1, 3, { publishTime: '23:00', intraRowGapMinutes: 60 })).toBe('23:59');
    expect(checkRowPublishing({ publishTime: '23:00', intraRowGapMinutes: 5 }, 3).clamped).toBe(false);
  });

  it('refuses the plan when the row would spill past midnight', () => {
    const res = planCampaign(oneRow(), snapshot('2026-09-15'), withPub('23:00', 60));
    const c = res.conflicts.filter((x) => x.kind === 'publish_time');
    expect(c).toHaveLength(1);
    expect(c[0]!.detail).toMatchObject({ rowSize: 3, wouldEndAt: '25:00' });
    expect(res.feasible).toBe(false);
  });

  it('refuses the plan when the time does not parse, instead of quietly using 18:00', () => {
    const res = planCampaign(oneRow(), snapshot('2026-09-15'), withPub('25:00', 5));
    expect(res.conflicts.filter((x) => x.kind === 'publish_time')).toHaveLength(1);
    expect(res.feasible).toBe(false);
  });

  it('says nothing when the time is fine', () => {
    const res = planCampaign(oneRow(), snapshot('2026-09-15'), withPub('18:00', 5));
    expect(res.conflicts.filter((x) => x.kind === 'publish_time')).toHaveLength(0);
    expect(res.feasible).toBe(true);
  });

  it('checks the WIDEST row, not the first one', () => {
    // 23:50 + a 5-minute gap fits two posts and not three.
    const res = planCampaign(
      monthLike({
        rows: [
          { rowKey: 'r:a', projectId: PROJECT_A.projectId, day: '2026-10-04', platform: 'instagram', posts: 2 },
          { rowKey: 'r:b', projectId: PROJECT_B.projectId, day: '2026-10-06', platform: 'instagram', posts: 3 },
        ],
        rangeEnd: '2026-10-06',
      }),
      snapshot('2026-09-15'),
      withPub('23:50', 5),
    );
    expect(res.conflicts.filter((x) => x.kind === 'publish_time')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* D8 — a stage records what it actually booked                         */
/* ------------------------------------------------------------------ */

describe('a stage records the slots it actually booked', () => {
  const res = planCampaign(oneRow(), snapshot('2026-09-15'), rules());

  it('a row stage is THREE slots on ONE day, whatever its step estimate says', () => {
    for (const s of res.rows[0]!.stages) {
      expect(s.slotWeights).toEqual([3]);
      expect(s.start).toBe(s.end);
    }
    // The estimate is still carried, and for `design` it reads 1 (one of a
    // designer's four daily slots) while the row booked THREE — which is exactly
    // why nothing may derive the booking from the estimate.
    const design = res.rows[0]!.stages.find((s) => s.stepKey === 'design')!;
    expect(design.workingDays).toBe(1);
    expect(design.slotWeights).toEqual([3]);
    expect(design.slotWeights).not.toEqual([design.workingDays]);
  });

  it('every reservation is that stage, named and not re-derived', () => {
    for (const r of res.reservations) {
      expect(r.spread).toBe('same_day');
      expect(r.weights).toEqual([3]);
      expect(r.weight).toBe(3);
    }
  });

  it('a loose wizard item still spreads one slot per working day', () => {
    const loose = planCampaign(
      {
        campaignId: null, kind: 'organic',
        projects: [{ ...PROJECT_A, posts: 1, videos: 0 }],
        platforms: ['instagram'],
        rangeStart: '2026-10-11', rangeEnd: '2026-10-12',
        frequency: [{ platform: 'instagram', perDay: 1, weekdays: null }],
        crossPost: false, publishBufferDays: 1,
      },
      snapshot('2026-09-15'),
      // Spreading "one slot per working day" needs a step that spans days, so
      // this runs on the classic two-day design (see classicWorkflow.ts).
      withClassicPost(rules()),
    );
    expect(loose.feasible).toBe(true);
    const design = loose.reservations.find((r) => r.stepKey === 'design')!;
    expect(design.spread).toBe('per_day');
    expect(design.weights).toEqual([1, 1]);
    expect(design.weight).toBe(2);
    expect(loose.reservations.every((r) => r.rowKey === null)).toBe(true);
  });
});

describe('the wizard path is untouched', () => {
  it('a plan with no rows still emits ONE release per placement, unversioned', () => {
    const res = planCampaign(
      {
        campaignId: null, kind: 'organic',
        projects: [{ ...PROJECT_A, posts: 1, videos: 0 }, { ...PROJECT_B, posts: 1, videos: 0 }],
        platforms: ['instagram'],
        rangeStart: '2026-10-11', rangeEnd: '2026-10-12',
        frequency: [{ platform: 'instagram', perDay: 1, weekdays: null }],
        crossPost: false, publishBufferDays: 1,
      },
      snapshot('2026-09-15'),
      rules(),
    );
    expect(res.feasible).toBe(true);
    expect(res.rows).toHaveLength(0);
    expect(res.totals.rows).toBeUndefined();
    expect(res.releases).toHaveLength(2);
    for (const r of res.releases) {
      expect(r.placementVariant).toBeNull();
      expect(r.pairId).toBeNull();
      expect(r.key).not.toMatch(/:feed$|:story$/);
    }
    // Loose items keep per-ITEM reservations; nothing claims a row.
    expect(res.reservations.every((r) => r.rowKey === null)).toBe(true);
    for (const it of res.items) expect(it.rowKey).toBeUndefined();
  });
});
