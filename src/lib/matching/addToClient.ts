/**
 * Add a recommended record to one of a client's multi-lookup preference fields —
 * the controlled, USER-TRIGGERED "Add to client" action behind the Project Finder
 * cards. Routed by SOURCE so each id lands in the field that targets the right
 * model:
 *   - our_projects / all_projects → `preferred_projects` (lookup → all_projects)
 *   - market_listings             → `preferred_market_listings` (lookup → market_listings)
 * This keeps a market-listing id out of `preferred_projects` (an all_projects
 * lookup), which would otherwise be an invalid cross-model reference.
 *
 * Goes through the store's `saveRecord` (version-aware, RLS-correct, surfaces +
 * persists failures per the silent-failure rules). NEVER writes from AI text —
 * only when the salesperson presses the button. Append-dedup, so pressing twice
 * is a no-op.
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

/** Append `recordId` to the client's `field` (a multi-value lookup), dedup + version-aware. */
async function addToClientLookup(clientId: string, recordId: string, field: string): Promise<AddToClientResult> {
  if (!clientId || !recordId) return { ok: false, status: 'error', reason: 'missing ids' };

  const state = useAppStore.getState();
  const clientsModel = state.models.find((m) => m.name === 'clients');
  if (!clientsModel) return { ok: false, status: 'error', reason: 'clients model not loaded' };

  const record = (state.records[clientsModel.id] ?? []).find((r) => r.id === clientId);
  if (!record) return { ok: false, status: 'error', reason: 'client not found' };

  const raw = record.data[field];
  const current: string[] = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string')
    : typeof raw === 'string' && raw
      ? [raw]
      : [];
  if (current.includes(recordId)) return { ok: true, status: 'already' };

  const updated: AppRecord = {
    ...record,
    data: { ...record.data, [field]: [...current, recordId] },
    updated_at: new Date().toISOString(),
  };

  const res = await state.saveRecord(updated, { expectedVersion: record.version ?? null });
  if (res.status === 'saved') return { ok: true, status: 'added' };
  if (res.status === 'queued') return { ok: true, status: 'queued', reason: res.reason };
  // conflict — a concurrent edit bumped the version; the user should reload.
  return { ok: false, status: 'conflict', reason: 'version_mismatch' };
}

/** Add an all_projects record to `clients.preferred_projects`. */
export function addProjectToClient(clientId: string, projectId: string): Promise<AddToClientResult> {
  return addToClientLookup(clientId, projectId, 'preferred_projects');
}

/** Add a market_listings record to `clients.preferred_market_listings`. */
export function addMarketListingToClient(clientId: string, listingId: string): Promise<AddToClientResult> {
  return addToClientLookup(clientId, listingId, 'preferred_market_listings');
}
