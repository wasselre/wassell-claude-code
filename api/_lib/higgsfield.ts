/**
 * Higgsfield Soul-API adapter.
 *
 * Two phase wrappers used by `api/marketing/generate.ts`:
 *
 *   - `higgsfieldCleanup`: takes a raw building photo + cleanup prompt,
 *     returns a request id + status URL the orchestrator polls.
 *   - `higgsfieldDesign`:  takes the cleaned photo + reference image +
 *     Wassel logo + design prompt, returns the same shape.
 *
 * `pollHiggsfield` walks a status URL until completion / failure /
 * timeout. Both phases use the same poller.
 *
 * **Stub mode.** When `HIGGSFIELD_API_KEY === 'stub'` the adapter skips
 * the network entirely and returns canned URLs after a short sleep —
 * needed for offline dev + CI. Final URLs point at `picsum.photos` for
 * the cleaned + final assets so the form renders something visible.
 *
 * Environment variables (all server-side only):
 *
 *   HIGGSFIELD_API_KEY      — secret key half of Higgsfield's auth pair.
 *   HIGGSFIELD_API_SECRET   — secret key second half.
 *   HIGGSFIELD_BASE_URL     — defaults to https://platform.higgsfield.ai
 *   HIGGSFIELD_MODEL_ID     — defaults to higgsfield-ai/soul/standard
 *
 * The exact request shape is intentionally light because Higgsfield's
 * public docs don't specify reference-image params or webhook hooks.
 * Confirm + adjust the request body against the sandbox API once
 * credentials are available — see open risks in the project plan.
 */

const STUB_KEY = 'stub';

const STUB_DELAY_MS = 2000;
const STUB_CLEANED_URL = 'https://picsum.photos/seed/wassel-cleaned/1024/1024';
const STUB_EDITED_URL = 'https://picsum.photos/seed/wassel-edited/1024/1024';
const STUB_FINAL_URL = 'https://picsum.photos/seed/wassel-final/1024/1024';

export interface HiggsfieldStartResult {
  requestId: string;
  statusUrl: string;
}

export interface HiggsfieldPollResult {
  status: 'completed' | 'failed' | 'nsfw';
  imageUrls?: string[];
  rawError?: string;
}

interface HiggsfieldEnv {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  modelId: string;
}

function readEnv(): HiggsfieldEnv {
  const apiKey = process.env.HIGGSFIELD_API_KEY;
  const apiSecret = process.env.HIGGSFIELD_API_SECRET;
  if (!apiKey) {
    throw new Error('HIGGSFIELD_API_KEY is not set');
  }
  if (!apiSecret && apiKey !== STUB_KEY) {
    throw new Error('HIGGSFIELD_API_SECRET is required when HIGGSFIELD_API_KEY is not "stub"');
  }
  return {
    apiKey,
    apiSecret: apiSecret ?? '',
    baseUrl: process.env.HIGGSFIELD_BASE_URL ?? 'https://platform.higgsfield.ai',
    modelId: process.env.HIGGSFIELD_MODEL_ID ?? 'higgsfield-ai/soul/standard',
  };
}

function authHeader(env: HiggsfieldEnv): string {
  return `Key ${env.apiKey}:${env.apiSecret}`;
}

interface CleanupOpts {
  rawPhotoUrl: string;
  cleanupPrompt: string;
  signal?: AbortSignal;
}

/**
 * Phase 1. Takes the raw uploaded building photograph + a cleanup prompt
 * and returns a Higgsfield request id + status URL the caller polls.
 *
 * Stub mode: returns a canned `requestId` + `statusUrl` immediately;
 * `pollHiggsfield` recognises stub URLs and returns the canned cleaned
 * image without doing any network I/O.
 */
