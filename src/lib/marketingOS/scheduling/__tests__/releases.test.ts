/**
 * Releases — the creation/publication split (2026-09-14).
 *
 * Every case here is a defect that was measured on the real system before the
 * split, not a hypothetical.
 */
import { describe, expect, it } from 'vitest';
import { planCampaign, type RuleSet } from '../plan';
import { buildReleases, releaseReason, DEFAULT_PUBLISHING, type PublishingRules } from '../releases';
import { CapacityBook } from '../ledger';
import { POST_WORKFLOW, VIDEO_WORKFLOW, CONTENT_TYPE_BUCKET, CONTENT_TYPE_WORKFLOW, DEFAULT_WORKFLOWS } from '../defaults';
import { CAL, PROJECT_A, PROJECT_B, TEAM, snapshot } from './fixtures';
import type { PlannedItem, PersonCapacity } from '../types';

const rules = (publishing?: Partial<PublishingRules>): RuleSet => ({
  workflows: DEFAULT_WORKFLOWS,
  contentTypeWorkflow: CONTENT_TYPE_WORKFLOW,
  contentTypeBucket: CONTENT_TYPE_BUCKET,
  publishing: { ...DEFAULT_PUBLISHING, ...publishing },
});

/** Two projects so Instagram's no-consecutive-same-project rule is satisfiable. */
const twoProjectPlan = (publishing?: Partial<PublishingRules>) => planCampaign(
  {
    campaignId: null, kind: 'organic',
    projects: [{ ...PROJECT_A, posts: 1, videos: 0 }, { ...PROJECT_B, posts: 1, videos: 0 }],
    platforms: ['instagram', 'tiktok'],
    rangeStart: '2026-10-12', rangeEnd: '2026-10-29',
    frequency: [
      { platform: 'instagram', perDay: 1, weekdays: null },
      { platform: 'tiktok', perDay: 1, weekdays: null },
    ],
    crossPost: true, publishBufferDays: 1,
  },
  snapshot('2026-09-14'),
  rules(publishing),
);

describe('the production path stops at approval', () => {
  it('no workflow still carries a scheduling or publish-check step', () => {
    for (const wf of [POST_WORKFLOW, VIDEO_WORKFLOW]) {
      const keys = wf.steps.map((s) => s.key);
      expect(keys).not.toContain('scheduling');
      expect(keys).not.toContain('publish_check');
      expect(wf.steps[wf.steps.length - 1]?.isApproval).toBe(true);
    }
  });

  it('a paid creative books NO publishing stage — it used to book two per creative', () => {
    const res = planCampaign(
      {
        campaignId: null, kind: 'paid',
        projects: [{ ...PROJECT_A, posts: 0, videos: 0 }],
        platforms: ['meta'], rangeStart: '2026-10-12', rangeEnd: '2026-10-26',
        frequency: [], crossPost: false, publishBufferDays: 1,
        paid: [{
          executionKey: 'exec:meta', executionId: null, platform: 'meta',
          policy: {
            slateSize: 5, keepMin: 1, cycleDays: 7, minRemainingDays: 3,
            leadTimeWorkingDays: 7, fifthPolicy: 'A', bankedSpares: [],
          },
        }],
      },
      snapshot('2026-09-14'),
      rules(),
    );
    expect(res.feasible).toBe(true);
    const publishing = res.items.flatMap((i) => i.stages)
      .filter((s) => /schedul|publish/.test(s.stepKey));
    expect(publishing).toHaveLength(0);
    // Nothing is charged to a production bucket for putting an ad live.
    expect(res.load.filter((c) => c.bucket === 'publishing' && c.proposed > 0)).toHaveLength(0);
  });

  it('an ad never needs a person to publish it — the worker builds and verifies it', () => {
    const res = planCampaign(
      {
        campaignId: null, kind: 'paid',
        projects: [{ ...PROJECT_A, posts: 0, videos: 0 }],
        platforms: ['meta'], rangeStart: '2026-10-12', rangeEnd: '2026-10-19',
        frequency: [], crossPost: false, publishBufferDays: 1,
        paid: [{
          executionKey: 'exec:meta', executionId: null, platform: 'meta',
          policy: {
            slateSize: 2, keepMin: 1, cycleDays: 7, minRemainingDays: 3,
            leadTimeWorkingDays: 5, fifthPolicy: 'A', bankedSpares: [],
          },
        }],
      },
      snapshot('2026-09-14'),
      // meta is deliberately absent from `automatable`; an ad must still be
      // automatic, because its reason comes from its kind, not the account map.
      rules({ automatable: {} }),
    );
    expect(res.releases.length).toBeGreaterThan(0);
    expect(res.releases.every((r) => r.kind === 'ad')).toBe(true);
    expect(res.releases.every((r) => r.needsPerson === false)).toBe(true);
    expect(res.totals.releases.manual).toBe(0);
  });
});

