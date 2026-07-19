/**
 * Client Property Options — the deterministic, USER-TRIGGERED store of the
 * property options found for a client (projects, units, market listings) in ONE
 * unified place. This is the OUTPUT of the matching work (Project Finder), NOT
 * the client's preference INPUTS (budget / location / bedrooms / type / area /
 * amenities stay on the clients model's Preferences section, untouched).
 *
 * NO AI anywhere in this file. Every write goes through the store's version-aware
 * `saveRecord` (RLS-correct, surfaces + persists failures per the silent-failure
 * rules). Uniqueness on (client_id + source_type + source_id) is enforced here at
 * save time via read-check-merge — which is required anyway for the "update don't
 * duplicate / don't silently reactivate an eliminated option" rules.
 *
 * Backing model: `client_property_options` (JSONB seed model, see seedModels.ts).
 * Display facts (price / area / beds / etc.) are snapshotted onto `data.facts`
 * at save time so the Client Options view renders without re-resolving the 46k
 * market_listings catalogue.
 */

import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import type { AppModel, AppRecord } from '@/types';

export const CLIENT_OPTIONS_MODEL = 'client_property_options';

export type ClientOptionSourceType = 'project' | 'unit' | 'market_listing';
export type ClientOptionStatus =
  | 'suitable'
  | 'main_focus'
  | 'presented'
  | 'interested'
  | 'not_interested'
  | 'eliminated'
  | 'reserved'
  | 'closed';
export type ClientOptionAddedFrom = 'project_finder' | 'manual' | 'follow_up';

/** The shape we read off a `client_property_options` record's `data` JSONB. */
export interface ClientOptionData {
  client_id: string;
  source_type: ClientOptionSourceType;
  source_id: string;
  source_name?: string;
  status: ClientOptionStatus;
  is_main?: boolean;
  match_score?: number | null;
  match_run_id?: string | null;
  priority_rank?: number | null;
  added_from?: ClientOptionAddedFrom;
  added_by?: string | null;
  sales_notes?: string;
  elimination_notes?: string;
  /** Snapshot of the source's display facts (same shape FinderCard renders). */
  facts?: Record<string, unknown> | null;
}

/** Input for upserting one option (e.g. from a Project Finder card). */
export interface SaveOptionInput {
  clientId: string;
  sourceType: ClientOptionSourceType;
  sourceId: string;
  sourceName?: string | null;
  matchScore?: number | null;
  matchRunId?: string | null;
  facts?: Record<string, unknown> | null;
  addedFrom?: ClientOptionAddedFrom;
  /** Default status for a NEW option. Ignored when updating an existing one. */
  status?: ClientOptionStatus;
}

export type SaveOptionOutcome =
  | 'created'
  | 'updated'
  | 'eliminated_exists'
  | 'conflict'
  | 'queued'
  | 'error';

export interface SaveOptionResult {
  ok: boolean;
  outcome: SaveOptionOutcome;
  optionId?: string;
  reason?: string;
}

export interface SimpleResult {
  ok: boolean;
  status?: 'saved' | 'queued' | 'conflict' | 'error';
  reason?: string;
}

/** Shared status display metadata — single source for labels + badge colors. */
export const CLIENT_OPTION_STATUS_META: Record<ClientOptionStatus, { ar: string; en: string; color: string }> = {
  suitable: { ar: 'مناسبة', en: 'Suitable', color: '#C09B5F' },
  main_focus: { ar: 'التركيز الرئيسي', en: 'Main Focus', color: '#B8734F' },
  presented: { ar: 'تم العرض', en: 'Presented', color: '#3B82F6' },
  interested: { ar: 'مهتم', en: 'Interested', color: '#16A34A' },
  not_interested: { ar: 'غير مهتم', en: 'Not Interested', color: '#6B7280' },
  eliminated: { ar: 'مستبعدة', en: 'Eliminated', color: '#DC2626' },
  reserved: { ar: 'محجوزة', en: 'Reserved', color: '#D97706' },
  closed: { ar: 'مغلقة', en: 'Closed', color: '#4A2C2A' },
};

