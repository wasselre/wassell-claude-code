/**
 * POST /api/internal/run-report  — internal, worker-only.
 *
 * Triggers one Scheduled Report run. Authenticated by a shared secret
 * (REPORTS_RUNNER_SECRET) — NOT a user JWT — because the caller is the Fly
 * worker's scheduler loop, not a browser. The actual compute is owner-scoped
 * inside runReportById (minted owner JWT). Body: { report_id }.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'node:crypto';
import { runReportById } from '../_lib/reportRunner.js';

export const config = { runtime: 'nodejs', maxDuration: 120 };

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };

  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });

  const secret = process.env.REPORTS_RUNNER_SECRET;
  if (!secret) return send(500, { error: 'REPORTS_RUNNER_SECRET not configured' });
  const provided = (req.headers['x-reports-runner-secret'] as string | undefined) ?? '';
  if (!provided || !timingSafeEqual(provided, secret)) return send(401, { error: 'unauthorized' });

  let reportId: string | undefined;
  try {
    const body = JSON.parse((await readBody(req)) || '{}') as { report_id?: string };
    reportId = body.report_id;
  } catch {
    return send(400, { error: 'invalid JSON body' });
  }
  if (!reportId) return send(400, { error: 'report_id is required' });

  try {
    const result = await runReportById(reportId, 'schedule');
    // runReportById never throws (records failures on the report); a 200 with
    // status:'failed' lets the worker log it without retry-looping.
    return send(200, { ok: result.status !== 'failed', result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return send(500, { error: msg });
  }
}
