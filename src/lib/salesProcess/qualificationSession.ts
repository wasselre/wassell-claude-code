// qualificationSession — the app-wide singleton that holds the live-call working
// preference draft for ONE follow-up at a time.
//
// WHY A SINGLETON (Phase 4): capture is a singleton so it survives the rep going
// Follow-Up → Suggested Projects → Follow-Up. The working draft must survive the
// same round-trip AND keep receiving extraction while the Workspace is unmounted.
// Component state can't; this can.
//
// It wraps the PURE Phase 3 reducer (qualificationDraft.ts) unchanged — this module
// only holds the state + a pub/sub, and enforces the follow-up scope. `useQualification
// Draft` subscribes to it; captureController feeds `applyExtractionEvent`.
//
// FOLLOW-UP SCOPED: navigation within a mission preserves state; switching missions/
// clients resets it (no draft/transcript/exception/provenance leak between tasks).

import {
  seedQualification, applyRepEdit, applyExtraction as reduceExtraction, computeDiff,
  type QualificationState, type DiffEntry, type ExtractionInput, type DistrictIndexEntry,
} from './qualificationDraft';

export interface QualificationSessionContext {
  /** The saved client data at session start — the baseline for green-vs-amber provenance. */
  savedData: Record<string, unknown> | null;
  resolveDistrict?: (name: string) => DistrictIndexEntry | 'ambiguous' | 'not_found';
}

export interface QualificationSessionState {
  followupId: string | null;
  clientId: string | null;
  qual: QualificationState;
  ctx: QualificationSessionContext;
}

const EMPTY: QualificationSessionState = {
  followupId: null,
  clientId: null,
  qual: seedQualification(null),
  ctx: { savedData: null },
};

let state: QualificationSessionState = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot for useSyncExternalStore (same ref until a mutation). */
export function getSnapshot(): QualificationSessionState {
  return state;
}

/**
 * Ensure the session is for THIS follow-up. Same follow-up → preserved (navigation
 * within a mission never resets the draft). Different → reset + reseed from the new
 * client's saved data (a mission/client change must never inherit the prior state).
 */
export function ensureSession(input: {
  followupId: string;
  clientId: string | null;
  ctx: QualificationSessionContext;
}): void {
  if (state.followupId === input.followupId) return;
  state = {
    followupId: input.followupId,
    clientId: input.clientId,
    qual: seedQualification(input.ctx.savedData),
    ctx: input.ctx,
  };
  emit();
}

/** Human edit — locks the field (via the reducer). */
export function setRepEdit(slug: string, value: unknown): void {
  state = { ...state, qual: applyRepEdit(state.qual, slug, value) };
  emit();
}

/** AI evidence — runs the Phase 3 auto-apply reducer with the session's ctx. */
export function applyExtractionEvent(extraction: ExtractionInput): void {
  state = {
    ...state,
    qual: reduceExtraction(state.qual, extraction, {
      savedData: state.ctx.savedData,
      resolveDistrict: state.ctx.resolveDistrict,
    }),
  };
  emit();
}

/** Re-seed from a freshly-saved client (after the full-edit modal persists). Resets
 *  the baseline to the new saved values. */
export function reseedFromSaved(savedData: Record<string, unknown> | null): void {
  state = { ...state, ctx: { ...state.ctx, savedData }, qual: seedQualification(savedData) };
  emit();
}

/** Clear on completion/abandon of a follow-up. No-op if a followupId is given and
 *  doesn't match the active session (avoids clearing a different mission). */
export function resetSession(followupId?: string): void {
  if (followupId && state.followupId !== followupId) return;
  state = EMPTY;
  emit();
}

export function sessionDiff(): DiffEntry[] {
  return computeDiff(state.qual, state.ctx.savedData);
}

/** TEST-ONLY. */
export function __resetSession(): void {
  state = EMPTY;
  emit();
}
