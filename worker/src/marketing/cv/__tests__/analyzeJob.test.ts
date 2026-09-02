import { describe, it, expect } from 'vitest';
import { buildStructure, microSummary, runCvAnalyzeJob } from '../runCvAnalyzeJob.js';
import { makeDb, makeFakeAi, makeFakeSb, unit, type Row } from './fakes.js';
import type { CvJob } from '../types.js';

const VIDEO = 'v1';
const job: CvJob = { id: 'j1', kind: 'cv_analyze', videoId: VIDEO, frameId: null, params: {}, attempts: 1, maxAttempts: 3 };

function shot(no: number, extra: Partial<Row> = {}): Row {
  return { id: `s${no}`, video_id: VIDEO, shot_no: no, start_ms: no * 3000, end_ms: no * 3000 + 3000, duration_ms: 3000, transition_in: 'cut', transition_out: 'cut', is_static: false, is_micro: false, internal_change: false, edit_pace_local: 20, representative_frame_id: `f${no}a`, keyframe_ids: [`f${no}a`, `f${no}b`], summary: null, analysis: null, analysis_status: 'pending', ...extra };
}
function frame(id: string, shotNo: number, ts: number, at: number): Row {
  return { id, video_id: VIDEO, shot_id: `s${shotNo}`, ts_ms: ts, is_keyframe: true, public_url: `https://x/${id}.webp`, ocr: { text: `OCR ${id}` }, labels: ['light:day'], embedding: JSON.stringify(unit(768, at)), analysis: null };
}
function db(opts: { budgetOkTimes?: number; shots?: Row[] } = {}) {
  let budgetChecks = 0;
  const shots = opts.shots ?? [shot(0), shot(1), shot(2)];
  const frames = shots.flatMap((s) => [frame(`f${s.shot_no}a`, s.shot_no as number, (s.start_ms as number) + 500, 1), frame(`f${s.shot_no}b`, s.shot_no as number, (s.start_ms as number) + 2000, 2)]);
  return makeDb({
    mkt_cv_videos: [{ id: VIDEO, content_media_id: 'cm1', content_post_id: 'cp1', organization_id: 'o1', owner: 'competitor', wassel_asset_id: null, source_url: 'https://x/v.mp4', duration_ms: 9000, status: 'frames_done', shot_count: shots.length, error: null }],
    mkt_cv_shots: shots,
    mkt_cv_frames: frames,
    mkt_transcripts: [{ content_media_id: 'cm1', status: 'done', language: 'ar', segments: [{ start_ms: 0, end_ms: 4000, text: 'مرحبا بكم' }], text: 'مرحبا بكم', created_at: '2026-01-01' }],
    mkt_content_enrichment: [{ content_post_id: 'cp1', result: { content_type: 'project_launch', campaign_message: 'launch offer' } }],
  }, (fn) => {
    if (fn === 'mkt_cv_budget_ok') { budgetChecks++; return { data: opts.budgetOkTimes === undefined || budgetChecks <= opts.budgetOkTimes, error: null }; }
    return { data: null, error: null };
  });
}

