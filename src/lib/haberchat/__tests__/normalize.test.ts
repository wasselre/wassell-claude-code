import { describe, expect, it } from 'vitest';
import {
  chatRecordId,
  deviceIdString,
  mergeChatIntoRecord,
  matchRecordByPhone,
  ksaCanonicalPhone,
} from '../normalize';
import type { AppRecord, HaberchatChat } from '@/types';

const DEVICE = '6a324d9052c72dfccc5446cc';
const MODEL_ID = 'chats-model';

function chat(overrides: Partial<HaberchatChat> = {}): HaberchatChat {
  return {
    wid: '966500000001@c.us',
    kind: 'user',
    name: 'Test',
    phone: '+966500000001',
    status: 'active',
    labels: [],
    unreadCount: 0,
    lastMessageAt: '2026-07-17T10:00:00.000Z',
    lastMessagePreview: null,
    ...overrides,
  };
}

function existingRecord(data: Record<string, unknown>): AppRecord {
  return {
    id: chatRecordId('966500000001@c.us'),
    model_id: MODEL_ID,
    data: { wid: '966500000001@c.us', ...data },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

describe('deviceIdString', () => {
  it('passes a plain id string through', () => {
    expect(deviceIdString(DEVICE)).toBe(DEVICE);
  });

  it('extracts id from the corrupt device-object shape', () => {
    // The exact shape Haberchat's webhook envelope delivers — the whole
    // object leaked into device_id before the 2026-07-17 fix.
    expect(deviceIdString({ id: DEVICE, phone: '+966556546238', alias: 'x', plan: 'io' })).toBe(DEVICE);
  });

  it('returns null for unusable values', () => {
    expect(deviceIdString(null)).toBeNull();
    expect(deviceIdString('')).toBeNull();
    expect(deviceIdString({ plan: 'io' })).toBeNull();
    expect(deviceIdString(42)).toBeNull();
  });
});

describe('mergeChatIntoRecord — preview + unread ownership', () => {
  it('keeps the webhook-stamped preview when Haberchat sends none', () => {
    // Haberchat's chat list has NO preview field — a sync must not wipe it.
    const prev = existingRecord({
      last_message_at: '2026-07-17T10:00:00.000Z',
      last_message_preview: 'مرحبا',
      unread_count: 0,
    });
    const next = mergeChatIntoRecord(prev, chat({ lastMessagePreview: null }), DEVICE, MODEL_ID);
    expect((next.data as Record<string, unknown>).last_message_preview).toBe('مرحبا');
  });

  it('takes a real preview from Haberchat when it provides one', () => {
    const prev = existingRecord({
      last_message_at: '2026-07-17T09:00:00.000Z',
      last_message_preview: 'old',
      unread_count: 0,
    });
    const next = mergeChatIntoRecord(prev, chat({ lastMessagePreview: 'newer' }), DEVICE, MODEL_ID);
    expect((next.data as Record<string, unknown>).last_message_preview).toBe('newer');
  });

  it('preserves the CRM-owned unread_count over Haberchat\'s phone-side count', () => {
    // User cleared the badge in the CRM (0), phone never read (Haberchat 3):
    // the cleared badge must not resurrect on sync.
    const prev = existingRecord({ unread_count: 0, last_message_preview: 'x', last_message_at: '2026-07-17T10:00:00.000Z' });
    const next = mergeChatIntoRecord(prev, chat({ unreadCount: 3 }), DEVICE, MODEL_ID);
    expect((next.data as Record<string, unknown>).unread_count).toBe(0);

    // And the inverse: webhook counted 2, Haberchat says 0 (phone read it):
    // the CRM user still hasn't seen them.
    const prev2 = existingRecord({ unread_count: 2, last_message_preview: 'x', last_message_at: '2026-07-17T10:00:00.000Z' });
    const next2 = mergeChatIntoRecord(prev2, chat({ unreadCount: 0 }), DEVICE, MODEL_ID);
    expect((next2.data as Record<string, unknown>).unread_count).toBe(2);
  });

  it('seeds unread_count from Haberchat for a chat we have never tracked', () => {
    const next = mergeChatIntoRecord(null, chat({ unreadCount: 5 }), DEVICE, MODEL_ID);
    expect((next.data as Record<string, unknown>).unread_count).toBe(5);
  });

  it('keeps forward-only recency: a lagging list sync cannot move the chat backwards', () => {
    const prev = existingRecord({
      last_message_at: '2026-07-17T12:00:00.000Z',
      last_message_preview: 'newest',
      unread_count: 1,
    });
    const next = mergeChatIntoRecord(
      prev,
      chat({ lastMessageAt: '2026-07-17T11:00:00.000Z', lastMessagePreview: null }),
      DEVICE,
      MODEL_ID,
    );
    const data = next.data as Record<string, unknown>;
    expect(data.last_message_at).toBe('2026-07-17T12:00:00.000Z');
    expect(data.last_message_preview).toBe('newest');
  });
});

describe('ksaCanonicalPhone', () => {
  it('reconciles every stored KSA format onto one E.164 string', () => {
    expect(ksaCanonicalPhone('966599090218')).toBe('966599090218'); // +966…
    expect(ksaCanonicalPhone('599090218')).toBe('966599090218');    // bare subscriber
    expect(ksaCanonicalPhone('0599090218')).toBe('966599090218');   // local trunk 0
    expect(ksaCanonicalPhone('00966599090218')).toBe('966599090218'); // international 00
  });
});

describe('matchRecordByPhone', () => {
  const CLIENT_SLUGS = ['phone_number'];
  function client(id: string, phone: string): AppRecord {
    return {
      id,
      model_id: 'clients-model',
      data: { phone_number: phone },
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    };
  }

  it('matches a client stored in local 05… form to a 966… chat wid (the bug fix)', () => {
    const c = client('c-05', '0599090218');
    expect(matchRecordByPhone('+966599090218', [c], CLIENT_SLUGS)?.id).toBe('c-05');
  });

  it('still matches the bare-9-digit and full-966 forms', () => {
    expect(matchRecordByPhone('+966599090218', [client('bare', '599090218')], CLIENT_SLUGS)?.id).toBe('bare');
    expect(matchRecordByPhone('+966599090218', [client('full', '+966599090218')], CLIENT_SLUGS)?.id).toBe('full');
  });

  it('does not match a different number', () => {
    expect(matchRecordByPhone('+966599090218', [client('other', '0500000000')], CLIENT_SLUGS)).toBeNull();
  });

  it('returns null when there are no phone slugs or the number is too short', () => {
    expect(matchRecordByPhone('+966599090218', [client('c', '0599090218')], [])).toBeNull();
    expect(matchRecordByPhone('123', [client('c', '0599090218')], CLIENT_SLUGS)).toBeNull();
  });
});
