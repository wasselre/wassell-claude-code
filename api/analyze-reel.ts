/**
 * POST /api/analyze-reel
 *
 * In-app "Clean & Analyze" button for one competitor-reel record. Reads the
 * record's raw `content` (the auto-transcript), runs the shared reelAnalyst
 * engine (clean → analyze in one forced-tool pass), and writes the cleaned
 * transcript + the marketing-analysis fields back onto the record.
 *
 * Request body: { record_id: string, model_id?: string }
 *
 * Flow:
 *   1. Auth via withAuth (caller's Supabase JWT — RLS scopes everything).
 *   2. Load the record via `unified_records` (frozen-safe).
 *   3. Run cleanAndAnalyzeReel() on record.data.content.
 *   4. Merge the analysis fields in and persist via the `record_save` RPC with
 *      optimistic concurrency (p_expected_version + one retry on 40001), exactly
 *      like /api/run-button-workflow.
 *
 * Runtime `edge` — matches the other Anthropic endpoints (/api/translate,
 * /api/workflow-agent). One reel is a short non-streaming call (~10–30s), well
 * under any edge ceiling; no HTTP stream is held open.
 *
 * Failure posture (CLAUDE.md "Silent Failures"): the engine throws loudly on
 * any model/parse failure and this returns 502 with the message — the button
 * surfaces a red toast. The bulk backfill script owns the `error` status.
 */

import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { recordSaveWithRetry } from './_lib/recordSaveRetry.js';
import { cleanAndAnalyzeReel, MIN_TRANSCRIPT_CHARS } from './_lib/reelAnalyst.mjs';

export const config = { runtime: 'edge' };

interface RequestBody {
  record_id?: string;
  model_id?: string;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

  return withAuth(req, async (_user) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) return jsonError(500, 'Supabase env vars missing');

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const recordId = (body.record_id ?? '').trim();
    if (!recordId) return jsonError(400, 'record_id is required');

    // JWT-scoped client — RLS lets the caller read/write only records they may.
    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    // 1. Load the record (frozen-safe via unified_records).
    const { data: record, error: recErr } = await supabase
      .from('unified_records')
      .select('id, model_id, data')
      .eq('id', recordId)
      .single();
    if (recErr || !record) return jsonError(404, `Record not found: ${recErr?.message ?? recordId}`);

    const data = (record.data ?? {}) as Record<string, unknown>;
    const content = typeof data.content === 'string' ? data.content.trim() : '';
    if (content.length < MIN_TRANSCRIPT_CHARS) {
      return jsonError(400, `This reel has no transcript to analyze (needs ≥ ${MIN_TRANSCRIPT_CHARS} chars in "content")`);
    }

    // 2. Clean + analyze. Engine throws loudly on failure → 502 (no silent skip).
    let result;
    try {
      result = await cleanAndAnalyzeReel(apiKey, content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(502, `Clean & analyze failed: ${msg}`);
    }

    // 4. Merge analysis onto the record (content + notes preserved) and persist.
    const patch = {
      clean_content: result.clean_content,
      hook: result.hook,
      hook_type: result.hook_type,
      angle: result.angle,
      psych_trigger: result.psych_trigger,
      structure: result.structure,
      tone: result.tone,
      cta: result.cta,
      cta_type: result.cta_type,
      analysis_notes: result.analysis_notes,
      processing_status: 'analyzed',
    };
    // Persist under the standardized T4 retry contract: re-reads the fresh row
    // and re-applies only our analysis `patch` onto the CURRENT data each attempt
    // (preserving a concurrent edit), max 3 attempts with full-jitter backoff,
    // and stops terminally on conflict_storm_blocked (no blind retry).
    try {
      await recordSaveWithRetry(supabase, {
        recordId,
        build: (cur) => ({ ...cur, ...patch }),
      });
    } catch (err) {
      return jsonError(500, `Failed to persist analysis: ${err instanceof Error ? err.message : String(err)}`);
    }

    return jsonOk({ ok: true, record_id: recordId, analysis: result });
  });
}
