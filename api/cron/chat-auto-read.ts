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
 * CALL AUDIT (2026-09-29): after the chat reads, while time remains
 * (CALL_AUDIT_RESERVE_MS kept back from the budget), `call_audit_candidates`
 * lists finished Hatif calls (> 20 s, diarized, ≥ 1 h after hang-up) not yet
 * audited, and each is audited SEQUENTIALLY (`auditCall`): preferences the
 * customer said that are EMPTY on the client become ONE pending proposal. It
 * never writes a client. The chat reads above are unchanged and always run
 * first.
 *
 * PLACES from calls (2026-09-29_02): the same audit also runs the geography
 * pipeline on the call — only for a client with NO places. Each candidate says
 * which passes are due (`needs_prefs`, `needs_geo`); a call whose preference
 * audit is already terminal gets a GEO-ONLY pass that never re-runs the
 * preference extractor. An older candidate shape (no `needs_*` columns — the
 * migration is not applied) runs the preference pass only.
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
import { auditCall, type CallAuditStatus } from '../_lib/clientPrefs/callAudit.js';
import { loadAutomationSettings, autoSavePlaces, autoSavePrefs } from '../_lib/clientPrefs/autoSave.js';

export const config = { runtime: 'nodejs', maxDuration: 300 };

const SERVICE_NAME = 'api:cron-chat-auto-read';
const TIME_BUDGET_MS = 240_000;
const PARALLELISM = 2;
const CANDIDATE_LIMIT = 50;
/**
 * No call audit STARTS after TIME_BUDGET_MS - this. One audit is the
 * preference extractor plus a geography read (extraction + verifier), so up to
 * ~2 minutes; 240 s - 120 s keeps a late start inside the 300 s limit.
 */
const CALL_AUDIT_RESERVE_MS = 120_000;
const CALL_CANDIDATE_LIMIT = 20;

interface CallCandidate {
  call_id: string;
  client_id: string;
  hangup_time: string;
  duration_seconds: number;
  /** Absent on the pre-2026-09-29_02 function ⇒ preference pass only. */
  needs_prefs?: boolean;
  needs_geo?: boolean;
}

const GEO_COUNT: Record<CallAuditStatus, 'geo_done' | 'geo_skipped' | 'geo_failed'> = {
  done: 'geo_done', skipped: 'geo_skipped', failed: 'geo_failed',
};

