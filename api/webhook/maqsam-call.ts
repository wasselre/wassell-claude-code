/**
 * POST /api/webhook/maqsam-call?secret=<MAQSAM_WEBHOOK_SECRET>
 *
 * Receives call events from Maqsam (the AI-calls provider — Hatif keeps the
 * human calls). Configure this URL in the Maqsam portal's webhook settings
 * during onboarding:
 *
 *   https://<prod-domain>/api/webhook/maqsam-call?secret=<MAQSAM_WEBHOOK_SECRET>
 *
 * Maqsam's exact webhook payload shape is NOT publicly documented (only the
 * Inquiries API callback is), so this handler is deliberately TOLERANT:
 *   - a full Calls-API-shaped object            → ingest directly
 *   - a thin ping carrying only a call id       → fetch the full call from
 *     Calls API v3, then ingest
 *   - anything else                             → 200 + logged (never burn
 *     Maqsam's retries on a shape we haven't seen), visible on /logs
 *
 * Either way the call lands in `call_logs` + `phone_calls` via the shared
 * ingest (api/_lib/maqsamIngest.ts) — same pipeline as Hatif calls.
 *
 * The reconcile sweep (api/maqsam/sync-calls.ts) backstops this endpoint
 * completely: even with no webhook configured at all, calls arrive on the
 * next sweep. Both paths derive the same deterministic UUID per call, so
 * overlap is an idempotent no-op.
 */

import { getCall, MaqsamCall } from '../_lib/maqsam.js';
import { ingestMaqsamCall } from '../_lib/maqsamIngest.js';
import { logWebhookReceipt } from '../_lib/activityLogger.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return json({ ok: true, hint: 'POST Maqsam call events here' });
  }
  if (req.method !== 'POST') {
    return json({ error: `Method ${req.method} not allowed` }, 405);
  }

  const secret = process.env.MAQSAM_WEBHOOK_SECRET;
  if (!secret) {
    return json({ error: 'MAQSAM_WEBHOOK_SECRET not configured' }, 500);
  }
  const url = new URL(req.url);
  if (!constantTimeEqual(url.searchParams.get('secret') ?? '', secret)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const rawBody = await req.text();
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  let handlerError: string | undefined;
  let eventType = 'unknown';
  try {
    const call = await resolveCall(event);
    if (call) {
      const result = await ingestMaqsamCall(call, event);
      eventType = result.skipped
        ? `skipped/${result.skipped}`
        : `${call.type ?? '?'}/${call.state ?? '?'}`;
    } else {
      // Unrecognized shape — keep the raw payload on /logs so we can extend
      // resolveCall for it, but return 200 (retries would fail identically).
      eventType = 'unrecognized-shape';
      handlerError = 'no call id found in payload';
      console.error('[maqsam-webhook] unrecognized payload shape:', rawBody.slice(0, 2000));
    }
  } catch (err) {
    console.error('[maqsam-webhook] ingest failed:', err);
    handlerError = err instanceof Error ? err.message : String(err);
  }

  void logWebhookReceipt({
    source: 'maqsam-call',
    eventType,
    payload: event,
    status: handlerError ? 'error' : 'success',
    error: handlerError,
  });

  return json({ ok: !handlerError });
}

/**
 * Accept the payload variants we might get and normalize to a full MaqsamCall.
 * A payload that already looks like a call (has id + type/state) is used as-is;
 * a thin ping (id / call_id / callId only) triggers a Calls API fetch.
 */
async function resolveCall(event: Record<string, unknown>): Promise<MaqsamCall | null> {
  // Nested `call` object wrapper.
  const nested = event.call;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return resolveCall(nested as Record<string, unknown>);
  }

  const id = event.id ?? event.call_id ?? event.callId ?? null;
  if (id == null) return null;

  const looksFull = typeof event.state === 'string' || typeof event.type === 'string';
  if (looksFull) return event as unknown as MaqsamCall;

  // Thin ping — pull the authoritative object.
  return await getCall({ id: id as string | number });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
