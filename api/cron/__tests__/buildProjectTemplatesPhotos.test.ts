import { describe, it, expect } from 'vitest';
import { isTooSmallForPhoto } from '../build-project-templates.js';

// Measured on live templates 2026-09-29.
describe('isTooSmallForPhoto', () => {
  it('drops the amenity icons scraped as gallery photos', () => {
    expect(isTooSmallForPhoto({ width_px: 356, height_px: 112, size_bytes: 6053 })).toBe(true);
    expect(isTooSmallForPhoto({ width_px: 432, height_px: 112, size_bytes: 14698 })).toBe(true);
  });
  it('keeps small-but-real photos', () => {
    expect(isTooSmallForPhoto({ width_px: 480, height_px: 360, size_bytes: 32918 })).toBe(false);
    expect(isTooSmallForPhoto({ width_px: 540, height_px: 413, size_bytes: 388948 })).toBe(false);
    expect(isTooSmallForPhoto({ width_px: 1920, height_px: 1080, size_bytes: 595466 })).toBe(false);
  });
  it('falls back to bytes when dimensions are unknown, and keeps fully unknown files', () => {
    expect(isTooSmallForPhoto({ width_px: null, height_px: null, size_bytes: 9000 })).toBe(true);
    expect(isTooSmallForPhoto({ width_px: null, height_px: null, size_bytes: 400000 })).toBe(false);
    expect(isTooSmallForPhoto({ width_px: null, height_px: null, size_bytes: null })).toBe(false);
  });
});
