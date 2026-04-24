/**
 * Server-side typed wrapper around the Hatif REST API (https://api.voxa.sa).
 *
 * Never imported from `src/*` — the client secret lives in
 * `process.env.HATIF_CLIENT_SECRET` and the browser must never see it. All
 * browser-initiated calls flow through an `api/hatif/*` handler which then
 * calls the helpers here.
 *
 * Auth: OAuth2 client-credentials. The /connect/token response carries an
 * `expires_in` (seconds); we cache the access_token in-memory across
 * invocations of the same Edge isolate with a 60-sec safety buffer. On 401
 * we invalidate and fetch a fresh token once.
 *
 * This module is intentionally tiny on v1 — it exposes only what we need to
 * (a) verify channel config at boot, and (b) list calls for a phone on demand
 * (future). The source of truth for call data is the webhook in
 * api/webhook/hatif-call.ts writing to the `call_logs` table; the REST API is
 * only a fallback / debug tool.
 */

const BASE_URL = 'https://api.voxa.sa';

export class HatifError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

interface TokenCache {
  accessToken: string;
  expiresAtMs: number;
}

let tokenCache: TokenCache | null = null;

function clientCredentials(): { id: string; secret: string } {
  const id = process.env.HATIF_CLIENT_ID;
  const secret = process.env.HATIF_CLIENT_SECRET;
  if (!id || !secret) {
    throw new HatifError(500, 'HATIF_CLIENT_ID and HATIF_CLIENT_SECRET must be set');
  }
  return { id, secret };
}

/** Default channel id (from env). Used when the caller doesn't specify one. */
export function defaultChannelId(): string | null {
  return process.env.HATIF_DEFAULT_CHANNEL_ID ?? null;
}

/**
 * Fetch an access token. Cached for its lifetime minus a 60-sec safety buffer,
 * so concurrent callers in the same Edge isolate share a single token.
 * Pass `force: true` to bypass the cache after a 401.
 */
async function getAccessToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && tokenCache && tokenCache.expiresAtMs > now) {
    return tokenCache.accessToken;
  }

  const { id, secret } = clientCredentials();
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    grant_type: 'client_credentials',
    scope: 'VoxaAPI',
  });

  const res = await fetch(`${BASE_URL}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    let err: unknown;
    try { err = await res.json(); } catch { err = await res.text().catch(() => null); }
    throw new HatifError(res.status, `Hatif /connect/token failed: ${res.status}`, err);
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  const token = json.access_token;
  const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  if (!token) throw new HatifError(502, 'Hatif /connect/token returned no access_token', json);

  tokenCache = {
    accessToken: token,
    expiresAtMs: now + Math.max(0, expiresInSec - 60) * 1000,
  };
  return token;
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401 && !retried) {
    // Invalidate cache and retry once. Covers rotated secrets / expiry races.
    tokenCache = null;
    return request<T>(path, init, true);
  }
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
    throw new HatifError(res.status, `Hatif ${init.method ?? 'GET'} ${path} failed: ${res.status}`, body);
  }
  return (await res.json()) as T;
}

// ─── Types ─────────────────────────────────────────────────────────
// Only the shapes we currently consume. Extend as endpoints land.

export interface HatifChannel {
  id: string;
  name: string;
  type: number;              // 1 = Phone, 2 = WhatsApp, 3 = Phone+WhatsApp
  phoneNumber: string;
  postCallWebhookUrl: string | null;
  workspaceId: string;
}

// ─── Endpoints ─────────────────────────────────────────────────────

export async function listChannels(): Promise<HatifChannel[]> {
  const raw = await request<{ items?: HatifChannel[]; totalCount?: number } | HatifChannel[]>(
    `/v1/channels/service-account?SkipCount=0&MaxResultCount=50`,
  );
  return Array.isArray(raw) ? raw : (raw.items ?? []);
}

// ─── Outbound IVR ──────────────────────────────────────────────────

export interface HatifIvrOption {
  digit: string;
  label: string;
}

export interface TriggerIvrInput {
  channelId: string;
  destinationNumber: string;
  webhookUrl: string;
  options: HatifIvrOption[];
  ttsText?: string;
  ttsVoice?: 'Male' | 'Female';
  audioFileUrl?: string;
  externalId?: string;
}

export interface TriggerIvrResult {
  ivrCallId?: string;
  raw: Record<string, unknown>;
}

/**
 * Trigger an outbound IVR call on Hatif. Exactly one of `ttsText` or
 * `audioFileUrl` must be supplied; Hatif rejects both / neither.
 */
export async function triggerOutboundIvr(input: TriggerIvrInput): Promise<TriggerIvrResult> {
  if (!input.channelId) throw new HatifError(400, 'channelId is required');
  if (!input.destinationNumber) throw new HatifError(400, 'destinationNumber is required');
  if (!input.webhookUrl) throw new HatifError(400, 'webhookUrl is required');
  if (!input.options || input.options.length === 0) {
    throw new HatifError(400, 'options must contain at least one entry');
  }
  const hasTts = !!input.ttsText;
  const hasAudio = !!input.audioFileUrl;
  if (hasTts === hasAudio) {
    throw new HatifError(400, 'exactly one of ttsText or audioFileUrl is required');
  }

  // Hatif's IVR endpoint accepts E.164 WITHOUT the leading '+'. The example in
  // the doc is `"9665xxxxxxxx"`, and trialed payloads with '+' get 400'd. Our
  // internal canonical form is `+9665...`, so strip the sign here at the
  // adapter boundary — nowhere else should do this.
  const destination = input.destinationNumber.startsWith('+')
    ? input.destinationNumber.slice(1)
    : input.destinationNumber;

  const payload: Record<string, unknown> = {
    channelId: input.channelId,
    destinationNumber: destination,
    webhookUrl: input.webhookUrl,
    options: input.options,
  };
  if (hasTts) {
    payload.ttsText = input.ttsText;
    payload.ttsVoice = input.ttsVoice ?? 'Female';
  } else {
    payload.audioFileUrl = input.audioFileUrl;
  }
  if (input.externalId) payload.externalId = input.externalId;

  const raw = await request<Record<string, unknown>>(`/v1/outbound-ivr`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  // Hatif's exact response shape for this endpoint isn't explicitly pinned in
  // the docs — check every field Hatif has used for call ids elsewhere.
  const ivrCallId =
    (raw.id as string | undefined) ??
    (raw.callId as string | undefined) ??
    (raw.ivrCallId as string | undefined) ??
    (raw.outboundIvrId as string | undefined);
  return { ivrCallId, raw };
}

// ─── Audio upload (passthrough) ────────────────────────────────────

/**
 * Upload an audio file to Hatif. The caller supplies the already-built
 * multipart/form-data FormData — we just attach the bearer token and forward.
 * Returns whatever Hatif returns (typically { url: "..." } or a plain string).
 */
export async function uploadAudioFile(form: FormData): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}/v1/support/upload-audio`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },   // DO NOT set Content-Type; fetch handles boundary
    body: form,
  });
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
    throw new HatifError(res.status, `Hatif /v1/support/upload-audio failed: ${res.status}`, body);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as Record<string, unknown>;
  return { url: (await res.text()).trim() };
}

