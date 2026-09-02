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

  // The unit option and its parent-project option are two independent records
  // (different source_type, different rows), so their writes never race. Run
  // them CONCURRENTLY: previously they awaited sequentially, so a single "add
  // unit" cost two full record_save round-trips end-to-end — and either one
  // hitting the DB's occasional multi-second tail stalled the whole action.
  const [unit, project] = await Promise.all([
    saveClientOption({
      clientId,
      sourceType: 'unit',
      sourceId: unitRec.id,
      sourceName: unitName || null,
      facts: buildOptionFacts(store, 'unit', unitRec),
      addedFrom,
      status: 'suitable',
    }),
    projRec
      ? saveClientOption({
          clientId,
          sourceType: 'project',
          sourceId: projRec.id,
          sourceName: projectName,
          facts: buildOptionFacts(store, 'project', projRec),
          addedFrom,
          status: 'suitable',
        })
      : Promise.resolve<SaveOptionResult | null>(null),
  ]);

  return { unit, project };
}

/**
 * Save ONE project to a client's property options — the unified path behind the
 * in-chat Projects & Units browser's "Add to options" button. Goes through the
 * SAME `saveClientOption` engine (client_property_options, `source_type:'project'`)
 * as the Project Finder and the unit save above, so a project saved from a chat
 * shows up in the Client Options tab like every other option — replacing the old
 * `addProjectToClient` path that wrote to the `clients.preferred_projects`
 * lookup (a preference field, invisible to the options tab).
 */
export async function saveProjectToClient(
  clientId: string,
  projectRec: AppRecord,
  addedFrom: ClientOptionAddedFrom = 'manual',
): Promise<SaveOptionResult> {
  const state = useAppStore.getState();
  const store = { models: state.models, records: state.records };
  const projectName = asString((projectRec.data as Record<string, unknown>).project_name);
  return saveClientOption({
    clientId,
    sourceType: 'project',
    sourceId: projectRec.id,
    sourceName: projectName,
    facts: buildOptionFacts(store, 'project', projectRec),
    addedFrom,
    status: 'suitable',
  });
}
