/**
 * POST /api/migrate — control plane for the Data Migration wizard.
 *
 * Dispatched on `action`. The FILE-HEAVY AI vision actions are now ENQUEUE-ONLY
 * (no Anthropic call here): they insert a `data_migration_jobs` row, write the
 * record's busy/status field server-side, ping the Fly worker, and return 202.
 * The worker (worker/src/runMigrationJob.ts) runs them with no timeout and
 * streams progress onto the record via Supabase Realtime — so a multi-minute
 * brochure extraction can never again die on the Vercel 300 s wall / a dropped
 * browser connection (the bug that froze migrations at status='extracting').
 *
 *   - extract  : enqueue the WHOLE extraction (records-mode source fusion OR
 *                project-mode single extract). discover/fuse run INSIDE the
 *                worker's one job, not as separate actions.
 *   - plan     : enqueue ONE pre-extraction clarify-chat turn (appends the
 *                operator's message + card answers to the record first).
 *   - discuss  : enqueue ONE post-extraction recount/revise chat turn.
 *   - cancel   : cancel the active job for a record + reset its busy/status.
 *   - status   : read the record's latest job (belt-and-suspenders for Realtime).
 *
 * The fast TEXT-ONLY actions stay SYNCHRONOUS (no files, ~seconds):
 *   - suggest_mappings : raw headers + samples + target fields → column→field map
 *   - standardize      : a column's distinct values → canonical option/lookup map
 *
 * Sole-writer rule (CRITICAL): the browser must NEVER write the migration record
 * during a job — a browser write registers in the realtime echo-dedup and would
 * SUPPRESS the worker's updates. So the busy/status flip + message append happen
 * HERE (service role). All job-time writes are the worker's. See CLAUDE.md.
 *
 * Auth via withAuth (Supabase JWT). user.userId is the caller's auth.uid().
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk, assertCanAccessRecord } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';
import {
  runSuggestMappings,
  runStandardize,
  type TargetFieldLite,
  type StandardizeCandidate,
} from './_lib/migrateAgent.js';

export const config = {
  runtime: 'nodejs',
  // Enqueue + the fast text-only actions are all seconds; no vision runs here.
  maxDuration: 60,
};

async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBody(nodeReq);
  return new Request(url.toString(), { method, headers, body });
}

async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  const buf = Buffer.from(await webResp.arrayBuffer());
  nodeRes.end(buf);
}

/** One prep card answer the operator submitted this turn. */
interface AnsweredQuestionLite {
  question: string;
  kind?: string;
  detail?: string;
  answer: string;
  ts?: string;
}

interface MigrateRequestBody {
  action?: 'extract' | 'plan' | 'discuss' | 'cancel' | 'status' | 'suggest_mappings' | 'standardize';
  language?: 'ar' | 'en';
  // The data_migration record (enqueue / control actions).
  recordId?: string;
  // extract
  mode?: 'records' | 'project';
  guidance?: string;
  fields?: TargetFieldLite[];
  // plan / discuss — this turn's operator message + (plan) submitted card answers.
  userText?: string;
  instructions?: string;
  answered?: AnsweredQuestionLite[];
  // suggest_mappings
  headers?: string[];
  sampleRows?: string[][];
  // standardize
  fieldType?: 'dropdown' | 'multiselect' | 'lookup';
  fieldLabel?: string;
  candidates?: StandardizeCandidate[];
  rawValues?: string[];
}

const MIGRATION_MODEL_NAME = 'data_migration';

// All record ids are UUIDs. Validate the client-supplied recordId BEFORE the
// access gate so a malformed id is a 400 (bad request) rather than falling
// through to the RLS-scoped query and surfacing as a 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serviceClient(): SupabaseClient | null {
  // T2: identity-tagged service-role client (x-wassel-service='api:migrate').
  return makeServiceClient('api:migrate');
}

/**
 * Merge `compute(freshData)` into a record's data via record_save, VERSION-UNAWARE
 * (`p_expected_version: null`) — 2026-06-23. The data_migration draft is a
 * single-logical-owner record that the browser wizard ALSO writes version-unaware
 * (MigrationWizard `patch` + jobRunner.patchMigrationRecord) and the Fly worker
 * writes version-unaware too (runMigrationJob.patchRecord, commit 44d0200). This
 * endpoint formerly used OPTIMISTIC concurrency + retry-on-40001 — the ROOT CAUSE
 * of a Postgres CPU storm: the browser freely bumps the row `version`, so this
 * server write lost every race and tight-looped on 40001 while the SPA re-fired
 * `/api/migrate` (record ba9211b7, 2026-06-23 — the API-endpoint twin of the
 * worker bug fixed in 44d0200). We still re-read the freshest row and MERGE, so
 * concurrent writes to OTHER fields survive; the busy/status fields this endpoint
 * owns are last-write-wins (correct). No retry loop: with no version check there
 * is no conflict, so it can never tight-loop. Service-role; the SPA never writes
 * the migration record during a job (echo-dedup).
 */
