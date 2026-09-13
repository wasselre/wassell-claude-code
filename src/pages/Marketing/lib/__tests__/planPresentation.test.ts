import { describe, it, expect } from 'vitest';
import type { LoadCell, PlanResult, PlannedCycle, PlannedItem } from '@/lib/marketingOS/scheduling';
import {
  buildLoadTable, buildPlanGrid, buildRefreshRows, alternativeOptions,
  creativeTotalsText, feasibilityVerdict, isOverCapacity, mergeLockedPlacements,
  parseCommitConflict, projectColorMap, resolveStepEffort, resolveUserCap,
  swapPlacements, weekendFromSettings,
} from '../planPresentation';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const emptyPlan = (over: Partial<PlanResult> = {}): PlanResult => ({
  feasible: true,
  infeasibleProof: null,
  searchIncomplete: false,
  searchStats: { expansions: 30, backtracks: 0, budget: 400_000 },
  items: [],
  batches: [],
  reservations: [],
  cycles: [],
  load: [],
  conflicts: [],
  totals: {
    items: 0, posts: 0, videos: 0, placements: 0, batches: 0,
    slotDaysByBucket: {}, perProject: [], perPlatform: [],
  },
  alternatives: { earliestFeasibleStart: null, earliestFeasibleEnd: null, maxItemsInRange: null },
  productionWindow: { start: null, end: null },
  snapshotHash: 'h',
  engineVersion: '1.0.0',
  ...over,
});

/** §22.1's six items: three projects × two batches on Instagram, 3 columns. */
const gridItem = (
  key: string, projectId: string, day: string, slotIndex: number, row: number, col: number,
): PlannedItem => ({
  key,
  title: `${projectId} ${key}`,
  contentTypeKey: 'post',
  bucket: 'post',
  projectId,
  projectName: projectId.toUpperCase(),
  workflowKey: 'post_std',
  needAt: `${day}T13:00:00.000Z`,
  requiredReadyAt: day,
  productionStart: day,
  priority: 1000 + slotIndex,
  stages: [],
  placements: [{
    platform: 'instagram',
    executionKey: 'exec:instagram',
    plannedAt: `${day}T13:00:00.000Z`,
    day,
    batchKey: `exec:instagram|${day}`,
    slotIndex,
    gridRow: row,
    gridCol: col,
  }],
});

const WORKED_EXAMPLE_ITEMS: PlannedItem[] = [
  gridItem('a:post:1', 'a', '2026-10-11', 0, 0, 0),
  gridItem('b:post:1', 'b', '2026-10-11', 1, 0, 1),
  gridItem('c:post:1', 'c', '2026-10-11', 2, 0, 2),
  gridItem('a:post:2', 'a', '2026-10-12', 0, 1, 0),
  gridItem('b:post:2', 'b', '2026-10-12', 1, 1, 1),
  gridItem('c:post:2', 'c', '2026-10-12', 2, 1, 2),
];

/* ------------------------------------------------------------------ */
/* 1. the three infeasibility wordings                                 */
/* ------------------------------------------------------------------ */

