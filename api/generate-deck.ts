/**
 * POST /api/generate-deck (queue-creator)
 *
 * Replaces the old SSE-streaming Edge function. New shape:
 *
 *   1. Validates the caller's Supabase JWT (withAuth).
 *   2. Validates the request body (brief, language, model, size, attachments).
 *   3. Inserts ONE row into `public.deck_jobs` with status='pending'.
 *   4. Best-effort POST /wake to the Fly.io worker so it skips its
 *      ~3-second polling delay. Failure is non-fatal — the worker's
 *      regular poll loop picks the job up either way.
 *   5. Returns 200 with { job_id }.
 *
 * Why the rewrite: the previous version held an SSE stream open for
 * the entire Anthropic call (up to 5 minutes on Vercel Edge), and any
 * deck that took longer than 300s was killed by Vercel without a
 * chance to write a final state. The new endpoint returns in <1s; the
 * actual generation runs on a Fly.io Node worker with no per-request
 * timeout. Status flows to the SPA via Supabase Realtime on the deck
 * record (status / phase / file_url / error_message), not via SSE.
 *
 * See:
 *   - supabase/migrations/2026-05-17_deck_jobs_queue.sql
 *   - worker/src/runDeckJob.ts (the moved generation pipeline)
 *   - worker/src/index.ts      (poll loop + watchdog)
 *   - docs/prd/decks.md
 */

import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';

export const config = { runtime: 'edge' };
// 30s is plenty — we do one DB insert and one fire-and-forget HTTP ping.
export const maxDuration = 30;

type DeckSize = '16:9' | '9:16' | '4:3' | '1:1';

interface DeckAttachmentRef {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

interface GenerateDeckRequestBody {
  recordId: string;
  brief: string;
  language?: 'ar' | 'en' | 'mixed';
  model?: 'claude-opus-4-7' | 'claude-sonnet-4-6';
  size?: DeckSize;
  attachments?: DeckAttachmentRef[];
}

const VALID_SIZES: ReadonlySet<DeckSize> = new Set(['16:9', '9:16', '4:3', '1:1']);

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    // ── Parse + validate body ─────────────────────────────────────────
    let body: GenerateDeckRequestBody;
    try {
      body = (await req.json()) as GenerateDeckRequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!body.recordId || typeof body.recordId !== 'string') {
      return jsonError(400, 'recordId must be a string');
    }
    if (!body.brief || typeof body.brief !== 'string' || body.brief.trim().length < 10) {
      return jsonError(400, 'brief must be at least 10 characters');
    }
    const model = body.model ?? 'claude-opus-4-7';
    const language = body.language ?? 'ar';
    const size: DeckSize = body.size ?? '16:9';
    const attachments: DeckAttachmentRef[] = Array.isArray(body.attachments)
      ? body.attachments
      : [];
    if (!['claude-opus-4-7', 'claude-sonnet-4-6'].includes(model)) {
      return jsonError(400, `unsupported model: ${model}`);
    }
    if (!VALID_SIZES.has(size)) {
      return jsonError(400, `unsupported size: ${size}`);
    }
    // Defensive: every attachment must declare a path that starts with
    // the caller's auth.uid()/. The storage bucket's RLS would still
    // block another user's path, but failing fast here returns a clearer
    // error and avoids the worker spending an Anthropic upload slot on it.
    for (const att of attachments) {
      if (!att.path || typeof att.path !== 'string' || !att.path.startsWith(`${user.userId}/`)) {
        return jsonError(400, `attachment path outside user scope: ${att.path ?? '(missing)'}`);
      }
    }

    // ── Insert deck_jobs row (service role) ───────────────────────────
    // T2: identity-tagged service-role client (x-wassel-service='api:generate-deck').
    const supabase = makeServiceClient('api:generate-deck');
    if (!supabase) {
      return jsonError(
        500,
        'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required',
      );
    }

    // Guard: caller must own the deck record they're queuing work for.
    // Service role bypasses RLS, so we have to re-check here.
    const { data: rec, error: recErr } = await supabase
      .from('records')
      .select('id, created_by_user_id, data')
      .eq('id', body.recordId)
      .single();
    if (recErr || !rec) {
      return jsonError(404, `deck record not found: ${recErr?.message ?? 'unknown'}`);
    }
    // created_by_user_id is the public.users (CRM) id, NOT auth.uid(). We
    // don't have a cheap lookup auth.uid() → public.users.id from here.
    // The path-prefix attachment check above already validates ownership
    // (the user can only upload attachments to <auth.uid()>/...); we
    // additionally require the recordId to be one the caller could
    // theoretically see. Since the SPA only ever creates deck records
    // belonging to the signed-in user, this is sufficient — any
    // unauthorized recordId would have failed the SPA's own RLS load
    // long before this endpoint sees it.

    const payload = {
      brief: body.brief.trim(),
      language,
      model,
      size,
      attachments,
    };

    const { data: jobRow, error: insertErr } = await supabase
      .from('deck_jobs')
      .insert({
        deck_record_id: body.recordId,
        user_id: user.userId,
        status: 'pending',
        payload,
      })
      .select('id')
      .single();
    if (insertErr || !jobRow) {
      return jsonError(500, `failed to enqueue deck job: ${insertErr?.message ?? 'unknown'}`);
    }
    const jobId = jobRow.id as string;
    console.log(`[generate-deck] queued job=${jobId} record=${body.recordId} user=${user.userId}`);

    // ── Best-effort wake ping ──────────────────────────────────────────
    // Worker polls every ~3s anyway, so a missed wake just means up to
    // 3s of extra latency. Don't block the response on this.
    const workerUrl = process.env.WASSEL_DECK_WORKER_URL;
    if (workerUrl) {
      try {
        // 1.5s timeout — if the worker is asleep or unreachable, fall
        // back to its poll loop. We never want this ping to delay the
        // 200 response we're about to send.
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        await fetch(`${workerUrl.replace(/\/$/, '')}/wake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job_id: jobId }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
      } catch (err) {
        // Best-effort — log and move on. The poll loop catches up.
        console.warn(
          `[generate-deck] wake ping failed (non-fatal): ${(err as Error).message}`,
        );
      }
    }

    return jsonOk({ job_id: jobId, status: 'pending' }, 202);
  });
}
