/**
 * Modal `wassel-video-cv` EmbeddingProvider — HTTP client for the three
 * embedding endpoints (contracts §3):
 *
 *   POST /embed_text   {texts:[…]}  → {model, version, dim:1024, vectors:[[…]]}   (bge-m3)
 *   POST /embed_images {urls:[…]}   → {model, version, dim:768,  vectors:[[…]]}   (SigLIP-2)
 *   POST /embed_query  {text}       → {image_vec:[768], text_vec:[1024]}
 *
 * Header `x-wassel-token: ${MODAL_CV_TOKEN}`; 60 s timeout per request;
 * inputs are sent in batches of ≤ 64 and the vectors concatenated in order.
 * Env (`MODAL_CV_URL`, `MODAL_CV_TOKEN`) is read at call time so a worker
 * boots fine before the visual system is configured; the first embed call
 * then throws a clear `provider:modal MODAL_CV_URL is not set`.
 *
 * Cost: Modal bills container-seconds, not per call → `cost_usd: null`
 * (unknown), never 0. The per-video `cost_usd` in the /process manifest is
 * the only Modal cost we ledger (via `mkt_cv_finalize_video`).
 *
 * Transient failures (502/503/504 — Modal cold starts — and network errors)
 * are retried up to 3 attempts; 4xx and 500 are not. Everything surfaces as
 * `provider:modal …`.
 */

import {
  providerError,
  type EmbedInput,
  type EmbedQueryResult,
  type EmbedResult,
  type EmbeddingProvider,
  type RoleConfig,
} from '../types.js';

