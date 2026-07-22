import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../sha256';

const node = (s: string) => createHash('sha256').update(s).digest('hex');

describe('sha256Hex — edge-safe, byte-identical to node:crypto', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('matches node:crypto across varied inputs (incl. UTF-8, long, pipe-joined)', () => {
    const cases = [
      'youtube|@almajdiah|2026-07-22T10:00:00Z|Some caption|https://x/y.jpg',
      'الماجدية العقارية — إعلان جديد',
      'a'.repeat(1000),
      'x'.repeat(55), // one byte under a block boundary edge case
      'x'.repeat(56), // forces an extra padding block
      'x'.repeat(64),
      '🏠 emoji + mixed العربية text 123',
    ];
    for (const c of cases) expect(sha256Hex(c)).toBe(node(c));
  });
});
