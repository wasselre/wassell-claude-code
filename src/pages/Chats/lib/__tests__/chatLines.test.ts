import { describe, it, expect } from 'vitest';
import { chatLineRows, chatLines, lineGroupOf, lineLabel, lineMessageFilter, messageInLine, switcherLines } from '../chatLines';
import type { WhatsAppNumber } from '@/types';

function num(over: Partial<WhatsAppNumber>): WhatsAppNumber {
  return {
    device_id: 'x',
    phone: '+966500000000',
    friendly_name_ar: null,
    friendly_name_en: null,
    is_default: false,
    is_active: true,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

describe('chatLines', () => {
  it('uses every number the conversation has messages on', () => {
    expect(chatLines({ device_id: 'sales', lines: ['sales', 'bridge'] })).toEqual(['sales', 'bridge']);
  });

  it('falls back to the first number when lines were never filled', () => {
    expect(chatLines({ device_id: 'sales' })).toEqual(['sales']);
    expect(chatLines({ device_id: 'sales', lines: [] })).toEqual(['sales']);
  });

  it('reads a legacy object device id, and ignores junk', () => {
    expect(chatLines({ device_id: { id: 'old_dev' } })).toEqual(['old_dev']);
    expect(chatLines({ lines: ['', 42, 'bridge'] })).toEqual(['bridge']);
    expect(chatLines({})).toEqual([]);
    expect(chatLines(null)).toEqual([]);
  });
});

describe('lineLabel', () => {
  it('names the sales default and the operations line by role', () => {
    expect(lineLabel(num({ is_default: true, friendly_name_en: 'Wassel Real Estate' }), false)).toBe('Sales');
    expect(lineLabel(num({ is_default: true }), true)).toBe('المبيعات');
    expect(lineLabel(num({ is_operations: true, friendly_name_en: 'Wassel Ops' }), false)).toBe('Operations');
    expect(lineLabel(num({ is_operations: true }), true)).toBe('العمليات');
  });

  it('uses the display name for any other number, in the current language', () => {
    const bridge = num({ friendly_name_ar: 'طلبات العملاء', friendly_name_en: 'Client requests' });
    expect(lineLabel(bridge, true)).toBe('طلبات العملاء');
    expect(lineLabel(bridge, false)).toBe('Client requests');
    expect(lineLabel(num({ phone: '+966533716189' }), false)).toBe('+966533716189');
  });
});

describe('switcherLines', () => {
  it('lists active numbers only: sales, operations, then the rest', () => {
    const out = switcherLines([
      num({ device_id: 'bridge', friendly_name_en: 'Client requests' }),
      num({ device_id: 'old', is_active: false }),
      num({ device_id: 'ops', is_operations: true }),
      num({ device_id: 'sales', is_default: true }),
    ]);
    expect(out.map((d) => d.device_id)).toEqual(['sales', 'ops', 'bridge']);
  });
});

const LINES = [
  num({ device_id: 'sales', is_default: true }),
  num({ device_id: 'ops', is_operations: true }),
  num({ device_id: 'bridge', friendly_name_en: 'Client requests' }),
];

describe('lineGroupOf', () => {
  it('keeps an active number as its own chat', () => {
    expect(lineGroupOf('bridge', LINES)).toBe('bridge');
    expect(lineGroupOf('ops', LINES)).toBe('ops');
  });

  it('files a retired session (same sales phone) under the sales chat', () => {
    expect(lineGroupOf('wassel_main', LINES)).toBe('sales');
    expect(lineGroupOf(null, LINES)).toBe('sales');
  });
});

describe('chatLineRows — one chat per number', () => {
  it('splits a contact who talked to two numbers into two chats, newest first', () => {
    const rows = chatLineRows(
      {
        lines: ['sales', 'bridge'],
        line_meta: {
          sales: { last_message_at: '2026-10-01T10:00:00Z', last_message_preview: 'hi sales', last_message_flow: 'in', unread_count: 0 },
          bridge: { last_message_at: '2026-10-03T10:00:00Z', last_message_preview: 'hi office', last_message_flow: 'out', unread_count: 2 },
        },
      },
      LINES,
    );
    expect(rows.map((r) => [r.group, r.last_message_preview, r.unread_count])).toEqual([
      ['bridge', 'hi office', 2],
      ['sales', 'hi sales', 0],
    ]);
  });

  it('merges a retired session into the sales chat, keeping the newest preview and summing unread', () => {
    const rows = chatLineRows(
      {
        lines: ['wassel_main', 'sales'],
        line_meta: {
          wassel_main: { last_message_at: '2026-09-01T00:00:00Z', last_message_preview: 'old', unread_count: 1 },
          sales: { last_message_at: '2026-10-01T00:00:00Z', last_message_preview: 'new', unread_count: 2 },
        },
      },
      LINES,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ group: 'sales', devices: ['wassel_main', 'sales'], last_message_preview: 'new', unread_count: 3 });
  });

  it('shows a conversation without per-number data as one chat with its own fields', () => {
    const rows = chatLineRows(
      { device_id: 'bridge', last_message_at: '2026-10-02T00:00:00Z', last_message_preview: 'x', unread_count: 4 },
      LINES,
    );
    expect(rows).toEqual([
      { group: 'bridge', devices: ['bridge'], last_message_at: '2026-10-02T00:00:00Z', last_message_preview: 'x', last_message_flow: null, unread_count: 4 },
    ]);
  });
});

describe('lineMessageFilter + messageInLine', () => {
  it('another number shows only its own messages', () => {
    const f = lineMessageFilter('bridge', LINES);
    expect(f).toEqual({ include: ['bridge'] });
    expect(messageInLine('bridge', f)).toBe(true);
    expect(messageInLine('sales', f)).toBe(false);
    expect(messageInLine(undefined, f)).toBe(false);
  });

  it('the sales chat shows everything except the other active numbers', () => {
    const f = lineMessageFilter('sales', LINES);
    expect(f).toEqual({ exclude: ['ops', 'bridge'] });
    expect(messageInLine('sales', f)).toBe(true);
    expect(messageInLine('wassel_main', f)).toBe(true);
    expect(messageInLine(undefined, f)).toBe(true);
    expect(messageInLine('bridge', f)).toBe(false);
  });

  it('no filter shows everything', () => {
    expect(messageInLine('bridge', null)).toBe(true);
  });
});