export interface ModalEmbedOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  /** Default 60 000. */
  timeoutMs?: number;
  /** Default 64 (contract maximum). Values above 64 are clamped. */
  batchSize?: number;
  /** Default 3. */
  maxAttempts?: number;
  /** Default 500 ms base for exponential backoff. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ModalEmbedProvider extends EmbeddingProvider {
  embedQuery(text: string): Promise<EmbedQueryResult>;
}

interface VectorsResponse {
  model: string;
  version: string | number;
  dim: number;
  vectors: number[][];
}

interface QueryResponse {
  image_vec: number[];
  text_vec: number[];
}

const MAX_BATCH = 64;
const DEFAULT_TIMEOUT_MS = 60_000;

export function createModalEmbedProvider(opts: ModalEmbedOptions = {}): ModalEmbedProvider {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const batchSize = Math.min(MAX_BATCH, Math.max(1, opts.batchSize ?? MAX_BATCH));
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  function config(): { baseUrl: string; token: string } {
    const baseUrl = (opts.baseUrl ?? process.env.MODAL_CV_URL ?? '').trim().replace(/\/+$/, '');
    const token = (opts.token ?? process.env.MODAL_CV_TOKEN ?? '').trim();
    if (!baseUrl) throw providerError('modal', 'MODAL_CV_URL is not set (visual system endpoint)');
    if (!token) throw providerError('modal', 'MODAL_CV_TOKEN is not set (x-wassel-token header)');
    return { baseUrl, token };
  }

  async function post<R>(path: string, body: Record<string, unknown>): Promise<R> {
    const { baseUrl, token } = config();
    const url = `${baseUrl}${path}`;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-wassel-token': token },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const aborted = ctrl.signal.aborted;
        const detail = aborted ? `timeout after ${timeoutMs}ms` : `network error: ${errMessage(err)}`;
        if (attempt < maxAttempts) {
          console.error(`[ai/modal] POST ${path} attempt ${attempt}/${maxAttempts} ${detail} — retrying`);
          await sleep(backoffMs(baseDelayMs, attempt));
          continue;
        }
        throw providerError('modal', `POST ${path} ${detail} (attempts=${attempt})`, err);
      }
      clearTimeout(timer);

      if (!res.ok) {
        const snippet = (await safeText(res)).slice(0, 300);
        const transient = res.status === 502 || res.status === 503 || res.status === 504;
        if (transient && attempt < maxAttempts) {
          console.error(`[ai/modal] POST ${path} attempt ${attempt}/${maxAttempts} HTTP ${res.status} — retrying`);
          await sleep(backoffMs(baseDelayMs, attempt));
          continue;
        }
        throw providerError('modal', `POST ${path} HTTP ${res.status}: ${snippet || res.statusText}`);
      }

      try {
        return (await res.json()) as R;
      } catch (err) {
        // Only a JSON body parse failure is expected here.
        throw providerError('modal', `POST ${path} returned non-JSON body: ${errMessage(err)}`, err);
      }
    }
  }

  async function embedBatched(path: string, key: 'texts' | 'urls', items: string[]): Promise<Omit<EmbedResult, 'provider' | 'latency_ms' | 'cost_usd'>> {
    let model = '';
    let version = '';
    let dim = 0;
    const vectors: number[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const chunk = items.slice(i, i + batchSize);
      const r = await post<VectorsResponse>(path, { [key]: chunk });
      if (!Array.isArray(r.vectors) || r.vectors.length !== chunk.length) {
        throw providerError('modal', `POST ${path} returned ${Array.isArray(r.vectors) ? r.vectors.length : 'no'} vectors for ${chunk.length} inputs`);
      }
      const rModel = String(r.model ?? '');
      const rVersion = String(r.version ?? '');
      const rDim = Number(r.dim ?? (r.vectors[0]?.length ?? 0));
      if (model && (rModel !== model || rVersion !== version || rDim !== dim)) {
        throw providerError('modal', `POST ${path} model/version/dim changed mid-batch (${model}/${version}/${dim} → ${rModel}/${rVersion}/${rDim})`);
      }
      model = rModel;
      version = rVersion;
      dim = rDim;
      for (const v of r.vectors) {
        if (v.length !== dim) throw providerError('modal', `POST ${path} vector length ${v.length} ≠ dim ${dim}`);
        vectors.push(v);
      }
    }
    return { vectors, model, version, dim };
  }

  async function embed(role: RoleConfig, input: EmbedInput): Promise<EmbedResult> {
    if (role.provider !== 'modal') throw providerError('modal', `role provider is '${role.provider}', not modal`);
    const texts = input.texts ?? [];
    const urls = input.image_urls ?? [];
    if (texts.length > 0 && urls.length > 0) throw providerError('modal', 'embed() takes texts OR image_urls, not both');
    const started = now();
    if (texts.length === 0 && urls.length === 0) {
      return { vectors: [], model: role.model, version: role.version ?? '', dim: 0, cost_usd: null, provider: 'modal', latency_ms: 0 };
    }
    const r = texts.length > 0
      ? await embedBatched('/embed_text', 'texts', texts)
      : await embedBatched('/embed_images', 'urls', urls);
    return {
      ...r,
      model: r.model || role.model,
      version: r.version || role.version || '',
      cost_usd: null,
      provider: 'modal',
      latency_ms: Math.max(0, Math.round(now() - started)),
    };
  }

  async function embedQuery(text: string): Promise<EmbedQueryResult> {
    const started = now();
    const r = await post<QueryResponse>('/embed_query', { text });
    if (!Array.isArray(r.image_vec) || !Array.isArray(r.text_vec)) {
      throw providerError('modal', 'POST /embed_query returned no image_vec/text_vec');
    }
    return { image_vec: r.image_vec, text_vec: r.text_vec, provider: 'modal', latency_ms: Math.max(0, Math.round(now() - started)), cost_usd: null };
  }

  return { kind: 'modal', embed, embedQuery };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    // Body already consumed / stream error — the status code is the signal we keep.
    console.error(`[ai/modal] could not read error body: ${errMessage(err)}`);
    return '';
  }
}

function backoffMs(base: number, attempt: number): number {
  return base * 2 ** (attempt - 1) + Math.floor(Math.random() * base * 0.25);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
