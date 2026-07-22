import { describe, it, expect } from 'vitest';
import { selectOrphans, fingerprintOf, type StorageObject } from '../creativeCleanup';

describe('fingerprintOf', () => {
  it('extracts the sha256 filename', () => {
    expect(fingerprintOf('ad-creatives/abcdef0123456789abcdef0123456789.jpg')).toBe('abcdef0123456789abcdef0123456789');
    expect(fingerprintOf('ad-creatives/' + 'a'.repeat(64) + '.mp4')).toBe('a'.repeat(64));
  });
  it('rejects non-fingerprint names', () => {
    expect(fingerprintOf('ad-creatives/logo.png')).toBeNull();
    expect(fingerprintOf('ad-creatives/.keep')).toBeNull();
  });
});

describe('selectOrphans — storage safety', () => {
  const now = Date.parse('2026-07-22T00:00:00Z');
  const old = '2026-07-01T00:00:00Z';   // 21d old
  const recent = '2026-07-21T00:00:00Z'; // 1d old
  const fpRef = 'a'.repeat(32), fpOrphan = 'b'.repeat(32), fpRecent = 'c'.repeat(32);
  const objs: StorageObject[] = [
    { name: `ad-creatives/${fpRef}.jpg`, updatedAt: old },       // referenced → keep
    { name: `ad-creatives/${fpOrphan}.jpg`, updatedAt: old },    // orphan + old → delete
    { name: `ad-creatives/${fpRecent}.jpg`, updatedAt: recent }, // orphan but recent → keep
  ];
  const referenced = new Set([fpRef]);

  it('NEVER selects a referenced creative', () => {
    const r = selectOrphans(objs, referenced, { retentionDays: 7, now });
    expect(r.orphans).not.toContain(`ad-creatives/${fpRef}.jpg`);
    expect(r.keptReferenced).toBe(1);
  });
  it('respects the retention window (young orphans are kept)', () => {
    const r = selectOrphans(objs, referenced, { retentionDays: 7, now });
    expect(r.orphans).not.toContain(`ad-creatives/${fpRecent}.jpg`);
    expect(r.keptTooRecent).toBe(1);
  });
  it('selects only the old, unreferenced creative', () => {
    const r = selectOrphans(objs, referenced, { retentionDays: 7, now });
    expect(r.orphans).toEqual([`ad-creatives/${fpOrphan}.jpg`]);
    expect(r.scanned).toBe(3);
  });
  it('is deterministic / idempotent for the same inputs', () => {
    const a = selectOrphans(objs, referenced, { retentionDays: 7, now });
    const b = selectOrphans(objs, referenced, { retentionDays: 7, now });
    expect(a).toEqual(b);
  });
  it('fails safe: an object with an unknown timestamp is KEPT, not deleted', () => {
    const objs2: StorageObject[] = [{ name: `ad-creatives/${'d'.repeat(32)}.jpg`, updatedAt: null }];
    const r = selectOrphans(objs2, new Set(), { retentionDays: 7, now });
    expect(r.orphans).toEqual([]);
    expect(r.keptTooRecent).toBe(1);
  });
  it('a zero-retention run still keeps referenced creatives', () => {
    const r = selectOrphans(objs, referenced, { retentionDays: 0, now });
    expect(r.orphans).not.toContain(`ad-creatives/${fpRef}.jpg`);
    // both orphans now eligible (retention 0)
    expect(r.orphans.sort()).toEqual([`ad-creatives/${fpOrphan}.jpg`, `ad-creatives/${fpRecent}.jpg`].sort());
  });
});
