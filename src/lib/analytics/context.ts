/**
 * The engine's runtime context. The caller supplies records that are ALREADY
 * RLS/scope-filtered (client = the Zustand store, which holds only rows the
 * user may see; server = a JWT-scoped `unified_records` read). The engine never
 * re-applies row-level security — it only filters/groups/aggregates what it's
 * handed. This keeps the engine pure and unit-testable.
 */
import type { AppModel, AppRecord, MetricDefinition, ModelView, User } from '../../types';

export interface AnalyticsContext {
  /** All models (source + any lookup-target models referenced by group/filter levels). */
  models: AppModel[];
  /** SOURCE records for the query's model, already scoped to the caller. */
  records: AppRecord[];
  /** model_id → records, for resolving lookup display values + lookup grouping. */
  allRecords: Record<string, AppRecord[]>;
  /** For assignee / created_by label resolution. */
  users: User[];
  /** Referenced by AnalyticsQuery.saved_view_id. */
  savedViews?: ModelView[];
  /** Referenced by AggregationConfig.metric_id. */
  metrics?: MetricDefinition[];
  /** Tie-break language for sorting by group label (both labels are always emitted). */
  isAr: boolean;
  /** Injectable clock so date windows are deterministic. Defaults to new Date(). */
  now?: Date;
  options?: {
    include_record_ids?: boolean; // collect per-row recordIds for drill-through
    comparison?: boolean; // also compute the previous-window comparison
  };
}
