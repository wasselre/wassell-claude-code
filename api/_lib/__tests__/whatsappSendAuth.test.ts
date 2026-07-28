import { describe, it, expect } from 'vitest';
import { maskPhone, chatWidFromPhone } from '../whatsappSendAuth.js';

describe('maskPhone — audit rows must not reproduce customer numbers', () => {
  it('keeps the country code and last two digits only', () => {
    // 12 digits: 4 kept at the front, 2 at the back, 6 masked between.
    expect(maskPhone('+966558333733')).toBe('+9665••••••33');
    expect(maskPhone('966558333733')).toBe('+9665••••••33');
  });

  it('never leaks the full number', () => {
    for (const p of ['+966558333733', '00966558333733', '0558333733']) {
      expect(maskPhone(p)).not.toContain('8333733');
    }
  });

  it('degrades safely on junk input', () => {
    expect(maskPhone(null)).toBe('•••');
    expect(maskPhone('')).toBe('•••');
    expect(maskPhone('12')).toBe('••');
  });
});

describe('chatWidFromPhone — one canonicalization, matching SQL ksa_phone_canon', () => {
  it('collapses every Saudi local form onto the same wid', () => {
    const want = '966558333733@c.us';
    expect(chatWidFromPhone('+966558333733')).toBe(want);
    expect(chatWidFromPhone('966558333733')).toBe(want);
    expect(chatWidFromPhone('00966558333733')).toBe(want);
    expect(chatWidFromPhone('0558333733')).toBe(want);
    expect(chatWidFromPhone('558333733')).toBe(want);
    expect(chatWidFromPhone('+966 55 833 3733')).toBe(want);
  });

  it('leaves genuine foreign numbers alone', () => {
    // Real numbers present in production chats.
    expect(chatWidFromPhone('+923183677100')).toBe('923183677100@c.us');
    expect(chatWidFromPhone('+971506814683')).toBe('971506814683@c.us');
    expect(chatWidFromPhone('+447710173736')).toBe('447710173736@c.us');
  });

  it('rejects what it cannot address rather than guessing', () => {
    expect(chatWidFromPhone('')).toBeNull();
    expect(chatWidFromPhone('abc')).toBeNull();
    expect(chatWidFromPhone('12345')).toBeNull();               // too short
    expect(chatWidFromPhone('1234567890123456789')).toBeNull(); // too long
  });

  it('never produces the malformed 055…@c.us the server used to build', () => {
    // toChatId() stripped non-digits and appended @c.us, so a local-format
    // number became an unroutable chat id (WA-21).
    expect(chatWidFromPhone('0558333733')).not.toBe('0558333733@c.us');
  });
});
