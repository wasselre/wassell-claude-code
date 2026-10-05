import { describe, it, expect } from 'vitest';
import { sniffImageType } from '../plans.js';

describe('sniffImageType — the bytes decide the image type (live test 2026-10-05)', () => {
  it('reads PNG, JPEG, GIF and WEBP signatures', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
    expect(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
  });
  it('unknown bytes → null (the files row type is used)', () => {
    expect(sniffImageType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });
});