async function patchRecordServer(
  sb: SupabaseClient,
  recordId: string,
  compute: (data: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; modelId: string } | { error: string }> {
  const { data: row, error } = await sb
    .from('records')
    .select('data, created_by_user_id, model_id')
    .eq('id', recordId)
    .single();
  if (error || !row) return { error: `record not found: ${error?.message ?? 'unknown'}` };
  const data = ((row.data as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const modelId = (row as { model_id: string }).model_id;
  const newData = { ...data, ...compute(data) };
  const { error: saveErr } = await sb.rpc('record_save', {
    p_model_id: modelId,
    p_id: recordId,
    p_data: newData,
    p_created_by: (row as { created_by_user_id: string | null }).created_by_user_id ?? null,
    p_expected_version: null,
  });
  if (saveErr) return { error: `record_save failed: ${saveErr.message}` };
  return { data: newData, modelId };
}

/** Best-effort wake ping so the worker skips its ~3s poll. Never blocks. */
async function wakeWorker(jobId: string): Promise<void> {
  const workerUrl = process.env.WASSEL_DECK_WORKER_URL;
  if (!workerUrl) return;
  try {
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
    console.warn(`[migrate] wake ping failed (non-fatal): ${(err as Error).message}`);
  }
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const req = await nodeToWebRequest(nodeReq);
  const resp = await withAuth(req, async (user) => {
    if (req.method !== 'POST') return jsonError(405, 'Method not allowed');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');

    let body: MigrateRequestBody;
    try {
      body = (await req.json()) as MigrateRequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    switch (body.action) {
      // ── Enqueue: extract / plan / discuss ──────────────────────────────
      case 'extract':
      case 'plan':
      case 'discuss': {
        const recordId = body.recordId;
        if (!recordId || typeof recordId !== 'string' || !UUID_RE.test(recordId)) {
          return jsonError(400, `${body.action}: a valid recordId is required`);
        }
        // T3 access gate: the caller must be able to SEE this record under RLS
        // (anon key + their own JWT) BEFORE any service-role write. Service role
        // bypasses RLS, so without this any authenticated user could drive
        // another user's migration. Throws AuthError(403) → withAuth maps it.
        await assertCanAccessRecord(req, recordId, 'api:migrate');
        const sb = serviceClient();
        if (!sb) return jsonError(500, 'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

        const fields = Array.isArray(body.fields) ? body.fields : [];
        const language = body.language ?? 'ar';
        const now = new Date().toISOString();

        // Server-side record write that puts the record into its busy state +
        // (plan/discuss) appends the operator's message. The browser does NOT
        // write the record here — that would suppress the worker's Realtime
        // updates via the echo-dedup (CLAUDE.md sole-writer rule).
        let payload: Record<string, unknown>;
        let patchRes: { data: Record<string, unknown>; modelId: string } | { error: string };

        if (body.action === 'extract') {
          const mode = body.mode === 'project' ? 'project' : 'records';
          const guidance = typeof body.guidance === 'string' ? body.guidance : undefined;
          payload = { fields, mode, language, guidance };
          patchRes = await patchRecordServer(sb, recordId, () => ({
            status: 'extracting',
            phase: 'queued',
            progress_done: 0,
            progress_total: null,
            error_message: null,
          }));
        } else if (body.action === 'plan') {
          const text = (body.userText ?? '').trim();
          if (!text) return jsonError(400, 'plan: userText is required');
          const instructions = typeof body.instructions === 'string' ? body.instructions : undefined;
          const answered = Array.isArray(body.answered) ? body.answered : [];
          payload = { fields, language, instructions };
          patchRes = await patchRecordServer(sb, recordId, (data) => {
            const chat = (Array.isArray(data.prep_chat) ? data.prep_chat : []) as {
              role: string;
              content: string;
              ts?: string;
            }[];
            const merged = [
              ...((Array.isArray(data.prep_answered) ? data.prep_answered : []) as AnsweredQuestionLite[]),
            ];
            for (const a of answered) {
              const i = merged.findIndex((x) => x.question === a.question);
              if (i >= 0) merged[i] = a;
              else merged.push(a);
            }
            return {
              prep_chat: [...chat, { role: 'user', content: text, ts: now }],
              prep_answered: merged,
              prep_answers_draft: {},
              prep_busy: true,
              error_message: null,
            };
          });
        } else {
          // discuss
          const text = (body.userText ?? '').trim();
          if (!text) return jsonError(400, 'discuss: userText is required');
          payload = { fields, language };
          patchRes = await patchRecordServer(sb, recordId, (data) => {
            const chat = (Array.isArray(data.chat) ? data.chat : []) as {
              role: string;
              content: string;
              ts?: string;
            }[];
            return {
              chat: [...chat, { role: 'user', content: text, ts: now }],
              discuss_busy: true,
              error_message: null,
            };
          });
        }

        if ('error' in patchRes) return jsonError(404, patchRes.error);

        const { data: jobId, error: enqErr } = await sb.rpc('data_migration_job_enqueue', {
          p_record_id: recordId,
          p_user_id: user.userId,
          p_kind: body.action,
          p_payload: payload,
        });
        if (enqErr || !jobId) {
          return jsonError(500, `failed to enqueue ${body.action}: ${enqErr?.message ?? 'unknown'}`);
        }
        console.log(`[migrate] queued ${body.action} job=${jobId} record=${recordId} user=${user.userId}`);
        await wakeWorker(jobId as string);
        return jsonOk({ job_id: jobId, status: 'queued' }, 202);
      }

      // ── Cancel the active job + reset the record's busy state ───────────
      case 'cancel': {
        const recordId = body.recordId;
        if (!recordId || typeof recordId !== 'string' || !UUID_RE.test(recordId)) return jsonError(400, 'cancel: a valid recordId is required');
        await assertCanAccessRecord(req, recordId, 'api:migrate'); // T3 access gate
        const sb = serviceClient();
        if (!sb) return jsonError(500, 'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
        const { error: cancelErr } = await sb.rpc('data_migration_job_cancel', { p_record_id: recordId });
        if (cancelErr) return jsonError(500, `cancel failed: ${cancelErr.message}`);
        // Reset the record so the spinner exits (extraction → back to draft).
        await patchRecordServer(sb, recordId, (data) => ({
          status: data.status === 'extracting' ? 'draft' : (data.status as string | undefined),
          phase: null,
          prep_busy: false,
          discuss_busy: false,
        }));
        return jsonOk({ ok: true });
      }

      // ── Status read (Realtime is primary; this is a fallback) ───────────
      case 'status': {
        const recordId = body.recordId;
        if (!recordId || typeof recordId !== 'string' || !UUID_RE.test(recordId)) return jsonError(400, 'status: a valid recordId is required');
        await assertCanAccessRecord(req, recordId, 'api:migrate'); // T3 access gate
        const sb = serviceClient();
        if (!sb) return jsonError(500, 'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
        const { data: jobRow, error } = await sb
          .from('data_migration_jobs')
          .select('id, kind, status, error_message, created_at, finished_at')
          .eq('migration_record_id', recordId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) return jsonError(500, `status read failed: ${error.message}`);
        return jsonOk({ job: jobRow ?? null });
      }

      // ── Fast synchronous actions (text-only, no files) ──────────────────
      case 'suggest_mappings': {
        const headers = Array.isArray(body.headers) ? body.headers : [];
        const fields = Array.isArray(body.fields) ? body.fields : [];
        if (headers.length === 0 || fields.length === 0) {
          return jsonError(400, 'suggest_mappings: headers[] and fields[] are required');
        }
        try {
          const mappings = await runSuggestMappings(apiKey, {
            headers,
            sampleRows: Array.isArray(body.sampleRows) ? body.sampleRows : [],
            fields,
            language: body.language ?? 'ar',
          });
          return jsonOk({ ok: true, mappings });
        } catch (err) {
          return jsonError(502, `Mapping failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      case 'standardize': {
        const fieldType = body.fieldType;
        const rawValues = Array.isArray(body.rawValues) ? body.rawValues : [];
        if (!fieldType || rawValues.length === 0) {
          return jsonError(400, 'standardize: fieldType and rawValues[] are required');
        }
        try {
          const decisions = await runStandardize(apiKey, {
            fieldType,
            fieldLabel: body.fieldLabel ?? '',
            candidates: Array.isArray(body.candidates) ? body.candidates : [],
            rawValues,
            language: body.language ?? 'ar',
          });
          return jsonOk({ ok: true, decisions });
        } catch (err) {
          return jsonError(502, `Standardization failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      default:
        return jsonError(400, `unknown action "${body.action ?? ''}"`);
    }
  });
  await writeWebResponseToNode(resp, nodeRes);
}
