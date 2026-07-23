/**
 * Server-side helpers for the Retell AI integration.
 *
 * Retell is the AI voice-agent brain riding on the Hatif SIP Integration
 * (purchased 2026-07-23): Hatif carries the PSTN leg on our existing number,
 * Retell answers/places the calls, and every call lands in the SAME
 * `call_logs` + `phone_calls` pipeline as Hatif/Maqsam calls, tagged
 * `provider='retell'`.
 *
 * Never imported from `src/*` — `RETELL_API_KEY` lives server-side only.
 *
 * Docs: https://docs.retellai.com/features/webhook
 *       https://docs.retellai.com/deploy/custom-telephony
 */

export class RetellError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

// ─── Webhook payload types (from the public webhook doc) ───────────

export type RetellWebhookEvent = 'call_started' | 'call_ended' | 'call_analyzed';

export interface RetellCallAnalysis {
  call_summary?: string | null;
  user_sentiment?: string | null;      // Positive | Negative | Neutral (casing per docs)
  call_successful?: boolean | null;
  custom_analysis_data?: Record<string, unknown> | null;
}

export interface RetellCall {
  call_id: string;
  agent_id?: string | null;
  from_number?: string | null;
  to_number?: string | null;
  direction?: string | null;           // inbound | outbound
  call_status?: string | null;         // registered | ongoing | ended | error
  disconnection_reason?: string | null;
  start_timestamp?: number | null;     // epoch ms
  end_timestamp?: number | null;       // epoch ms
  transcript?: string | null;
  transcript_object?: unknown;
  recording_url?: string | null;
  metadata?: Record<string, unknown> | null;
  retell_llm_dynamic_variables?: Record<string, unknown> | null;
  call_analysis?: RetellCallAnalysis | null;
}

export interface RetellWebhookBody {
  event: RetellWebhookEvent | string;
  call: RetellCall;
}

// ─── Signature verification ────────────────────────────────────────

/**
 * Verify the `x-retell-signature` header. Retell's SDK (`Retell.verify(body,
 * apiKey, signature)`) computes an HMAC-SHA256 of the raw body keyed with the
 * account's API key; we reimplement it with Web Crypto since api/* runs on
 * the Edge runtime without the SDK.
 *
 * UNVERIFIED (pre-activation): the exact digest encoding (hex vs base64, and
 * whether a timestamp is mixed in) isn't spelled out in the public docs — the
 * SDK abstracts it. Verify against a real webhook delivery during setup; until
 * then the `?secret=` URL-param fallback in the webhook handler keeps ingest
 * working even if this HMAC shape is wrong (both hex and base64 are accepted
 * below to cover the common variants).
 */
export async function verifyRetellSignature(
  rawBody: string,
  receivedSignature: string,
  apiKey: string,
): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(apiKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = btoa(String.fromCharCode(...sig));
  const received = receivedSignature.trim();
  return constantTimeEqual(hex, received.toLowerCase()) || constantTimeEqual(b64, received);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Enum maps → our normalized string enums ───────────────────────

/**
 * Retell reports lifecycle via `call_status` (registered/ongoing/ended/error)
 * and the terminal cause via `disconnection_reason` (user_hangup, agent_hangup,
 * dial_no_answer, dial_busy, dial_failed, voicemail_reached, error_*, …).
 */
export function mapRetellStatus(
  callStatus: string | null | undefined,
  disconnectionReason: string | null | undefined,
): import('../../src/types').CallStatus {
  const status = (callStatus ?? '').toLowerCase();
  if (status === 'ongoing' || status === 'registered') return 'active';
  const reason = (disconnectionReason ?? '').toLowerCase();
  if (reason === 'dial_no_answer') return 'no_answer';
  if (reason === 'dial_busy') return 'rejected_by_callee';
  if (reason === 'dial_failed' || reason.startsWith('error') || status === 'error') return 'failed';
  // user_hangup / agent_hangup / voicemail_reached / call transfer variants —
  // the call happened and ended; that's a completed call for our purposes.
  return 'completed';
}

export function mapRetellDirection(direction: string | null | undefined): import('../../src/types').CallDirection {
  return (direction ?? '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
}

export function mapRetellSentiment(s: string | null | undefined): import('../../src/types').CallSentiment | null {
  switch ((s ?? '').toLowerCase()) {
    case 'positive': return 'positive';
    case 'neutral':  return 'neutral';
    case 'negative': return 'negative';
    default:         return null;
  }
}

export function durationSeconds(call: RetellCall): number | null {
  if (typeof call.start_timestamp === 'number' && typeof call.end_timestamp === 'number') {
    const ms = call.end_timestamp - call.start_timestamp;
    if (ms >= 0) return Math.round(ms / 1000);
  }
  return null;
}
