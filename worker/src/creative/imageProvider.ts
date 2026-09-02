/**
 * Image provider registry — the 'fal' creative provider (contracts §5).
 *
 * The three image roles (`image_edit`, `image_generate`, `image_remove_text`)
 * are DATA in `mos_settings.ai_roles` like every other role; this module turns
 * the resolved config into an `ImageProvider` whose four operations wrap
 * `worker/src/imageGen.ts` (REUSED — never edited):
 *
 *   generate   → imageGenChat with NO input images (text-to-image slug)
 *   edit       → imageGenChat with input images; keepFraming + single source
 *                → imageGenTextRemoval (its submit omits aspect_ratio, which is
 *                how fal keeps the source framing — verified live 2026-07-18)
 *   combine    → imageGenChat with every source image + a prompt that names
 *                each image's role (nano-banana-pro/edit pulls identity from
 *                each input separately)
 *   removeText → imageGenTextRemoval with its own tuned CLEAN_TEXT_PROMPT
 *
 * Model routing without editing imageGen.ts: imageGen.ts resolves its fal
 * model slug from env vars (FAL_CHAT_MODEL_ID / FAL_CHAT_T2I_MODEL_ID /
 * FAL_CLEAN_TEXT_MODEL_ID / FAL_CLEAN_TEXT_PROMPT) READ SYNCHRONOUSLY at the
 * top of each exported function, before the first await. `withModelEnv` sets
 * the override, invokes the function (env captured synchronously), and
 * restores — safe under Node's run-to-first-await semantics, and every
 * invocation re-reads, so two lanes with different configured models cannot
 * leak into each other.
 *
 * Stub mode: when `FAL_KEY === 'stub'` imageGen.ts skips the network and
 * `pollImageGen` returns canned picsum URLs — the provider then reports
 * kind 'stub'. Cost: fal bills per image at rates we do not track here →
 * cost_usd is null (unknown ≠ free), never a guessed number.
 */

import {
  imageGenChat,
  imageGenTextRemoval,
  pollImageGen,
  type ChatAspectRatio,
  type ImageGenPollResult,
  type ImageGenStartResult,
} from '../imageGen.js';
import { creativeProviderError, isImageRoleKey, resolveCreativeRoles, type CreativeRoleConfig, type ImageRoleKey, type SettingsClient } from './roles.js';

// ---------------------------------------------------------------------------
// Public interface (contracts §5 / brief A-AI §2)
// ---------------------------------------------------------------------------

export interface ImageResult {
  urls: string[];
  /** 'stub' when FAL_KEY === 'stub' (offline dev / CI — canned URLs). */
  provider: 'fal' | 'stub';
  /** The configured fal model slug the call ran on. */
  model: string;
  /** fal per-image pricing is not tracked → null (unknown ≠ free). */
  cost_usd: number | null;
  latency_ms: number;
}

export interface ImageGenerateRequest {
  prompt: string;
  /** Creative aspect, e.g. '1:1' | '4:5' | '9:16' | '16:9' | '1.91:1'. Mapped to the nearest fal ratio. */
  aspect: string;
  /** Variations, 1–4 (clamped). */
  n: number;
}

export interface ImageEditRequest {
  prompt: string;
  /** Source image URLs; the first is the primary subject. */
  sources: string[];
  aspect?: string;
  /** Keep the source framing (no re-aspect). Honoured for a single source via the text-removal submit path. */
  keepFraming?: boolean;
}

export interface ImageCombineSource {
  url: string;
  /** What this image contributes, e.g. 'hero building photo' | 'layout reference' | 'logo'. */
  role: string;
}

export interface ImageCombineRequest {
  prompt: string;
  sources: ImageCombineSource[];
}

export interface ImageRemoveTextRequest {
  source: string;
}

export interface ImageProvider {
  kind: 'fal' | 'stub';
  /** The configured fal model slug (from ai_roles). */
  model: string;
  generate(req: ImageGenerateRequest): Promise<ImageResult>;
  edit(req: ImageEditRequest): Promise<ImageResult>;
  combine(req: ImageCombineRequest): Promise<ImageResult>;
  removeText(req: ImageRemoveTextRequest): Promise<ImageResult>;
}

