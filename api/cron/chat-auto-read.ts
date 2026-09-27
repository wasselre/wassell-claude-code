/**
 * GET / POST /api/cron/chat-auto-read — reads client WhatsApp chats on their
 * own, every minute.
 *
 * Live traffic (2026-09-27): ~46 customer messages a day across ~15 chats, a
 * median message of 20 characters, 71% of a customer's consecutive messages
 * under 3 minutes apart (median 42 s). So there is NO AI classifier in front of
 * the reading: `chat_read_candidates` (SQL) lists the linked chats with unread
 * customer text, the pure `selectDueChats` waits for a burst to settle (90 s,
 * capped at 10 min, held for an in-flight voice transcript, backed off after
 * failures) and applies the free keyword gate, and each due chat gets ONE
 * whole-conversation read (`readChatForClient`: the geography agent + the
 * preference agent, in parallel, under a per-chat lease).
 *
 * A gated batch («تمام», «👍») advances the watermarks without any model call.
 * Nothing here writes a client record or sends a message — the reads produce
 * PROPOSALS a rep ticks and saves in the chat card.
 *
 * Budget: stops STARTING reads after TIME_BUDGET_MS (240 s of the 300 s
 * function limit), PARALLELISM reads at a time; the rest wait for the next tick.
 *
 * Auth: Bearer $CRON_SECRET or ?secret= (same as the other crons). `?dryRun=1`
 * returns the selection only — no read, no write. Always 200 with a counts
 * body so Vercel never marks the cron failed; every failure is ALSO
 * console.error-ed.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { selectDueChats, type ReadCandidate } from '../_lib/clientPrefs/dueSelection.js';
import { readChatForClient, type ReadChatResult } from '../_lib/clientPrefs/readChat.js';

export const config = { runtime: 'nodejs', maxDuration: 300 };

const SERVICE_NAME = 'api:cron-chat-auto-read';
const TIME_BUDGET_MS = 240_000;
const PARALLELISM = 2;
const CANDIDATE_LIMIT = 50;

function nodeToWebRequest(nodeReq: IncomingMessage): Request {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  // The cron takes no body — GET and POST are read the same way.
  return new Request(url.toString(), { method: 'GET', headers });
}

function send(nodeRes: ServerResponse, status: number, body: unknown): void {
  nodeRes.statusCode = status;
  nodeRes.setHeader('content-type', 'application/json');
  nodeRes.end(JSON.stringify(body, null, 2));
}

const brief = (c: ReadCandidate) => ({
  chat_wid: c.chat_wid, client_id: c.client_id, unread: c.unread_count,
  pending_transcripts: c.pending_transcripts, newest_in_at: c.newest_in_at, oldest_unread_at: c.oldest_unread_at,
});

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const req = nodeToWebRequest(nodeReq);

  const expected = process.env.CRON_SECRET;
  if (!expected) return send(nodeRes, 500, { error: 'CRON_SECRET is not set; refusing to run' });
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const sent = bearer || url.searchParams.get('secret') || '';
  if (sent !== expected) return send(nodeRes, 401, { error: 'unauthorized' });

  const dryParam = (url.searchParams.get('dryRun') ?? '0').toLowerCase();
  const dryRun = dryParam === '1' || dryParam === 'true';

  const sb = makeServiceClient(SERVICE_NAME);
  if (!sb) {
    console.error('[chat-auto-read] server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
    return send(nodeRes, 200, { ok: false, error: 'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY' });
  }

  const now = new Date();
  const { data, error } = await sb.rpc('chat_read_candidates', {
    p_now: now.toISOString(), p_window: '7 days', p_limit: CANDIDATE_LIMIT,
  });
  if (error) {
    console.error('[chat-auto-read] chat_read_candidates failed:', error.message);
    return send(nodeRes, 200, { ok: false, error: `chat_read_candidates: ${error.message}` });
  }
  const candidates = (data ?? []) as ReadCandidate[];
  const sel = selectDueChats(candidates, now);

  const counts = {
    candidates: candidates.length,
    due: sel.due.length,
    gated: sel.gated.length,
    waiting: sel.waiting.length,
    leased: sel.leased.length,
    backoff: sel.backoff.length,
  };

  if (dryRun) {
    return send(nodeRes, 200, {
      ok: true, dryRun: true, counts,
      due: sel.due.map(brief), gated: sel.gated.map(brief), waiting: sel.waiting.map(brief),
      leased: sel.leased.map(brief), backoff: sel.backoff.map(brief),
      ms: Date.now() - startedAt,
    });
  }

  const errors: string[] = [];

  // Gated batches: nothing worth reading — advance both watermarks, no model call.
  let gateSkipped = 0;
  for (const c of sel.gated) {
    if (!c.newest_in_at || c.unread_count === 0) continue;
    const { error: gErr } = await sb.rpc('chat_read_mark_gate_skipped', {
      p_chat_wid: c.chat_wid, p_client_id: c.client_id, p_through: c.newest_in_at, p_trigger: 'cron',
    });
    if (gErr) {
      const msg = `gate-skip ${c.chat_wid}/${c.client_id}: ${gErr.message}`;
      console.error('[chat-auto-read]', msg);
      errors.push(msg);
    } else {
      gateSkipped += 1;
    }
  }

  // Due chats: PARALLELISM at a time, no new read started after the budget.
  const outcomes: Record<ReadChatResult['outcome'], number> = {
    read: 0, partial: 0, failed: 0, gate_skipped: 0, not_claimed: 0, nothing_new: 0, waiting: 0,
  };
  const queue = [...sel.due];
  let deferred = 0;
  const tick = globalThis.crypto.randomUUID().slice(0, 8);
  const worker = async (): Promise<void> => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      if (Date.now() - startedAt > TIME_BUDGET_MS) { deferred += 1; continue; }
      try {
        const r = await readChatForClient(sb, {
          clientId: c.client_id, chatWid: c.chat_wid, trigger: 'cron',
          owner: `cron:${process.env.VERCEL_REGION ?? 'local'}:${tick}`,
          log: (m) => console.log(m),
        });
        outcomes[r.outcome] += 1;
      } catch (err) {
        const msg = `${c.chat_wid}/${c.client_id}: ${err instanceof Error ? err.message : String(err)}`;
        console.error('[chat-auto-read] read failed:', msg);
        errors.push(msg);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLELISM, queue.length) }, () => worker()));

  const body = {
    ok: errors.length === 0,
    counts: { ...counts, gate_skipped_marked: gateSkipped, deferred },
    outcomes,
    errors,
    ms: Date.now() - startedAt,
  };
  console.log(`[chat-auto-read] ${JSON.stringify({ counts: body.counts, outcomes, errors: errors.length, ms: body.ms })}`);
  return send(nodeRes, 200, body);
}