describe('one release per destination per date', () => {
  it('a cross-posted creative gets ONE release per platform, not one for both', () => {
    const res = twoProjectPlan({ automatable: { instagram: true, tiktok: true } });
    expect(res.feasible).toBe(true);
    for (const it of res.items) {
      const mine = res.releases.filter((r) => r.itemKey === it.key);
      expect(mine).toHaveLength(it.placements.length);
      expect(mine.length).toBeGreaterThan(1);
      expect(new Set(mine.map((r) => r.platform)).size).toBe(mine.length);
    }
  });

  it('release keys are unique and stable across destination and date', () => {
    const a = twoProjectPlan({ automatable: { instagram: true, tiktok: true } });
    const b = twoProjectPlan({ automatable: { instagram: true, tiktok: true } });
    const keys = a.releases.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(b.releases.map((r) => r.key));
  });

  it('the same creative released twice on one platform is two releases', () => {
    const item: PlannedItem = {
      key: 'i1', title: 't', contentTypeKey: 'post', bucket: 'post', projectId: 'p',
      workflowKey: 'post_std', priority: 1, needDay: '2026-10-12',
      requiredReadyAt: '2026-10-11', productionStart: '2026-10-05', stages: [],
      placements: [
        { platform: 'instagram', executionKey: 'e', plannedAt: '2026-10-12T10:00:00.000Z', day: '2026-10-12', batchKey: 'b1', slotIndex: 0, gridRow: null, gridCol: null },
        { platform: 'instagram', executionKey: 'e', plannedAt: '2026-11-12T10:00:00.000Z', day: '2026-11-12', batchKey: 'b2', slotIndex: 0, gridRow: null, gridCol: null },
      ],
    } as PlannedItem;
    const book = new CapacityBook(snapshot('2026-09-14'), CAL);
    const out = buildReleases([item], 'organic', { ...DEFAULT_PUBLISHING, automatable: { instagram: true } }, book, CAL);
    expect(out.releases).toHaveLength(2);
    expect(new Set(out.releases.map((r) => r.key)).size).toBe(2);
  });
});

describe('a task only when a person is needed', () => {
  it('a connected account that can publish needs nobody', () => {
    const res = twoProjectPlan({ automatable: { instagram: true, tiktok: true } });
    expect(res.releases.every((r) => r.needsPerson === false)).toBe(true);
    expect(res.releases.every((r) => r.reason === null)).toBe(true);
    expect(res.totals.releases.manual).toBe(0);
    expect(res.totals.releases.automatic).toBe(res.totals.releases.total);
  });

  it('an account that cannot publish needs a person, and says why', () => {
    const res = twoProjectPlan({ automatable: { instagram: true, tiktok: false } });
    const tiktok = res.releases.filter((r) => r.platform === 'tiktok');
    const instagram = res.releases.filter((r) => r.platform === 'instagram');
    expect(tiktok.every((r) => r.needsPerson && r.reason === 'account_not_connected')).toBe(true);
    expect(instagram.every((r) => !r.needsPerson)).toBe(true);
    expect(res.totals.releases.manual).toBe(tiktok.length);
  });

  it('an unknown platform is NOT automatable — never promise a publish nothing can do', () => {
    expect(releaseReason('x', { ...DEFAULT_PUBLISHING, automatable: {} }))
      .toBe('platform_not_automatable');
    expect(releaseReason('instagram', { ...DEFAULT_PUBLISHING, automatable: { instagram: true } }))
      .toBeNull();
  });

  it('the operator can keep an automatable platform manual on purpose', () => {
    const r = releaseReason('instagram', {
      ...DEFAULT_PUBLISHING, automatable: { instagram: true }, manualByPolicy: ['instagram'],
    });
    expect(r).toBe('manual_by_policy');
  });
});

