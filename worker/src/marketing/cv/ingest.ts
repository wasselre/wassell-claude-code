// ============================================================================
// Chunked manifest ingest (contracts §1.3). A manifest with 2,000 frames × 768
// floats is ~15 MB of JSON — it must not travel in one RPC call. Order:
//
//   1. mkt_cv_ingest_manifest(video + shots)      — header + shots, status→processing
//   2. mkt_cv_ingest_frames(chunk) × N            — ≤ FRAME_CHUNK frames per call
//   3. mkt_cv_finalize_video(groups, keyframes)   — dup groups, representatives,
//                                                    counts, status→frames_done, cost
//
// Every step is an idempotent upsert, so a job that dies between steps simply
// re-runs from the top on its next attempt. The pure builders are exported for
// tests; ingestManifest() is the only I/O.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CvManifest, FinalizeGroup, ManifestFrame, ShotKeyframes } from './types.js';

/** Under the RPC's ≤ 200 ceiling with headroom for PostgREST body limits. */
export const FRAME_CHUNK = 150;

export function chunkFrames(frames: readonly ManifestFrame[], size = FRAME_CHUNK): ManifestFrame[][] {
  if (size <= 0 || size > 200) throw new Error(`chunkFrames: size must be 1..200, got ${size}`);
  const out: ManifestFrame[][] = [];
  for (let i = 0; i < frames.length; i += size) out.push(frames.slice(i, i + size));
  return out;
}

/**
 * Finalize wants each dup group WITH its member timestamps; the manifest lists
 * groups without members and tags each frame with `dup_group`. Join them here.
 * A group the manifest lists but no frame references is still written (size
 * from the manifest) so the representative is recorded.
 */
export function buildDupGroups(manifest: Pick<CvManifest, 'frames' | 'dup_groups'>): FinalizeGroup[] {
  const members = new Map<number, number[]>();
  for (const f of manifest.frames) {
    if (f.dup_group == null) continue;
    const list = members.get(f.dup_group) ?? [];
    list.push(f.ts_ms);
    members.set(f.dup_group, list);
  }
  const out: FinalizeGroup[] = [];
  const listed = new Set<number>();
  for (const g of manifest.dup_groups ?? []) {
    listed.add(g.group);
    const m = (members.get(g.group) ?? []).slice().sort((a, b) => a - b);
    out.push({ group: g.group, representative_ts_ms: g.representative_ts_ms, members_ts_ms: m, size: Math.max(g.size ?? m.length, m.length) });
  }
  // Frames referencing a group the manifest forgot to list: representative =
  // earliest member, so nothing is silently dropped.
  for (const [group, m] of members) {
    if (listed.has(group)) continue;
    const sorted = m.slice().sort((a, b) => a - b);
    out.push({ group, representative_ts_ms: sorted[0]!, members_ts_ms: sorted, size: sorted.length });
  }
  return out.sort((a, b) => a.group - b.group);
}

export function buildShotKeyframes(manifest: Pick<CvManifest, 'shots'>): ShotKeyframes[] {
  return manifest.shots.map((s) => {
    const keys = Array.isArray(s.keyframe_ts_ms) ? s.keyframe_ts_ms.slice() : [];
    // The representative is always a keyframe — the contact sheet and the
    // search thumbnail both rely on it having been described.
    if (!keys.includes(s.representative_ts_ms)) keys.push(s.representative_ts_ms);
    return { shot_no: s.shot_no, representative_ts_ms: s.representative_ts_ms, keyframe_ts_ms: keys.sort((a, b) => a - b) };
  });
}

export interface IngestResult { shots: number; frames: number; keyframes: number; chunks: number }

export async function ingestManifest(sb: SupabaseClient, videoId: string, manifest: CvManifest, chunkSize = FRAME_CHUNK): Promise<IngestResult> {
  // 1. header + shots (frames deliberately NOT included — they go in chunks)
  const { data: head, error: headErr } = await sb.rpc('mkt_cv_ingest_manifest', {
    p_video_id: videoId,
    p_manifest: { video: manifest.video, shots: manifest.shots },
  });
  if (headErr) throw new Error(`ingest: mkt_cv_ingest_manifest failed: ${headErr.message}`);
  const shots = Number((head as { shots?: number } | null)?.shots ?? manifest.shots.length);

  // 2. frames in chunks
  let frames = 0;
  const chunks = chunkFrames(manifest.frames, chunkSize);
  for (const [i, c] of chunks.entries()) {
    const { data, error } = await sb.rpc('mkt_cv_ingest_frames', { p_video_id: videoId, p_frames: c });
    if (error) throw new Error(`ingest: mkt_cv_ingest_frames chunk ${i + 1}/${chunks.length} failed: ${error.message}`);
    frames += Number((data as { frames?: number } | null)?.frames ?? c.length);
  }

  // 3. finalize
  const { data: fin, error: finErr } = await sb.rpc('mkt_cv_finalize_video', {
    p_video_id: videoId,
    p_groups: buildDupGroups(manifest),
    p_shot_keyframes: buildShotKeyframes(manifest),
    p_cost_usd: manifest.cost_usd ?? 0,
  });
  if (finErr) throw new Error(`ingest: mkt_cv_finalize_video failed: ${finErr.message}`);
  const f = (fin ?? {}) as { shots?: number; frames?: number; keyframes?: number };
  return { shots: Number(f.shots ?? shots), frames: Number(f.frames ?? frames), keyframes: Number(f.keyframes ?? 0), chunks: chunks.length };
}
