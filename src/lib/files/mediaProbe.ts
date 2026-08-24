/**
 * Deterministic, browser-side media probing — NO AI, NO human. Reads a File's
 * intrinsic metadata (image/video dimensions, video/audio duration) by loading
 * it into a media element, and snaps the dimensions to a common display ratio.
 *
 * Runs at upload time (see uploadFile) so every media file carries its length
 * and size ratio automatically. Never throws and never hangs an upload: a file
 * whose metadata will not load, or a timeout, resolves to an empty result.
 */

export interface MediaMetadata {
  width_px?: number;
  height_px?: number;
  duration_seconds?: number;
  /** Snapped display ratio, e.g. "16:9" / "9:16" / "1:1". */
  aspect_ratio?: string;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) { [x, y] = [y, x % y]; }
  return x || 1;
}

/**
 * Snap width:height to a common ratio label; fall back to the reduced fraction.
 * Deterministic — the same dimensions always produce the same label.
 */
export function snapAspectRatio(w: number, h: number): string | undefined {
  if (!w || !h || w < 0 || h < 0) return undefined;
  const r = w / h;
  const common: Array<[number, number]> = [
    [1, 1], [16, 9], [9, 16], [4, 3], [3, 4], [3, 2], [2, 3],
    [21, 9], [4, 5], [5, 4], [2, 1], [1, 2], [16, 10], [10, 16],
  ];
  let best = common[0]!;
  let bestDiff = Infinity;
  for (const c of common) {
    const diff = Math.abs(r - c[0] / c[1]);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  // Within ~4% of a common ratio → snap to it; otherwise the exact reduced ratio.
  if (bestDiff / (best[0] / best[1]) <= 0.04) return `${best[0]}:${best[1]}`;
  const g = gcd(Math.round(w), Math.round(h));
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Probe an image / video / audio File. `kind` is the app's FilePreviewKind
 * ('image' | 'video' | 'audio' | …); anything else resolves to {}.
 */
export function probeMediaMetadata(file: File, kind: string): Promise<MediaMetadata> {
  return new Promise((resolve) => {
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') { resolve({}); return; }
    if (typeof window === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) { resolve({}); return; }

    let settled = false;
    const url = URL.createObjectURL(file);
    let timer: number | undefined;
    const finish = (m: MediaMetadata) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      try { URL.revokeObjectURL(url); } catch { /* nothing to revoke */ }
      resolve(m);
    };
    // A media file that never fires loadedmetadata must not stall the upload.
    timer = window.setTimeout(() => finish({}), PROBE_TIMEOUT_MS);

    try {
      if (kind === 'image') {
        const img = new Image();
        img.onload = () => finish({
          width_px: img.naturalWidth || undefined,
          height_px: img.naturalHeight || undefined,
          aspect_ratio: snapAspectRatio(img.naturalWidth, img.naturalHeight),
        });
        img.onerror = () => finish({});
        img.src = url;
      } else if (kind === 'video') {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        v.onloadedmetadata = () => finish({
          width_px: v.videoWidth || undefined,
          height_px: v.videoHeight || undefined,
          duration_seconds: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : undefined,
          aspect_ratio: snapAspectRatio(v.videoWidth, v.videoHeight),
        });
        v.onerror = () => finish({});
        v.src = url;
      } else { // audio
        const a = document.createElement('audio');
        a.preload = 'metadata';
        a.onloadedmetadata = () => finish({
          duration_seconds: Number.isFinite(a.duration) && a.duration > 0 ? a.duration : undefined,
        });
        a.onerror = () => finish({});
        a.src = url;
      }
    } catch {
      finish({});
    }
  });
}
