/**
 * POST /api/analytics
 *
 * Server-side execution of the universal analytics engine. Runs the SAME pure
 * `runAnalyticsQuery` the browser uses (`src/lib/analytics`), so a result can
 * never disagree between the in-browser builder preview and the server.
 *
 * Body: { query: AnalyticsQuery, include_record_ids?: boolean, comparison?: boolean }
 * → 200 { result: AnalyticsResult } | 400 invalid query | 401 bad JWT
 *
 * Auth: `withAuth` validates the caller's Supabase JWT; the data client is the
 * anon key + the caller's `Authorization` header, so reads of `unified_records`
 * (security_invoker) apply the CALLER's RLS. NO service role here — same posture
 * as run-button-workflow. Used for: computing public-dashboard snapshots (called
 * by the owner on publish/refresh) and an optional per-widget "compute on
 * server" path for very large models.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { runAnalyticsQuery, validateAnalyticsQuery, flattenFields } from '../src/lib/analytics/index.js';
import type { AnalyticsContext } from '../src/lib/analytics/index.js';
import type { AnalyticsQuery, AnalyticsWarning } from '../src/lib/analytics/types.js';
import type { AppModel, AppRecord, MetricDefinition, ModelView, User } from '../src/types/index.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

interface RequestBody {
  query?: AnalyticsQuery;
  include_record_ids?: boolean;
  comparison?: boolean;
}

const PAGE_SIZE = 1000;
const MAX_PAGES = 50; // 50k rows/model ceiling — surfaced as page_ceiling_hit, never silent

function log(...parts: unknown[]): void {
  process.stderr.write(`${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
}

/* ─── Node ↔ Web Request/Response adapter (same as run-button-workflow) ─── */
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

/* ─── Data loading ──────────────────────────────────────────────────────── */

async function loadModelRecords(
  supabase: SupabaseClient,
  modelId: string,
): Promise<{ records: AppRecord[]; hitCeiling: boolean }> {
  const out: AppRecord[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await supabase
      .from('unified_records')
      .select('id, model_id, data, created_by_user_id, created_at, updated_at')
      .eq('model_id', modelId)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`load records for ${modelId}: ${error.message}`);
    const batch = (data ?? []) as AppRecord[];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) return { records: out, hitCeiling: false };
  }
  return { records: out, hitCeiling: true };
}

/** Walk a query (+ its metric / numerator / denominator sub-queries) collecting
 *  every source model id, saved-view id, and lookup-target model id needed. */
function collectNeeds(
  q: AnalyticsQuery | undefined,
  modelsById: Map<string, AppModel>,
  metricsById: Map<string, MetricDefinition>,
  needModels: Set<string>,
  needViews: Set<string>,
  seenMetrics: Set<string>,
): void {
  if (!q) return;
  needModels.add(q.source_model_id);
  if (q.saved_view_id) needViews.add(q.saved_view_id);

  const model = modelsById.get(q.source_model_id);
  if (model) {
    const fields = flattenFields(model);
    for (const gb of q.group_by ?? []) {
      if (gb.field.kind !== 'field') continue;
      const fieldId = gb.field.field_id;
      const f = fields.find((x) => x.id === fieldId);
      if (!f) continue;
      if (f.type === 'lookup' && f.lookup_model_id) needModels.add(f.lookup_model_id);
      if (f.type === 'unit_picker' && f.unit_picker_unit_model_id) needModels.add(f.unit_picker_unit_model_id);
    }
  }

  collectNeeds(q.aggregation?.numerator, modelsById, metricsById, needModels, needViews, seenMetrics);
  collectNeeds(q.aggregation?.denominator, modelsById, metricsById, needModels, needViews, seenMetrics);
  const mid = q.aggregation?.metric_id;
  if (mid && !seenMetrics.has(mid)) {
    seenMetrics.add(mid);
    const m = metricsById.get(mid);
    if (m) {
      collectNeeds(m.query, modelsById, metricsById, needModels, needViews, seenMetrics);
      for (const inp of m.inputs ?? []) {
        const im = metricsById.get(inp.metric_id);
        if (im) collectNeeds(im.query, modelsById, metricsById, needModels, needViews, seenMetrics);
      }
    }
  }
}

/* ─── Main handler ──────────────────────────────────────────────────────── */
async function mainHandler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (_user) => {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const query = body.query;
    const validationError = validateAnalyticsQuery(query);
    if (validationError || !query) return jsonError(400, validationError ?? 'query is required');

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) return jsonError(500, 'Supabase env vars missing');

    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    // Models (small table — load all so lookup targets resolve).
    const { data: modelRows, error: modelErr } = await supabase.from('models').select('id, name, schema');
    if (modelErr) return jsonError(500, `load models: ${modelErr.message}`);
    const models = (modelRows ?? []) as unknown as AppModel[];
    const modelsById = new Map(models.map((m) => [m.id, m]));

    // Metrics (best-effort: the table may not exist before its migration — absence
    // means "no semantic metrics yet", not data loss, so we default to []).
    let metrics: MetricDefinition[] = [];
    {
      const { data: metricRows, error: metricErr } = await supabase.from('metric_definitions').select('*');
      if (metricErr) log('[analytics] metric_definitions unavailable:', metricErr.message);
      else metrics = (metricRows ?? []) as unknown as MetricDefinition[];
    }
    const metricsById = new Map(metrics.map((m) => [m.id, m]));

    // What to load.
    const needModels = new Set<string>();
    const needViews = new Set<string>();
    collectNeeds(query, modelsById, metricsById, needModels, needViews, new Set());
    if (!modelsById.has(query.source_model_id)) {
      return jsonError(400, `unknown source_model_id: ${query.source_model_id}`);
    }

    // Saved views by id.
    let savedViews: ModelView[] = [];
    if (needViews.size > 0) {
      const { data: viewRows, error: viewErr } = await supabase
        .from('model_views')
        .select('*')
        .in('id', [...needViews]);
      if (viewErr) return jsonError(500, `load saved views: ${viewErr.message}`);
      savedViews = (viewRows ?? []) as unknown as ModelView[];
    }

    // Users (for assignee / created_by labels).
    const { data: userRows, error: userErr } = await supabase.from('users').select('id, name_ar, name_en');
    if (userErr) return jsonError(500, `load users: ${userErr.message}`);
    const users = (userRows ?? []) as unknown as User[];

    // Records for every needed model (paginated, RLS-scoped via unified_records).
    const allRecords: Record<string, AppRecord[]> = {};
    const ceilingWarnings: AnalyticsWarning[] = [];
    for (const modelId of needModels) {
      const { records, hitCeiling } = await loadModelRecords(supabase, modelId);
      allRecords[modelId] = records;
      if (hitCeiling) ceilingWarnings.push({ code: 'page_ceiling_hit', scanned: records.length });
    }

    const ctx: AnalyticsContext = {
      models,
      records: allRecords[query.source_model_id] ?? [],
      allRecords,
      users,
      savedViews,
      metrics,
      isAr: false,
      now: new Date(),
      options: { include_record_ids: !!body.include_record_ids, comparison: !!body.comparison },
    };

    const result = runAnalyticsQuery(query, ctx);
    if (ceilingWarnings.length > 0) result.warnings = [...result.warnings, ...ceilingWarnings];
    return jsonOk({ result });
  });
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
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
  const webResp = await mainHandler(webReq);
  await writeWebResponseToNode(webResp, nodeRes);
}
