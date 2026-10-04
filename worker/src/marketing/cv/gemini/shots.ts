// ============================================================================
// Shot boundaries for the Gemini visual pipeline. Pure — unit tested.
//
// Two sources, each good at what the other is bad at:
//   - ffmpeg's `scdet` filter scores every frame change. A HIGH score is an
//     exact, certain hard cut. It never sees soft transitions (dissolves,
//     fades, slideshow changes, a walkthrough moving room to room) and it
//     fires falsely on flashes and crowds in motion.
//   - Gemini watches the video and decides the shots. It catches soft
//     transitions, but samples ~1 frame per second, so its times are only
//     roughly right and can even run past the end of the video (it did on
//     2 of 20 test videos, 2026-10-04).
// So Gemini decides WHERE shots are, and its boundaries are snapped onto the
// detector's exact times when one is close, and clamped into the video.
// ============================================================================

export interface DetectedCut { t_ms: number; score: number }

/** At or above this scdet score a cut is treated as certain (measured on 20 videos). */
export const CERTAIN_CUT_SCORE = 25;
/** Below this the detector's reports are noise and are not even shown to the model. */
export const HINT_CUT_SCORE = 10;
/** A model boundary this close to a detected cut moves onto the cut. */
export const SNAP_MS = 600;
/** Shots shorter than this after snapping are merged into the previous one. */
export const MIN_SHOT_MS = 150;

/** Parse ffmpeg `-vf scdet` stderr ("lavfi.scd.score: 31.2, lavfi.scd.time: 4.37"). */
export function parseScdet(stderr: string): DetectedCut[] {
  const out: DetectedCut[] = [];
  const re = /lavfi\.scd\.score:\s*([0-9.]+)[^\n]*?lavfi\.scd\.time:\s*([0-9.]+)/g;
  for (let m = re.exec(stderr); m; m = re.exec(stderr)) {
    const score = Number(m[1]);
    const t = Number(m[2]);
    if (Number.isFinite(score) && Number.isFinite(t)) out.push({ t_ms: Math.round(t * 1000), score });
  }
  return out.sort((a, b) => a.t_ms - b.t_ms);
}

export type TransitionIn = 'start' | 'cut' | 'fade' | 'dissolve' | 'graphic';
export type TransitionOut = 'end' | 'cut' | 'fade' | 'dissolve' | 'graphic';

/** The minimum a model shot must carry for boundary normalisation. */
export interface ModelShotTiming {
  start_s: number;
  end_s?: number;
  continuous_take?: boolean;
  transition_in?: string;
}

export interface NormalizedShot<T> {
  shot_no: number;
  start_ms: number;
  end_ms: number;
  transition_in: TransitionIn;
  transition_out: TransitionOut;
  /** The camera never cut — the take moved into a different place. */
  internal_change: boolean;
  data: T;
}

function transitionOf(raw: string | undefined): 'cut' | 'fade' | 'dissolve' | 'graphic' {
  return raw === 'fade' || raw === 'dissolve' || raw === 'graphic' ? raw : 'cut';
}

/**
 * Model shots → contiguous shots covering exactly [0, durationMs].
 * Shots are ordered by start; each later shot's start becomes a boundary,
 * snapped to the nearest detected cut within SNAP_MS, clamped into the video.
 * A boundary that lands within MIN_SHOT_MS of the previous one (or of the
 * end) is dropped and its shot folded into the one before via `merge`.
 */
export function normalizeShots<T extends ModelShotTiming>(
  modelShots: readonly T[],
  durationMs: number,
  cuts: readonly DetectedCut[],
  merge: (kept: T, dropped: T) => T,
): NormalizedShot<T>[] {
  if (!(durationMs > 0)) throw new Error(`normalizeShots: duration must be > 0 (got ${durationMs})`);
  const usable = modelShots.filter((s) => Number.isFinite(s.start_s)).slice().sort((a, b) => a.start_s - b.start_s);
  if (usable.length === 0) return [];
  const hints = cuts.filter((c) => c.score >= HINT_CUT_SCORE);

  const snap = (ms: number): number => {
    let best: DetectedCut | null = null;
    for (const c of hints) {
      const d = Math.abs(c.t_ms - ms);
      if (d <= SNAP_MS && (!best || d < Math.abs(best.t_ms - ms))) best = c;
    }
    return best ? best.t_ms : ms;
  };

  const kept: Array<{ start: number; shot: T }> = [{ start: 0, shot: usable[0]! }];
  for (let i = 1; i < usable.length; i++) {
    const s = usable[i]!;
    const b = Math.min(durationMs, Math.max(0, snap(Math.round(s.start_s * 1000))));
    const last = kept[kept.length - 1]!;
    if (b - last.start < MIN_SHOT_MS || durationMs - b < MIN_SHOT_MS) {
      last.shot = merge(last.shot, s);
      continue;
    }
    kept.push({ start: b, shot: s });
  }

  return kept.map((k, i) => {
    const next = kept[i + 1];
    return {
      shot_no: i,
      start_ms: k.start,
      end_ms: next ? next.start : durationMs,
      transition_in: i === 0 ? 'start' : transitionOf(k.shot.transition_in),
      transition_out: next ? transitionOf(next.shot.transition_in) : 'end',
      internal_change: i === 0 ? false : k.shot.continuous_take === true,
      data: k.shot,
    };
  });
}

/**
 * Shots from the detector alone (no model): every cut at or above HINT_CUT_SCORE
 * is a boundary. Used for our own videos, which only need searchable pictures.
 */
export function shotsFromCuts(durationMs: number, cuts: readonly DetectedCut[]): Array<{ shot_no: number; start_ms: number; end_ms: number }> {
  const bounds: number[] = [0];
  for (const c of cuts) {
    if (c.score < HINT_CUT_SCORE) continue;
    if (c.t_ms - bounds[bounds.length - 1]! < MIN_SHOT_MS || durationMs - c.t_ms < MIN_SHOT_MS) continue;
    bounds.push(c.t_ms);
  }
  return bounds.map((b, i) => ({ shot_no: i, start_ms: b, end_ms: bounds[i + 1] ?? durationMs }));
}

/**
 * Keyframe times for a shot: the middle; for a shot over 6 s also the quarter
 * points (three frames). Kept 50 ms inside the shot so a frame never belongs to
 * the neighbour.
 */
export function keyframeTimes(startMs: number, endMs: number): number[] {
  const len = endMs - startMs;
  const at = (f: number) => Math.round(startMs + len * f);
  const raw = len > 6000 ? [at(0.25), at(0.5), at(0.75)] : [at(0.5)];
  const lo = startMs + Math.min(50, Math.floor(len / 2));
  const hi = endMs - Math.min(50, Math.ceil(len / 2));
  return [...new Set(raw.map((t) => Math.min(hi, Math.max(lo, t))))];
}

/**
 * Edit pace in cuts per minute. Counts every shot boundary plus each CERTAIN
 * detector cut the shot list does not already have (Gemini's shot count on a
 * fast montage varies run to run; certain cuts do not).
 */
export function paceCutsPerMin(boundariesMs: readonly number[], cuts: readonly DetectedCut[], durationMs: number): number | null {
  if (!(durationMs > 0)) return null;
  const all = [...boundariesMs.filter((b) => b > 0)];
  for (const c of cuts) {
    if (c.score < CERTAIN_CUT_SCORE) continue;
    if (all.some((b) => Math.abs(b - c.t_ms) <= 500)) continue;
    all.push(c.t_ms);
  }
  return Math.round((all.length / (durationMs / 60000)) * 10) / 10;
}
