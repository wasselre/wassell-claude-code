import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { runAnalyticsQuery } from '@/lib/analytics/engine';
import type { AnalyticsContext } from '@/lib/analytics/context';
import type { AnalyticsQuery, AnalyticsResult } from '@/lib/analytics/types';

export interface UseAnalyticsQueryResult {
  data: AnalyticsResult | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const EMPTY: never[] = [];

/**
 * Runs an AnalyticsQuery against the in-store (already RLS-scoped) records via
 * the shared engine. Instant + synchronous — the same engine the server uses,
 * so the builder preview and the saved render agree. Server / public-snapshot
 * modes are layered on in later phases; this client path powers the editor and
 * authenticated dashboards.
 */
export function useAnalyticsQuery(
  query: AnalyticsQuery | null,
  opts: { comparison?: boolean; includeRecordIds?: boolean } = {},
): UseAnalyticsQueryResult {
  const records = useAppStore((s) => s.records);
  const models = useAppStore((s) => s.models);
  const users = useAppStore((s) => s.users);
  const views = useAppStore((s) => s.views);
  const language = useAppStore((s) => s.language);
  const metrics = useAppStore((s) => s.metricDefinitions);

  const comparison = !!opts.comparison;
  const includeRecordIds = !!opts.includeRecordIds;
  const key = query ? safeStringify(query) : null;

  const data = useMemo<AnalyticsResult | null>(() => {
    if (!query) return null;
    const ctx: AnalyticsContext = {
      models,
      records: records[query.source_model_id] ?? EMPTY,
      allRecords: records,
      users: users ?? EMPTY,
      savedViews: views ?? EMPTY,
      metrics: metrics ?? EMPTY,
      isAr: language === 'ar',
      now: new Date(),
      options: { include_record_ids: includeRecordIds, comparison },
    };
    return runAnalyticsQuery(query, ctx);
    // `key` is the stable identity of `query`; the store slices are the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, records, models, users, views, language, comparison, includeRecordIds]);

  return { data, loading: false, error: null, refetch: () => {} };
}

function safeStringify(q: AnalyticsQuery): string {
  try {
    return JSON.stringify(q);
  } catch {
    return String(Math.random());
  }
}
