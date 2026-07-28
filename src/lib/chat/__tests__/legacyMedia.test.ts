import { describe, it, expect } from 'vitest';
import { isLegacyHaberchatRef } from '../legacyMedia';

describe('isLegacyHaberchatRef', () => {
  it('recognises a Haberchat ObjectId', () => {
    // Real refs taken from chat_messages (2026-07-18, the last Haberchat day).
    expect(isLegacyHaberchatRef('6a5b2cbdcad4d0b39b04a9ef')).toBe(true);
    expect(isLegacyHaberchatRef('6a324d9052c72dfccc5446cc')).toBe(true);
  });

  it('never claims a WAHA ref — the prefixes keep them apart', () => {
    expect(isLegacyHaberchatRef('wt_waha-outbound/abc.jpg')).toBe(false);
    expect(isLegacyHaberchatRef('wf_sales/3EB0.jpeg')).toBe(false);
    expect(isLegacyHaberchatRef('wm_wassel_main/3EB0.jpeg')).toBe(false);
  });

  it('rejects near-misses rather than guessing', () => {
    expect(isLegacyHaberchatRef('6a5b2cbdcad4d0b39b04a9e')).toBe(false);   // 23 chars
    expect(isLegacyHaberchatRef('6a5b2cbdcad4d0b39b04a9ef0')).toBe(false); // 25 chars
    expect(isLegacyHaberchatRef('6a5b2cbdcad4d0b39b04a9zz')).toBe(false);  // not hex
    expect(isLegacyHaberchatRef(null)).toBe(false);
    expect(isLegacyHaberchatRef(undefined)).toBe(false);
    expect(isLegacyHaberchatRef('')).toBe(false);
  });
});
