import { describe, it, expect } from 'vitest';
import { describeFrameOnDemand, INHERIT_MAX_DISTANCE, shouldInherit } from '../describeFrameOnDemand.js';
import { makeDb, makeFakeAi, makeFakeSb, unit, type Row } from './fakes.js';
import type { CvJob } from '../types.js';

const job = (frameId: string): CvJob => ({ id: 'j', kind: 'cv_describe_frame', videoId: 'v1', frameId, params: {}, attempts: 1, maxAttempts: 3 });
const repAnalysis = { description: 'facade', main_subject: 'villa', tags: ['shot_size:wide'], confidence: 0.9 };

function frame(id: string, vec: number[], extra: Partial<Row> = {}): Row {
  return { id, video_id: 'v1', shot_id: 's1', ts_ms: 0, is_keyframe: false, public_url: `https://x/${id}.webp`, ocr: null, labels: [], embedding: JSON.stringify(vec), analysis: null, dup_group_id: null, ...extra };
}

describe('shouldInherit', () => {
  it('inherits only when close AND the representative is described', () => {
    const near = unit(768, 0); near[1] = 0.1; // cos dist ≈ 0.005
    expect(shouldInherit({ embedding: near }, { embedding: unit(768, 0), analysis: repAnalysis as never }).inherit).toBe(true);
    expect(shouldInherit({ embedding: unit(768, 5) }, { embedding: unit(768, 0), analysis: repAnalysis as never })).toEqual({ inherit: false, distance: 1 });
    expect(shouldInherit({ embedding: near }, { embedding: unit(768, 0), analysis: null }).inherit).toBe(false);
    expect(shouldInherit({ embedding: null }, { embedding: unit(768, 0), analysis: repAnalysis as never })).toEqual({ inherit: false, distance: null });
    expect(INHERIT_MAX_DISTANCE).toBe(0.15);
  });
});

describe('describeFrameOnDemand', () => {
  it('copies the shot representative\'s analysis when the frame is near-identical — no paid call', async () => {
    const near = unit(768, 0); near[1] = 0.1;
    const d = makeDb({
      mkt_cv_frames: [frame('rep', unit(768, 0), { analysis: repAnalysis, is_keyframe: true }), frame('f2', near, { ts_ms: 500 })],
      mkt_cv_shots: [{ id: 's1', representative_frame_id: 'rep' }],
    }, () => ({ data: true, error: null }));
    const { ai, calls } = makeFakeAi();
    const r = await describeFrameOnDemand({ sb: makeFakeSb(d), ai }, job('f2'));
    expect(r.path).toBe('inherited');
    expect(r.representative_frame_id).toBe('rep');
    expect(r.distance).toBeLessThan(0.15);
    expect(calls).toHaveLength(0);
    expect(d.rpcCalls.map((c) => c.fn)).not.toContain('mkt_cv_cost_add');
    const f2 = d.tables.mkt_cv_frames![1]!;
    expect(f2.analysis).toMatchObject({ ...repAnalysis, inherited_from: 'rep' });
    expect(f2.described_at).toBeDefined();
  });

  it('prefers the dup-group representative over the shot\'s', async () => {
    const near = unit(768, 3); near[4] = 0.05;
    const d = makeDb({
      mkt_cv_frames: [frame('shotrep', unit(768, 0), { analysis: { description: 'shot rep' } }), frame('grouprep', unit(768, 3), { analysis: { description: 'group rep' } }), frame('f2', near, { dup_group_id: 'g1' })],
      mkt_cv_dup_groups: [{ id: 'g1', representative_frame_id: 'grouprep' }],
      mkt_cv_shots: [{ id: 's1', representative_frame_id: 'shotrep' }],
    }, () => ({ data: true, error: null }));
    const { ai } = makeFakeAi();
    const r = await describeFrameOnDemand({ sb: makeFakeSb(d), ai }, job('f2'));
    expect(r).toMatchObject({ path: 'inherited', representative_frame_id: 'grouprep' });
  });

  it('calls the model when the frame is materially different, and records the ledger row', async () => {
    const d = makeDb({
      mkt_cv_frames: [frame('rep', unit(768, 0), { analysis: repAnalysis }), frame('f2', unit(768, 9), { labels: ['light:night'] })],
      mkt_cv_shots: [{ id: 's1', representative_frame_id: 'rep' }],
    }, () => ({ data: true, error: null }));
    const { ai, calls } = makeFakeAi();
    const r = await describeFrameOnDemand({ sb: makeFakeSb(d), ai }, job('f2'));
    expect(r).toMatchObject({ path: 'described', representative_frame_id: 'rep', distance: 1, cost_usd: 0.01 });
    expect(calls).toEqual([expect.objectContaining({ role: 'frame_describer', images: 1 })]);
    expect(d.rpcCalls.map((c) => c.fn)).toEqual(['mkt_cv_budget_ok', 'mkt_cv_cost_add']);
    expect(d.rpcCalls[1]!.params).toMatchObject({ p_kind: 'describe_on_demand', p_video_id: 'v1', p_cost: 0.01 });
    const f2 = d.tables.mkt_cv_frames![1]!;
    expect((f2.analysis as { tags: string[] }).tags).toEqual(['shot_size:wide', 'setting:exterior_facade', 'light:night']);
  });

  it('is a no-op for a frame that is already described, and stops on budget', async () => {
    const d = makeDb({ mkt_cv_frames: [frame('f1', unit(768, 0), { analysis: repAnalysis })] });
    const { ai, calls } = makeFakeAi();
    expect((await describeFrameOnDemand({ sb: makeFakeSb(d), ai }, job('f1'))).path).toBe('already_described');
    expect(calls).toHaveLength(0);

    const d2 = makeDb({ mkt_cv_frames: [frame('f1', unit(768, 0))], mkt_cv_shots: [{ id: 's1', representative_frame_id: null }] }, (fn) => ({ data: fn === 'mkt_cv_budget_ok' ? false : null, error: null }));
    await expect(describeFrameOnDemand({ sb: makeFakeSb(d2), ai }, job('f1'))).rejects.toThrow(/^budget_exceeded:/);
    expect(d2.rpcCalls.map((c) => c.fn)).toEqual(['mkt_cv_budget_ok', 'mkt_alert_emit']);
  });
});