export const CLIENT_OPTION_SOURCE_META: Record<ClientOptionSourceType, { ar: string; en: string }> = {
  project: { ar: 'مشروع', en: 'Project' },
  unit: { ar: 'وحدة', en: 'Unit' },
  market_listing: { ar: 'إعلان سوق', en: 'Market Listing' },
};

/** Display ordering: active/important statuses first, eliminated last. */
export const CLIENT_OPTION_STATUS_ORDER: ClientOptionStatus[] = [
  'main_focus', 'reserved', 'interested', 'presented', 'suitable', 'not_interested', 'closed', 'eliminated',
];

/** Map a Project Finder source to a Client Option source_type. */
export function finderSourceToOptionType(
  source: 'our_projects' | 'all_projects' | 'market_listings',
): ClientOptionSourceType {
  return source === 'market_listings' ? 'market_listing' : 'project';
}

/** Route for the source record behind an option (for the "view source" action). */
export function optionSourceUrl(sourceType: ClientOptionSourceType, sourceId: string): string {
  const model =
    sourceType === 'market_listing' ? 'market_listings' : sourceType === 'unit' ? 'units' : 'all_projects';
  return `/model/${model}/${sourceId}`;
}

const nowIso = () => new Date().toISOString();

/** The `client_property_options` model, or null if not loaded yet. */
export function clientOptionsModel(): AppModel | null {
  return useAppStore.getState().models.find((m) => m.name === CLIENT_OPTIONS_MODEL) ?? null;
}

/** All option records for a client (unsorted; caller orders for display). */
export function getClientOptions(clientId: string): AppRecord[] {
  const state = useAppStore.getState();
  const model = state.models.find((m) => m.name === CLIENT_OPTIONS_MODEL);
  if (!model || !clientId) return [];
  return (state.records[model.id] ?? []).filter((r) => r.data.client_id === clientId);
}

/** Find the single option matching the uniqueness key (client + source_type + source_id). */
export function findClientOption(
  clientId: string,
  sourceType: ClientOptionSourceType,
  sourceId: string,
): AppRecord | undefined {
  return getClientOptions(clientId).find(
    (r) => r.data.source_type === sourceType && r.data.source_id === sourceId,
  );
}

/** Get a single option record by its own id (across the whole model). */
function optionById(optionId: string): AppRecord | undefined {
  const state = useAppStore.getState();
  const model = state.models.find((m) => m.name === CLIENT_OPTIONS_MODEL);
  if (!model) return undefined;
  return (state.records[model.id] ?? []).find((r) => r.id === optionId);
}

function mapSaveStatus(status: 'saved' | 'queued' | 'conflict'): SimpleResult {
  if (status === 'saved') return { ok: true, status: 'saved' };
  if (status === 'queued') return { ok: true, status: 'queued' };
  return { ok: false, status: 'conflict', reason: 'version_mismatch' };
}

/**
 * Upsert one option, enforcing uniqueness + the eliminated guard:
 *   - no existing row      → create with status (default 'suitable')
 *   - existing eliminated  → DO NOT reactivate; return 'eliminated_exists'
 *   - existing otherwise   → refresh only SAFE metadata (match_score, match_run_id,
 *                            facts, source_name) — never touch status / is_main / notes
 */
