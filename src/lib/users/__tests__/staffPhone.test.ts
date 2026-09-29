import { describe, expect, it } from 'vitest';
import { normalizeStaffPhone } from '../staffPhone';

const value = (s: string) => {
  const r = normalizeStaffPhone(s);
  return r.ok ? r.value : `ERR:${r.reason_en}`;
};

describe('normalizeStaffPhone', () => {
  it('stores every way a Saudi mobile is typed as +9665XXXXXXXX', () => {
    expect(value('0555123456')).toBe('+966555123456');
    expect(value('555123456')).toBe('+966555123456');
    expect(value('966555123456')).toBe('+966555123456');
    expect(value('+966 55 512 3456')).toBe('+966555123456');
    expect(value('00966555123456')).toBe('+966555123456');
  });

  it('empty clears the number', () => {
    expect(value('')).toBeNull();
    expect(value('   ')).toBeNull();
  });

  it('keeps a non-Saudi number typed with its country code', () => {
    expect(value('+20 100 123 4567')).toBe('+201001234567');
    expect(value('0020 100 123 4567')).toBe('+201001234567');
  });

  it('rejects numbers that are not a mobile instead of saving them half-right', () => {
    expect(value('12345')).toMatch(/^ERR:/);
    expect(value('0112345678')).toMatch(/^ERR:/); // a Riyadh landline, not a mobile
    expect(value('+1 23')).toMatch(/^ERR:/);
  });
});
