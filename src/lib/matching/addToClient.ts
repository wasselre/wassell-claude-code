/**
 * Add a recommended project to a client's `preferred_projects` — the controlled,
 * USER-TRIGGERED "Add to client" action behind the Suggested Projects cards.
 *
 * Goes through the store's `saveRecord` (version-aware, RLS-correct, surfaces +
 * persists failures per the silent-failure rules). NEVER writes from AI text —
 * only when the salesperson presses the button. Reuses the EXISTING
 * `clients.preferred_projects` lookup field (multi → all_projects); no schema
 * change. Append-dedup, so pressing twice is a no-op.
 */

import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';

export type AddToClientStatus = 'added' | 'already' | 'conflict' | 'queued' | 'error';

export interface AddToClientResult {
  ok: boolean;
  status: AddToClientStatus;
  /** A non-localized reason for logging; the UI shows its own toast text. */
  reason?: string;
}

const FIELD = 'preferred_projects';

export async function addProjectToClient(clientId: string, projectId: string): Promise<AddToClientResult> {
  if (!clientId || !projectId) return { ok: false, status: 'error', reason: 'missing ids' };

  const state = useAppStore.getState();
  const clientsModel = state.models.find((m) => m.name === 'clients');
  if (!clientsModel) return { ok: false, status: 'error', reason: 'clients model not loaded' };

  const record = (state.records[clientsModel.id] ?? []).find((r) => r.id === clientId);
  if (!record) return { ok: false, status: 'error', reason: 'client not found' };

  const raw = record.data[FIELD];
  const current: string[] = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string')
    : typeof raw === 'string' && raw
      ? [raw]
      : [];
  if (current.includes(projectId)) return { ok: true, status: 'already' };

  const updated: AppRecord = {
    ...record,
    data: { ...record.data, [FIELD]: [...current, projectId] },
    updated_at: new Date().toISOString(),
  };

  const res = await state.saveRecord(updated, { expectedVersion: record.version ?? null });
  if (res.status === 'saved') return { ok: true, status: 'added' };
  if (res.status === 'queued') return { ok: true, status: 'queued', reason: res.reason };
  // conflict — a concurrent edit bumped the version; the user should reload.
  return { ok: false, status: 'conflict', reason: 'version_mismatch' };
}