describe('release load is charged to the publishing budget', () => {
  const withPublishing: PersonCapacity[] = TEAM.map((p) => (
    p.roles.includes('writer') ? { ...p, caps: { ...p.caps, publishing: 4 } } : p
  ));

  it('a manual release books the publishing bucket on its own day, never a production one', () => {
    const res = planCampaign(
      {
        campaignId: null, kind: 'organic',
        projects: [{ ...PROJECT_A, posts: 1, videos: 0 }],
        platforms: ['tiktok'], rangeStart: '2026-10-12', rangeEnd: '2026-10-20',
        frequency: [{ platform: 'tiktok', perDay: 1, weekdays: null }],
        crossPost: false, publishBufferDays: 1,
      },
      snapshot('2026-09-14', [], withPublishing),
      rules({ automatable: { tiktok: false } }),
    );
    expect(res.feasible).toBe(true);
    const manual = res.releases.filter((r) => r.needsPerson);
    expect(manual.length).toBe(1);
    const one = manual[0]!;
    expect(one.assigneeUserId).not.toBeNull();
    expect(one.workingDays).toBeGreaterThan(0);

    const cell = res.load.find((c) => c.bucket === 'publishing' && c.day === one.day);
    expect(cell?.proposed).toBeCloseTo(one.workingDays, 5);
    // And the release day itself carries no extra production load.
    const prodOnDay = res.load.filter((c) => c.day === one.day && (c.bucket === 'post' || c.bucket === 'video'));
    expect(prodOnDay.every((c) => c.proposed === 0)).toBe(true);
  });

  it('an automatic release costs nobody a slot-day', () => {
    const res = twoProjectPlan({ automatable: { instagram: true, tiktok: true } });
    expect(res.releases.every((r) => r.workingDays === 0)).toBe(true);
    expect(res.load.filter((c) => c.bucket === 'publishing' && c.proposed > 0)).toHaveLength(0);
  });

  it('no eligible publisher opens the task unassigned and NEVER makes the plan infeasible', () => {
    /*
     * A team where NOBODY can publish — built here ON PURPOSE.
     *
     * This test used to get that shape for free, because the shared fixture
     * gave nobody `publishing` capacity. That was not a deliberate scenario: it
     * MIRRORED a real defect. `BUCKETS` in snapshot.ts listed three of
     * `LoadBucket`'s four values, so `caps.publishing` was never computed for
     * anyone in production either — and this test's own comment recorded the
     * symptom ("three publish checks orphaned since 2026-09-12") as though it
     * were the intended behaviour. Fixed 2026-09-16; the fixture now carries the
     * `publishing: 8` four real people actually have.
     *
     * The path is still worth covering — an operator CAN leave a role with no
     * publishing budget — so the zero is now stated rather than inherited.
     */
    const base = snapshot('2026-09-14');
    const noPublishers = {
      ...base,
      people: base.people.map((p) => ({ ...p, caps: { ...p.caps, publishing: 0 } })),
    };
    const res = planCampaign(
      {
        campaignId: null, kind: 'organic',
        projects: [{ ...PROJECT_A, posts: 1, videos: 0 }],
        platforms: ['tiktok'], rangeStart: '2026-10-12', rangeEnd: '2026-10-20',
        frequency: [{ platform: 'tiktok', perDay: 1, weekdays: null }],
        crossPost: false, publishBufferDays: 1,
      },
      noPublishers,
      rules({ automatable: { tiktok: false } }),
    );
    expect(res.feasible).toBe(true);
    const manual = res.releases.filter((r) => r.needsPerson);
    expect(manual).toHaveLength(1);
    expect(manual[0]?.assigneeUserId).toBeNull();
    expect(res.conflicts.some((c) => c.stepKey === 'release')).toBe(true);
  });
});
