import { describe, it, expect } from 'vitest';
import { buildContactSheet, chunk, consolidateOcr, segmentsForShot, MAX_IMAGES_PER_CALL } from '../evidence.js';

const f = (i: number, url: string | null = `https://x/${i}.webp`) => ({ id: `f${i}`, ts_ms: i * 1000, public_url: url });

describe('contact sheet assembly', () => {
  it('keeps every keyframe (time-sorted) when at or under the cap', () => {
    const sheet = buildContactSheet([f(3), f(1), f(2)]);
    expect(sheet.map((s) => s.frame_id)).toEqual(['f1', 'f2', 'f3']);
    expect(sheet[0]).toEqual({ frame_id: 'f1', ts_ms: 1000, url: 'https://x/1.webp' });
  });
  it('samples evenly to ≤ 8 and always keeps first + last', () => {
    const frames = Array.from({ length: 20 }, (_, i) => f(i));
    const sheet = buildContactSheet(frames);
    expect(sheet).toHaveLength(MAX_IMAGES_PER_CALL);
    expect(sheet[0]!.frame_id).toBe('f0');
    expect(sheet[sheet.length - 1]!.frame_id).toBe('f19');
    const ts = sheet.map((s) => s.ts_ms);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(new Set(sheet.map((s) => s.frame_id)).size).toBe(8);
  });
  it('drops frames without a public url', () => {
    expect(buildContactSheet([f(0, null), f(1, ''), f(2)]).map((s) => s.frame_id)).toEqual(['f2']);
  });
  it('honours a custom cap', () => {
    expect(buildContactSheet(Array.from({ length: 9 }, (_, i) => f(i)), 3).map((s) => s.frame_id)).toEqual(['f0', 'f4', 'f8']);
  });
});

describe('chunk', () => {
  it('batches in order', () => { expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]); });
  it('rejects a non-positive size', () => { expect(() => chunk([1], 0)).toThrow(); });
});

describe('transcript alignment', () => {
  const segs = [
    { start_ms: 0, end_ms: 2000, text: 'مرحبا' },
    { start_ms: 2000, end_ms: 4000, text: 'بكم' },
    { start_ms: 4000, end_ms: 6000, text: 'في المشروع' },
    { start: 6, end: 8, text: 'legacy seconds' },
    { start_ms: 8000, end_ms: 9000, text: '   ' },
  ];
  it('returns segments overlapping the shot window, in order', () => {
    expect(segmentsForShot(segs, 1500, 4500).map((s) => s.text)).toEqual(['مرحبا', 'بكم', 'في المشروع']);
  });
  it('is exclusive at the boundaries and tolerant of legacy seconds', () => {
    expect(segmentsForShot(segs, 2000, 4000).map((s) => s.text)).toEqual(['بكم']);
    expect(segmentsForShot(segs, 6500, 7000)).toEqual([{ start_ms: 6000, end_ms: 8000, text: 'legacy seconds' }]);
  });
  it('skips blank and malformed entries', () => {
    expect(segmentsForShot([...segs, null, 'x', { text: 'no times' }], 0, 100000)).toHaveLength(4);
  });
});

describe('OCR consolidation', () => {
  it('dedupes lines across frames, keeping first occurrence order', () => {
    const text = consolidateOcr([
      { ts_ms: 1000, ocr: { text: 'يبدأ من 850,000 ريال\nاتصل الآن' } },
      { ts_ms: 0, ocr: { text: 'اتصل  الآن' } },
      { ts_ms: 2000, ocr: { text: 'ATTAL   NOW\nاتصل الآن' } },
      { ts_ms: 3000, ocr: null },
    ]);
    expect(text.split('\n')).toEqual(['اتصل الآن', 'يبدأ من 850,000 ريال', 'ATTAL NOW']);
  });
});
