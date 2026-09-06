/**
 * POST /api/whatsapp/ai-send-project
 *
 * Send ONE of our projects to a WhatsApp customer using the FULL rep flow —
 * marketing MESSAGE + project BROCHURE + top PHOTOS — in one call. The bot's
 * equivalent of a human rep's ProjectWhatsAppFlow (compose → files → chat).
 *
 * Thin wrapper over the shared `api/_lib/aiSendProject.ts`. Auth is the shared
 * WHATSAPP_AI_SECRET (the bot has no user JWT); everything reads/sends as service
 * role. Delivery goes through the scheduled-send queue (the Fly worker delivers)
 * — this returns as soon as the messages are ENQUEUED, never waiting for WhatsApp.
 *
 * Body: { chat_wid, project_id? | project_name?, device_id?, job_id?, force? }
 *   - `force: true` skips the reply gate. ONLY for operator smoke tests.
 *
 * Reply: { queued, message_source, project_id, media_queued, media_failed }
 *      | { queued:false, blocked:true, reason }
 *      | { queued:false, error }
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { sendProjectViaAiFlow } from '../_lib/aiSendProject.js';

export const config = { runtime: 'nodejs', maxDuration: 120 };

interface Body {
  chat_wid?: string;
  project_id?: string;
  project_name?: string;
  device_id?: string;
  job_id?: string;
  force?: boolean;
}

async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function jsonRes(nodeRes: ServerResponse, status: number, body: unknown): void {
  nodeRes.statusCode = status;
  nodeRes.setHeader('Content-Type', 'application/json; charset=utf-8');
  nodeRes.end(JSON.stringify(body));
}
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  if (nodeReq.method === 'GET') { jsonRes(nodeRes, 200, { ok: true, hint: 'POST { chat_wid, project_id|project_name } with x-wassel-ai-secret' }); return; }
  if (nodeReq.method !== 'POST') { jsonRes(nodeRes, 405, { error: `Method ${nodeReq.method} not allowed` }); return; }

  const secret = process.env.WHATSAPP_AI_SECRET;
  if (!secret) { jsonRes(nodeRes, 500, { error: 'WHATSAPP_AI_SECRET not configured' }); return; }
  const provided = (nodeReq.headers['x-wassel-ai-secret'] as string | undefined) ?? '';
  if (!constantTimeEqual(provided, secret)) { jsonRes(nodeRes, 401, { error: 'unauthorized' }); return; }

  let input: Body;
  try { input = JSON.parse((await readNodeBody(nodeReq)).toString('utf8')) as Body; }
  catch { jsonRes(nodeRes, 400, { error: 'invalid JSON body' }); return; }

  const res = await sendProjectViaAiFlow(getServiceSupabase(), {
    chatWid: input.chat_wid ?? '',
    projectId: input.project_id,
    projectName: input.project_name,
    deviceId: input.device_id,
    jobId: input.job_id,
    force: input.force,
  });

  if (res.blocked) { jsonRes(nodeRes, 200, { queued: false, blocked: true, reason: res.reason, message_source: res.message_source, project_id: res.project_id }); return; }
  if (res.error) {
    const status = /required|unsupported|not found|matched several|empty/.test(res.error) ? 400
      : res.error.includes('no active') ? 500 : 502;
    jsonRes(nodeRes, status, { queued: false, error: res.error, project_id: res.project_id });
    return;
  }
  jsonRes(nodeRes, 200, {
    queued: true,
    delivery: 'queued',
    message_source: res.message_source,
    project_id: res.project_id,
    media_queued: res.media_queued,
    media_failed: res.media_failed,
    wid: res.wid,
    chat_wid: input.chat_wid,
  });
}
