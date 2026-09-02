/**
 * Competitor Visual Intelligence — the two pieces the Edge endpoints share:
 *
 *   1. `embedQuery` — the Modal `wassel-video-cv` service's `/embed_query`
 *      (SigLIP-2 text tower → 768-d image-space vector + bge-m3 → 1024-d text
 *      vector). Env: MODAL_CV_URL + MODAL_CV_TOKEN (header `x-wassel-token`).
 *      Returns null — with a console.error — when the env is absent, the call
 *      times out or the service answers anything but a well-formed 200. Callers
 *      MUST translate null into a clean `{unavailable:true}` reply, never a 500:
 *      the visual system is optional by design (the writer works without it).
 *
 *   2. `diversify` — the per-video / per-organization caps + MMR-lite re-ranking
 *      the contract puts in the API layer (the SQL RPC only fuses channels).
 *
 * Used by api/marketing-os.ts (scene references) and api/marketing.ts (cv_search).
 */

export interface QueryEmbedding {
  image_vec: number[];
  text_vec: number[];
}

const EMBED_TIMEOUT_MS = 8_000;

function isNumberArray(v: unknown, dim: number): v is number[] {
  return Array.isArray(v) && v.length === dim && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** True when both Modal env vars are present (the cheap pre-check before any call). */
export function modalConfigured(): boolean {
  return Boolean(process.env.MODAL_CV_URL && process.env.MODAL_CV_TOKEN);
}

export async function embedQuery(text: string): Promise<QueryEmbedding | null> {
  const base = process.env.MODAL_CV_URL;
  const token = process.env.MODAL_CV_TOKEN;
  if (!base || !token) {
    console.error('[modal-cv] MODAL_CV_URL / MODAL_CV_TOKEN not set — visual search unavailable');
    return null;
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/embed_query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wassel-token': token },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('[modal-cv] embed_query failed', res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const json = (await res.json()) as { image_vec?: unknown; text_vec?: unknown };
    if (!isNumberArray(json.image_vec, 768) || !isNumberArray(json.text_vec, 1024)) {
      console.error('[modal-cv] embed_query returned malformed vectors',
        Array.isArray(json.image_vec) ? json.image_vec.length : typeof json.image_vec,
        Array.isArray(json.text_vec) ? json.text_vec.length : typeof json.text_vec);
      return null;
    }
    return { image_vec: json.image_vec, text_vec: json.text_vec };
  } catch (e) {
    // Network / timeout / JSON parse — all mean "the visual system is not
    // reachable right now". Logged, then degraded to unavailable by the caller.
    console.error('[modal-cv] embed_query threw', e instanceof Error ? e.message : String(e));
    return null;
  }
}

export interface DiversifyOptions<T> {
  /** Group key standing in for "the same video" (a checksum group collapses re-uploads). */
  videoKey: (row: T) => string;
  orgKey: (row: T) => string | null;
  score: (row: T) => number;
  /** Max rows per video group (Infinity to disable). */
  perVideo: number;
  /** Max rows per organization (Infinity to disable). */
  perOrg: number;
  /** MMR-lite: each already-picked row from the same org multiplies the score by lambda. */
  lambda: number;
  limit: number;
}

/**
 * Greedy diversity re-rank: at every step pick the candidate with the highest
 * lambda-penalised score whose video/org caps are not yet exhausted. O(n·k),
 * n ≤ 200 and k ≤ 100 here, so no index games.
 */
export function diversify<T>(rows: T[], opts: DiversifyOptions<T>): T[] {
  const remaining = [...rows];
  const picked: T[] = [];
  const perVideo = new Map<string, number>();
  const perOrg = new Map<string, number>();
  while (picked.length < opts.limit && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const r = remaining[i];
      if (r === undefined) continue;
      const v = opts.videoKey(r);
      const o = opts.orgKey(r);
      if ((perVideo.get(v) ?? 0) >= opts.perVideo) continue;
      if (o !== null && (perOrg.get(o) ?? 0) >= opts.perOrg) continue;
      const penalty = o === null ? 1 : Math.pow(opts.lambda, perOrg.get(o) ?? 0);
      const s = opts.score(r) * penalty;
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    const chosen = remaining.splice(bestIdx, 1)[0];
    if (chosen === undefined) break;
    picked.push(chosen);
    const v = opts.videoKey(chosen);
    perVideo.set(v, (perVideo.get(v) ?? 0) + 1);
    const o = opts.orgKey(chosen);
    if (o !== null) perOrg.set(o, (perOrg.get(o) ?? 0) + 1);
  }
  return picked;
}

/** One row of `mkt_cv_search` (shot mode). Mirrors the RPC's RETURNS TABLE. */
export interface CvSearchRow {
  shot_id: string;
  video_id: string;
  frame_id: string | null;
  content_media_id: string | null;
  content_post_id: string | null;
  organization_id: string | null;
  org_name: string | null;
  owner: 'competitor' | 'wassel';
  platform: string | null;
  published_at: string | null;
  post_url: string | null;
  stored_url: string | null;
  start_ms: number | null;
  end_ms: number | null;
  duration_ms: number | null;
  representative_frame_url: string | null;
  summary: string | null;
  tags: string[] | null;
  score: number | string;
  why: { visual?: number | null; text?: number | null; lexical?: number | null } | null;
}

/** One row of `mkt_cv_search_frames` (frame mode) — v2 carries the post attribution. */
export interface CvFrameSearchRow {
  frame_id: string;
  shot_id: string | null;
  video_id: string;
  ts_ms: number;
  public_url: string | null;
  labels: string[] | null;
  ocr_text: string | null;
  score: number | string;
  organization_id: string | null;
  org_name: string | null;
  platform: string | null;
  published_at: string | null;
  post_url: string | null;
  stored_url: string | null;
  shot_start_ms: number | null;
  shot_end_ms: number | null;
}

export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Deterministic, provider-free explanation of a match: the fused channel scores
 * plus the shot's top tags. A worker job (`reference_explainer` role) may later
 * replace it with model-written prose — this is the placeholder the contract
 * allows the Edge layer to produce without an LLM round-trip.
 */
export function describeMatch(row: Pick<CvSearchRow, 'why' | 'tags'>): { reason: string; learn_element: string | null } {
  const pct = (x: number | null | undefined): string | null =>
    typeof x === 'number' && Number.isFinite(x) ? `${Math.round(x * 100)}%` : null;
  const parts: string[] = [];
  const vis = pct(row.why?.visual); if (vis) parts.push(`visual ${vis}`);
  const txt = pct(row.why?.text); if (txt) parts.push(`text ${txt}`);
  const lex = pct(row.why?.lexical); if (lex) parts.push(`keywords ${lex}`);
  const tags = (row.tags ?? []).slice(0, 4);
  const reason = [
    parts.length ? `match: ${parts.join(', ')}` : 'match: fused rank',
    tags.length ? `tags: ${tags.join(', ')}` : null,
  ].filter(Boolean).join(' · ');
  // The most specific thing to learn from: prefer a composition/motion tag over a setting.
  const learn = tags.find((t) => /^(shot_size|motion|graphic):/.test(t)) ?? tags[0] ?? null;
  return { reason, learn_element: learn };
}
