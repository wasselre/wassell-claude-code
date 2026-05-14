/**
 * Image generation adapter — fal.ai's `nano-banana-pro/edit`
 * (Google's Gemini 3 Pro Image, aka "Nano Banana 2").
 *
 * Replaces the previous Higgsfield Soul adapter because:
 *   1. nano-banana-pro/edit accepts an ARRAY of input images, so the
 *      design phase can finally pass building photo + reference
 *      layout + Wassel logo together (Higgsfield Soul accepted only
 *      one `image_reference`).
 *   2. It's an actual image-edit model, not a style-reference model —
 *      the cleanup phase can literally edit the input photo.
 *
 * Three thin wrappers used by `api/marketing/generate.ts`:
 *
 *   - `imageGenCleanup`: raw photo + cleanup prompt → cleaned photo.
 *   - `imageGenEditing`: cleaned photo + editing prompt → edited photo.
 *   - `imageGenDesign`:  edited photo + reference layout + logo +
 *                        design prompt → final design.
 *
 * `pollImageGen` walks the queue's status URL until the request
 * terminates, then fetches the final result from the response URL.
 *
 * **Stub mode.** When `FAL_KEY === 'stub'` the adapter skips the
 * network and returns canned URLs after a short sleep — needed for
 * offline dev + CI.
 *
 * Environment variables (server-side only):
 *
 *   FAL_KEY        — your fal.ai API key (https://fal.ai/dashboard/keys)
 *   FAL_BASE_URL   — defaults to https://queue.fal.run
 *   FAL_MODEL_ID   — defaults to fal-ai/nano-banana-pro/edit. Swap to
 *                    `fal-ai/nano-banana/edit` for the v1 model.
 */

const STUB_KEY = 'stub';

const STUB_DELAY_MS = 2000;
const STUB_CLEANED_URL = 'https://picsum.photos/seed/wassel-cleaned/1024/1024';
const STUB_EDITED_URL = 'https://picsum.photos/seed/wassel-edited/1024/1024';
const STUB_FINAL_URL = 'https://picsum.photos/seed/wassel-final/1024/1024';
const STUB_ICON_URL = 'https://picsum.photos/seed/wassel-icon/512/512';

export interface ImageGenStartResult {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
}

export interface ImageGenPollResult {
  status: 'completed' | 'failed' | 'nsfw';
  imageUrls?: string[];
  rawError?: string;
}

interface FalEnv {
  apiKey: string;
  baseUrl: string;
  modelId: string;
}

function readEnv(): FalEnv {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new Error('FAL_KEY is not set');
  }
  return {
    apiKey,
    baseUrl: process.env.FAL_BASE_URL ?? 'https://queue.fal.run',
    modelId: process.env.FAL_MODEL_ID ?? 'fal-ai/nano-banana-pro/edit',
  };
}

/**
 * Read env vars specific to the icon-generation pipeline. Reuses
 * FAL_KEY / FAL_BASE_URL but uses a separate model ID so the marketing-
 * deck flow (nano-banana-pro/edit) and the icon flow (recraft-v3,
 * text-to-image) don't fight over a single env var.
 */
function readIconEnv(): FalEnv {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new Error('FAL_KEY is not set');
  }
  return {
    apiKey,
    baseUrl: process.env.FAL_BASE_URL ?? 'https://queue.fal.run',
    modelId: process.env.FAL_ICON_MODEL_ID ?? 'fal-ai/recraft-v3',
  };
}

function authHeader(env: FalEnv): string {
  return `Key ${env.apiKey}`;
}

interface CleanupOpts {
  rawPhotoUrl: string;
  cleanupPrompt: string;
  signal?: AbortSignal;
}

/**
 * Phase 1. Edit the raw building photograph using the cleanup prompt.
 * nano-banana-pro will preserve the building's identity and apply the
 * removals/reconstructions the prompt asks for.
 */
export async function imageGenCleanup(opts: CleanupOpts): Promise<ImageGenStartResult> {
  const env = readEnv();
  if (env.apiKey === STUB_KEY) {
    return stubStart('cleanup');
  }
  return startGeneration(env, {
    prompt: opts.cleanupPrompt,
    imageUrls: [opts.rawPhotoUrl],
    signal: opts.signal,
    phase: 'cleanup',
  });
}

interface EditingOpts {
  cleanedPhotoUrl: string;
  editingPrompt: string;
  signal?: AbortSignal;
}

