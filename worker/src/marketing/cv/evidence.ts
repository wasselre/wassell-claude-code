// ============================================================================
// Pure evidence assembly for shot analysis: the keyframe contact sheet, the
// time-aligned transcript window, and the consolidated OCR. No I/O — tested.
// ============================================================================
import type { CvFrameRow, TranscriptSegment } from './types.js';

/** Hard cap on images per LLM call (Anthropic vision cost + context). */
export const MAX_IMAGES_PER_CALL = 8;

export interface ContactSheetEntry { frame_id: string; ts_ms: number; url: string }

/**
 * Pick ≤ `max` keyframes for the contact sheet, in time order, always keeping
 * the first and last so the model sees how the shot enters and exits. When the
 * shot has more keyframes than the cap, the middle is sampled evenly.
 */
export function buildContactSheet(frames: readonly Pick<CvFrameRow, 'id' | 'ts_ms' | 'public_url'>[], max = MAX_IMAGES_PER_CALL): ContactSheetEntry[] {
  const usable = frames
    .filter((f): f is Pick<CvFrameRow, 'id' | 'ts_ms' | 'public_url'> & { public_url: string } => typeof f.public_url === 'string' && f.public_url.length > 0)
    .slice()
    .sort((a, b) => a.ts_ms - b.ts_ms);
  if (max <= 0) return [];
  let picked: typeof usable;
  if (usable.length <= max) picked = usable;
  else if (max === 1) picked = [usable[0]!];
  else {
    picked = [];
    const last = usable.length - 1;
    for (let i = 0; i < max; i++) {
      const idx = Math.round((i * last) / (max - 1));
      picked.push(usable[idx]!);
    }
    // Rounding can land two slots on the same index for tiny inputs; dedupe.
    picked = picked.filter((f, i, arr) => i === 0 || arr[i - 1]!.id !== f.id);
  }
  return picked.map((f) => ({ frame_id: f.id, ts_ms: f.ts_ms, url: f.public_url }));
}

/** Split a list into ≤ `size` batches (order preserved). */
export function chunk<T>(xs: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk: size must be positive, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Transcript segments overlapping [start_ms, end_ms). Segment shape per
 *  mkt_transcripts.segments: {start_ms, end_ms, text}. Tolerant of rows that
 *  carry seconds (`start`/`end`) from older ASR runs. */
export function segmentsForShot(segments: readonly unknown[] | null | undefined, startMs: number, endMs: number): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const raw of segments ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    if (!text) continue;
    let s = Number(r.start_ms); let e = Number(r.end_ms);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      const ss = Number(r.start); const ee = Number(r.end);
      if (!Number.isFinite(ss) || !Number.isFinite(ee)) continue;
      s = Math.round(ss * 1000); e = Math.round(ee * 1000);
    }
    if (e <= startMs || s >= endMs) continue;
    out.push({ start_ms: s, end_ms: e, text });
  }
  return out.sort((a, b) => a.start_ms - b.start_ms);
}

/** Frames' OCR text, deduped (whitespace-normalised, case-insensitive), in time order. */
export function consolidateOcr(frames: readonly Pick<CvFrameRow, 'ts_ms' | 'ocr'>[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const f of [...frames].sort((a, b) => a.ts_ms - b.ts_ms)) {
    const text = typeof f.ocr?.text === 'string' ? f.ocr.text : '';
    for (const line of text.split(/\r?\n/)) {
      const norm = line.replace(/\s+/g, ' ').trim();
      if (!norm) continue;
      const key = norm.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(norm);
    }
  }
  return lines.join('\n');
}

/** Human-readable timing line for the prompt. */
export function describeTiming(shot: { start_ms: number; end_ms: number; transition_in: string | null; transition_out: string | null; is_static: boolean; internal_change: boolean; edit_pace_local: number | null }): string {
  const dur = shot.end_ms - shot.start_ms;
  const parts = [
    `start ${(shot.start_ms / 1000).toFixed(2)}s, end ${(shot.end_ms / 1000).toFixed(2)}s, duration ${dur} ms`,
    `transition in: ${shot.transition_in ?? 'unknown'}, out: ${shot.transition_out ?? 'unknown'}`,
    shot.is_static ? 'camera/content static' : 'camera or content moving',
    shot.internal_change ? 'contains an internal visual change without a cut' : 'no internal change',
  ];
  if (shot.edit_pace_local != null) parts.push(`local editing pace ≈ ${Number(shot.edit_pace_local).toFixed(1)} cuts/min`);
  return parts.join('; ');
}