describe('feasibilityVerdict — the impossible / not-found distinction', () => {
  it('says "impossible" for a PROVEN time bound, in both languages', () => {
    const v = feasibilityVerdict(emptyPlan({ feasible: false, infeasibleProof: 'time_bound' }));
    expect(v.kind).toBe('time_bound');
    expect(v.tone).toBe('bad');
    expect(v.provenImpossible).toBe(true);
    expect(v.title.ar).toContain('مستحيل');
    expect(v.title.en.toLowerCase()).toContain('impossible');
    // It must say WHY: time, not capacity.
    expect(v.title.ar).toContain('الوقت');
    expect(v.title.en.toLowerCase()).toContain('time');
  });

  it('says "impossible" for a PROVEN capacity bound, naming capacity', () => {
    const v = feasibilityVerdict(emptyPlan({ feasible: false, infeasibleProof: 'capacity_bound' }));
    expect(v.kind).toBe('capacity_bound');
    expect(v.provenImpossible).toBe(true);
    expect(v.title.ar).toContain('مستحيل');
    expect(v.title.ar).toContain('السعة');
    expect(v.title.en.toLowerCase()).toContain('impossible');
    expect(v.title.en.toLowerCase()).toContain('capacity');
  });

  it('NEVER says "impossible" when the search merely ran out of budget', () => {
    const v = feasibilityVerdict(emptyPlan({
      feasible: false,
      infeasibleProof: null,
      searchIncomplete: true,
      searchStats: { expansions: 400_000, backtracks: 12, budget: 400_000 },
    }));
    expect(v.kind).toBe('not_found');
    expect(v.provenImpossible).toBe(false);
    // The exact wording the contract mandates.
    expect(v.title.ar).toContain('لم نعثر على جدول ضمن حدّ البحث');
    expect(v.title.ar).toContain('ليس إثباتًا بالاستحالة');
    expect(v.title.en).toContain('No schedule found within the search budget');
    expect(v.title.en).toContain('not proof that it is impossible');
    // The word "impossible" may appear ONLY inside that denial, never as a claim.
    expect(v.title.ar).not.toContain('مستحيل');
    expect(v.body.ar).not.toContain('مستحيل');
    expect(v.body.en.toLowerCase()).not.toContain('impossible');
    // Arabic-Indic digits for the expansion count.
    expect(v.body.ar).toContain('٤٠٠,٠٠٠');
  });

  it('flags a feasible-but-incomplete search without alarming', () => {
    const v = feasibilityVerdict(emptyPlan({ feasible: true, searchIncomplete: true }));
    expect(v.kind).toBe('feasible_incomplete');
    expect(v.tone).toBe('warn');
    expect(v.provenImpossible).toBe(false);
  });

  it('is plainly ok for a clean plan', () => {
    const v = feasibilityVerdict(emptyPlan());
    expect(v.kind).toBe('feasible');
    expect(v.tone).toBe('ok');
  });

  it('offers both alternatives as one-click actions when the engine found them', () => {
    const alts = alternativeOptions(emptyPlan({
      feasible: false,
      infeasibleProof: null,
      alternatives: {
        earliestFeasibleStart: '2026-10-18',
        earliestFeasibleEnd: '2026-10-25',
        maxItemsInRange: 4,
      },
    }), 6);
    expect(alts.map((a) => a.kind)).toEqual(['earliest_start', 'fewer_items']);
    expect(alts[0]?.rangeStart).toBe('2026-10-18');
    expect(alts[1]?.maxItems).toBe(4);
    expect(alts[1]?.detail.ar).toContain('٤');
  });

  it('does not offer "fewer items" when the cap is not actually fewer', () => {
    const alts = alternativeOptions(emptyPlan({
      alternatives: { earliestFeasibleStart: null, earliestFeasibleEnd: null, maxItemsInRange: 6 },
    }), 6);
    expect(alts).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. grid row / column mapping                                        */
/* ------------------------------------------------------------------ */

describe('buildPlanGrid — row/column mapping', () => {
  it('places §22.1 exactly as the engine assigned it (2 rows × 3 columns)', () => {
    const g = buildPlanGrid(WORKED_EXAMPLE_ITEMS, 'instagram');
    expect(g.columns).toBe(3);
    expect(g.rows).toHaveLength(2);
    expect(g.rows[0]?.map((c) => c?.itemKey)).toEqual(['a:post:1', 'b:post:1', 'c:post:1']);
    expect(g.rows[1]?.map((c) => c?.itemKey)).toEqual(['a:post:2', 'b:post:2', 'c:post:2']);
    // Every row of three holds three DIFFERENT projects — the operator's rule.
    for (const row of g.rows) {
      const projects = row.flatMap((c) => (c ? [c.projectId] : []));
      expect(new Set(projects).size).toBe(projects.length);
    }
  });

  it('reverses row ORDER for a newest-first feed without changing row indices', () => {
    const g = buildPlanGrid(WORKED_EXAMPLE_ITEMS, 'instagram', { newestFirst: true });
    expect(g.rows[0]?.[0]?.itemKey).toBe('a:post:2');
    expect(g.rows[0]?.[0]?.row).toBe(1);
    expect(g.rows[1]?.[0]?.itemKey).toBe('a:post:1');
  });

  it('ignores placements on other platforms', () => {
    const cross: PlannedItem = {
      ...gridItem('x:post:1', 'x', '2026-10-11', 0, 0, 0),
      placements: [{
        platform: 'tiktok', executionKey: 'exec:tiktok', plannedAt: '2026-10-11T19:00:00.000Z',
        day: '2026-10-11', batchKey: 'exec:tiktok|2026-10-11', slotIndex: 0, gridRow: null, gridCol: null,
      }],
    };
    const g = buildPlanGrid([...WORKED_EXAMPLE_ITEMS, cross], 'instagram');
    expect(g.cells).toHaveLength(6);
    expect(g.cells.some((c) => c.itemKey === 'x:post:1')).toBe(false);
  });

  it('derives a grid in publish order for a stream platform with no grid positions', () => {
    const stream: PlannedItem[] = ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'].map((day, i) => ({
      ...gridItem(`s:post:${i}`, `p${i}`, day, 0, 0, 0),
      placements: [{
        platform: 'tiktok', executionKey: 'exec:tiktok', plannedAt: `${day}T19:00:00.000Z`,
        day, batchKey: `exec:tiktok|${day}`, slotIndex: 0, gridRow: null, gridCol: null,
      }],
    }));
    const g = buildPlanGrid(stream, 'tiktok', { columns: 3 });
    expect(g.rows).toHaveLength(2);
    expect(g.rows[0]?.map((c) => c?.itemKey)).toEqual(['s:post:0', 's:post:1', 's:post:2']);
    // The tail row is padded, never short — the grid keeps its shape.
    expect(g.rows[1]).toHaveLength(3);
    expect(g.rows[1]?.[1]).toBeNull();
  });

  it('gives each project a stable colour index by first appearance', () => {
    const colors = projectColorMap(WORKED_EXAMPLE_ITEMS);
    expect(colors.get('a')).toBe(0);
    expect(colors.get('b')).toBe(1);
    expect(colors.get('c')).toBe(2);
    const g = buildPlanGrid(WORKED_EXAMPLE_ITEMS, 'instagram', { colors });
    expect(g.rows[1]?.[0]?.colorIndex).toBe(0); // a:post:2 is still project a's colour
  });

  it('swapping two cells pins BOTH sides', () => {
    const g = buildPlanGrid(WORKED_EXAMPLE_ITEMS, 'instagram');
    const locks = swapPlacements(g.cells, 'a:post:1', 'c:post:2', 'instagram');
    expect(locks).toEqual([
      { item_key: 'a:post:1', platform: 'instagram', day: '2026-10-12', index: 2 },
      { item_key: 'c:post:2', platform: 'instagram', day: '2026-10-11', index: 0 },
    ]);
    // A later swap of the same item replaces its lock, keeping the others.
    const merged = mergeLockedPlacements(locks, [
      { item_key: 'a:post:1', platform: 'instagram', day: '2026-10-11', index: 1 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((l) => l.item_key === 'a:post:1')?.index).toBe(1);
  });

  it('refuses to swap an item that is not on the grid', () => {
    const g = buildPlanGrid(WORKED_EXAMPLE_ITEMS, 'instagram');
    expect(swapPlacements(g.cells, 'a:post:1', 'nope', 'instagram')).toEqual([]);
    expect(swapPlacements(g.cells, 'a:post:1', 'a:post:1', 'instagram')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 3. the load table's over-capacity flag                              */
/* ------------------------------------------------------------------ */

const cell = (
  userId: string, day: string, bucket: LoadCell['bucket'],
  existing: number, proposed: number, capacity: number,
): LoadCell => ({ userId, day, bucket, existing, proposed, capacity });

describe('buildLoadTable — over-capacity is existing + proposed > capacity', () => {
  it('flags only the cells that actually exceed the cap', () => {
    const t = buildLoadTable([
      cell('m1', '2026-10-06', 'post', 2, 2, 4), // exactly at the cap → fine
      cell('m1', '2026-10-07', 'post', 3, 2, 4), // 5 of 4 → over
      cell('m2', '2026-10-06', 'post', 0, 1, 4),
    ]);
    expect(t.days).toEqual(['2026-10-06', '2026-10-07']);
    expect(t.overCells).toBe(1);
    const m1 = t.rows.find((r) => r.userId === 'm1');
    expect(m1?.anyOver).toBe(true);
    expect(m1?.cells.map((c) => c.over)).toEqual([false, true]);
    expect(t.rows.find((r) => r.userId === 'm2')?.anyOver).toBe(false);
  });

  it('treats a half-slot sum at the cap as within it (no float noise)', () => {
    expect(isOverCapacity({ existing: 0.5 + 0.5 + 0.5, proposed: 1.5, capacity: 3 })).toBe(false);
    expect(isOverCapacity({ existing: 3, proposed: 0.5, capacity: 3 })).toBe(true);
  });

  it('drops untouched people but keeps anyone this plan pushes over', () => {
    const t = buildLoadTable([
      cell('idle', '2026-10-06', 'post', 1, 0, 4),      // nothing proposed, within cap → hidden
      cell('busted', '2026-10-06', 'approvals', 21, 0, 20), // already over, no proposal → kept
      cell('w', '2026-10-06', 'post', 0, 2, 10),
    ]);
    expect(t.rows.map((r) => r.userId).sort()).toEqual(['busted', 'w']);
  });

  it('sorts rows by person then bucket (post, video, approvals)', () => {
    const t = buildLoadTable([
      cell('w', '2026-10-06', 'approvals', 0, 1, 20),
      cell('w', '2026-10-06', 'video', 0, 1, 4),
      cell('w', '2026-10-06', 'post', 0, 1, 10),
    ]);
    expect(t.rows.map((r) => r.bucket)).toEqual(['post', 'video', 'approvals']);
  });

  it('sorts each row’s cells by day even when the engine emitted them out of order', () => {
    const t = buildLoadTable([
      cell('m1', '2026-10-08', 'post', 0, 1, 4),
      cell('m1', '2026-10-06', 'post', 0, 1, 4),
    ]);
    expect(t.rows[0]?.cells.map((c) => c.day)).toEqual(['2026-10-06', '2026-10-08']);
  });
});

/* ------------------------------------------------------------------ */
/* 4. the refresh forecast and its totals                              */
/* ------------------------------------------------------------------ */

/** §22.2 — a 30-day Meta campaign from 2026-10-01, policy A, weekly cycle. */
const CYCLES_22_2: PlannedCycle[] = [
  { executionKey: 'exec:meta', round: 0, refreshOn: '2026-10-01', readyBy: '2026-09-30', productionStartOn: '2026-09-23', decisionDueOn: null, produced: 5, bankedSpareSlotId: null, note: 'launch slate' },
  { executionKey: 'exec:meta', round: 1, refreshOn: '2026-10-08', readyBy: '2026-10-07', productionStartOn: '2026-09-30', decisionDueOn: '2026-10-07', produced: 5, bankedSpareSlotId: null, note: '4 replacements + 1 fifth' },
  { executionKey: 'exec:meta', round: 2, refreshOn: '2026-10-15', readyBy: '2026-10-14', productionStartOn: '2026-10-07', decisionDueOn: '2026-10-14', produced: 5, bankedSpareSlotId: null, note: '4 replacements + 1 fifth' },
  { executionKey: 'exec:meta', round: 3, refreshOn: '2026-10-22', readyBy: '2026-10-21', productionStartOn: '2026-10-14', decisionDueOn: '2026-10-21', produced: 5, bankedSpareSlotId: null, note: '4 replacements + 1 fifth' },
  { executionKey: 'exec:meta', round: 4, refreshOn: '2026-10-29', readyBy: null, productionStartOn: null, decisionDueOn: null, produced: 0, bankedSpareSlotId: null, note: 'skipped' },
];

describe('buildRefreshRows / creativeTotalsText — §22.2', () => {
  it('reproduces the worked example’s days-left column', () => {
    const rows = buildRefreshRows(CYCLES_22_2, '2026-10-30');
    expect(rows.map((r) => r.daysLeft)).toEqual([30, 23, 16, 9, 2]);
    expect(rows.map((r) => r.produced)).toEqual([5, 5, 5, 5, 0]);
  });

  it('labels the launch and explains the skipped final refresh in plain words', () => {
    const rows = buildRefreshRows(CYCLES_22_2, '2026-10-30');
    expect(rows[0]?.label.ar).toBe('الإطلاق');
    expect(rows[0]?.label.en).toBe('Launch');
    expect(rows[1]?.label.ar).toBe('التحديث ١');
    expect(rows[1]?.label.en).toBe('Refresh 1');
    const skipped = rows[4];
    expect(skipped?.skipped).toBe(true);
    expect(skipped?.note.ar).toContain('متخطّى');
    expect(skipped?.note.ar).toContain('٢');
    expect(skipped?.note.en).toContain('only 2 day');
  });

  it('names a banked spare on the cycle that may draw on it', () => {
    const withBank = CYCLES_22_2.map((c) => (
      c.round === 3 ? { ...c, produced: 4, bankedSpareSlotId: 'abcdef12-0000-0000-0000-000000000000' } : c
    ));
    const rows = buildRefreshRows(withBank, '2026-10-30');
    expect(rows[3]?.note.ar).toContain('احتياطي');
    expect(rows[3]?.note.en).toContain('banked spare');
  });

  it('formats policy A’s 20 creatives with Arabic-Indic digits', () => {
    const text = creativeTotalsText(
      { initial: 5, replacements: 12, fifths: 3, total: 20, cycles: 3 }, true,
    );
    expect(text).toBe('٢٠ تصميمًا = ٥ إطلاق + ١٢ بديلًا + ٣ خامس · عبر ٣ تحديثات');
    expect(text).not.toMatch(/[0-9]/);
  });

  it('formats policy B’s 17 creatives in English and omits the empty fifths term', () => {
    const text = creativeTotalsText(
      { initial: 5, replacements: 12, fifths: 0, total: 17, cycles: 3 }, false,
    );
    expect(text).toBe('17 creatives = 5 launch + 12 replacements · across 3 refreshes');
  });

  it('renders a dash rather than zeros when a plan carries no creative forecast', () => {
    expect(creativeTotalsText(undefined, true)).toBe('—');
  });
});

/* ------------------------------------------------------------------ */
/* 5. the 409 commit conflict                                          */
/* ------------------------------------------------------------------ */

describe('parseCommitConflict', () => {
  const body = {
    error: 'plan_changed',
    error_ar: 'تغيّر الحمل أثناء المراجعة: تحرّك ٢ بندًا.',
    error_en: 'The workload changed while you were reviewing: 2 item(s) moved.',
    diff: [{ item: 'a:post:1|design', was: 'm1 2026-10-06→2026-10-07', now: 'm2 2026-10-07→2026-10-08' }],
    plan: null,
  };

  it('reads the JSON-string body the server nests inside payload.error', () => {
    const c = parseCommitConflict({ status: 409, payload: { error: JSON.stringify(body) } });
    expect(c?.kind).toBe('plan_changed');
    expect(c?.diff).toHaveLength(1);
    expect(c?.message.en).toContain('2 item(s) moved');
  });

  it('reads a capacity conflict and keeps both languages', () => {
    const c = parseCommitConflict({
      status: 409,
      payload: { error: JSON.stringify({ error: 'capacity_conflict', detail: 'over cap' }) },
    });
    expect(c?.kind).toBe('capacity_conflict');
    expect(c?.message.ar).toContain('السعة');
    expect(c?.message.en.toLowerCase()).toContain('capacity');
  });

  it('returns null for anything that is not one of the two planned conflicts', () => {
    expect(parseCommitConflict({ status: 500, payload: { error: 'boom' } })).toBeNull();
    expect(parseCommitConflict({ status: 409, payload: { error: 'plan is approved' } })).toBeNull();
    expect(parseCommitConflict(new Error('network'))).toBeNull();
    expect(parseCommitConflict(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 6. reading the live capacity configuration                          */
/* ------------------------------------------------------------------ */

describe('resolveStepEffort — stored values beat seeds, seeds are labelled', () => {
  const rows = [
    { workflow_key: 'post_std', step_key: 'design', bucket: 'post', working_days: 3 },
    { workflow_key: 'post_std', step_key: 'writing', bucket: '*', working_days: 1.5 },
    { workflow_key: 'video_std', step_key: 'editing', bucket: 'video', working_days: 4 },
  ];

  it('prefers the bucket-specific row', () => {
    expect(resolveStepEffort(rows, 'post_std', 'design', 'post', 2))
      .toEqual({ value: 3, source: 'stored' });
  });

  it('falls back to the wildcard row', () => {
    expect(resolveStepEffort(rows, 'post_std', 'writing', 'post', 1))
      .toEqual({ value: 1.5, source: 'stored' });
  });

  it('falls back to the engine seed and says so when nothing is stored', () => {
    expect(resolveStepEffort(rows, 'post_std', 'design_review', 'post', 1))
      .toEqual({ value: 1, source: 'default' });
    // A row for the same step on a DIFFERENT workflow must not leak across.
    expect(resolveStepEffort(rows, 'post_std', 'editing', 'post', 2))
      .toEqual({ value: 2, source: 'default' });
  });
});

describe('resolveUserCap — an override is a decision, a role cap is inherited', () => {
  const overrides = [{ user_id: 'u1', bucket: 'post', daily_slots: 6 }];

  it('reports an override as stored', () => {
    expect(resolveUserCap(overrides, 'u1', 'post', 10)).toEqual({ value: 6, source: 'stored' });
  });

  it('reports the resolved role cap as a default', () => {
    expect(resolveUserCap(overrides, 'u1', 'video', 4)).toEqual({ value: 4, source: 'default' });
    expect(resolveUserCap(overrides, 'u2', 'post', 10)).toEqual({ value: 10, source: 'default' });
  });

  it('keeps a deliberate zero override rather than reading it as absent', () => {
    expect(resolveUserCap([{ user_id: 'u1', bucket: 'video', daily_slots: 0 }], 'u1', 'video', 4))
      .toEqual({ value: 0, source: 'stored' });
  });
});

describe('weekendFromSettings', () => {
  it('reads a valid weekday list', () => {
    expect(weekendFromSettings({ weekend_days: [5, 6] })).toEqual([5, 6]);
    expect(weekendFromSettings({ weekend_days: [] })).toEqual([]);
  });

  it('refuses anything that is not a clean weekday list, so the caller falls back', () => {
    expect(weekendFromSettings({})).toBeNull();
    expect(weekendFromSettings({ weekend_days: 'friday' })).toBeNull();
    expect(weekendFromSettings({ weekend_days: [5, 9] })).toBeNull();
  });
});
