/**
 * Server-side typed wrapper around the Maqsam REST API.
 *
 * Maqsam is the SECOND telephony provider (added 2026-07-22): it carries the
 * AI-agent calls on its own dedicated number, while Hatif keeps carrying the
 * human sales-agent calls. Both providers land their calls in the SAME
 * `call_logs` + `phone_calls` pipeline; rows are distinguished by the
 * `call_logs.provider` column ('hatif' | 'maqsam').
 *
 * Never imported from `src/*` — `MAQSAM_ACCESS_SECRET` lives server-side only.
 *
 * Auth: HTTP Basic (`access_key_id:access_secret`), generated in the Maqsam
 * portal under Account Settings → API Credentials. API access itself must be
 * enabled by support@maqsam.com on the account first.
 *
 * Docs (public): https://maqsam.com/apis
 *   - Calls API v3:      https://portal.maqsam.com/docs/v3/calls
 *   - Recordings API v1: https://portal.maqsam.com/docs/v1/recordings
 *
 * NOTE (pre-activation): this module was written against Maqsam's public docs
 * BEFORE our account existed, so a few shapes are marked UNVERIFIED below.
 * Verify each against the live account during onboarding, then delete the
 * marker comments.
 */

const DEFAULT_BASE_URL = 'https://api.maqsam.com';

export class MaqsamError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

function baseUrl(): string {
  return (process.env.MAQSAM_API_BASE ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

function basicAuthHeader(): string {
  const id = process.env.MAQSAM_ACCESS_KEY_ID;
  const secret = process.env.MAQSAM_ACCESS_SECRET;
  if (!id || !secret) {
    throw new MaqsamError(500, 'MAQSAM_ACCESS_KEY_ID and MAQSAM_ACCESS_SECRET must be set');
  }
  return `Basic ${btoa(`${id}:${secret}`)}`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
    throw new MaqsamError(res.status, `Maqsam ${init.method ?? 'GET'} ${path} failed: ${res.status}`, body);
  }
  return (await res.json()) as T;
}

// ─── Types (from the public Calls API v3 doc) ──────────────────────

export interface MaqsamAgentRef {
  email?: string | null;
  name?: string | null;
}

/**
 * A call object as returned by Calls API v3. Timestamp field names are
 * UNVERIFIED (the public doc lists filters `start_time`/`end_time` but not the
 * response field) — we accept the plausible variants at the ingest layer.
 */
export interface MaqsamCall {
  id: number | string;
  referenceId?: string | null;
  caller?: string | null;
  callee?: string | null;
  callerNumber?: string | null;
  calleeNumber?: string | null;
  type?: string | null;        // inbound | outbound | internal | campaign
  state?: string | null;       // serviced | dropped | abandoned | failed | completed | in_progress
  duration?: number | null;    // seconds
  agents?: MaqsamAgentRef[] | null;
  sentiment?: string | null;   // positive | negative | neutral
  summary?: string | null;
  transcription?: unknown;     // text (shape UNVERIFIED — may be string or object)
  // Timestamp variants — whichever the live API actually sends.
  time?: string | number | null;
  timestamp?: string | number | null;
  createdAt?: string | null;
  created_at?: string | null;
  startTime?: string | null;
  start_time?: string | null;
}

// ─── Endpoints ─────────────────────────────────────────────────────

/** GET a single call by Maqsam id or by our referenceId. */
export async function getCall(opts: { id?: string | number; referenceId?: string }): Promise<MaqsamCall> {
  if (opts.id != null) {
    const raw = await request<{ call?: MaqsamCall } | MaqsamCall>(`/v3/calls/id/${opts.id}`);
    return unwrapCall(raw);
  }
  if (opts.referenceId) {
    const raw = await request<{ call?: MaqsamCall } | MaqsamCall>(`/v3/calls/reference_id/${opts.referenceId}`);
    return unwrapCall(raw);
  }
  throw new MaqsamError(400, 'getCall requires id or referenceId');
}

/**
 * GET the paginated call list (max 100/page per the doc). The `start_time`
 * filter FORMAT is UNVERIFIED (epoch vs ISO) — callers that need a time window
 * should also be prepared to just page from page 1 (list is assumed
 * newest-first; also UNVERIFIED).
 */
export async function listCalls(params: {
  page?: number;
  phone?: string;
  start_time?: string;
  end_time?: string;
} = {}): Promise<MaqsamCall[]> {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.phone) qs.set('phone', params.phone);
  if (params.start_time) qs.set('start_time', params.start_time);
  if (params.end_time) qs.set('end_time', params.end_time);
  const raw = await request<{ calls?: MaqsamCall[]; data?: MaqsamCall[] } | MaqsamCall[]>(
    `/v3/calls${qs.size ? `?${qs.toString()}` : ''}`,
  );
  if (Array.isArray(raw)) return raw;
  return raw.calls ?? raw.data ?? [];
}

