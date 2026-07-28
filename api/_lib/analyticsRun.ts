/**
 * Shared server-side analytics execution — the ONE place that loads RLS-scoped
 * records and runs the engine. Both `/api/analytics` (dashboard preview / public
 * snapshot, scoped by the caller's JWT) and the Scheduled Reports runner (scoped
 * by a minted owner JWT) call this, so there is never a second analytics path.
 *
 * The `supabase` client passed in carries the scope: PostgREST applies whatever
 * RLS the client's JWT implies when reading `unified_records` (security_invoker).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { runAnalyticsQuery, flattenFields } from '../../src/lib/analytics/index.js';
import type { AnalyticsContext } from '../../src/lib/analytics/index.js';
import type { AnalyticsQuery, AnalyticsResult, AnalyticsWarning } from '../../src/lib/analytics/types.js';
import type { AppModel, AppRecord, MetricDefinition, ModelView, User } from '../../src/types/index.js';

const PAGE_SIZE = 1000;
const MAX_PAGES = 50; // 50k rows/model ceiling — surfaced as page_ceiling_hit, never silent

export interface RunOptions {
  isAr?: boolean;
  includeRecordIds?: boolean;
  comparison?: boolean;
  now?: Date;
}

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
      // Bound to a const before the guard: narrowing a mutable PROPERTY does not
      // survive into a closure, so `gb.field.field_id` inside the callback was
      // still the whole union — including the synthetic refs that have no
      // field_id at all.
      const ref = gb.field;
      if (ref.kind !== 'field') continue;
      const f = fields.find((x) => x.id === ref.field_id);
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

export interface PreparedContext {
  models: AppModel[];
  modelsById: Map<string, AppModel>;
  metrics: MetricDefinition[];
  users: User[];
}

/** Load the small shared tables (models, metrics, users) once — reusable across
 *  many queries in one report run. metric_definitions is best-effort (absent =
 *  []), matching the original endpoint. */
export async function prepareContext(supabase: SupabaseClient): Promise<PreparedContext> {
  const { data: modelRows, error: modelErr } = await supabase.from('models').select('id, name, schema');
  if (modelErr) throw new Error(`load models: ${modelErr.message}`);
  const models = (modelRows ?? []) as unknown as AppModel[];

  let metrics: MetricDefinition[] = [];
  const { data: metricRows, error: metricErr } = await supabase.from('metric_definitions').select('*');
  if (metricErr) process.stderr.write(`[analyticsRun] metric_definitions unavailable: ${metricErr.message}\n`);
  else metrics = (metricRows ?? []) as unknown as MetricDefinition[];

  const { data: userRows, error: userErr } = await supabase.from('users').select('id, name_ar, name_en');
  if (userErr) throw new Error(`load users: ${userErr.message}`);
  const users = (userRows ?? []) as unknown as User[];

  return { models, modelsById: new Map(models.map((m) => [m.id, m])), metrics, users };
}

/**
 * Resolve everything a single query needs (records, lookup targets, saved views)
 * using the scoped `supabase` client, then run the engine. Returns the
 * AnalyticsResult with any page_ceiling_hit warnings appended.
 */
export async function runQueryWithClient(
  supabase: SupabaseClient,
  query: AnalyticsQuery,
  prepared: PreparedContext,
  opts: RunOptions = {},
): Promise<AnalyticsResult> {
  const { models, modelsById, metrics, users } = prepared;
  const metricsById = new Map(metrics.map((m) => [m.id, m]));

  const needModels = new Set<string>();
  const needViews = new Set<string>();
  collectNeeds(query, modelsById, metricsById, needModels, needViews, new Set());

  let savedViews: ModelView[] = [];
  if (needViews.size > 0) {
    const { data: viewRows, error: viewErr } = await supabase.from('model_views').select('*').in('id', [...needViews]);
    if (viewErr) throw new Error(`load saved views: ${viewErr.message}`);
    savedViews = (viewRows ?? []) as unknown as ModelView[];
  }

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
    isAr: !!opts.isAr,
    now: opts.now ?? new Date(),
    options: { include_record_ids: !!opts.includeRecordIds, comparison: !!opts.comparison },
  };

  const result = runAnalyticsQuery(query, ctx);
  if (ceilingWarnings.length > 0) result.warnings = [...result.warnings, ...ceilingWarnings];
  return result;
}
