import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { runAnalyticsQuery } from '@/lib/analytics/engine';
import { resolveFieldDisplay, useFieldDisplayVersion } from '@/lib/recordTranslation/resolver';
import { activeClientsOnly } from '@/lib/clients/retirement';
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
  // Re-run the query when async translations arrive so chart labels fill in.
  // The resolver itself is INJECTED into the context — the engine must stay
  // importable from server bundles that can't load the browser runtime.
  const translationVersion = useFieldDisplayVersion();

  // Retired clients are excluded from every analytics count/group. This is the
  // single client-side choke point every authenticated dashboard/widget flows
  // through, so filtering the clients slice here (both the primary source feed
  // and the cross-model `allRecords` slice) covers all of them at once.
  const clientsModelId = useMemo(() => models.find((m) => m.name === 'clients')?.id ?? null, [models]);

  const data = useMemo<AnalyticsResult | null>(() => {
    if (!query) return null;
    const scopedAll =
      clientsModelId && records[clientsModelId]
        ? { ...records, [clientsModelId]: activeClientsOnly(records[clientsModelId]!) }
        : records;
    const ctx: AnalyticsContext = {
      models,
      records: scopedAll[query.source_model_id] ?? EMPTY,
      allRecords: scopedAll,
      users: users ?? EMPTY,
      savedViews: views ?? EMPTY,
      metrics: metrics ?? EMPTY,
      isAr: language === 'ar',
      resolveText: (raw, lang, meta) =>
        resolveFieldDisplay(meta?.entity_id, meta?.field_hint ?? '', raw, lang, meta),
      now: new Date(),
      options: { include_record_ids: includeRecordIds, comparison },
    };
    return runAnalyticsQuery(query, ctx);
    // `key` is the stable identity of `query`; the store slices are the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, records, models, users, views, language, comparison, includeRecordIds, translationVersion]);

  return { data, loading: false, error: null, refetch: () => {} };
}

function safeStringify(q: AnalyticsQuery): string {
  try {
    return JSON.stringify(q);
  } catch {
    return String(Math.random());
  }
}
