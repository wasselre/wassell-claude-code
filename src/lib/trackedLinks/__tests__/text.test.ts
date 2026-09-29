import { describe, it, expect } from 'vitest';
import { replaceLinksInMessage, trackedTokenIn } from '../text';

const BLOCK = '📸 الصور\nhttps://app.wassel.re/v/Abc12345/photos';

describe('replaceLinksInMessage', () => {
  it('swaps the website project link for the tracked block', () => {
    const body = 'مشروع يمام 17\n🔗 https://wassel.re/project?id=11111111-2222-3333-4444-555555555555\nمن 559 ألف';
    const out = replaceLinksInMessage(body, BLOCK);
    expect(out).not.toContain('wassel.re/project?id=');
    expect(out.startsWith('مشروع يمام 17')).toBe(true);
    expect(out.endsWith(BLOCK)).toBe(true);
  });

  it('replaces an earlier tracked link instead of stacking two', () => {
    const once = replaceLinksInMessage('نص', BLOCK);
    const twice = replaceLinksInMessage(once, '📍 الموقع\nhttps://app.wassel.re/v/Zzz98765/location');
    expect(twice).not.toContain('Abc12345');
    expect(twice).toContain('Zzz98765');
  });

  it('handles the English website link', () => {
    expect(replaceLinksInMessage('x\nhttps://wassel.re/en/project?id=abc', BLOCK)).toBe(`x\n\n${BLOCK}`);
  });
});

describe('trackedTokenIn', () => {
  it('finds the token with or without a section', () => {
    expect(trackedTokenIn('see https://app.wassel.re/v/Abc12345/units')).toBe('Abc12345');
    expect(trackedTokenIn('https://app.wassel.re/v/Abc12345')).toBe('Abc12345');
  });
  it('returns null without a link', () => {
    expect(trackedTokenIn('hello')).toBeNull();
    expect(trackedTokenIn(null)).toBeNull();
  });
});
