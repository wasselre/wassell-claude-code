// ============================================================================
// HTTP client for the Modal service `wassel-video-cv` (contracts §3).
//
//   POST /process      {video_id, video_url, config} → manifest (§2)
//   POST /embed_images {urls}                        → {model, version, dim:768, vectors}
//   POST /embed_text   {texts}                       → {model, version, dim:1024, vectors}
//
// Auth: header `x-wassel-token: MODAL_CV_TOKEN`. Every failure is thrown with
// the stable `provider:` prefix so mkt_cv_job_fail treats it as retryable (a
// Modal cold start or a 502 is transient; `permanent:`/`budget_exceeded:` are
// the terminal prefixes).
// ============================================================================
import type { CvManifest, ModalCvClient, ModalEmbedResponse, ModalProcessConfig } from './types.js';

/** /process is a long call (shot detection + OCR + embeddings on a real video). */
export const MODAL_PROCESS_TIMEOUT_MS = 15 * 60 * 1000;
export const MODAL_EMBED_TIMEOUT_MS = 2 * 60 * 1000;

export interface ModalClientConfig { baseUrl: string; token: string | null; fetchImpl?: typeof fetch }

async function postJson<T>(cfg: ModalClientConfig, path: string, body: unknown, timeoutMs: number): Promise<T> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.token ? { 'x-wassel-token': cfg.token } : {}) },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new Error(`provider: modal ${path} ${aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `request failed: ${msg}`}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`provider: modal ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    // Not JSON at all — the body is the only diagnostic, so it goes in the message.
    throw new Error(`provider: modal ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`provider: modal ${path} returned a non-object body`);
  }
  return parsed as T;
}

function assertManifest(m: unknown, path: string): CvManifest {
  const o = m as Partial<CvManifest>;
  if (!o.video || typeof o.video !== 'object') throw new Error(`provider: modal ${path} manifest missing "video"`);
  if (!Array.isArray(o.shots)) throw new Error(`provider: modal ${path} manifest missing "shots"`);
  if (!Array.isArray(o.frames)) throw new Error(`provider: modal ${path} manifest missing "frames"`);
  return {
    video: o.video,
    shots: o.shots,
    frames: o.frames,
    dup_groups: Array.isArray(o.dup_groups) ? o.dup_groups : [],
    cost_usd: typeof o.cost_usd === 'number' && Number.isFinite(o.cost_usd) ? o.cost_usd : 0,
    partial: o.partial === true,
    partial_reason: typeof o.partial_reason === 'string' ? o.partial_reason : (typeof o.reason === 'string' ? o.reason : undefined),
  };
}

function assertEmbed(r: unknown, path: string, expectDim: number): ModalEmbedResponse {
  const o = r as Partial<ModalEmbedResponse>;
  if (!Array.isArray(o.vectors)) throw new Error(`provider: modal ${path} response missing "vectors"`);
  const dim = typeof o.dim === 'number' ? o.dim : (o.vectors[0]?.length ?? 0);
  if (dim !== expectDim) throw new Error(`provider: modal ${path} returned dim=${dim}, expected ${expectDim}`);
  return { model: String(o.model ?? 'unknown'), version: String(o.version ?? ''), dim, vectors: o.vectors };
}

export function makeModalClient(cfg: ModalClientConfig): ModalCvClient {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const c: ModalClientConfig = { ...cfg, baseUrl: base };
  return {
    async process(videoId: string, videoUrl: string, config: ModalProcessConfig): Promise<CvManifest> {
      const raw = await postJson<unknown>(c, '/process', { video_id: videoId, video_url: videoUrl, config }, MODAL_PROCESS_TIMEOUT_MS);
      return assertManifest(raw, '/process');
    },
    async embedImages(urls: string[]): Promise<ModalEmbedResponse> {
      if (urls.length === 0) return { model: 'none', version: '', dim: 768, vectors: [] };
      const raw = await postJson<unknown>(c, '/embed_images', { urls }, MODAL_EMBED_TIMEOUT_MS);
      return assertEmbed(raw, '/embed_images', 768);
    },
    async embedText(texts: string[]): Promise<ModalEmbedResponse> {
      if (texts.length === 0) return { model: 'none', version: '', dim: 1024, vectors: [] };
      const raw = await postJson<unknown>(c, '/embed_text', { texts }, MODAL_EMBED_TIMEOUT_MS);
      return assertEmbed(raw, '/embed_text', 1024);
    },
  };
}
