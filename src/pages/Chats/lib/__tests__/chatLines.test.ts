import { describe, it, expect } from 'vitest';
import { chatLines, lineLabel, switcherLines } from '../chatLines';
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
