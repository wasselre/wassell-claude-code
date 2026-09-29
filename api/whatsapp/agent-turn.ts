/**
 * POST /api/whatsapp/agent-turn — run ONE turn of the WhatsApp sales agent.
 *
 * Called by the Fly worker after it claims a debounced wa_agent_turn_jobs row
 * (never by the webhook — a turn runs an LLM call and the Finder). Auth: the
 * shared x-wassel-ai-secret (the worker already holds it for basic-reply).
 *
 * Body: { chat_wid, job_id? }                    → a real turn (sends + persists)
 *       { chat_wid, dry_run: true, sim?: {...} } → the real LLM + Finder, but
 *         nothing is sent or saved; `sim.messages` stands in for the chat. Used
 *         to test the agent without messaging anyone.
 * A thrown error returns 500 so the worker fails the job (it retries ≤ 3×; a turn
 * persists its watermark before sending, so a retry can never double-send).
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { runAgentTurn, type SimInput } from '../_lib/salesAgent/turn.js';

export const config = { runtime: 'nodejs', maxDuration: 120 };

async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function jsonRes(nodeRes: ServerResponse, status: number, body: unknown): void {
  nodeRes.statusCode = status;
  nodeRes.setHeader('Content-Type', 'application/json');
  nodeRes.end(JSON.stringify(body));
}
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  if (nodeReq.method !== 'POST') return jsonRes(nodeRes, 405, { error: 'Method not allowed' });
  const secret = process.env.WHATSAPP_AI_SECRET;
  if (!secret) return jsonRes(nodeRes, 500, { error: 'WHATSAPP_AI_SECRET not configured' });
  const provided = (nodeReq.headers['x-wassel-ai-secret'] as string | undefined) ?? '';
  if (!constantTimeEqual(provided, secret)) return jsonRes(nodeRes, 401, { error: 'unauthorized' });

  let body: { chat_wid?: string; job_id?: string; dry_run?: boolean; sim?: SimInput };
  try { body = JSON.parse((await readNodeBody(nodeReq)).toString('utf-8') || '{}'); }
  catch { return jsonRes(nodeRes, 400, { error: 'invalid JSON body' }); }

  const chatWid = (body.chat_wid ?? '').trim();
  if (!chatWid) return jsonRes(nodeRes, 400, { error: 'chat_wid is required' });

  try {
    const result = await runAgentTurn(getServiceSupabase(), chatWid, { dryRun: body.dry_run === true, sim: body.sim });
    console.log(`[agent-turn] chat=${chatWid} job=${body.job_id ?? '-'} ${result.skipped ? `skipped=${result.skipped}` : `step=${result.step?.kind}${result.project ? ` project=${result.project.projectName}` : ''} sent=${result.sent}`}`);
    return jsonRes(nodeRes, 200, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agent-turn] chat=${chatWid} job=${body.job_id ?? '-'} FAILED: ${msg}`);
    return jsonRes(nodeRes, 500, { error: msg });
  }
}
