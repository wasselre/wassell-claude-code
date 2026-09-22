/**
 * Completion events — the request-binding half of the completion contract
 * (plan-driven assignment, 2026-09-22; docs/reviews/mos-assignment-redesign-2026-09-22).
 *
 * Every state-changing task action (complete, row complete, transfer, revise)
 * is bound to ONE event id and ONE request hash:
 *
 *   • the event id names the attempt. The SPA generates it before the first
 *     send and re-sends the SAME id on every retry, so a retried click after a
 *     dropped response is a REPLAY (the database returns the stored outcome)
 *     and never a second transition;
 *   • the request hash is a SHA-256 of the sanitized request. A replay with a
 *     different body (same id, other result) is refused by the database as
 *     `MOS:EVENT_MISMATCH` instead of being silently accepted as "done".
 *
 * A client that sends no id (older bundles, curl) gets a fresh one here, so
 * the event is still recorded — it just cannot be replayed.
 *
 * SHA-256 through WebCrypto: this runs on the Vercel Edge runtime, where
 * `node:crypto` is not available.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CompletionEventRef {
  /** The event id the database records the outcome under. */
  id: string;
  /** True when the caller did not send one (no replay protection this time). */
  generated: boolean;
}

/**
 * The event id of this attempt: `event_id` in the body, else the
 * `Idempotency-Key` header, else a fresh uuid. A present-but-malformed value is
 * an error (a truncated id would silently defeat the replay rule).
 */
export function completionEventOf(
  body: Record<string, unknown>,
  req: Request | null,
): { ref: CompletionEventRef } | { error: string } {
  const raw = typeof body.event_id === 'string' && body.event_id.trim()
    ? body.event_id.trim()
    : (req?.headers.get('idempotency-key') ?? '').trim();
  if (!raw) return { ref: { id: crypto.randomUUID(), generated: true } };
  if (!UUID_RE.test(raw)) return { error: 'event_id must be a uuid' };
  return { ref: { id: raw.toLowerCase(), generated: false } };
}

/** Deterministic JSON: object keys sorted, undefined dropped — so two
 *  equivalent requests hash the same. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v ?? null;
  };
  return JSON.stringify(norm(value));
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The hash the database binds the event to. */
export async function requestHashOf(request: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalJson(request));
}
