import { describe, it, expect } from 'vitest';
import {
  resolveConversationIdentity,
  conversationIdentityMessage,
  type ConversationIdentity,
} from '../conversationIdentity';
import type { AppModel, AppRecord, WhatsAppNumber, HaberchatDevice } from '@/types';

const CHATS_MODEL = { id: 'M_CHATS', name: 'chats' } as unknown as AppModel;

function chatRecord(data: Record<string, unknown>, id = 'REC_1'): AppRecord {
  return { id, model_id: 'M_CHATS', data } as unknown as AppRecord;
}

function device(over: Partial<WhatsAppNumber> = {}): WhatsAppNumber {
  return {
    device_id: 'DEV_OVERLAY',
    phone: '966500000000',
    friendly_name_ar: null,
    friendly_name_en: null,
    is_default: true,
    is_active: true,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

const LIVE: HaberchatDevice[] = [{ id: 'DEV_LIVE', phone: '966511111111', name: null }];

function resolve(over: Partial<Parameters<typeof resolveConversationIdentity>[0]> = {}) {
  return resolveConversationIdentity({
    recordId: 'REC_1',
    chatsModel: CHATS_MODEL,
    chatRecords: [chatRecord({ wid: '966555000111@c.us', phone: '+966555000111', kind: 'user', device_id: 'DEV_REC' })],
    waDevices: [device()],
    waDevicesLive: LIVE,
    devicesLoaded: true,
    ...over,
  });
}

describe('resolveConversationIdentity', () => {
  it('resolves record id, wid, phone and device together', () => {
    expect(resolve()).toEqual({
      status: 'ready',
      recordId: 'REC_1',
      chatWid: '966555000111@c.us',
      phone: '+966555000111',
      deviceId: 'DEV_REC',
    });
  });

  it('waits while the chats model or the conversation record is missing', () => {
    expect(resolve({ chatsModel: null }).status).toBe('loading');
    expect(resolve({ chatRecords: [] }).status).toBe('loading');
  });

  it('refuses groups and channels outright', () => {
    const out = resolve({
      chatRecords: [chatRecord({ wid: 'x@g.us', phone: '+966555000111', kind: 'group' })],
    });
    expect(out).toEqual({ status: 'unsupported', kind: 'group' });
  });

  it('reports an unresolved conversation number instead of looking ready', () => {
    // The #4 race: an inbound-webhook chat that has a wid but whose phone has
    // not been resolved yet. Rendering an enabled composer here is what let a
    // rep send a message that then vanished.
    expect(resolve({ chatRecords: [chatRecord({ wid: '123@lid', kind: 'user' })] }))
      .toEqual({ status: 'incomplete', reason: 'missing-phone' });
    expect(resolve({ chatRecords: [chatRecord({ phone: '+966555000111', kind: 'user' })] }))
      .toEqual({ status: 'incomplete', reason: 'missing-wid' });
  });

  it('falls back down the device chain: record → default → active → live', () => {
    const noRecordDevice = [chatRecord({ wid: 'w@c.us', phone: '+966555000111', kind: 'user' })];
    expect(resolve({ chatRecords: noRecordDevice })).toMatchObject({ deviceId: 'DEV_OVERLAY' });
    expect(resolve({ chatRecords: noRecordDevice, waDevices: [device({ is_default: false })] }))
      .toMatchObject({ deviceId: 'DEV_OVERLAY' });
    expect(resolve({ chatRecords: noRecordDevice, waDevices: [device({ is_active: false })] }))
      .toMatchObject({ deviceId: 'DEV_LIVE' });
  });

  it('waits for the device overlay, then reports no-device once it has settled', () => {
    const noRecordDevice = [chatRecord({ wid: 'w@c.us', phone: '+966555000111', kind: 'user' })];
    const args = { chatRecords: noRecordDevice, waDevices: [], waDevicesLive: [] };
    // Devices still loading at boot → wait, do NOT accuse the admin of a
    // misconfiguration and do NOT enable the composer.
    expect(resolve({ ...args, devicesLoaded: false }).status).toBe('loading');
    expect(resolve({ ...args, devicesLoaded: true }))
      .toEqual({ status: 'incomplete', reason: 'no-device' });
  });

  it('tolerates the legacy device OBJECT shape on the record', () => {
    const legacy = [chatRecord({ wid: 'w@c.us', phone: '+966555000111', kind: 'user', device_id: { id: 'DEV_OBJ' } })];
    expect(resolve({ chatRecords: legacy })).toMatchObject({ deviceId: 'DEV_OBJ' });
  });
});

describe('conversationIdentityMessage', () => {
  const states: Exclude<ConversationIdentity, { status: 'ready' }>[] = [
    { status: 'loading' },
    { status: 'unsupported', kind: 'channel' },
    { status: 'incomplete', reason: 'missing-phone' },
    { status: 'incomplete', reason: 'no-device' },
  ];

  it('has a non-empty message in BOTH languages for every non-ready state', () => {
    for (const s of states) {
      expect(conversationIdentityMessage(s, true).length).toBeGreaterThan(0);
      expect(conversationIdentityMessage(s, false).length).toBeGreaterThan(0);
      expect(conversationIdentityMessage(s, true)).not.toBe(conversationIdentityMessage(s, false));
    }
  });
});
