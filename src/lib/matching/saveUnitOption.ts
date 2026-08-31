/**
 * Save ONE unit to a client's property options — and, per the sales rule, save
 * its PARENT PROJECT too. A unit is only ever a candidate *inside* a project, so
 * a client whose options list holds a unit must also hold that unit's project
 * (the project is what carries the "Send to client" WhatsApp flow + the units
 * inventory popup in the Client Options tab).
 *
 * Both writes go through the SAME `saveClientOption` engine as the Project
 * Finder — version-aware, dedup on (client + source_type + source_id), and the
 * eliminated-guard (a previously-eliminated unit/project is NOT silently
 * reactivated; the caller surfaces "reactivate from the options list"). Two
 * independent option records, so the writes don't race each other.
 *
 * NEVER writes from AI text — only when the salesperson presses the button.
 */

import { useAppStore } from '@/stores/appStore';
import { modelByName, asString } from '@/lib/projects/projectView';
import { buildOptionFacts } from '@/lib/matching/optionFacts';
import {
  saveClientOption,
  type ClientOptionAddedFrom, type SaveOptionResult,
} from '@/lib/matching/clientOptions';
import type { AppRecord } from '@/types';

const firstId = (v: unknown): string | null =>
  Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : null) : typeof v === 'string' && v ? v : null;

export interface SaveUnitResult {
  /** The unit option write. */
  unit: SaveOptionResult;
  /** The parent-project option write, or null when the unit has no project link. */
  project: SaveOptionResult | null;
}

/**
 * Upsert the unit option + its parent-project option for a client. Returns both
 * results so the UI can toast an accurate outcome (created / already-there /
 * eliminated-guard / failure) for each.
 */
export async function saveUnitToClient(
  clientId: string,
  unitRec: AppRecord,
  addedFrom: ClientOptionAddedFrom = 'manual',
): Promise<SaveUnitResult> {
  const state = useAppStore.getState();
  const store = { models: state.models, records: state.records };
  const data = unitRec.data as Record<string, unknown>;

  // Resolve the parent project (for the unit's display name + the project option).
  const projectId = firstId(data.project_id);
  const ap = modelByName(state.models, 'all_projects');
  const projRec = projectId && ap ? (state.records[ap.id] ?? []).find((r) => r.id === projectId) : undefined;
  const projectName = projRec ? asString((projRec.data as Record<string, unknown>).project_name) : null;

  // Unit display name: "Project — U-0001" (falls back gracefully), matching the
  // manual Add-option picker so the two surfaces name a unit identically.
  const code = asString(data.unit_code) ?? asString(data.unit_number) ?? '';
  const unitName = [projectName, code].filter(Boolean).join(' — ');

  const unit = await saveClientOption({
    clientId,
    sourceType: 'unit',
    sourceId: unitRec.id,
    sourceName: unitName || null,
    facts: buildOptionFacts(store, 'unit', unitRec),
    addedFrom,
    status: 'suitable',
  });

  let project: SaveOptionResult | null = null;
  if (projRec) {
    project = await saveClientOption({
      clientId,
      sourceType: 'project',
      sourceId: projRec.id,
      sourceName: projectName,
      facts: buildOptionFacts(store, 'project', projRec),
      addedFrom,
      status: 'suitable',
    });
  }

  return { unit, project };
}
