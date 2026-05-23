// Hooks that apply cross-record rollup computations to records before
// they're consumed by the UI. Today this is the our_projects → units
// rollups (see src/lib/ourProjectsRollup.ts); future rollups for other
// models would extend the dispatch below.
//
// Subscribe to BOTH the consumed model's records AND the units records
// so the rolled-up values stay live: when a unit is added / edited /
// deleted, every our_projects row visible on screen recomputes through
// React's normal re-render cycle.

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { applyOurProjectsRollups } from '@/lib/ourProjectsRollup';
import type { AppRecord } from '@/types';

/**
 * Apply rollup post-processing to a list of records for a given model.
 * For models without any rollups (everything except our_projects in v1)
 * this is the identity function and returns the same array reference,
 * so downstream useMemo / equality checks aren't disturbed.
 */
export function useRolledUpRecordList(
  modelId: string | undefined,
  rawList: readonly AppRecord[],
): readonly AppRecord[] {
  const models = useAppStore((s) => s.models);
  const allRecords = useAppStore((s) => s.records);
  return useMemo(() => {
    if (!modelId) return rawList;
    const model = models.find((m) => m.id === modelId);
    if (!model || model.name !== 'our_projects') return rawList;
    const unitsModel = models.find((m) => m.name === 'units');
    if (!unitsModel) return rawList;
    const units = allRecords[unitsModel.id] ?? [];
    return rawList.map((r) => applyOurProjectsRollups(r, model, units));
  }, [modelId, rawList, models, allRecords]);
}

/**
 * Apply rollup post-processing to a single record. Returns null when the
 * record is null/undefined so consumers can chain through optional
 * existingRecord lookups without extra guards.
 */
export function useRolledUpRecord(
  modelId: string | undefined,
  rawRecord: AppRecord | null | undefined,
): AppRecord | null {
  const models = useAppStore((s) => s.models);
  const allRecords = useAppStore((s) => s.records);
  return useMemo(() => {
    if (!rawRecord) return null;
    if (!modelId) return rawRecord;
    const model = models.find((m) => m.id === modelId);
    if (!model || model.name !== 'our_projects') return rawRecord;
    const unitsModel = models.find((m) => m.name === 'units');
    if (!unitsModel) return rawRecord;
    const units = allRecords[unitsModel.id] ?? [];
    return applyOurProjectsRollups(rawRecord, model, units);
  }, [modelId, rawRecord, models, allRecords]);
}
