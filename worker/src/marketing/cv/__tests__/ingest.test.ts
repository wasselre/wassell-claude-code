import { describe, it, expect } from 'vitest';
import { buildDupGroups, buildShotKeyframes, chunkFrames, FRAME_CHUNK, ingestManifest } from '../ingest.js';
import { makeDb, makeFakeSb } from './fakes.js';
import type { CvManifest, ManifestFrame } from '../types.js';

function manifest(frameCount: number): CvManifest {
  const frames: ManifestFrame[] = Array.from({ length: frameCount }, (_, i) => ({
    ts_ms: i * 500, shot_no: Math.floor(i / 10), is_boundary: i % 10 === 0, phash: `h${i}`, dup_group: i % 3 === 0 ? Math.floor(i / 3) : null,
    storage_path: `content/frame/v1/${String(i * 500).padStart(7, '0')}.webp`, public_url: `https://x/${i}.webp`, width: 512, height: 910, bytes: 1000,
    quality: { blur: 0.1, dark: 0.1 }, ocr: { text: '', lang: null, boxes: [], inherited_from_ts_ms: null }, labels: [], embedding: [0.1, 0.2],
  }));
  const shotCount = Math.ceil(frameCount / 10);
  return {
    video: { duration_ms: frameCount * 500, fps: 30, width: 1080, height: 1920, detector_version: 'psd-adaptive-1', embedding_version: 'siglip2-b16-256-1' },
    shots: Array.from({ length: shotCount }, (_, s) => ({ shot_no: s, start_ms: s * 5000, end_ms: (s + 1) * 5000, transition_in: s === 0 ? 'start' : 'cut', transition_out: s === shotCount - 1 ? 'end' : 'cut', is_static: false, internal_change: false, representative_ts_ms: s * 5000 + 2500, keyframe_ts_ms: [s * 5000] })),
    frames,
    dup_groups: [{ group: 0, representative_ts_ms: 0, size: 3 }],
    cost_usd: 0.02,
  };
}

describe('manifest chunking', () => {
  it('splits frames into ≤ FRAME_CHUNK batches, order preserved', () => {
    const chunks = chunkFrames(manifest(320).frames);
    expect(chunks.map((c) => c.length)).toEqual([150, 150, 20]);
    expect(chunks[1]![0]!.ts_ms).toBe(150 * 500);
    expect(FRAME_CHUNK).toBeLessThanOrEqual(200);
  });
  it('refuses a chunk larger than the RPC ceiling', () => {
    expect(() => chunkFrames([], 201)).toThrow(/1\.\.200/);
  });
  it('joins dup-group members from the frames and never drops an unlisted group', () => {
    const groups = buildDupGroups(manifest(12));
    // frames 0,3,6,9 → groups 0,1,2,3; only group 0 is listed by the manifest
    expect(groups.map((g) => g.group)).toEqual([0, 1, 2, 3]);
    expect(groups[0]).toEqual({ group: 0, representative_ts_ms: 0, members_ts_ms: [0], size: 3 });
    expect(groups[1]).toEqual({ group: 1, representative_ts_ms: 1500, members_ts_ms: [1500], size: 1 });
  });
  it('always includes the representative among a shot\'s keyframes', () => {
    const k = buildShotKeyframes(manifest(10));
    expect(k).toEqual([{ shot_no: 0, representative_ts_ms: 2500, keyframe_ts_ms: [0, 2500] }]);
  });
});

describe('ingestManifest call ordering', () => {
  it('calls header → frame chunks → finalize, with frames kept OUT of the header', async () => {
    const db = makeDb({}, (fn) => {
      if (fn === 'mkt_cv_ingest_manifest') return { data: { shots: 32 }, error: null };
      if (fn === 'mkt_cv_ingest_frames') return { data: { frames: 0 }, error: null };
      if (fn === 'mkt_cv_finalize_video') return { data: { shots: 32, frames: 320, keyframes: 64 }, error: null };
      return { data: null, error: null };
    });
    const sb = makeFakeSb(db);
    const m = manifest(320);
    const r = await ingestManifest(sb, 'v1', m);
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(['mkt_cv_ingest_manifest', 'mkt_cv_ingest_frames', 'mkt_cv_ingest_frames', 'mkt_cv_ingest_frames', 'mkt_cv_finalize_video']);
    const header = db.rpcCalls[0]!.params.p_manifest as Record<string, unknown>;
    expect(header).toHaveProperty('video');
    expect(header).toHaveProperty('shots');
    expect(header).not.toHaveProperty('frames');
    const sizes = db.rpcCalls.slice(1, 4).map((c) => (c.params.p_frames as unknown[]).length);
    expect(sizes).toEqual([150, 150, 20]);
    const fin = db.rpcCalls[4]!.params;
    expect(fin.p_video_id).toBe('v1');
    expect(fin.p_cost_usd).toBe(0.02);
    expect((fin.p_shot_keyframes as unknown[]).length).toBe(32);
    expect(r).toEqual({ shots: 32, frames: 320, keyframes: 64, chunks: 3 });
  });

  it('stops at the first failing chunk and names it', async () => {
    const db = makeDb({}, (fn, _p, calls) => {
      if (fn === 'mkt_cv_ingest_frames' && calls.filter((c) => c.fn === fn).length === 2) return { data: null, error: { message: 'payload too large' } };
      return { data: null, error: null };
    });
    await expect(ingestManifest(makeFakeSb(db), 'v1', manifest(320))).rejects.toThrow(/chunk 2\/3 failed: payload too large/);
    expect(db.rpcCalls.map((c) => c.fn)).not.toContain('mkt_cv_finalize_video');
  });
});