/**
 * POST /v3/calls — initiate an outbound call. Per the doc, `email` (the Maqsam
 * agent the call is attributed to) and `phone` are mandatory; `caller` picks
 * the originating number. Returns `referenceId`.
 *
 * NOTE: whether this is also the mechanism that triggers an AI-AGENT outbound
 * call (vs. a human agent's device ringing) is UNVERIFIED — confirm with
 * Maqsam onboarding before wiring a workflow action to it.
 */
export async function createCall(input: {
  email: string;
  phone: string;
  caller?: string;
}): Promise<{ referenceId?: string; raw: Record<string, unknown> }> {
  const raw = await request<Record<string, unknown>>(`/v3/calls`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return { referenceId: (raw.referenceId as string | undefined), raw };
}

/**
 * GET /v1/recording/{id} — the MP3 bytes of a call recording. Auth'd fetch;
 * the caller decides where the bytes go (we re-host them in Supabase Storage
 * so the SPA's <audio> player can play them without Maqsam credentials).
 */
export async function fetchRecording(callId: string | number): Promise<ArrayBuffer | null> {
  const res = await fetch(`${baseUrl()}/v1/recording/${callId}`, {
    headers: { Authorization: basicAuthHeader() },
  });
  if (res.status === 404) return null;      // documented: "Recording Not Found"
  if (!res.ok) {
    throw new MaqsamError(res.status, `Maqsam GET /v1/recording/${callId} failed: ${res.status}`);
  }
  return await res.arrayBuffer();
}

function unwrapCall(raw: { call?: MaqsamCall } | MaqsamCall): MaqsamCall {
  if ('call' in raw && raw.call && typeof raw.call === 'object') return raw.call;
  return raw as MaqsamCall;
}

// ─── Enum maps → our normalized string enums ───────────────────────

export function mapMaqsamStatus(state: string | null | undefined): import('../../src/types').CallStatus {
  switch ((state ?? '').toLowerCase()) {
    case 'serviced':
    case 'completed':   return 'completed';
    case 'in_progress': return 'active';
    case 'abandoned':   return 'missed';      // inbound hung up before an answer
    case 'dropped':     return 'no_answer';
    case 'failed':      return 'failed';
    default:            return 'failed';
  }
}

export function mapMaqsamDirection(type: string | null | undefined): import('../../src/types').CallDirection {
  return (type ?? '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
}

export function mapMaqsamSentiment(s: string | null | undefined): import('../../src/types').CallSentiment | null {
  switch ((s ?? '').toLowerCase()) {
    case 'positive': return 'positive';
    case 'neutral':  return 'neutral';
    case 'negative': return 'negative';
    case 'mixed':    return 'mixed';
    default:         return null;
  }
}

// ─── Deterministic UUIDs for provider-native ids ───────────────────
// call_logs.id is UUID (Hatif callIds are native UUIDs). Maqsam call ids are
// plain integers and Retell's are strings ("call_…"), so we derive a STABLE
// UUID from the provider id via SHA-1 in a fixed namespace (RFC-4122 v5
// layout). Webhook retries and reconcile sweeps hash to the same UUID →
// upserts stay idempotent across every ingest path.

/** Fixed namespace — never change, or every derived call id re-ingests as new. */
const WASSEL_CALL_UUID_NAMESPACE = 'b3f1a9c2-58d4-4e7a-9c11-7a2e6f0d4b83';

/** Synthetic channel id: call_logs.channel_id is NOT NULL and Maqsam has no channel concept. */
export const MAQSAM_CHANNEL_ID = '5f0aa1de-6a2b-4c8f-9d3e-1b7c4a90e2f5';

export async function maqsamCallUuid(maqsamId: string | number): Promise<string> {
  return deterministicUuid(`maqsam-call:${maqsamId}`);
}

/**
 * RFC-4122-v5-shaped UUID derived from `name` in the fixed Wassel namespace.
 * Shared by the Maqsam and Retell ingests (prefix the name with the provider,
 * e.g. `retell-call:<id>`, so the two id spaces can never collide).
 */
export async function deterministicUuid(name: string): Promise<string> {
  const ns = WASSEL_CALL_UUID_NAMESPACE.replace(/-/g, '');
  const nsBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) nsBytes[i] = parseInt(ns.slice(i * 2, i * 2 + 2), 16);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(nsBytes.length + nameBytes.length);
  input.set(nsBytes, 0);
  input.set(nameBytes, nsBytes.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', input));
  const b = hash.slice(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50;   // version 5
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;   // RFC-4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