// ---------------------------------------------------------------------------
// Transport — injectable so tests never touch the network
// ---------------------------------------------------------------------------

export interface ImageTransport {
  chat(opts: { prompt: string; imageUrls: string[]; aspectRatio: ChatAspectRatio; numVariations: number }): Promise<ImageGenStartResult>;
  textRemoval(opts: { imageUrl: string }): Promise<ImageGenStartResult>;
  poll(start: ImageGenStartResult, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<ImageGenPollResult>;
}

const defaultTransport: ImageTransport = {
  chat: (opts) =>
    imageGenChat({ prompt: opts.prompt, imageUrls: opts.imageUrls, aspectRatio: opts.aspectRatio, numVariations: opts.numVariations }),
  textRemoval: (opts) => imageGenTextRemoval({ imageUrl: opts.imageUrl }),
  poll: (start, opts) => pollImageGen(start, opts),
};

export interface ImageProviderDeps {
  transport?: ImageTransport;
  now?: () => number;
  /** Test override for stub detection; defaults to reading process.env.FAL_KEY. */
  falKey?: string;
  /** Poll knobs forwarded to pollImageGen. */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Aspect mapping — ChatAspectRatio has no '4:5' / '1.91:1'; approximate loudly
// ---------------------------------------------------------------------------

const ASPECT_MAP: Record<string, ChatAspectRatio> = {
  '1:1': '1:1',
  '9:16': '9:16',
  '16:9': '16:9',
  '4:3': '4:3',
  '3:4': '3:4',
  '4:5': '3:4', // nearest supported portrait ratio
  '1.91:1': '16:9', // nearest supported landscape ratio
};

export function mapAspectToFal(aspect: string): ChatAspectRatio {
  const mapped = ASPECT_MAP[aspect.trim()];
  if (!mapped) {
    console.error(`[creative/imageProvider] unsupported aspect '${aspect}' — falling back to '1:1'`);
    return '1:1';
  }
  if (mapped !== aspect.trim()) {
    console.error(`[creative/imageProvider] aspect '${aspect}' is not a native fal ratio — using nearest '${mapped}' (image will need a crop in the design step)`);
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Env override — see the header for why the synchronous window is safe
// ---------------------------------------------------------------------------

function withModelEnv<T>(overrides: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ---------------------------------------------------------------------------
// createImageProvider
// ---------------------------------------------------------------------------

export function createImageProvider(cfg: CreativeRoleConfig, deps: ImageProviderDeps = {}): ImageProvider {
  if (cfg.provider !== 'fal') {
    throw creativeProviderError(cfg.provider, `image provider requires a role with provider 'fal' (got '${cfg.provider}' for model '${cfg.model}')`);
  }
  const transport = deps.transport ?? defaultTransport;
  const now = deps.now ?? (() => Date.now());
  const falKey = () => deps.falKey ?? process.env.FAL_KEY;
  const kind = (): 'fal' | 'stub' => (falKey() === 'stub' ? 'stub' : 'fal');
  const model = cfg.model;

  // `start` is a Promise: withModelEnv captures the model env SYNCHRONOUSLY (see
  // the module header) and returns the in-flight imageGen promise, which we
  // await here before polling.
  async function run(start: ImageGenStartResult | Promise<ImageGenStartResult>, what: string): Promise<ImageResult> {
    const t0 = now();
    const resolvedStart = await start;
    const poll = await transport.poll(resolvedStart, { intervalMs: deps.pollIntervalMs, timeoutMs: deps.pollTimeoutMs });
    if (poll.status !== 'completed') {
      throw creativeProviderError('fal', `${what} ${poll.status} (model=${model}): ${poll.rawError ?? 'no error detail'}`);
    }
    const urls = poll.imageUrls ?? [];
    if (urls.length === 0) {
      throw creativeProviderError('fal', `${what} completed but returned no image URLs (model=${model})`);
    }
    return { urls, provider: kind(), model, cost_usd: null, latency_ms: Math.max(0, Math.round(now() - t0)) };
  }

  return {
    get kind() {
      return kind();
    },
    model,

    async generate(req) {
      if (!req.prompt.trim()) throw creativeProviderError('fal', 'generate: prompt is empty');
      const n = Math.max(1, Math.min(4, Math.round(req.n)));
      // Text-to-image: no image_urls → imageGenChat resolves the t2i slug from FAL_CHAT_T2I_MODEL_ID.
      const start = withModelEnv({ FAL_CHAT_T2I_MODEL_ID: model }, () =>
        transport.chat({ prompt: req.prompt, imageUrls: [], aspectRatio: mapAspectToFal(req.aspect), numVariations: n }),
      );
      return run(start, `generate(${req.aspect} ×${n})`);
    },

    async edit(req) {
      if (!req.prompt.trim()) throw creativeProviderError('fal', 'edit: prompt is empty');
      if (req.sources.length === 0) throw creativeProviderError('fal', 'edit: sources is empty — an edit needs at least one input image');
      if (req.keepFraming) {
        if (req.sources.length === 1) {
          // The text-removal submit omits aspect_ratio so fal keeps the source
          // framing; FAL_CLEAN_TEXT_PROMPT carries OUR edit prompt for this call.
          const start = withModelEnv({ FAL_CLEAN_TEXT_MODEL_ID: model, FAL_CLEAN_TEXT_PROMPT: req.prompt }, () =>
            transport.textRemoval({ imageUrl: req.sources[0]! }),
          );
          return run(start, 'edit(keepFraming)');
        }
        console.error(
          `[creative/imageProvider] edit: keepFraming requested with ${req.sources.length} sources — only single-source edits can keep framing; re-aspecting to '${req.aspect ?? '1:1'}'`,
        );
      }
      const start = withModelEnv({ FAL_CHAT_MODEL_ID: model }, () =>
        transport.chat({
          prompt: req.prompt,
          imageUrls: req.sources,
          aspectRatio: mapAspectToFal(req.aspect ?? '1:1'),
          numVariations: 1,
        }),
      );
      return run(start, `edit(${req.sources.length} sources)`);
    },

    async combine(req) {
      if (!req.prompt.trim()) throw creativeProviderError('fal', 'combine: prompt is empty');
      if (req.sources.length === 0) throw creativeProviderError('fal', 'combine: sources is empty');
      // Name each input's role in the prompt — nano-banana-pro/edit receives the
      // image array as-is and treats the first as the primary subject.
      const roleList = req.sources.map((s, i) => `image ${i + 1}: ${s.role}`).join('; ');
      const prompt = `${req.prompt}\n\nInput images in order: ${roleList}.`;
      const start = withModelEnv({ FAL_CHAT_MODEL_ID: model }, () =>
        transport.chat({ prompt, imageUrls: req.sources.map((s) => s.url), aspectRatio: '1:1', numVariations: 1 }),
      );
      return run(start, `combine(${req.sources.length} sources)`);
    },

    async removeText(req) {
      if (!req.source) throw creativeProviderError('fal', 'removeText: source is empty');
      // Deliberately does NOT override FAL_CLEAN_TEXT_PROMPT — imageGen.ts's
      // CLEAN_TEXT_PROMPT is tuned + verified on real listing photos.
      const start = withModelEnv({ FAL_CLEAN_TEXT_MODEL_ID: model }, () => transport.textRemoval({ imageUrl: req.source }));
      return run(start, 'removeText');
    },
  };
}

// ---------------------------------------------------------------------------
// resolveImageProvider — config from mos_settings.ai_roles (60 s cache)
// ---------------------------------------------------------------------------

export async function resolveImageProvider(
  roleKey: ImageRoleKey,
  sb: SettingsClient,
  deps: ImageProviderDeps = {},
): Promise<ImageProvider> {
  if (!isImageRoleKey(roleKey)) {
    // Unreachable given the type, but the runtime guard costs nothing and fails loudly.
    throw creativeProviderError('settings', `resolveImageProvider: '${String(roleKey)}' is not an image role`);
  }
  const roles = await resolveCreativeRoles(sb);
  const cfg = roles[roleKey];
  if (cfg.provider !== 'fal') {
    throw creativeProviderError(cfg.provider, `ai_roles.${roleKey} resolved to provider '${cfg.provider}' — image roles must use provider 'fal' (model '${cfg.model}')`);
  }
  return createImageProvider(cfg, deps);
}
