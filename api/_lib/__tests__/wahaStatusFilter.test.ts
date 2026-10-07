import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isStatusOrBroadcastMessage } from '../waha';

describe('isStatusOrBroadcastMessage (WA-23)', () => {
  it('drops an inbound status post by id or by from', () => {
    expect(isStatusOrBroadcastMessage('false_status@broadcast_3EB0ABC_966500000000@c.us', '966500000000@c.us')).toBe(true);
    expect(isStatusOrBroadcastMessage(undefined, 'status@broadcast')).toBe(true);
  });

  it('drops our OWN status post, whose from is our number (the half the backspace byte broke)', () => {
    expect(isStatusOrBroadcastMessage('true_status@broadcast_3EB0DEF', '966511111111@c.us')).toBe(true);
  });

  it('drops a broadcast-list message', () => {
    expect(isStatusOrBroadcastMessage('true_1696000000@broadcast_3EB0123', '966511111111@c.us')).toBe(true);
    expect(isStatusOrBroadcastMessage('true_1696000000@broadcast', null)).toBe(true);
  });

  it('keeps ordinary client, group and LID messages', () => {
    expect(isStatusOrBroadcastMessage('true_966509004886@c.us_3EB0B1505C2A77C4723EEA', '966511111111@c.us')).toBe(false);
    expect(isStatusOrBroadcastMessage('false_966509004886@c.us_3EB0B1505C', '966509004886@c.us')).toBe(false);
    expect(isStatusOrBroadcastMessage('false_120363000000000000@g.us_3EB0_966500000000@c.us', '120363000000000000@g.us')).toBe(false);
    expect(isStatusOrBroadcastMessage('false_123456789012345@lid_3EB0', '123456789012345@lid')).toBe(false);
    expect(isStatusOrBroadcastMessage(undefined, undefined)).toBe(false);
  });

  it('does not match a longer word that merely starts with status/broadcast', () => {
    expect(isStatusOrBroadcastMessage('false_x@broadcaster_3EB0', 'x@c.us')).toBe(false);
  });

  it('the webhook and its helper carry no control bytes', () => {
    for (const f of ['api/webhook/waha.ts', 'api/_lib/waha.ts']) {
      expect(/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(readFileSync(f, 'utf8'))).toBe(false);
    }
  });
});
