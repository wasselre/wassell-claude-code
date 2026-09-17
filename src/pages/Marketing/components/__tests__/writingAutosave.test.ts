import { describe, expect, it } from 'vitest';
import { stableJson } from '../WritingFields';

describe('stableJson — the autosave comparison', () => {
  it('treats the same record in a different key order as the same state', () => {
    // What the browser saved vs what Postgres jsonb hands back on reload.
    const saved = { headlines: ['أ', 'ب'], caption: 'نص', caption_confirmed_text: '' };
    const reloaded = { caption_confirmed_text: '', caption: 'نص', headlines: ['أ', 'ب'] };
    expect(stableJson(reloaded)).toBe(stableJson(saved));
  });

  it('sorts nested objects too, but keeps array order meaningful', () => {
    expect(stableJson({ a: { y: 1, x: 2 } })).toBe(stableJson({ a: { x: 2, y: 1 } }));
    expect(stableJson({ lines: ['1', '2'] })).not.toBe(stableJson({ lines: ['2', '1'] }));
  });

  it('sees a real edit as a different state', () => {
    expect(stableJson({ caption: 'قبل' })).not.toBe(stableJson({ caption: 'بعد' }));
  });
});
