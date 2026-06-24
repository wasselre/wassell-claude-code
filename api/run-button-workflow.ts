/**
 * POST /api/run-button-workflow
 *
 * Server-side runner for the custom-button → workflow path.
 *
 * Request body: { record_id: string, button_id: string }
 *
 * 1. Auth via withAuth (caller's Supabase JWT — RLS scopes everything).
 * 2. Load the record + its model. Find the matching CustomButton in
 *    model.schema.custom_buttons.
 * 3. Load the workflow the button targets.
 * 4. For every `paseet_query` action in the workflow:
 *      - Render the prompt_template against the record's data
 *        (`{slug}` substitution)
 *      - Call paseetRunner to drive Paseet via Browserbase
 *      - Apply each response_mapping via paseetMapper
 *      - Merge the resulting patch into the record's data
 * 5. Persist the merged data back to the record.
 * 6. Return a JSON summary the browser turns into a toast.
 *
 * Non-paseet actions (create_record / update_record / etc.) are skipped
 * with a logged warning — they were originally designed to run inside
 * the browser-side workflow engine, and porting them server-side is a
 * separate piece of work. The button still completes successfully if at
 * least one paseet_query ran; if there were no paseet_query actions at
 * all, the endpoint returns 200 with `{ ok: true, ran: 0 }` so the UI
 * toast shows the no-op state instead of an error.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { recordSaveWithRetry } from './_lib/recordSaveRetry.js';
import { runPaseetQuery, type PaseetQueryResult, type PaseetResponseShape } from './_lib/paseetRunner.js';
import {
  applyPaseetMapping,
  type PaseetResponseMapping,
  type MapperSchema,
} from './_lib/paseetMapper.js';
import { substituteTemplate } from '../src/lib/templateUtils.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 240,
};

interface RequestBody {
  record_id?: string;
  button_id?: string;
}

function log(...parts: unknown[]): void {
  process.stderr.write(`${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
}

/* ─── Node ↔ Web Request/Response adapter ──────────────────────────── */

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

/* ─── Workflow + button shape (light, only what we read) ────────────── */

interface ActionPaseetQuery {
  id: string;
  type: 'paseet_query';
  prompt_template: string;
  response_shape: PaseetResponseShape;
  response_mappings: PaseetResponseMapping[];
  timeout_ms?: number;
}

interface AnyAction {
  id: string;
  type: string;
}

interface WorkflowBranch {
  is_else?: boolean;
  actions?: AnyAction[];
}

interface WorkflowRow {
  id: string;
  trigger_model_id: string;
  branches?: WorkflowBranch[];
  // Older workflows may have `actions` directly. We support either shape.
  actions?: AnyAction[];
}

interface CustomButton {
  id: string;
  label_ar: string;
  label_en: string;
  enabled?: boolean;
  action: { type: 'trigger_workflow'; workflow_id: string };
}

interface ModelRow {
  id: string;
  name: string;
  schema: MapperSchema & { custom_buttons?: CustomButton[] };
}

/* ─── Main handler ──────────────────────────────────────────────────── */