// ─── Enum maps shared with the webhook handler ─────────────────────
// Hatif's webhook payload encodes status/sentiment as integers. Centralize
// the mapping here so the webhook handler and any future REST consumers can
// both convert to the normalized string enums defined in src/types.

export function mapCallStatus(code: number): import('../../src/types').CallStatus {
  switch (code) {
    case 0: return 'active';
    case 1: return 'completed';
    case 2: return 'missed';
    case 3: return 'rejected_by_caller';
    case 4: return 'rejected_by_callee';
    case 5: return 'no_answer';
    case 6: return 'cancelled';
    case 7: return 'failed';
    case 8: return 'ringing';
    default: return 'failed';
  }
}

export function mapCallDirection(code: number): import('../../src/types').CallDirection {
  return code === 1 ? 'inbound' : 'outbound';
}

export function mapCallSentiment(code: number | null | undefined): import('../../src/types').CallSentiment | null {
  if (code == null) return null;
  switch (code) {
    case 1: return 'positive';
    case 2: return 'neutral';
    case 3: return 'negative';
    case 4: return 'mixed';
    case 5: return 'unknown';
    default: return null;
  }
}

/**
 * Parse Hatif's "HH:MM:SS" callLength into seconds. Returns null on malformed
 * input so the row still inserts — the raw event is preserved in `raw_event`
 * for forensics.
 */
export function parseCallLengthSeconds(callLength: string | null | undefined): number | null {
  if (!callLength) return null;
  const parts = callLength.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

/**
 * Normalize a raw phone value to canonical E.164 without the `+` sign, then
 * add it back. Matches src/lib/phone.ts#normalizePhone — duplicated here
 * because api/* can't import from src/*. Keep in sync.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7) return null;
  if (hasPlus) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0')) return `+966${digits.slice(1)}`;
  if (digits.startsWith('966')) return `+${digits}`;
  return `+966${digits}`;
}

/**
 * HMAC-SHA256 signature verification for Hatif webhook requests. Expected
 * header is `X-Voxa-Signature` containing the lowercase hex digest of
 * HMAC-SHA256(webhookSecret, rawBody). Uses Web Crypto (available in Edge
 * runtime) with a constant-time comparison.
 */
export async function verifyHatifSignature(
  rawBody: string,
  receivedHex: string,
  secret: string,
): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const bytes = new Uint8Array(sig);
  const expectedHex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return constantTimeEqualHex(expectedHex, receivedHex.trim().toLowerCase());
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