export async function saveClientOption(input: SaveOptionInput): Promise<SaveOptionResult> {
  const { clientId, sourceType, sourceId } = input;
  if (!clientId || !sourceType || !sourceId) {
    return { ok: false, outcome: 'error', reason: 'missing ids' };
  }
  const state = useAppStore.getState();
  const model = state.models.find((m) => m.name === CLIENT_OPTIONS_MODEL);
  if (!model) return { ok: false, outcome: 'error', reason: 'client_property_options model not loaded' };

  const existing = findClientOption(clientId, sourceType, sourceId);

  if (existing) {
    // Already eliminated → do NOT silently reactivate. The UI surfaces this and
    // requires a manual reactivation.
    if (existing.data.status === 'eliminated') {
      return { ok: true, outcome: 'eliminated_exists', optionId: existing.id };
    }
    // Refresh only safe metadata; preserve the rep's status / main / notes.
    const patch: Partial<ClientOptionData> = {};
    if (input.matchScore != null) patch.match_score = input.matchScore;
    if (input.matchRunId) patch.match_run_id = input.matchRunId;
    if (input.facts) patch.facts = input.facts;
    if (input.sourceName && !existing.data.source_name) patch.source_name = input.sourceName;
    if (Object.keys(patch).length === 0) return { ok: true, outcome: 'updated', optionId: existing.id };

    const updated: AppRecord = {
      ...existing,
      data: { ...existing.data, ...patch },
      updated_at: nowIso(),
    };
    const res = await state.saveRecord(updated, { expectedVersion: existing.version ?? null });
    const m = mapSaveStatus(res.status);
    return {
      ok: m.ok,
      outcome: m.status === 'conflict' ? 'conflict' : m.status === 'queued' ? 'queued' : 'updated',
      optionId: existing.id,
      reason: m.reason,
    };
  }

  // Create a new option.
  const id = uuid();
  const data: ClientOptionData = {
    client_id: clientId,
    source_type: sourceType,
    source_id: sourceId,
    source_name: input.sourceName ?? '',
    status: input.status ?? 'suitable',
    is_main: false,
    match_score: input.matchScore ?? null,
    match_run_id: input.matchRunId ?? null,
    priority_rank: null,
    added_from: input.addedFrom ?? 'manual',
    added_by: state.currentUserId ?? null,
    sales_notes: '',
    elimination_notes: '',
    facts: input.facts ?? null,
  };
  const record: AppRecord = {
    id,
    model_id: model.id,
    data: data as unknown as Record<string, unknown>,
    created_by_user_id: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const res = await state.saveRecord(record);
  if (res.status === 'saved') return { ok: true, outcome: 'created', optionId: id };
  if (res.status === 'queued') return { ok: true, outcome: 'queued', optionId: id };
  return { ok: false, outcome: 'conflict', optionId: id, reason: 'version_mismatch' };
}

export interface BulkSaveSummary {
  created: number;
  updated: number;
  skippedEliminated: number;
  failed: number;
}

/**
 * Save many options for a client (e.g. the SELECTED Project Finder cards). Each
 * option is its own record, so writes are independent; we run them sequentially
 * for deterministic tallying. Returns counts the UI can summarize in a toast.
 */
export async function bulkSaveOptions(
  clientId: string,
  items: Omit<SaveOptionInput, 'clientId'>[],
  addedFrom: ClientOptionAddedFrom = 'project_finder',
): Promise<BulkSaveSummary> {
  const summary: BulkSaveSummary = { created: 0, updated: 0, skippedEliminated: 0, failed: 0 };
  for (const item of items) {
    const res = await saveClientOption({ ...item, clientId, addedFrom: item.addedFrom ?? addedFrom });
    if (res.outcome === 'created') summary.created += 1;
    else if (res.outcome === 'updated') summary.updated += 1;
    else if (res.outcome === 'eliminated_exists') summary.skippedEliminated += 1;
    else summary.failed += 1;
  }
  return summary;
}

/** Merge a patch into one option's data and persist it (version-aware). */
async function patchOption(optionId: string, patch: Partial<ClientOptionData>): Promise<SimpleResult> {
  const rec = optionById(optionId);
  if (!rec) return { ok: false, status: 'error', reason: 'option not found' };
  const updated: AppRecord = {
    ...rec,
    data: { ...rec.data, ...patch },
    updated_at: nowIso(),
  };
  const res = await useAppStore.getState().saveRecord(updated, { expectedVersion: rec.version ?? null });
  return mapSaveStatus(res.status);
}

/**
 * Mark one option as the client's MAIN option. Enforces a single active main:
 * this option becomes is_main=true + status='main_focus'; every OTHER option for
 * the same client is set is_main=false (and any sibling still flagged
 * 'main_focus' is demoted to 'suitable' so the status badge stays consistent).
 * Only records that actually change are written.
 */
export async function setMainOption(clientId: string, optionId: string): Promise<SimpleResult> {
  const target = optionById(optionId);
  if (!target) return { ok: false, status: 'error', reason: 'option not found' };

  let ok = true;
  let lastReason: string | undefined;

  // Demote siblings.
  for (const sib of getClientOptions(clientId)) {
    if (sib.id === optionId) continue;
    const wasMain = sib.data.is_main === true;
    const wasMainFocus = sib.data.status === 'main_focus';
    if (!wasMain && !wasMainFocus) continue;
    const patch: Partial<ClientOptionData> = { is_main: false };
    if (wasMainFocus) patch.status = 'suitable';
    const r = await patchOption(sib.id, patch);
    if (!r.ok) { ok = false; lastReason = r.reason; }
  }

  // Promote the target.
  const r = await patchOption(optionId, { is_main: true, status: 'main_focus' });
  if (!r.ok) { ok = false; lastReason = r.reason; }
  return { ok, reason: lastReason };
}

/** Eliminate an option: status='eliminated' + store the (required) reason notes, clear main. */
export function eliminateOption(optionId: string, eliminationNotes: string): Promise<SimpleResult> {
  return patchOption(optionId, {
    status: 'eliminated',
    is_main: false,
    elimination_notes: eliminationNotes,
  });
}

/** Manually reactivate an eliminated option back to 'suitable' (keeps the notes for history). */
export function reactivateOption(optionId: string): Promise<SimpleResult> {
  return patchOption(optionId, { status: 'suitable' });
}

/**
 * HARD-DELETE one option row — remove the property from this client's options
 * entirely. Distinct from `eliminateOption`:
 *
 *   eliminate → the row STAYS with status 'eliminated'. It is the tombstone
 *               that makes the finder refuse to re-add this source ("already
 *               eliminated"), preserving the rep's judgement + reason.
 *   delete    → the row is GONE. The uniqueness key (client + source_type +
 *               source_id) frees up, so a later search can surface the same
 *               property again and save it fresh. Use when the option was
 *               added by mistake or the list should be re-opened for a clean
 *               re-search.
 *
 * Deletes ONLY the client_property_options row. The underlying project / unit /
 * market listing record is never touched.
 */
export function deleteClientOption(optionId: string): SimpleResult {
  const state = useAppStore.getState();
  const model = state.models.find((m) => m.name === CLIENT_OPTIONS_MODEL);
  if (!model) return { ok: false, status: 'error', reason: 'client_property_options model not loaded' };
  const rec = optionById(optionId);
  if (!rec) return { ok: false, status: 'error', reason: 'option not found' };
  // Store-level delete: removes locally, mirrors to Supabase through the
  // shared helper (surfaces + queues failures per the silent-failure rules).
  state.deleteRecord(model.id, optionId);
  return { ok: true, status: 'saved' };
}

/**
 * Change an option's status. 'main_focus' is routed through setMainOption to keep
 * a single active main; 'eliminated' should go through eliminateOption (so a
 * reason is captured) — but is handled here too for completeness (no notes).
 */
export async function updateOptionStatus(
  optionId: string,
  status: ClientOptionStatus,
): Promise<SimpleResult> {
  const rec = optionById(optionId);
  if (!rec) return { ok: false, status: 'error', reason: 'option not found' };
  if (status === 'main_focus') return setMainOption(rec.data.client_id as string, optionId);
  const patch: Partial<ClientOptionData> = { status };
  // Leaving main_focus by hand drops the main flag so the two stay consistent.
  if (rec.data.is_main === true) patch.is_main = false;
  return patchOption(optionId, patch);
}

/** Update the free-text sales notes on an option. */
export function updateSalesNotes(optionId: string, salesNotes: string): Promise<SimpleResult> {
  return patchOption(optionId, { sales_notes: salesNotes });
}
