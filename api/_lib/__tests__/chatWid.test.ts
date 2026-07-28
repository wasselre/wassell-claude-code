import { describe, it, expect } from 'vitest';
import { isValidChatWid, messageIdHash } from '../chatIngest.js';

describe('isValidChatWid — WA-22 guard', () => {
  it('accepts every addressing WhatsApp actually uses', () => {
    expect(isValidChatWid('966501234567@c.us')).toBe(true);
    expect(isValidChatWid('120363409325147557@g.us')).toBe(true);
    expect(isValidChatWid('120363403816678819@newsletter')).toBe(true);
    expect(isValidChatWid('196271432331425@lid')).toBe(true);
    expect(isValidChatWid('45539706028035@status')).toBe(true);
  });

  it('rejects the serialized chat object that produced the corrupted record', () => {
    const blob = JSON.stringify({ id: '966554446109@c.us', name: '.', meta: { isSpam: true } });
    expect(isValidChatWid(blob)).toBe(false);
  });

  it('rejects anything else that is not a wid', () => {
    expect(isValidChatWid('')).toBe(false);
    expect(isValidChatWid('966501234567')).toBe(false);       // no domain
    expect(isValidChatWid('@c.us')).toBe(false);              // no number
    expect(isValidChatWid('abc@c.us')).toBe(false);           // not digits
    expect(isValidChatWid('966501234567@unknown')).toBe(false);
  });
});

describe('messageIdHash — server twin of the browser identity', () => {
  it('matches the browser implementation on both addressings', () => {
    expect(messageIdHash('true_966554446109@c.us_3EB0AAAA')).toBe('3EB0AAAA');
    expect(messageIdHash('true_196271432331425@lid_3EB0AAAA')).toBe('3EB0AAAA');
  });

  it('leaves ids that are their own identity alone', () => {
    expect(messageIdHash('D397D49B3F4396472B')).toBeNull();
  });
});