export async function higgsfieldCleanup(opts: CleanupOpts): Promise<HiggsfieldStartResult> {
  const env = readEnv();
  if (env.apiKey === STUB_KEY) {
    return {
      requestId: `stub-cleanup-${crypto.randomUUID()}`,
      statusUrl: 'stub://cleanup',
    };
  }
  return startGeneration(env, {
    prompt: opts.cleanupPrompt,
    image_url: opts.rawPhotoUrl,
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
 * Phase 2. Takes the cleaned photo + an editing prompt and returns
 * the request id + status URL. The editing prompt typically asks the
 * model to regenerate a new camera angle of the same building (or
 * apply other photographic adjustments) while preserving the
 * architectural identity. Same wire shape as cleanup — just a
 * different intent at the prompt level.
 */
export async function higgsfieldEditing(opts: EditingOpts): Promise<HiggsfieldStartResult> {
  const env = readEnv();
  if (env.apiKey === STUB_KEY) {
    return {
      requestId: `stub-editing-${crypto.randomUUID()}`,
      statusUrl: 'stub://editing',
    };
  }
  return startGeneration(env, {
    prompt: opts.editingPrompt,
    image_url: opts.cleanedPhotoUrl,
    signal: opts.signal,
    phase: 'editing',
  });
}

interface DesignOpts {
  /**
   * The phase-2 EDITED photo (not the cleaned one). The design phase
   * composites this hero shot into the layout, so it should already
   * have the right camera angle / lighting.
   */
  editedPhotoUrl: string;
  referenceImageUrl: string;
  logoUrl: string;
  designPrompt: string;
  signal?: AbortSignal;
}

/**
 * Phase 3. Takes the EDITED photo (phase-2 output) + the template's
 * reference image + the Wassel logo URL + the design prompt (already
 * substituted with the template's variable values) and returns the
 * request id + status URL.
 *
 * Reference image and logo are passed as separate inputs so the model
 * can use one as the visual target and the other as a brand asset to
 * composite. The exact field names depend on Higgsfield's contract; we
 * pick reasonable defaults and document the adjustment point.
 */
export async function higgsfieldDesign(opts: DesignOpts): Promise<HiggsfieldStartResult> {
  const env = readEnv();
  if (env.apiKey === STUB_KEY) {
    return {
      requestId: `stub-design-${crypto.randomUUID()}`,
      statusUrl: 'stub://design',
    };
  }
  return startGeneration(env, {
    prompt: opts.designPrompt,
    image_url: opts.editedPhotoUrl,
    reference_image_url: opts.referenceImageUrl,
    logo_url: opts.logoUrl,
    signal: opts.signal,
    phase: 'design',
  });
}

/**
 * Shared start helper for all three phases. Per Higgsfield's docs the
 * model id is part of the URL path, NOT the body — the body carries
 * `prompt` (required) plus `aspect_ratio` / `resolution` (defaults
 * applied here) plus any image inputs the model accepts.
 *
 * The image input field names (`image_url`, `reference_image_url`,
 * `logo_url`) are best-effort: Higgsfield's public docs explicitly
 * cover only text-to-image, so any image fields we send may be
 * silently ignored by the model. Phase 1 / Phase 2 are likely to
 * generate-from-text only until Higgsfield publishes their image-to-
 * image schema (or we discover it by experiment). The user will see a
 * generated image either way; whether it incorporates the input photo
 * depends on the model's actual capabilities.
 */
async function startGeneration(
  env: HiggsfieldEnv,
  opts: {
    prompt: string;
    image_url?: string;
    reference_image_url?: string;
    logo_url?: string;
    signal?: AbortSignal;
    phase: 'cleanup' | 'editing' | 'design';
  },
): Promise<HiggsfieldStartResult> {
  // Drop any leading slash in modelId so the URL composes cleanly.
  const modelPath = env.modelId.startsWith('/') ? env.modelId.slice(1) : env.modelId;
  const url = `${env.baseUrl.replace(/\/$/, '')}/${modelPath}`;

  // Body: documented fields first, image inputs second (might be no-ops
  // for text-only models — sent on the chance Soul accepts them).
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    aspect_ratio: '1:1',
    resolution: '1080p',
  };
  if (opts.image_url) body.image_url = opts.image_url;
  if (opts.reference_image_url) body.reference_image_url = opts.reference_image_url;
  if (opts.logo_url) body.logo_url = opts.logo_url;

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
    throw new Error(`Higgsfield ${opts.phase} start failed (${res.status}): ${errBody.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    request_id?: string;
    status_url?: string;
    cancel_url?: string;
    status?: string;
  };
  const requestId = json.request_id ?? '';
  // status_url is documented; if absent fall back to constructing one
  // from request_id at the documented GET /requests/{id}/status path.
  const statusUrl =
    json.status_url ??
    (requestId ? `${env.baseUrl.replace(/\/$/, '')}/requests/${requestId}/status` : '');
  if (!requestId || !statusUrl) {
    throw new Error(`Higgsfield ${opts.phase} response missing request_id or status_url: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return { requestId, statusUrl };
}

interface PollOpts {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Polls a Higgsfield status URL until terminal. Returns
 * `{ status: 'completed' | 'failed' | 'nsfw', imageUrls?, rawError? }`.
 * Throws on timeout. In stub mode (`statusUrl` starting with `stub://`)
 * waits `STUB_DELAY_MS` then returns a canned cleaned/final URL based
 * on which phase the stub session is for.
 */
export async function pollHiggsfield(
  statusUrl: string,
  opts: PollOpts = {},
): Promise<HiggsfieldPollResult> {
  const intervalMs = opts.intervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  if (statusUrl.startsWith('stub://')) {
    await new Promise((r) => setTimeout(r, STUB_DELAY_MS));
    const phase = statusUrl.slice('stub://'.length);
    const stubByPhase: Record<string, string> = {
      cleanup: STUB_CLEANED_URL,
      editing: STUB_EDITED_URL,
      design: STUB_FINAL_URL,
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
    const res = await fetch(statusUrl, {
      headers: { Authorization: authHeader(env) },
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Higgsfield poll failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      status?: string;
      // Per Higgsfield docs the completed shape is { images: [{ url }], video: { url } }
      images?: Array<{ url?: string }>;
      video?: { url?: string };
      // Plus older / undocumented shapes we tolerate
      output?: unknown;
      error?: string;
      detail?: string;
    };
    const status = (json.status ?? '').toLowerCase();
    if (status === 'completed' || status === 'succeeded') {
      const fromImages = Array.isArray(json.images)
        ? json.images.map((i) => i?.url).filter((u): u is string => typeof u === 'string')
        : [];
      const fromVideo = json.video?.url ? [json.video.url] : [];
      const fromOutput = extractImageUrls(json.output);
      const urls = [...fromImages, ...fromVideo, ...fromOutput];
      return { status: 'completed', imageUrls: urls };
    }
    if (status === 'failed' || status === 'error') {
      return { status: 'failed', rawError: json.error ?? json.detail ?? 'unknown error' };
    }
    if (status === 'nsfw' || status === 'content_policy_violation') {
      return { status: 'nsfw', rawError: json.error ?? json.detail ?? 'flagged content' };
    }
    // queued | in_progress | starting → keep waiting
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Higgsfield poll timed out');
}

/**
 * Higgsfield's docs are loose about the output shape — could be a top-
 * level URL string, a `{ images: [...] }` object, or an array. Try a
 * few common shapes and bail with an empty list rather than throwing.
 */
function extractImageUrls(output: unknown): string[] {
  if (typeof output === 'string') return [output];
  if (Array.isArray(output)) {
    return output.filter((x): x is string => typeof x === 'string');
  }
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    const images = obj.images;
    if (Array.isArray(images)) {
      return images
        .map((x) => (typeof x === 'string' ? x : (x && typeof x === 'object' && 'url' in x ? String((x as { url: unknown }).url) : null)))
        .filter((x): x is string => !!x);
    }
    if (typeof obj.url === 'string') return [obj.url];
  }
  return [];
}
