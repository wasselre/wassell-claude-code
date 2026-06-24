import { describe, it, expect, beforeEach } from 'vitest';
import {
  engageHardWriteStop,
  isStaleBuildWriteLocked,
  isHardWriteStopped,
  lockStaleBuildWrites,
  getStaleBuildState,
  markStaleBuildOutdated,
  __resetStaleBuild,
} from '../staleBuild';

beforeEach(() => __resetStaleBuild());

describe('hard write-stop (T1 req 6 — build-independent)', () => {
  it('engages independently of stale-build/outdated state', () => {
    const before = getStaleBuildState();
    expect(before.outdated).toBe(false);
    expect(before.writeLocked).toBe(false);

    engageHardWriteStop('server-blocked');

    const after = getStaleBuildState();
    // bullet "hard write-stop works even when build is not outdated"
    expect(after.writeLocked).toBe(true);
    expect(after.outdated).toBe(false); // never marked the build outdated
    expect(after.forcedReloadAt).toBeGreaterThan(0); // a forced reload is scheduled
    expect(after.hardStopReason).toBe('server-blocked');
    // bullet 8 predicate: with this true, supabaseRecordUpsert returns before
    // ever calling record_save.
    expect(isStaleBuildWriteLocked()).toBe(true);
    expect(isHardWriteStopped()).toBe(true);
  });

  it('lockStaleBuildWrites is just the stale-build reason for the same hard stop', () => {
    lockStaleBuildWrites();
    expect(getStaleBuildState().writeLocked).toBe(true);
    expect(getStaleBuildState().hardStopReason).toBe('stale-build');
  });

  it('is idempotent — the first reason + earliest deadline win', () => {
    engageHardWriteStop('record-storm');
    const firstDeadline = getStaleBuildState().forcedReloadAt;
    engageHardWriteStop('server-blocked');
    expect(getStaleBuildState().hardStopReason).toBe('record-storm');
    expect(getStaleBuildState().forcedReloadAt).toBe(firstDeadline);
  });

  it('an outdated build alone does NOT lock writes (only engage does)', () => {
    markStaleBuildOutdated(Date.now() + 90_000);
    expect(getStaleBuildState().outdated).toBe(true);
    expect(getStaleBuildState().writeLocked).toBe(false);
  });
});
