import { describe, it, expect } from 'vitest';
import { isLatinToken, latinKey, latinVariants } from '../latinNames.js';

/** English-letter district names — the «Malga» defect from calib-003 (2026-09-27). */
describe('latinKey', () => {
  it('equates the customer spelling with the official English name', () => {
    expect(latinKey('Malga')).toBe(latinKey('Al Malqa Dist.'));
    expect(latinKey('Malka')).toBe(latinKey('Al Malqa Dist.'));
    expect(latinKey('Yasmin')).toBe(latinKey('Al Yasmeen Dist.'));
    expect(latinKey('Narjes')).toBe(latinKey('An Narjis'));
    expect(latinKey('Hittin')).toBe(latinKey('Hiteen Dist.'));
    expect(latinKey('al-arid')).toBe(latinKey('Al Arid Dist.'));
  });
  it('stays EXACT — a different district is a different key', () => {
    expect(latinKey('Al Malqa')).not.toBe(latinKey('Al Mahdiyah'));
    expect(latinKey('Al Jubail')).not.toBe(latinKey('Al Jubailah'));
    expect(latinKey('Al Khalidiyah')).not.toBe(latinKey('Al Khalij'));
  });
  it('is empty for Arabic input, so the Arabic gate is never bypassed', () => {
    expect(latinKey('الملقا')).toBe('');
    expect(isLatinToken('الملقا')).toBe(false);
    expect(isLatinToken('Malga')).toBe(true);
  });
});

describe('latinVariants', () => {
  it('generates the q/g spelling so the ILIKE stage can reach «Al Malqa»', () => {
    expect(latinVariants('Malga')).toContain('Malqa');
    expect(latinVariants('Yasmin')).toContain('Yasmeen');
  });
  it('nothing for Arabic', () => {
    expect(latinVariants('النرجس')).toEqual([]);
  });
});