/** PURE: which passes a candidate row asks for. The old shape (no needs_* columns) ⇒ prefs only, no geo. */
export function candidatePasses(c: CallCandidate): { needsPrefs: boolean; needsGeo: boolean } {
  const newShape = typeof c.needs_prefs === 'boolean' || typeof c.needs_geo === 'boolean';
  if (!newShape) return { needsPrefs: true, needsGeo: false };
  return { needsPrefs: c.needs_prefs === true, needsGeo: c.needs_geo === true };
}

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
    const callRes = await loadCallCandidates(sb, now);
    return send(nodeRes, 200, {
      ok: true, dryRun: true, counts,
      due: sel.due.map(brief), gated: sel.gated.map(brief), waiting: sel.waiting.map(brief),
      leased: sel.leased.map(brief), backoff: sel.backoff.map(brief),
      calls: callRes.error ? { error: callRes.error } : { candidates: callRes.rows.length, list: callRes.rows },
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

  // Call audit: after the chat reads, sequentially, within what is left of the budget.
  // done / skipped / failed / proposals = the PREFERENCE pass; geo_* = the places pass.
  const calls = {
    candidates: 0, geo_only: 0, done: 0, skipped: 0, failed: 0, proposals: 0, not_claimed: 0,
    geo_done: 0, geo_skipped: 0, geo_failed: 0, geo_proposals: 0, deferred: 0, auto_saved: 0,
  };
  // The AI saves what the audit found onto the client (fill-empty-only, as the
  // call audit always was). Settings read once per tick.
  let autoSaveOn = false;
  try {
    autoSaveOn = (await loadAutomationSettings(sb)).auto_save_profile;
  } catch (err) {
    const msg = `automation settings: ${err instanceof Error ? err.message : String(err)}`;
    console.error('[chat-auto-read]', msg);
    errors.push(msg);
  }
  const callDeadline = TIME_BUDGET_MS - CALL_AUDIT_RESERVE_MS;
  if (Date.now() - startedAt < callDeadline) {
    const callRes = await loadCallCandidates(sb, new Date());
    if (callRes.error) {
      errors.push(`call_audit_candidates: ${callRes.error}`);
    } else {
      calls.candidates = callRes.rows.length;
      for (const c of callRes.rows) {
        if (Date.now() - startedAt >= callDeadline) { calls.deferred += 1; continue; }
        const passes = candidatePasses(c);
        if (!passes.needsPrefs) calls.geo_only += 1;
        // auditCall never throws for an audit failure (it records + returns
        // 'failed'); a throw here is the claim RPC itself failing.
        try {
          const r = await auditCall(sb, {
            callId: c.call_id, clientId: c.client_id, hangupAt: c.hangup_time,
            needsPrefs: passes.needsPrefs, needsGeo: passes.needsGeo,
            log: (m) => console.log(m),
          });
          if (r.reason === 'not_claimed') {
            calls.not_claimed += 1;
          } else if (r.prefsRan) {
            calls[r.status] += 1;
            if (r.proposalId) calls.proposals += 1;
            if (r.status === 'failed') errors.push(`call ${c.call_id}: ${r.reason ?? 'failed'}`);
          }
          if (r.geo) {
            calls[GEO_COUNT[r.geo.status]] += 1;
            if (r.geo.proposalId) calls.geo_proposals += 1;
            if (r.geo.status === 'failed') errors.push(`call ${c.call_id} geo: ${r.geo.reason ?? 'failed'}`);
          }
          if (autoSaveOn) {
            const log = (m: string) => console.log(m);
            const saves: Array<[string, () => Promise<unknown>]> = [];
            if (r.proposalId) saves.push(['prefs', () => autoSavePrefs(sb, { proposalId: r.proposalId!, conversation: null, source: 'call', sourceRef: c.call_id, log })]);
            if (r.geo?.proposalId) saves.push(['places', () => autoSavePlaces(sb, { proposalId: r.geo!.proposalId!, source: 'call', sourceRef: c.call_id, log })]);
            for (const [what, run] of saves) {
              try {
                await run();
                calls.auto_saved += 1;
              } catch (err) {
                const msg = `call ${c.call_id} ${what} auto-save: ${err instanceof Error ? err.message : String(err)}`;
                console.error('[chat-auto-read]', msg);
                errors.push(msg);
              }
            }
          }
        } catch (err) {
          const msg = `call ${c.call_id}/${c.client_id}: ${err instanceof Error ? err.message : String(err)}`;
          console.error('[chat-auto-read] call audit failed:', msg);
          errors.push(msg);
          calls.failed += 1;
        }
      }
    }
  } else {
    console.log('[chat-auto-read] no time left for the call audit this tick');
  }

  const body = {
    ok: errors.length === 0,
    counts: { ...counts, gate_skipped_marked: gateSkipped, deferred },
    outcomes,
    calls,
    errors,
    ms: Date.now() - startedAt,
  };
  console.log(`[chat-auto-read] ${JSON.stringify({ counts: body.counts, outcomes, calls, errors: errors.length, ms: body.ms })}`);
  return send(nodeRes, 200, body);
}

/** The finished calls due for the audit. An RPC error is returned (and console.error-ed), never an empty list. */
async function loadCallCandidates(
  sb: NonNullable<ReturnType<typeof makeServiceClient>>, now: Date,
): Promise<{ rows: CallCandidate[]; error: string | null }> {
  const { data, error } = await sb.rpc('call_audit_candidates', {
    p_now: now.toISOString(), p_grace: '60 minutes', p_window: '60 days', p_limit: CALL_CANDIDATE_LIMIT,
  });
  if (error) {
    console.error('[chat-auto-read] call_audit_candidates failed:', error.message);
    return { rows: [], error: error.message };
  }
  return { rows: (data ?? []) as CallCandidate[], error: null };
}
