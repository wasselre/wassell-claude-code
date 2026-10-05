import { describe, it, expect } from 'vitest';
import type { AppModel, AppRecord } from '@/types';
import { buildLastInteractionIndex, inInteractionWindow } from '../lastInteraction';

const CLIENTS = 'm-clients';

function model(id: string, name: string, lookupSlug?: string): AppModel {
  return {
    id,
    name,
    schema: {
      sections: [
        {
          id: 's',
          fields: lookupSlug ? [{ id: 'f', name: lookupSlug, type: 'lookup', lookup_model_id: CLIENTS }] : [],
        },
      ],
    },
  } as unknown as AppModel;
}

function rec(id: string, data: Record<string, unknown>): AppRecord {
  return { id, model_id: 'x', data } as unknown as AppRecord;
}

const models = [
  model(CLIENTS, 'clients'),
  model('m-fu', 'followups'),
  model('m-chats', 'chats', 'client_link'),
  model('m-calls', 'phone_calls', 'client_link'),
];

describe('buildLastInteractionIndex', () => {
  it('keeps the newest contact across follow-ups, chats and calls', () => {
    const idx = buildLastInteractionIndex(
      models,
      {
        'm-fu': [
          rec('f1', { client_id: 'c1', followup_status: 'completed', actual_datetime: '2026-10-01T10:00:00Z' }),
          // open follow-ups are plans, not contact
          rec('f2', { client_id: 'c1', followup_status: 'open', actual_datetime: '2026-10-05T10:00:00Z' }),
        ],
        'm-chats': [rec('ch1', { client_link: 'c1', last_message_at: '2026-10-03T09:00:00Z', last_message_flow: 'in' })],
        'm-calls': [rec('k1', { client_link: ['c1', 'c2'], call_time: '2026-10-02T09:00:00Z' })],
      },
      CLIENTS,
    );
    expect(idx.get('c1')).toEqual({ at: '2026-10-03T09:00:00Z', kind: 'whatsapp_in' });
    expect(idx.get('c2')).toEqual({ at: '2026-10-02T09:00:00Z', kind: 'call' });
  });

  it('does not guess a WhatsApp side when the chat has no flow', () => {
    const idx = buildLastInteractionIndex(
      models,
      { 'm-chats': [rec('ch1', { client_link: 'c1', last_message_at: '2026-10-03T09:00:00Z' })] },
      CLIENTS,
    );
    expect(idx.get('c1')?.kind).toBe('whatsapp');
  });
});

describe('inInteractionWindow', () => {
  const now = new Date(2026, 9, 5, 15, 0).getTime(); // 5 Oct, 15:00 local
  const at = (d: number, h: number) => ({ at: new Date(2026, 9, d, h, 0).toISOString(), kind: 'call' as const });

  it('splits today and yesterday on the local calendar day', () => {
    expect(inInteractionWindow(at(5, 0), 'today', now)).toBe(true);
    expect(inInteractionWindow(at(4, 23), 'today', now)).toBe(false);
    expect(inInteractionWindow(at(4, 23), 'yesterday', now)).toBe(true);
    expect(inInteractionWindow(at(3, 23), 'yesterday', now)).toBe(false);
  });

  it('week = today and the six days before', () => {
    expect(inInteractionWindow(at(1, 9), 'week', now)).toBe(true);
    expect(inInteractionWindow({ at: new Date(2026, 8, 29, 9).toISOString(), kind: 'call' }, 'week', now)).toBe(true);
    expect(inInteractionWindow({ at: new Date(2026, 8, 28, 9).toISOString(), kind: 'call' }, 'week', now)).toBe(false);
  });

  it('never = no contact at all', () => {
    expect(inInteractionWindow(undefined, 'none', now)).toBe(true);
    expect(inInteractionWindow(at(5, 9), 'none', now)).toBe(false);
    expect(inInteractionWindow(undefined, 'today', now)).toBe(false);
    expect(inInteractionWindow(undefined, 'all', now)).toBe(true);
  });
});
