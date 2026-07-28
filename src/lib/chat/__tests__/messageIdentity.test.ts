import { describe, it, expect } from 'vitest';
import { messageIdHash, identityKey, mergeOne, mergeMessageSources } from '../messageIdentity';
import type { ChatMessage } from '@/types';

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'flow'>): ChatMessage {
  return {
    chat_wid: '966501234567@c.us',
    kind: 'text',
    body: 'hello',
    from_phone: null,
    to_phone: null,
    ack: null,
    date: '2026-07-20T10:00:00.000Z',
    media_file_id: null,
    media_mime: null,
    media_size: null,
    media_caption: null,
    reference: null,
    quoted: null,
    ...over,
  } as ChatMessage;
}

// The same physical message as the two sources report it.
const C_US = 'true_966501234567@c.us_3EB0AAAA';
const LID = 'true_196271432331425@lid_3EB0AAAA';

describe('messageIdHash', () => {
  it('extracts WhatsApp\'s own id from either addressing mode', () => {
    expect(messageIdHash(C_US)).toBe('3EB0AAAA');
    expect(messageIdHash(LID)).toBe('3EB0AAAA');
  });

  it('handles the group form with a trailing participant', () => {
    expect(messageIdHash('true_120363@g.us_ABC123_966501234567@c.us')).toBe('ABC123');
  });

  it('returns null for ids that are their own identity', () => {
    expect(messageIdHash('D397D49B3F4396472B')).toBeNull();      // Haberchat era
    expect(messageIdHash('pending:uuid-1')).toBeNull();           // optimistic
    expect(messageIdHash('reaction_true_x@c.us_H_me')).toBeNull(); // synthesized
  });
});

describe('identityKey', () => {
  it('collapses the two addressings of one message', () => {
    expect(identityKey(msg({ id: C_US, flow: 'out' })))
      .toBe(identityKey(msg({ id: LID, flow: 'out' })));
  });

  it('never merges across direction', () => {
    expect(identityKey(msg({ id: C_US, flow: 'out' })))
      .not.toBe(identityKey(msg({ id: C_US, flow: 'in' })));
  });

  it('keeps distinct optimistic placeholders apart', () => {
    expect(identityKey(msg({ id: 'pending:a', flow: 'out' })))
      .not.toBe(identityKey(msg({ id: 'pending:b', flow: 'out' })));
  });
});

describe('mergeOne', () => {
  it('advances the ack but never walks it back', () => {
    const mirror = msg({ id: C_US, flow: 'out', ack: 'sent' });
    const gateway = msg({ id: LID, flow: 'out', ack: 'read' });
    expect(mergeOne(mirror, gateway).ack).toBe('read');
    expect(mergeOne(gateway, mirror).ack).toBe('read');
  });

  it('keeps the preferred source\'s media ref rather than the other disk\'s', () => {
    const mirror = msg({ id: C_US, flow: 'out', media_file_id: 'wm_sales/a.jpg' });
    const gateway = msg({ id: LID, flow: 'out', media_file_id: 'wf_other/a.jpg' });
    expect(mergeOne(mirror, gateway).media_file_id).toBe('wm_sales/a.jpg');
  });

  it('backfills a field the preferred source is missing', () => {
    const mirror = msg({ id: C_US, flow: 'out', media_file_id: null });
    const gateway = msg({ id: LID, flow: 'out', media_file_id: 'wf_sales/a.jpg' });
    expect(mergeOne(mirror, gateway).media_file_id).toBe('wf_sales/a.jpg');
  });

  it('does NOT resurrect the text of a deleted message', () => {
    const revoked = msg({ id: C_US, flow: 'in', kind: 'revoked', body: null });
    const stale = msg({ id: LID, flow: 'in', body: 'the withdrawn text' });
    const out = mergeOne(revoked, stale);
    expect(out.kind).toBe('revoked');
    expect(out.body).toBeNull();
  });

  it('clears pending once either side has confirmed', () => {
    const local = msg({ id: C_US, flow: 'out', pending: true });
    const confirmed = msg({ id: LID, flow: 'out', ack: 'sent' });
    expect(mergeOne(local, confirmed).pending).toBeUndefined();
  });
});

describe('mergeMessageSources — the Phase 0 matrix', () => {
  const mirrorRow = msg({ id: C_US, flow: 'out', ack: 'delivered', body: 'from db' });
  const gatewayRow = msg({ id: LID, flow: 'out', ack: 'read', body: 'from gateway' });

  it('renders the database when the gateway returns nothing', () => {
    const out = mergeMessageSources([mirrorRow], [], []);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toBe('from db');
  });

  it('renders the database when the gateway has FEWER messages', () => {
    const older = msg({ id: 'true_966501234567@c.us_3EB0OLD', flow: 'in', date: '2026-07-01T09:00:00.000Z' });
    const out = mergeMessageSources([older, mirrorRow], [], [gatewayRow]);
    expect(out).toHaveLength(2);
  });

  it('shows one bubble when both sources have the same message', () => {
    const out = mergeMessageSources([mirrorRow], [], [gatewayRow]);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toBe('from db');   // mirror wins on content
    expect(out[0]!.ack).toBe('read');       // ack still advances
  });

  it('adds a gateway message we have not mirrored yet', () => {
    const onlyOnGateway = msg({ id: 'true_966501234567@c.us_3EB0NEW', flow: 'in', date: '2026-07-21T10:00:00.000Z' });
    const out = mergeMessageSources([mirrorRow], [], [onlyOnGateway]);
    expect(out).toHaveLength(2);
  });

  it('keeps an in-flight optimistic bubble alongside the thread', () => {
    const optimistic = msg({ id: 'pending:abc', flow: 'out', pending: true, date: '2026-07-20T11:00:00.000Z' });
    const out = mergeMessageSources([mirrorRow], [optimistic], []);
    expect(out).toHaveLength(2);
    expect(out.some((m) => m.pending)).toBe(true);
  });

  it('replaces the optimistic bubble once it carries the real id', () => {
    const confirmedLocal = msg({ id: C_US, flow: 'out', ack: 'sent', client_id: 'abc' });
    const out = mergeMessageSources([mirrorRow], [confirmedLocal], []);
    expect(out).toHaveLength(1);
    expect(out[0]!.pending).toBeUndefined();
  });

  it('never drops or merges reactions into messages', () => {
    const reaction = msg({ id: 'reaction_' + C_US + '_966501234567', flow: 'in', kind: 'reaction', body: '👍' });
    const out = mergeMessageSources([mirrorRow], [], [], [reaction]);
    expect(out).toHaveLength(2);
    expect(out.some((m) => m.kind === 'reaction')).toBe(true);
  });

  it('sorts ascending by date regardless of source order', () => {
    const a = msg({ id: 'true_x@c.us_A', flow: 'in', date: '2026-07-01T00:00:00.000Z' });
    const b = msg({ id: 'true_x@c.us_B', flow: 'in', date: '2026-07-02T00:00:00.000Z' });
    const c = msg({ id: 'true_x@c.us_C', flow: 'in', date: '2026-07-03T00:00:00.000Z' });
    const out = mergeMessageSources([c], [a], [b]);
    expect(out.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
  });

  it('preserves a failed send rather than hiding it', () => {
    const failed = msg({ id: 'pending:zz', flow: 'out', ack: 'failed' });
    const out = mergeMessageSources([mirrorRow], [failed], []);
    expect(out.find((m) => m.ack === 'failed')).toBeTruthy();
  });
});
