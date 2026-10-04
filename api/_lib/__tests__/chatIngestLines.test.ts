import { describe, it, expect } from 'vitest';
import { withLine } from '../chatIngest';

describe('withLine — the numbers a conversation has messages on', () => {
  it('adds a new number and keeps the ones already there', () => {
    expect(withLine({ device_id: 'sales', lines: ['sales'] }, 'bridge')).toEqual(['sales', 'bridge']);
  });

  it('does not duplicate a number it already has', () => {
    expect(withLine({ lines: ['sales', 'bridge'] }, 'bridge')).toEqual(['sales', 'bridge']);
  });

  it('starts from the first number when lines were never filled, so it is never forgotten', () => {
    expect(withLine({ device_id: 'sales' }, 'bridge')).toEqual(['sales', 'bridge']);
    expect(withLine({}, 'bridge')).toEqual(['bridge']);
  });

  it('drops junk entries rather than carrying them forward', () => {
    expect(withLine({ lines: ['', null, 'sales'] }, 'sales')).toEqual(['sales']);
  });
});
