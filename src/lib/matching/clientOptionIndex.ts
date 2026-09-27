/**
 * PURE read helpers over Client Options (`client_property_options` records).
 *
 * Client Options are the ONE home for "which projects / units / listings is this
 * client considering" — the old `clients.preferred_*` lookup fields were retired
 * on 2026-09-27 (their values were migrated into options by
 * `supabase/migrations/2026-09-27_03_client_legacy_prefs_migrate.sql`).
 *
 * No store, no React, no `import.meta` — the pure resolvers (`clientView.ts`,
 * `demandAggregation.ts`) take `models` + `records` from their caller's context
 * and read options through here. The write side (and the store-bound readers)
 * stay in `clientOptions.ts`.
 */
import type { AppModel, AppRecord } from '@/types';

/** Mirrors `CLIENT_OPTIONS_MODEL` in clientOptions.ts (kept here so this file
 *  never imports the store-bound module). */
export const CLIENT_OPTIONS_MODEL_NAME = 'client_property_options';

export type OptionSourceKind = 'project' | 'unit' | 'market_listing';

/**
 * Statuses that mean the client is no longer considering the option. Everything
 * else (suitable, main focus, presented, interested, reserved, closed) still
 * counts as "this client wants / wanted this".
 */
const INACTIVE_OPTION_STATUSES = new Set(['eliminated', 'not_interested']);

export interface ActiveOptionRef {
  optionId: string;
  sourceId: string;
  /** The name snapshotted onto the option at save time (display fallback). */
  sourceName: string | null;
  isMain: boolean;
}

// Per records-array memo: the store replaces the array on every change, so a
// WeakMap keyed by it invalidates itself and never leaks.
const byClientCache = new WeakMap<AppRecord[], Map<string, AppRecord[]>>();

/** All option records grouped by `data.client_id` (empty map when the options
 *  model isn't loaded). */
export function optionRecordsByClient(
  models: AppModel[],
  records: Record<string, AppRecord[]>,
): Map<string, AppRecord[]> {
  const model = models.find((m) => m.name === CLIENT_OPTIONS_MODEL_NAME);
  if (!model) return new Map();
  const list = records[model.id] ?? [];
  const cached = byClientCache.get(list);
  if (cached) return cached;
  const map = new Map<string, AppRecord[]>();
  for (const r of list) {
    const cid = (r.data as Record<string, unknown> | undefined)?.client_id;
    if (typeof cid !== 'string' || !cid) continue;
    const arr = map.get(cid);
    if (arr) arr.push(r);
    else map.set(cid, [r]);
  }
  byClientCache.set(list, map);
  return map;
}

/**
 * The client's still-active options of one source kind, main option first
 * (then any `main_focus` status), otherwise in stored order. De-duplicated by
 * source id. Empty when the client has none.
 */
export function activeOptionRefs(options: AppRecord[], kind: OptionSourceKind): ActiveOptionRef[] {
  const out: (ActiveOptionRef & { rank: number })[] = [];
  const seen = new Set<string>();
  for (const r of options) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    if (d.source_type !== kind) continue;
    const sourceId = typeof d.source_id === 'string' ? d.source_id : '';
    if (!sourceId || seen.has(sourceId)) continue;
    if (typeof d.status === 'string' && INACTIVE_OPTION_STATUSES.has(d.status)) continue;
    seen.add(sourceId);
    const isMain = d.is_main === true;
    const name = typeof d.source_name === 'string' && d.source_name.trim() ? d.source_name.trim() : null;
    out.push({ optionId: r.id, sourceId, sourceName: name, isMain, rank: isMain ? 0 : d.status === 'main_focus' ? 1 : 2 });
  }
  // Array.prototype.sort is stable, so equal ranks keep their stored order.
  out.sort((a, b) => a.rank - b.rank);
  return out.map((o) => ({ optionId: o.optionId, sourceId: o.sourceId, sourceName: o.sourceName, isMain: o.isMain }));
}

/** Convenience: one client's active options of one kind, from ctx-style inputs. */
export function clientActiveOptionRefs(
  models: AppModel[],
  records: Record<string, AppRecord[]>,
  clientId: string,
  kind: OptionSourceKind,
): ActiveOptionRef[] {
  if (!clientId) return [];
  return activeOptionRefs(optionRecordsByClient(models, records).get(clientId) ?? [], kind);
}
