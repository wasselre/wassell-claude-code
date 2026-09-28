import { describe, it, expect } from 'vitest';
import { extractAdReferral, type WahaMessageRaw } from '../waha.js';

/**
 * Click-to-WhatsApp ad attribution off a raw WAHA (GOWS) message. The shapes
 * below are the real ones pulled back from the gateway on 2026-09-28, minus the
 * thumbnails and with the opaque tokens shortened.
 */
const msg = (message: Record<string, unknown>): WahaMessageRaw =>
  ({ id: 'false_1@lid_X', fromMe: false, _data: { Message: message } }) as unknown as WahaMessageRaw;

const GREETING = 'مهتم بمشروع ريا النخيل';

describe('extractAdReferral — the ad card', () => {
  it('reads the ad ID off externalAdReply (the 13:19 lead, P-471 story)', () => {
    const r = extractAdReferral(msg({
      extendedTextMessage: {
        text: GREETING,
        contextInfo: {
          conversionSource: 'FB_Ads',
          externalAdReply: {
            title: 'تواصل معنا على الواتساب',
            sourceType: 'ad',
            sourceID: '120253660820760020',
            sourceURL: 'https://www.instagram.com/p/DdyexaMgdZr/',
            ctwaClid: 'AfhFcLd2',
            sourceApp: 'instagram',
          },
          entryPointConversionSource: 'ctwa_ad',
          entryPointConversionApp: 'instagram',
        },
      },
    }));
    expect(r?.ad_id).toBe('120253660820760020');
    expect(r?.ctwa_clid).toBe('AfhFcLd2');
    expect(r?.source_app).toBe('instagram');
    expect(r?.ad_id_missing).toBeUndefined();
  });
});

describe('extractAdReferral — an ad lead WhatsApp sent without its card', () => {
  it('keeps the ad-origin mark with no ad ID (the 16:08 lead, chat 966500700283)', () => {
    const r = extractAdReferral(msg({
      extendedTextMessage: {
        text: GREETING,
        contextInfo: {
          conversionSource: 'FB_Ads',
          conversionData: 'AfjFu65b',
          entryPointConversionSource: 'ctwa_ad',
          entryPointConversionApp: 'instagram',
          entryPointConversionExternalSource: 'FB_Ads',
          ctwaSignals: 'all,all',
          ctwaPayload: 'AfjFu65b',
        },
      },
    }));
    expect(r).not.toBeNull();
    expect(r?.ad_id).toBeNull();
    expect(r?.ctwa_clid).toBeNull();
    expect(r?.ad_id_missing).toBe(true);
    expect(r?.source_app).toBe('instagram');
    expect(r?.entry_point_source).toBe('ctwa_ad');
    expect(r?.conversion_source).toBe('FB_Ads');
    expect(r?.ctwa_payload).toBe('AfjFu65b');
    // Unknown, because it lives on the card that did not come.
    expect(r?.source_type).toBeNull();
    expect(r?.source_url).toBeNull();
  });

  it('treats FB_Ads alone as ad origin (the card-less duplicate copy seen 18 Sep)', () => {
    const r = extractAdReferral(msg({
      extendedTextMessage: { text: 'مهتم بمشروع تل الربوة', contextInfo: { conversionSource: 'FB_Ads' } },
    }));
    expect(r?.ad_id_missing).toBe(true);
    expect(r?.entry_point_source).toBeNull();
  });

  it('treats a card with no usable identity as a card-less ad lead, not as nothing', () => {
    const r = extractAdReferral(msg({
      extendedTextMessage: {
        text: GREETING,
        contextInfo: { entryPointConversionSource: 'ctwa_ad', externalAdReply: { title: 'x', sourceType: 'ad' } },
      },
    }));
    expect(r?.ad_id).toBeNull();
    expect(r?.ad_id_missing).toBe(true);
  });

  it('lets a card anywhere in the message win over a bare mark elsewhere', () => {
    const r = extractAdReferral(msg({
      messageContextInfo: { contextInfo: { conversionSource: 'FB_Ads' } },
      extendedTextMessage: {
        text: GREETING,
        contextInfo: { externalAdReply: { sourceID: '120253660823560020', sourceApp: 'instagram' } },
      },
    }));
    expect(r?.ad_id).toBe('120253660823560020');
    expect(r?.ad_id_missing).toBeUndefined();
  });
});

describe('extractAdReferral — not an ad lead', () => {
  it('returns null for a plain message and for a reply that quotes one', () => {
    expect(extractAdReferral(msg({ conversation: 'السلام عليكم' }))).toBeNull();
    expect(extractAdReferral(msg({
      extendedTextMessage: { text: 'English?', contextInfo: { stanzaID: '3A1', quotedMessage: { conversation: 'x' } } },
    }))).toBeNull();
  });

  it('returns null for another entry point and for a message with no raw data', () => {
    expect(extractAdReferral(msg({
      extendedTextMessage: { text: 'hi', contextInfo: { entryPointConversionSource: 'click_to_chat_link' } },
    }))).toBeNull();
    expect(extractAdReferral({ id: 'x' } as unknown as WahaMessageRaw)).toBeNull();
  });
});