async function mainHandler(req: Request): Promise<Response> {
  log('[run-button-workflow] entered, method=', req.method);
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (_user) => {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const recordId = (body.record_id ?? '').trim();
    const buttonId = (body.button_id ?? '').trim();
    if (!recordId) return jsonError(400, 'record_id is required');
    if (!buttonId) return jsonError(400, 'button_id is required');
    log('[run-button-workflow] record=', recordId, 'button=', buttonId);

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) return jsonError(500, 'Supabase env vars missing');

    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    // 1. Load the record + figure out which model it belongs to.
    // unified_records — works whether the model has been frozen or not.
    const { data: record, error: recErr } = await supabase
      .from('unified_records')
      .select('id, model_id, data')
      .eq('id', recordId)
      .single();
    if (recErr || !record) return jsonError(404, `Record not found: ${recErr?.message ?? recordId}`);

    // 2. Load that model's schema and find the button.
    const { data: modelRow, error: modelErr } = await supabase
      .from('models')
      .select('id, name, schema')
      .eq('id', record.model_id)
      .single<ModelRow>();
    if (modelErr || !modelRow) return jsonError(500, `Model not found: ${modelErr?.message ?? record.model_id}`);

    const button = (modelRow.schema.custom_buttons ?? []).find((b) => b.id === buttonId);
    if (!button) return jsonError(404, `Button ${buttonId} not configured on model ${modelRow.name}`);
    if (button.enabled === false) return jsonError(400, `Button "${button.label_en || button.label_ar}" is disabled`);
    if (button.action.type !== 'trigger_workflow') {
      return jsonError(400, `Button action type ${button.action.type} not supported yet`);
    }
    log('[run-button-workflow] resolved button:', button.label_en || button.label_ar);

    // 3. Load the workflow and collect every action across its branches.
    const { data: wfRow, error: wfErr } = await supabase
      .from('workflows')
      .select('*')
      .eq('id', button.action.workflow_id)
      .single<WorkflowRow>();
    if (wfErr || !wfRow) return jsonError(404, `Workflow ${button.action.workflow_id} not found`);

    const allActions: AnyAction[] = [
      ...(wfRow.actions ?? []),
      ...(wfRow.branches ?? []).flatMap((b) => b.actions ?? []),
    ];
    const paseetActions = allActions.filter((a): a is ActionPaseetQuery => a.type === 'paseet_query') as ActionPaseetQuery[];
    const skipped = allActions.filter((a) => a.type !== 'paseet_query');
    log('[run-button-workflow] actions:', allActions.length, 'paseet:', paseetActions.length, 'skipped:', skipped.length);

    if (paseetActions.length === 0) {
      return jsonOk({
        ok: true,
        ran: 0,
        skipped: skipped.length,
        message: 'No paseet_query actions in this workflow yet — nothing to run server-side',
      });
    }

    // 4. Walk paseet actions in declaration order. Each result is mapped onto
    //    a running `mergedData` snapshot so a later action can see fields
    //    written by an earlier action via {slug} substitution.
    const recordData = (record.data as Record<string, unknown>) ?? {};
    let mergedData: Record<string, unknown> = { ...recordData };
    let totalMappingsApplied = 0;

    for (const action of paseetActions) {
      const prompt = substituteTemplate(action.prompt_template, mergedData);
      log('[run-button-workflow] action', action.id, 'prompt-head:', prompt.slice(0, 120));

      let result: PaseetQueryResult;
      try {
        result = await runPaseetQuery({
          prompt,
          responseShape: action.response_shape,
          timeoutMs: action.timeout_ms,
          log,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('[run-button-workflow] paseet runner threw:', msg);
        return jsonError(502, `Paseet query failed: ${msg}`);
      }

      for (const mapping of action.response_mappings) {
        try {
          const patch = applyPaseetMapping({
            result,
            mapping,
            modelSchema: modelRow.schema,
            existingData: mergedData,
          });
          if (Object.keys(patch).length > 0) {
            mergedData = { ...mergedData, ...patch };
            totalMappingsApplied += 1;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log('[run-button-workflow] mapping failed:', msg);
          // Don't abort — let the other mappings still apply. The summary
          // will reflect what actually landed.
        }
      }
    }

    // 5. Persist merged data back to the record. record_save dispatches to
    // the dedicated table when the model is frozen.
    //
    // Audit fix C3 — pass `p_expected_version` so a concurrent edit during
    // the (potentially long) Paseet run is detected. On version_mismatch
    // re-read the record, re-apply our paseet patches onto its CURRENT
    // data (preserving the user's concurrent edit), and retry once.
    if (totalMappingsApplied > 0) {
      // The patch = ONLY the paseet-produced changes (diff vs the original record
      // data), so re-merging onto the FRESH row each attempt preserves a
      // concurrent user edit instead of clobbering it with a stale full snapshot.
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(mergedData)) {
        if (recordData[k] !== v) patch[k] = v;
      }
      // Persist under the standardized T4 retry contract (max 3 attempts,
      // full-jitter backoff, terminal on conflict_storm_blocked, fresh re-read).
      try {
        await recordSaveWithRetry(supabase, {
          recordId,
          build: (cur) => ({ ...cur, ...patch }),
        });
      } catch (err) {
        return jsonError(500, `Failed to persist record: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log('[run-button-workflow] done, mappings applied=', totalMappingsApplied);

    return jsonOk({
      ok: true,
      ran: paseetActions.length,
      mappings_applied: totalMappingsApplied,
      skipped: skipped.length,
      record_id: recordId,
    });
  });
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  log('[run-button-workflow] L0 wrapper, method=', nodeReq.method ?? '?');
  let webReq: Request;
  try {
    webReq = await nodeToWebRequest(nodeReq);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    nodeRes.statusCode = 500;
    nodeRes.setHeader('Content-Type', 'application/json');
    nodeRes.end(JSON.stringify({ error: `request adapter failed: ${msg}` }));
    return;
  }
  let webResp: Response;
  try {
    webResp = await mainHandler(webReq);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('[run-button-workflow] handler threw:', msg);
    webResp = jsonError(500, `unhandled: ${msg}`);
  }
  await writeWebResponseToNode(webResp, nodeRes);
}
