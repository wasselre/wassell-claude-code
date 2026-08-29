import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  noteRecordConflict,
  recordSaveBlocked,
  markRecordWedged,
  releaseBreakerForRetry,
  clearRecordConflict,
  getReloadAttempts,
  noteReloadAttempt,
  reachedReloadCap,
  shouldAdoptResync,
  noteAbsoluteConflict,
  reachedAbsoluteConflictCap,
  __resetConflictBreaker,
  RECORD_CONFLICT_LIMIT,
  MAX_RELOAD_RETRIES,
  RECORD_ABSOLUTE_CONFLICT_LIMIT,
} from '../conflictBreaker';

beforeEach(() => __resetConflictBreaker());

describe('per-record conflict breaker', () => {
  it('does not block until the conflict limit is reached, then trips permanently', () => {
    const id = 'r1';
    for (let i = 1; i < RECORD_CONFLICT_LIMIT; i++) {
      expect(noteRecordConflict(id)).toBe(false);
      expect(recordSaveBlocked(id)).toBe(false);
    }
    // the LIMIT-th conflict in the window trips the breaker (returns true once)
    expect(noteRecordConflict(id)).toBe(true);
    expect(recordSaveBlocked(id)).toBe(true);
  });

  it('markRecordWedged trips immediately so saves stop (storm_blocked / wedged)', () => {
    // bullets 1 & 5: conflict_storm_blocked → markRecordWedged → recordSaveBlocked
    // is true, so supabaseRecordUpsert short-circuits and never calls record_save.
    const id = 'r2';
    expect(recordSaveBlocked(id)).toBe(false);
    markRecordWedged(id);
    expect(recordSaveBlocked(id)).toBe(true);
  });

  it('a wedged record stays blocked across further conflicts (no auto re-open)', () => {
    const id = 'r3';
    markRecordWedged(id);
    expect(noteRecordConflict(id)).toBe(false); // already tripped → no re-trip churn
    expect(recordSaveBlocked(id)).toBe(true);
  });
});

describe('reload-attempt cap (one reload, then wedge)', () => {
  it('allows exactly one reload, then reports the cap reached', () => {
    const id = 'r4';
    // bullet 4: first version_mismatch → reload allowed (cap not yet reached)
    expect(reachedReloadCap(id)).toBe(false);
    expect(noteReloadAttempt(id)).toBe(1);
    // bullet 5: second version_mismatch after that reload → cap reached → wedge
    expect(reachedReloadCap(id)).toBe(true);
    expect(MAX_RELOAD_RETRIES).toBe(1);
  });

  it('releaseBreakerForRetry clears the breaker but PRESERVES the attempt counter', () => {
    // bullet 6: reload-on-conflict must NOT repeatedly clear the breaker. Releasing
    // for one retry keeps the attempt counter so a recurrence still caps.
    const id = 'r5';
    noteRecordConflict(id);
    noteReloadAttempt(id);
    expect(getReloadAttempts(id)).toBe(1);
    markRecordWedged(id);
    releaseBreakerForRetry(id);
    expect(recordSaveBlocked(id)).toBe(false); // released for ONE retry...
    expect(getReloadAttempts(id)).toBe(1); // ...but the cap is NOT reset
    expect(reachedReloadCap(id)).toBe(true); // so the next recurrence wedges
  });

  it('successful save (clearRecordConflict) resets BOTH breaker and attempt counter', () => {
    // bullet 7
    const id = 'r6';
    markRecordWedged(id);
    noteReloadAttempt(id);
    clearRecordConflict(id);
    expect(recordSaveBlocked(id)).toBe(false);
    expect(getReloadAttempts(id)).toBe(0);
    expect(reachedReloadCap(id)).toBe(false);
  });
});

describe('counting window rollover', () => {
  it('rolls the counting window so isolated conflicts far apart never trip', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-24T00:00:00Z'));
      const id = 'r7';
      expect(noteRecordConflict(id)).toBe(false); // count 1
      vi.setSystemTime(new Date('2026-06-24T00:00:11Z')); // >10s later
      expect(noteRecordConflict(id)).toBe(false); // window rolled → count 1, not tripped
      expect(recordSaveBlocked(id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('absolute conflict cap (2026-08-29 followups two-writer storm)', () => {
  it('latches after RECORD_ABSOLUTE_CONFLICT_LIMIT conflicts even when the window count is repeatedly cleared', () => {
    // The storm signature: every reload-and-retry deletes the windowed count
    // (releaseBreakerForRetry), so noteRecordConflict NEVER trips — yet the
    // absolute counter marches on because no SUCCESS ever resets it.
    const id = 'followup-storm';
    let cap = false;
    for (let i = 1; i <= RECORD_ABSOLUTE_CONFLICT_LIMIT; i++) {
      noteRecordConflict(id);
      const n = noteAbsoluteConflict(id);
      cap = n >= RECORD_ABSOLUTE_CONFLICT_LIMIT;
      // simulate the reset race that defeats the windowed breaker + reload cap
      releaseBreakerForRetry(id);
      expect(recordSaveBlocked(id)).toBe(false); // window breaker keeps getting cleared
    }
    // ...but the absolute counter latched on the LIMIT-th conflict.
    expect(cap).toBe(true);
    expect(reachedAbsoluteConflictCap(id)).toBe(true);
  });

  it('a genuine concurrent edit (conflict then SUCCESS) resets the absolute counter — no false positive', () => {
    const id = 'legit-edit';
    // one or two conflicts while the user is behind, then their reload+resave succeeds
    noteAbsoluteConflict(id);
    noteAbsoluteConflict(id);
    expect(reachedAbsoluteConflictCap(id)).toBe(false);
    clearRecordConflict(id); // successful save
    expect(reachedAbsoluteConflictCap(id)).toBe(false);
    // and it takes the FULL cap again from zero after the reset
    for (let i = 1; i < RECORD_ABSOLUTE_CONFLICT_LIMIT; i++) noteAbsoluteConflict(id);
    expect(reachedAbsoluteConflictCap(id)).toBe(false);
    noteAbsoluteConflict(id);
    expect(reachedAbsoluteConflictCap(id)).toBe(true);
  });

  it('releaseBreakerForRetry does NOT reset the absolute counter (only success does)', () => {
    const id = 'no-reset-on-refetch';
    noteAbsoluteConflict(id);
    noteAbsoluteConflict(id);
    releaseBreakerForRetry(id);
    expect(noteAbsoluteConflict(id)).toBe(3); // continued, not reset to 1
  });
});

describe('shouldAdoptResync — RecordFormPage one-shot re-sync (req 5)', () => {
  it('adopts when armed AND the live version advanced past the snapshot', () => {
    expect(shouldAdoptResync(true, 5, 3)).toBe(true);
    expect(shouldAdoptResync(true, 5, null)).toBe(true);
  });

  it('does NOT adopt an unrelated realtime change when not armed', () => {
    // even though the version advanced, no conflict recovery is armed → no silent sync
    expect(shouldAdoptResync(false, 5, 3)).toBe(false);
  });

  it('does NOT adopt when the version did not advance, or live is unknown', () => {
    expect(shouldAdoptResync(true, 3, 3)).toBe(false);
    expect(shouldAdoptResync(true, 2, 3)).toBe(false);
    expect(shouldAdoptResync(true, null, 3)).toBe(false);
  });
});