describe('runCvAnalyzeJob', () => {
  it('describes keyframes, analyses each shot, embeds, and finalises the video with a structure', async () => {
    const d = db();
    const { ai, calls } = makeFakeAi();
    const r = await runCvAnalyzeJob({ sb: makeFakeSb(d), ai }, job);
    expect(r.status).toBe('analyzed');
    expect(r.shots_done).toBe(3);
    expect(r.frames_described).toBe(6);
    // per shot: 1 frame_describer (2 images) + 1 shot_analyzer (2 images) + 1 embed_text
    expect(calls.filter((c) => c.role === 'frame_describer')).toHaveLength(3);
    expect(calls.filter((c) => c.role === 'shot_analyzer')).toHaveLength(3);
    expect(calls.filter((c) => c.role === 'embed_text')).toHaveLength(3);
    expect(calls.find((c) => c.role === 'shot_analyzer')!.images).toBe(2);
    // shot row: validated tags (bogus dropped, purpose mirrored), both embeddings, transcript aligned
    const s0 = d.tables.mkt_cv_shots![0]!;
    expect(s0.analysis_status).toBe('done');
    expect(s0.tags).toEqual(['motion:drone', 'setting:exterior_facade', 'purpose:hook', 'reproducibility:moderate']);
    expect((s0.embedding_text as number[]).length).toBe(1024);
    expect((s0.embedding_visual as number[]).length).toBe(768);
    expect((s0.embedding_visual as number[])[1]).toBeCloseTo(0.5); // mean of e1 and e2
    expect(s0.transcript_text).toBe('مرحبا بكم');
    expect(s0.ocr_text).toBe('OCR f0a\nOCR f0b');
    expect(String(s0.summary)).toContain('Aerial reveal');
    // frame rows carry analysis + zero-shot labels merged into tags
    const f0 = d.tables.mkt_cv_frames![0]!;
    expect((f0.analysis as { tags: string[] }).tags).toEqual(['shot_size:wide', 'setting:exterior_facade', 'light:day']);
    expect((f0.analysis as { rejected_tags: string[] }).rejected_tags).toEqual(['setting:garden']);
    // ledger: one row per paid call (3 frame batches + 3 shots)
    expect(d.rpcCalls.filter((c) => c.fn === 'mkt_cv_cost_add')).toHaveLength(6);
    // video finalised
    const v = d.tables.mkt_cv_videos![0]!;
    expect(v.status).toBe('analyzed');
    expect(v.analysis_version).toBe('cv-analysis-1');
    expect((v.structure as { purposes: string[] }).purposes).toEqual(['hook', 'hook', 'hook']);
    expect((v.structure as { purpose_sequence: string[] }).purpose_sequence).toEqual(['hook']);
    expect((v.structure as { pace_cuts_per_min: number }).pace_cuts_per_min).toBeCloseTo(13.3, 1);
  });

  it('stops on budget_exceeded, keeping finished shots and leaving the rest pending', async () => {
    // Shot 0 needs 2 checks (frames + shot pass); the 3rd check (shot 1) fails.
    const d = db({ budgetOkTimes: 2 });
    const { ai, calls } = makeFakeAi();
    await expect(runCvAnalyzeJob({ sb: makeFakeSb(d), ai }, job)).rejects.toThrow(/^budget_exceeded:/);
    const shots = d.tables.mkt_cv_shots!;
    expect(shots.map((s) => s.analysis_status)).toEqual(['done', 'pending', 'pending']);
    expect(calls.filter((c) => c.role === 'shot_analyzer')).toHaveLength(1);
    // one deduped alert, video left at 'analyzing' with the reason, NOT finalised
    expect(d.rpcCalls.filter((c) => c.fn === 'mkt_alert_emit')).toHaveLength(1);
    const v = d.tables.mkt_cv_videos![0]!;
    expect(v.status).toBe('analyzing');
    expect(String(v.error)).toMatch(/^budget_exceeded:/);
    expect(v.analyzed_at).toBeUndefined();
  });

  it('closes micro shots without a model call and marks a failed shot without sinking the video', async () => {
    const d = db({ shots: [shot(0), shot(1, { is_micro: true, end_ms: 3200, duration_ms: 200 }), shot(2)] });
    const { ai, calls } = makeFakeAi({ failRole: 'shot_analyzer' });
    const r = await runCvAnalyzeJob({ sb: makeFakeSb(d), ai }, job);
    expect(r.shots_micro).toBe(1);
    expect(r.shots_failed).toBe(2);
    expect(r.status).toBe('partial');
    const shots = d.tables.mkt_cv_shots!;
    expect(shots[1]!.analysis_status).toBe('done');
    expect(String(shots[1]!.summary)).toContain('Micro shot');
    expect(shots[0]!.analysis_status).toBe('failed');
    expect(String(shots[0]!.analysis_error)).toMatch(/^provider:/);
    // micro shot never reached the LLM; its visual vector still came from its frames
    expect(calls.filter((c) => c.role === 'shot_analyzer')).toHaveLength(2);
    expect((shots[1]!.embedding_visual as number[]).length).toBe(768);
    expect(d.tables.mkt_cv_videos![0]!.status).toBe('partial');
  });

  it('skips shots already done (resume) and refuses a video whose frames are not ingested', async () => {
    const d = db({ shots: [shot(0, { analysis_status: 'done', summary: 'prev' }), shot(1)] });
    const { ai, calls } = makeFakeAi();
    const r = await runCvAnalyzeJob({ sb: makeFakeSb(d), ai }, job);
    expect(r.shots_skipped).toBe(1);
    expect(r.shots_done).toBe(1);
    expect(calls.filter((c) => c.role === 'shot_analyzer')).toHaveLength(1);
    expect(calls.find((c) => c.role === 'shot_analyzer')!.user).toContain('Previous shot: prev');

    const d2 = db();
    d2.tables.mkt_cv_videos![0]!.status = 'queued';
    await expect(runCvAnalyzeJob({ sb: makeFakeSb(d2), ai }, job)).rejects.toThrow(/^permanent:/);
  });
});

describe('buildStructure / microSummary', () => {
  it('collapses purposes run-length and counts states', () => {
    const s = buildStructure([
      { is_micro: false, analysis_status: 'done', analysis: { purpose: 'hook' } as never, duration_ms: 1000 },
      { is_micro: true, analysis_status: 'done', analysis: null, duration_ms: 200 },
      { is_micro: false, analysis_status: 'done', analysis: { purpose: 'hook' } as never, duration_ms: 1000 },
      { is_micro: false, analysis_status: 'failed', analysis: null, duration_ms: 1000 },
      { is_micro: false, analysis_status: 'done', analysis: { purpose: 'cta' } as never, duration_ms: 1000 },
    ], 30000);
    expect(s).toMatchObject({ shot_count: 5, micro_count: 1, analyzed_count: 3, failed_count: 1, purposes: ['hook', 'hook', 'cta'], purpose_sequence: ['hook', 'cta'], pace_cuts_per_min: 8 });
    expect(buildStructure([], null).pace_cuts_per_min).toBeNull();
  });
  it('writes a bilingual micro summary from neighbours', () => {
    const s = microSummary({ duration_ms: 200, transition_in: 'cut', transition_out: 'fade' } as never, 'A\nB', null);
    expect(s).toContain('لقطة خاطفة');
    expect(s).toContain('after: A');
  });
});
