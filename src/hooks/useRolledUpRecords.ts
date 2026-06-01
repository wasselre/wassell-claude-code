// Hooks that apply cross-record rollup computations to records before
// they're consumed by the UI. These are the units → project rollups for
// BOTH our_projects and all_projects (see src/lib/ourProjectsRollup.ts);
// `applyProjectRollups` dispatches by model name and is the identity for
// every other model.
//
// Subscribe to BOTH the consumed model's records AND the units records
// so the rolled-up values stay live: when a unit is added / edited /
// deleted, every project row visible on screen recomputes through
// React's normal re-render cycle.

import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { applyProjectRollups, modelHasUnitRollups } from '@/lib/ourProjectsRollup';
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
    if (!modelHasUnitRollups(model)) return rawList;
    const unitsModel = models.find((m) => m.name === 'units');
    if (!unitsModel) return rawList;
    const units = allRecords[unitsModel.id] ?? [];
    return rawList.map((r) => applyProjectRollups(r, model!, units));
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
    if (!modelHasUnitRollups(model)) return rawRecord;
    const unitsModel = models.find((m) => m.name === 'units');
    if (!unitsModel) return rawRecord;
    const units = allRecords[unitsModel.id] ?? [];
    return applyProjectRollups(rawRecord, model!, units);
  }, [modelId, rawRecord, models, allRecords]);
}
