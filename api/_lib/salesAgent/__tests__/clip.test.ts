import { describe, it, expect } from 'vitest';
import { clip } from '../clip';

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('clip', () => {
  it('never leaves half an emoji (the 2026-09-29 agent failure)', () => {
    const s = 'ab📸 الصور: https://app.wassel.re/v/x/photos';
    // Cutting at 3 lands between the two halves of 📸.
    expect(loneSurrogate.test(s.slice(0, 3))).toBe(true);
    expect(clip(s, 3)).toBe('ab');
    expect(loneSurrogate.test(clip(s, 3))).toBe(false);
    // The result must survive a JSON round trip the way the API parses it.
    expect(() => JSON.parse(JSON.stringify({ t: clip(s, 3) }))).not.toThrow();
  });
  it('keeps a whole emoji that fits', () => {
    expect(clip('ab📸cd', 4)).toBe('ab📸');
  });
  it('returns short strings unchanged', () => {
    expect(clip('hello', 10)).toBe('hello');
  });
  it('every cut of a real card is valid Unicode', () => {
    const card = '🏙️ صفا 82\n\n📍 المدينة: الرياض\n🏘️ الحي: العارض\n💰 تبدأ من 1,101,400\n\n📸 الصور: x\n📄 البروشور: y\n🏠 الوحدات: z\n📍 الموقع: w';
    for (let n = 0; n <= card.length; n++) expect(loneSurrogate.test(clip(card, n))).toBe(false);
  });
});