/**
 * Phase 2. Take the cleaned photo and regenerate a new camera angle
 * (or apply other photographic edits) per the editing prompt.
 */
export async function imageGenEditing(opts: EditingOpts): Promise<ImageGenStartResult> {
  const env = readEnv();
  if (env.apiKey === STUB_KEY) {
    return stubStart('editing');
  }
  return startGeneration(env, {
    prompt: opts.editingPrompt,
    imageUrls: [opts.cleanedPhotoUrl],
    signal: opts.signal,
    phase: 'editing',
  });
}

interface DesignOpts {
  /** The phase-2 EDITED photo (the hero building shot). */
  editedPhotoUrl: string;
  /** Layout reference — an existing finished Wassel post. */
  referenceImageUrl: string;
  /** Wassel logo asset. */
  logoUrl: string;
  designPrompt: string;
  signal?: AbortSignal;
}

/**
 * Phase 3. Composite the edited photo + reference layout + logo into
 * a finished Wassel social post per the design prompt. nano-banana-
 * pro's multi-image input lets it pull visual identity from each
 * source separately rather than guessing from text alone.
 *
 * Image order: [edited_photo, reference_layout, logo]. The prompt
 * explicitly tells the model which image plays which role.
 */
export async function imageGenDesign(opts: DesignOpts): Promise<ImageGenStartResult> {
  const env = readEnv();
  if (env.apiKey === STUB_KEY) {
    return stubStart('design');
  }
  return startGeneration(env, {
    prompt: opts.designPrompt,
    imageUrls: [opts.editedPhotoUrl, opts.referenceImageUrl, opts.logoUrl].filter((u): u is string => !!u),
    signal: opts.signal,
    phase: 'design',
  });
}

interface IconOpts {
  /** Free-form description ("rooftop swimming pool") OR a curated noun. */
  prompt: string;
  /**
   * Recraft style. Defaults to `vector_illustration` — clean line/shape
   * vector graphics that read well at small sizes and pair with Wassel's
   * flat copper-on-cream brand. Other valid recraft-v3 styles include
   * `vector_illustration/line_art`, `digital_illustration`, etc.
   * recraft-v3 rejects `icon/*` subtypes (validation error) — those live
   * on a different recraft model.
   */
  style?: string;
  signal?: AbortSignal;
}

/**
 * Text-to-image generation tuned for the project_details icon picker.
 * Wraps recraft-v3 (text-to-image, no input image) and returns the same
 * tracking shape as the marketing-deck phases. The `imageGenIcon` /
 * `pollImageGen` pair drives the `/api/icons/generate` endpoint.
 *
 * Per CLAUDE.md "Silent Failures": this throws loudly on any fal.ai
 * non-2xx and returns `status: 'failed'` (with the error body) when the
 * queue reports FAILED — never swallow.
 */
export async function imageGenIcon(opts: IconOpts): Promise<ImageGenStartResult> {
  const env = readIconEnv();
  if (env.apiKey === STUB_KEY) {
    return stubStart('icon');
  }
  return startTextToImage(env, {
    prompt: opts.prompt,
    style: opts.style ?? 'vector_illustration',
    signal: opts.signal,
    phase: 'icon',
  });
}

/**
 * Submit a text-to-image request to fal.ai's queue (recraft-v3 shape:
 * `{ prompt, style, image_size }`, no `image_urls`). Returns the same
 * tracking URLs as the edit-flow `startGeneration`.
 */
