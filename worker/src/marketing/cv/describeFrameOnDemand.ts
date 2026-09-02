// ============================================================================
// cv_describe_frame job: describe ONE non-keyframe on demand. The API enqueues
// it whenever a user opens a frame whose `analysis` is null — it cannot compute
// vector distance through PostgREST — so the "is this frame materially
// different?" decision is made HERE:
//
//   1. load the frame's SigLIP vector + its representative (the dup-group
//      representative when it belongs to one, else the shot's representative)
//   2. cosine distance ≤ INHERIT_MAX_DISTANCE and the representative is already
//      described → COPY that analysis (`inherited_from` = representative id),
//      no paid call
//   3. otherwise → one frame_describer call, ledger kind 'describe_on_demand'
//
// The job result records which path was taken.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CvAi, CvFrameRow, CvJob, FrameAnalysis } from './types.js';
import { FRAME_DESCRIBER_SYSTEM, FRAME_SCHEMA, toFrameAnalysis, type FrameDescriberEntry } from './analyzeFrames.js';
import { addCost, checkBudget, stampOf } from './ledger.js';
import { cosineDistance, parseVector } from './embeddings.js';

export interface DescribeFrameDeps { sb: SupabaseClient; ai: CvAi }
export type DescribePath = 'already_described' | 'inherited' | 'described';
export interface DescribeFrameResult { frame_id: string; path: DescribePath; representative_frame_id: string | null; distance: number | null; cost_usd: number }

/** Cosine distance at or below which a frame is "the same picture" as its representative. */
export const INHERIT_MAX_DISTANCE = 0.15;

const FRAME_COLS = 'id, video_id, shot_id, ts_ms, is_keyframe, public_url, ocr, labels, embedding, analysis, dup_group_id';
type FrameWithGroup = CvFrameRow & { dup_group_id: string | null };

async function loadFrame(sb: SupabaseClient, frameId: string): Promise<FrameWithGroup | null> {
  const { data, error } = await sb.from('mkt_cv_frames').select(FRAME_COLS).eq('id', frameId).maybeSingle();
  if (error) throw new Error(`load frame ${frameId} failed: ${error.message}`);
  return (data as FrameWithGroup | null) ?? null;
}

/** The frame's representative: dup-group representative first, else the shot's. */
export async function findRepresentative(sb: SupabaseClient, frame: FrameWithGroup): Promise<FrameWithGroup | null> {
  let repId: string | null = null;
  if (frame.dup_group_id) {
    const { data, error } = await sb.from('mkt_cv_dup_groups').select('representative_frame_id').eq('id', frame.dup_group_id).maybeSingle();
    if (error) throw new Error(`load dup group ${frame.dup_group_id} failed: ${error.message}`);
    repId = (data as { representative_frame_id: string | null } | null)?.representative_frame_id ?? null;
  }
  if (!repId && frame.shot_id) {
    const { data, error } = await sb.from('mkt_cv_shots').select('representative_frame_id').eq('id', frame.shot_id).maybeSingle();
    if (error) throw new Error(`load shot ${frame.shot_id} failed: ${error.message}`);
    repId = (data as { representative_frame_id: string | null } | null)?.representative_frame_id ?? null;
  }
  if (!repId || repId === frame.id) return null;
  return loadFrame(sb, repId);
}

/** Pure decision: inherit when close enough AND the representative is described. */
export function shouldInherit(frame: Pick<CvFrameRow, 'embedding'>, rep: Pick<CvFrameRow, 'embedding' | 'analysis'> | null, maxDistance = INHERIT_MAX_DISTANCE): { inherit: boolean; distance: number | null } {
  if (!rep || !rep.analysis) return { inherit: false, distance: null };
  const a = parseVector(frame.embedding); const b = parseVector(rep.embedding);
  if (!a || !b || a.length !== b.length || a.length === 0) return { inherit: false, distance: null };
  const distance = cosineDistance(a, b);
  return { inherit: distance <= maxDistance, distance };
}

export async function describeFrameOnDemand(deps: DescribeFrameDeps, job: CvJob): Promise<DescribeFrameResult> {
  const { sb, ai } = deps;
  const frameId = job.frameId ?? (typeof job.params.frame_id === 'string' ? job.params.frame_id : null);
  if (!frameId) throw new Error('permanent: cv_describe_frame job has no frame_id');

  const frame = await loadFrame(sb, frameId);
  if (!frame) throw new Error(`permanent: frame ${frameId} not found`);
  if (frame.analysis) return { frame_id: frame.id, path: 'already_described', representative_frame_id: null, distance: null, cost_usd: 0 };

  // ── path 2: inherit from a near-identical, already-described representative ──
  const rep = await findRepresentative(sb, frame);
  const decision = shouldInherit(frame, rep);
  if (rep && decision.inherit) {
    const inherited: FrameAnalysis & { inherited_from: string; inherited_distance: number } = { ...(rep.analysis as FrameAnalysis), inherited_from: rep.id, inherited_distance: decision.distance ?? 0 };
    const { error } = await sb.from('mkt_cv_frames').update({ analysis: inherited, described_at: new Date().toISOString(), describe_role: { inherited_from: rep.id, distance: decision.distance } }).eq('id', frame.id);
    if (error) throw new Error(`write inherited analysis ${frame.id} failed: ${error.message}`);
    return { frame_id: frame.id, path: 'inherited', representative_frame_id: rep.id, distance: decision.distance, cost_usd: 0 };
  }

  // ── path 3: materially different (or nothing to inherit) → one paid call ──
  if (!frame.public_url) throw new Error(`permanent: frame ${frameId} has no public_url`);
  await checkBudget(sb, `describing frame ${frame.id} on demand`);
  const ocr = typeof frame.ocr?.text === 'string' && frame.ocr.text.trim() ? ` OCR: "${frame.ocr.text.trim().slice(0, 300)}"` : '';
  const labels = frame.labels?.length ? ` zero-shot labels: ${frame.labels.join(', ')}` : '';
  const call = await ai.callRole<{ frames: FrameDescriberEntry[] }>('frame_describer', {
    system: FRAME_DESCRIBER_SYSTEM,
    user: `Describe this single image (index 0). Context: t=${(frame.ts_ms / 1000).toFixed(2)}s.${ocr}${labels}`,
    images: [{ url: frame.public_url, mime: 'image/webp' }],
    schema: FRAME_SCHEMA,
    cache: true,
  });
  const stamp = stampOf('frame_describer', call);
  await addCost(sb, 'describe_on_demand', frame.video_id, stamp);
  const entry = call.output?.frames?.[0];
  if (!entry) throw new Error('provider: frame_describer returned no frame');
  const analysis = toFrameAnalysis(entry, frame.labels ?? []);
  const { error: wErr } = await sb.from('mkt_cv_frames').update({ analysis, described_at: new Date().toISOString(), describe_role: stamp }).eq('id', frame.id);
  if (wErr) throw new Error(`write frame ${frame.id} analysis failed: ${wErr.message}`);
  return { frame_id: frame.id, path: 'described', representative_frame_id: rep?.id ?? null, distance: decision.distance, cost_usd: stamp.cost_usd ?? 0 };
}
