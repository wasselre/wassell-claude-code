/**
 * Server-side activity logger — writes to the same `activity_log` table as
 * the client-side logger so the unified /logs timeline shows API hits, AI
 * agent turns + tool calls, and webhook receipts alongside user CRUD.
 *
 * Always uses the service-role Supabase client because some events
 * (webhooks, system events) have no user JWT. Safe to call without auth
 * context — actor fields just stay null. Best-effort: any DB error is
 * logged to the function's stdout and swallowed so logging never breaks
 * the request that triggered it.
 */

import { getServiceSupabase } from './supabaseServer.js';

/** The categories activity_log actually holds. There is no CHECK constraint on
 *  the column, so a category missing from this union never failed at runtime —
 *  it just made the call site a type error that nothing ran. Verified against
 *  production: 'file' (14,942 rows) and 'whatsapp' (14) were both in use and
 *  both absent here. */
export type ServerActivityCategory =
  | 'auth' | 'record' | 'workflow' | 'ai_agent' | 'api' | 'webhook' | 'system'
  | 'file' | 'whatsapp';
export type ServerActivityStatus = 'success' | 'error' | 'warning' | 'info';

interface ServerActivityInput {
  category: ServerActivityCategory;
  event_type: string;
  actor_user_id?: string | null;
  actor_email?: string | null;
  target_model_id?: string | null;
  target_record_id?: string | null;
  target_label?: string | null;
  summary_ar: string;
  summary_en: string;
  details?: Record<string, unknown>;
  duration_ms?: number | null;
  status?: ServerActivityStatus | null;
  error?: string | null;
  workflow_run_id?: string | null;
}

/** Insert one row into `activity_log`. Returns void; fire-and-forget. */
export async function logServerActivity(input: ServerActivityInput): Promise<void> {
  try {
    const supa = getServiceSupabase();
    const { error } = await supa.from('activity_log').insert({
      category: input.category,
      event_type: input.event_type,
      actor_user_id: input.actor_user_id ?? null,
      actor_email: input.actor_email ?? null,
      target_model_id: input.target_model_id ?? null,
      target_record_id: input.target_record_id ?? null,
      target_label: input.target_label ?? null,
      summary_ar: input.summary_ar,
      summary_en: input.summary_en,
      details: input.details ?? {},
      duration_ms: input.duration_ms ?? null,
      status: input.status ?? null,
      error: input.error ?? null,
      workflow_run_id: input.workflow_run_id ?? null,
    });
    if (error) {
      console.error('[activityLogger] insert failed:', error.message);
    }
  } catch (err) {
    console.error('[activityLogger] insert threw:', err);
  }
}

/** Log a single API hit — wraps the route handler and records method, path,
 *  status, duration, and an error message if the request threw. */
export async function logApiRequest(args: {
  req: Request;
  user: { userId?: string | null; email?: string | null } | null;
  status: number;
  duration_ms: number;
  error?: string;
  details?: Record<string, unknown>;
}) {
  // Edge runtime hands us a full URL ("https://app.wassel.re/api/..."), but
  // Node serverless functions hand us a path-only URL ("/api/..."), and
  // `new URL("/api/...")` throws "Invalid URL". Pass a placeholder base so
  // the constructor accepts either shape — the base is ignored when the
  // input is already absolute.
  const url = new URL(args.req.url, 'http://placeholder');
  const path = url.pathname;
  const method = args.req.method;
  const status: ServerActivityStatus =
    args.status >= 500 ? 'error' :
    args.status >= 400 ? 'warning' : 'success';

  await logServerActivity({
    category: 'api',
    event_type: 'request',
    actor_user_id: args.user?.userId ?? null,
    actor_email: args.user?.email ?? null,
    target_label: `${method} ${path}`,
    summary_ar: `طلب API: ${method} ${path} (${args.status})`,
    summary_en: `API request: ${method} ${path} (${args.status})`,
    details: {
      method,
      path,
      query: Object.fromEntries(url.searchParams.entries()),
      http_status: args.status,
      ...args.details,
    },
    duration_ms: args.duration_ms,
    status,
    error: args.error ?? null,
  });
}

/** Log a webhook receipt — the source ('haberchat' / 'hatif-call' / etc),
 *  the event type, and the raw payload (capped at 16KB after JSON-stringify
 *  to keep the row reasonably-sized). */
export async function logWebhookReceipt(args: {
  source: string; // 'haberchat' | 'hatif-call' | ...
  eventType: string;
  payload: unknown;
  status?: ServerActivityStatus;
  error?: string;
}) {
  const MAX_PAYLOAD_CHARS = 16_000;
  let serializedPayload: unknown = args.payload;
  try {
    const stringified = JSON.stringify(args.payload);
    if (stringified.length > MAX_PAYLOAD_CHARS) {
      serializedPayload = {
        truncated: true,
        original_size: stringified.length,
        preview: stringified.slice(0, MAX_PAYLOAD_CHARS),
      };
    }
  } catch {
    serializedPayload = { unserializable: true };
  }

  await logServerActivity({
    category: 'webhook',
    event_type: 'receipt',
    target_label: `${args.source}: ${args.eventType}`,
    summary_ar: `استقبال Webhook (${args.source}): ${args.eventType}`,
    summary_en: `Webhook received (${args.source}): ${args.eventType}`,
    details: {
      source: args.source,
      event_type: args.eventType,
      payload: serializedPayload,
    },
    status: args.status ?? 'success',
    error: args.error ?? null,
  });
}

/** Log one AI agent turn — captures the iteration number, stop reason, and
 *  the full list of tool calls with inputs + results for that turn. The user
 *  asked for FULL DEPTH so we don't truncate inputs/outputs. */
export async function logAiAgentTurn(args: {
  user: { userId?: string | null; email?: string | null };
  iteration: number;
  stop_reason: string;
  duration_ms: number;
  tool_calls: Array<{ name: string; input: unknown; result: string; duration_ms: number; error?: string }>;
  message_count: number;
  conversation_id?: string | null;
  error?: string;
}) {
  const toolNames = args.tool_calls.map((t) => t.name);
  const summarySuffix = toolNames.length > 0
    ? `tool calls: ${toolNames.join(', ')}`
    : `stop: ${args.stop_reason}`;
  await logServerActivity({
    category: 'ai_agent',
    event_type: 'turn',
    actor_user_id: args.user.userId ?? null,
    actor_email: args.user.email ?? null,
    target_record_id: args.conversation_id ?? null,
    target_label: 'AI Sales Agent',
    summary_ar: `جولة وكيل ذكاء — ${summarySuffix}`,
    summary_en: `AI agent turn — ${summarySuffix}`,
    details: {
      iteration: args.iteration,
      stop_reason: args.stop_reason,
      message_count: args.message_count,
      tool_calls: args.tool_calls,
      conversation_id: args.conversation_id ?? null,
    },
    duration_ms: args.duration_ms,
    status: args.error ? 'error' : 'success',
    error: args.error ?? null,
  });
}