async function startTextToImage(
  env: FalEnv,
  opts: {
    prompt: string;
    style: string;
    signal?: AbortSignal;
    phase: 'icon';
  },
): Promise<ImageGenStartResult> {
  const modelPath = env.modelId.startsWith('/') ? env.modelId.slice(1) : env.modelId;
  const url = `${env.baseUrl.replace(/\/$/, '')}/${modelPath}`;

  const body = {
    prompt: opts.prompt,
    style: opts.style,
    image_size: 'square_hd',
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authHeader(env),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Image-gen ${opts.phase} start failed (${res.status}): ${errBody.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    request_id?: string;
    status_url?: string;
    response_url?: string;
  };
  const requestId = json.request_id ?? '';
  const statusUrl = json.status_url ?? '';
  const responseUrl = json.response_url ?? '';
  if (!requestId || !statusUrl || !responseUrl) {
    throw new Error(
      `Image-gen ${opts.phase} response missing request_id/status_url/response_url: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return { requestId, statusUrl, responseUrl };
}

/**
 * Submit a generation request to fal.ai's queue API. Returns the
 * tracking URLs the poller uses.
 */
async function startGeneration(
  env: FalEnv,
  opts: {
    prompt: string;
    imageUrls: string[];
    signal?: AbortSignal;
    phase: 'cleanup' | 'editing' | 'design';
  },
): Promise<ImageGenStartResult> {
  const modelPath = env.modelId.startsWith('/') ? env.modelId.slice(1) : env.modelId;
  const url = `${env.baseUrl.replace(/\/$/, '')}/${modelPath}`;

  const body = {
    prompt: opts.prompt,
    image_urls: opts.imageUrls,
    num_images: 1,
    aspect_ratio: '1:1',
    output_format: 'png',
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authHeader(env),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Image-gen ${opts.phase} start failed (${res.status}): ${errBody.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    status?: string;
    request_id?: string;
    status_url?: string;
    response_url?: string;
    cancel_url?: string;
  };
  const requestId = json.request_id ?? '';
  const statusUrl = json.status_url ?? '';
  const responseUrl = json.response_url ?? '';
  if (!requestId || !statusUrl || !responseUrl) {
    throw new Error(
      `Image-gen ${opts.phase} response missing request_id/status_url/response_url: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return { requestId, statusUrl, responseUrl };
}

interface PollOpts {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Polls fal.ai's queue until terminal, then fetches the final result.
 *
 * fal.ai's queue is two-step: status_url returns just `{ status }`,
 * and response_url is where the actual model output (images) lives.
 * We poll status until COMPLETED/FAILED, then fetch response on
 * success.
 *
 * Stub mode (`statusUrl` starting with `stub://`) waits STUB_DELAY_MS
 * and returns a canned URL based on phase.
 */
export async function pollImageGen(
  start: ImageGenStartResult,
  opts: PollOpts = {},
): Promise<ImageGenPollResult> {
  const intervalMs = opts.intervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  if (start.statusUrl.startsWith('stub://')) {
    await new Promise((r) => setTimeout(r, STUB_DELAY_MS));
    const phase = start.statusUrl.slice('stub://'.length);
    const stubByPhase: Record<string, string> = {
      cleanup: STUB_CLEANED_URL,
      editing: STUB_EDITED_URL,
      design: STUB_FINAL_URL,
      icon: STUB_ICON_URL,
    };
    return {
      status: 'completed',
      imageUrls: [stubByPhase[phase] ?? STUB_CLEANED_URL],
    };
  }

  const env = readEnv();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new Error('poll aborted');
    }
    const res = await fetch(start.statusUrl, {
      headers: { Authorization: authHeader(env) },
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Image-gen poll failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      status?: string;
      error?: string;
      detail?: string;
      logs?: Array<{ message?: string }>;
    };
    const status = (json.status ?? '').toUpperCase();
    if (status === 'COMPLETED') {
      // Fetch the actual result from the response URL.
      const resultRes = await fetch(start.responseUrl, {
        headers: { Authorization: authHeader(env) },
        signal: opts.signal,
      });
      if (!resultRes.ok) {
        const body = await resultRes.text().catch(() => '');
        throw new Error(`Image-gen response fetch failed (${resultRes.status}): ${body.slice(0, 300)}`);
      }
      const resultJson = (await resultRes.json()) as {
        images?: Array<{ url?: string }>;
        description?: string;
      };
      const urls = (resultJson.images ?? [])
        .map((i) => i?.url)
        .filter((u): u is string => typeof u === 'string');
      return { status: 'completed', imageUrls: urls };
    }
    if (status === 'FAILED' || status === 'ERROR') {
      const lastLog = json.logs?.[json.logs.length - 1]?.message;
      return { status: 'failed', rawError: json.error ?? json.detail ?? lastLog ?? 'unknown error' };
    }
    if (status === 'NSFW' || status === 'CONTENT_POLICY_VIOLATION') {
      return { status: 'nsfw', rawError: json.error ?? json.detail ?? 'flagged content' };
    }
    // IN_QUEUE | IN_PROGRESS → keep waiting
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Image-gen poll timed out');
}

function stubStart(phase: 'cleanup' | 'editing' | 'design' | 'icon'): ImageGenStartResult {
  const id = `stub-${phase}-${crypto.randomUUID()}`;
  return {
    requestId: id,
    statusUrl: `stub://${phase}`,
    responseUrl: `stub://${phase}`,
  };
}
