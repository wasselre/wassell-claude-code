/**
 * Gemini `gemini-embedding-2` EmbeddingProvider — ONE multimodal model maps
 * text and images into the same space, so a text query finds pictures.
 *
 * It replaced Modal's two models (SigLIP-2 for images, bge-m3 for text) on
 * 2026-10-04. The vectors are truncatable, so the role's `dim` picks the
 * length: 768 for the visual columns, 1024 for the text columns. Vectors from
 * the old models are NOT comparable with these — the migration that switched
 * the roles cleared every stored one.
 *
 * Images are downloaded here and sent inline (base64); the API does not fetch
 * URLs. Requests go through `batchEmbedContents` in chunks of ≤ 50.
 * Cost is KNOWN: the response reports tokens per modality and the rates are
 * cited in geminiHttp.ts.
 */

import { embeddingCostUsd, errMessage, geminiPost, type GeminiHttpOptions, type GeminiUsage } from './geminiHttp.js';
import {
  providerError,
  type EmbedInput,
  type EmbedQueryResult,
  type EmbedResult,
  type EmbeddingProvider,
  type RoleConfig,
} from '../types.js';

export const GEMINI_EMBED_MODEL = 'gemini-embedding-2';
/** Visual-space (frames, shots' look, image queries) and text-space dimensions. */
export const VISUAL_DIM = 768;
export const TEXT_DIM = 1024;

const MAX_BATCH = 50;
const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const IMAGE_MAX_BYTES = 15_000_000;

export interface GeminiEmbedOptions extends GeminiHttpOptions {
  /** Injected for tests; used for the image downloads. */
  fetchImage?: typeof fetch;
  now?: () => number;
}

export interface GeminiEmbedProvider extends EmbeddingProvider {
  embedQuery(text: string): Promise<EmbedQueryResult>;
}

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };
interface BatchResponse { embeddings?: Array<{ values?: number[] }>; usageMetadata?: GeminiUsage }

const IMAGE_MIME = /^image\/(jpeg|png|webp|heic|heif|gif)$/i;

function mimeFromUrl(url: string): string | null {
  const m = /\.(jpe?g|png|webp|heic|heif|gif)(\?|$)/i.exec(url);
  if (!m) return null;
  const ext = m[1]!.toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
}

export function createGeminiEmbedProvider(opts: GeminiEmbedOptions = {}): GeminiEmbedProvider {
  const fetchImage = opts.fetchImage ?? opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());

  async function imagePart(url: string): Promise<Part> {
    let res: Response;
    try {
      res = await fetchImage(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
    } catch (err) {
      throw providerError('gemini', `image download failed (${url.slice(0, 120)}): ${errMessage(err)}`, err);
    }
    if (!res.ok) throw providerError('gemini', `image download HTTP ${res.status} (${url.slice(0, 120)})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw providerError('gemini', `image download returned 0 bytes (${url.slice(0, 120)})`);
    if (buf.length > IMAGE_MAX_BYTES) throw providerError('gemini', `image is ${buf.length} bytes, over the ${IMAGE_MAX_BYTES} limit (${url.slice(0, 120)})`);
    const header = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    const mime = IMAGE_MIME.test(header) ? header.toLowerCase() : mimeFromUrl(url);
    if (!mime) throw providerError('gemini', `not an embeddable image type '${header || 'unknown'}' (${url.slice(0, 120)})`);
    return { inline_data: { mime_type: mime, data: buf.toString('base64') } };
  }

  async function batch(parts: Part[][], dims: number[]): Promise<{ vectors: number[][]; cost: number }> {
    const vectors: number[][] = [];
    let cost = 0;
    for (let i = 0; i < parts.length; i += MAX_BATCH) {
      const chunk = parts.slice(i, i + MAX_BATCH);
      const r = await geminiPost<BatchResponse>(`/v1beta/models/${GEMINI_EMBED_MODEL}:batchEmbedContents`, {
        requests: chunk.map((p, j) => ({ model: `models/${GEMINI_EMBED_MODEL}`, content: { parts: p }, outputDimensionality: dims[i + j] })),
      }, opts);
      const got = r.embeddings ?? [];
      if (got.length !== chunk.length) throw providerError('gemini', `batchEmbedContents returned ${got.length} vectors for ${chunk.length} inputs`);
      got.forEach((e, j) => {
        const v = e.values;
        const want = dims[i + j]!;
        if (!Array.isArray(v) || v.length !== want) throw providerError('gemini', `vector ${i + j} has length ${Array.isArray(v) ? v.length : 'none'}, expected ${want}`);
        vectors.push(v);
      });
      cost += embeddingCostUsd(r.usageMetadata);
    }
    return { vectors, cost: Math.round(cost * 1e6) / 1e6 };
  }

  async function embed(role: RoleConfig, input: EmbedInput): Promise<EmbedResult> {
    if (role.provider !== 'gemini') throw providerError('gemini', `role provider is '${role.provider}', not gemini`);
    const dim = role.dim;
    if (!dim || !Number.isInteger(dim) || dim < 128 || dim > 3072) throw providerError('gemini', `role '${role.model}' needs a dim between 128 and 3072 (got ${String(dim)})`);
    const texts = input.texts ?? [];
    const urls = input.image_urls ?? [];
    if (texts.length > 0 && urls.length > 0) throw providerError('gemini', 'embed() takes texts OR image_urls, not both');
    const started = now();
    if (texts.length === 0 && urls.length === 0) {
      return { vectors: [], model: GEMINI_EMBED_MODEL, version: role.version ?? '', dim, cost_usd: 0, provider: 'gemini', latency_ms: 0 };
    }
    const parts: Part[][] = texts.length > 0
      ? texts.map((t) => [{ text: t.trim() ? t : ' ' }])
      : await Promise.all(urls.map(async (u) => [await imagePart(u)]));
    const { vectors, cost } = await batch(parts, parts.map(() => dim));
    return { vectors, model: GEMINI_EMBED_MODEL, version: role.version ?? '', dim, cost_usd: cost, provider: 'gemini', latency_ms: Math.max(0, Math.round(now() - started)) };
  }

  async function embedQuery(text: string): Promise<EmbedQueryResult> {
    const started = now();
    // One request, two lengths: the same text in the visual space and the text space.
    const { vectors, cost } = await batch([[{ text }], [{ text }]], [VISUAL_DIM, TEXT_DIM]);
    return { image_vec: vectors[0]!, text_vec: vectors[1]!, provider: 'gemini', latency_ms: Math.max(0, Math.round(now() - started)), cost_usd: cost };
  }

  return { kind: 'gemini', embed, embedQuery };
}
