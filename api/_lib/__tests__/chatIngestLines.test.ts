import { describe, it, expect } from 'vitest';
import { withLine, withLineMeta } from '../chatIngest';

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

describe('withLineMeta — each number keeps its own chat state', () => {
  const msg = { deviceId: 'bridge', lastAt: '2026-10-04T10:00:00Z', lastBody: 'hello', lastFlow: 'in' as const, incrementUnread: true };

  it('updates only the number the message came in on', () => {
    const out = withLineMeta(
      { line_meta: { sales: { last_message_at: '2026-10-01T00:00:00Z', last_message_preview: 'old', last_message_flow: 'out', unread_count: 0 } } },
      msg,
    );
    expect(out.sales).toEqual({ last_message_at: '2026-10-01T00:00:00Z', last_message_preview: 'old', last_message_flow: 'out', unread_count: 0 });
    expect(out.bridge).toEqual({ last_message_at: '2026-10-04T10:00:00Z', last_message_preview: 'hello', last_message_flow: 'in', unread_count: 1 });
  });

  it('counts unread up and does not let an older message replace the preview', () => {
    const prev = { line_meta: { bridge: { last_message_at: '2026-10-05T00:00:00Z', last_message_preview: 'newest', last_message_flow: 'out', unread_count: 2 } } };
    expect(withLineMeta(prev, msg).bridge).toEqual({ last_message_at: '2026-10-05T00:00:00Z', last_message_preview: 'newest', last_message_flow: 'out', unread_count: 3 });
  });

  it('an outbound message does not add unread', () => {
    expect(withLineMeta({}, { ...msg, lastFlow: 'out', incrementUnread: false }).bridge.unread_count).toBe(0);
  });
});
