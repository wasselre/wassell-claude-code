import { describe, it, expect } from 'vitest';
import { showsInterest } from '../basic-reply.js';

describe('a new number shows interest (operator, 2026-10-06: create the client, the agent replies)', () => {
  it('our project named, a property asked for, or a website unit code', () => {
    expect(showsInterest({ action: 'project_sheet', projectName: 'زنك 8' })).toBe(true);
    expect(showsInterest({ action: 'qualify' })).toBe(true);
    expect(showsInterest({ action: 'unit_sheet', unitCode: 'U-42' })).toBe(true);
  });
  it('a greeting, a rent ask, a vendor pitch or a voice note alone is not interest', () => {
    expect(showsInterest({ action: 'greet' })).toBe(false);
    expect(showsInterest({ action: 'no_service' })).toBe(false);
    expect(showsInterest({ action: 'handoff', reason: 'b2b' })).toBe(false);
    expect(showsInterest({ action: 'handoff', reason: 'media' })).toBe(false);
  });
});
