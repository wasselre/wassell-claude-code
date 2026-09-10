import { describe, it, expect } from 'vitest';
import {
  adName, buildAdPayload, buildCreativePayload, pickCreativeAsset, resolveAdDestination,
  type PushAd, type PushCampaign, type PushExecution,
} from '../metaPush';

const campaign: PushCampaign = { id: 'c1', ref: 'C-037', name: 'مينا 52', objective: 'leads' };
const execution: PushExecution = {
  id: 'e1', label: 'ميتا', platform: 'meta', budget: 100, starts_on: null, ends_on: null,
  targeting: null, platform_settings: null,
};
const ad: PushAd = {
  id: 'a1', label: 'تعريف بالمشروع ١', content_title: 'P-131',
  creative: { primary_text: 'شقق جاهزة في النرجس', headline: 'مينا 52', description: 'ابدأ من 850 ألف', cta: 'CONTACT_US', destination_url: 'https://wassel.re/p/mina-52' },
};

describe('metaPush — ad level (2026-09-10)', () => {
  it('leads campaigns default to the WhatsApp destination; traffic to a link', () => {
    expect(resolveAdDestination(campaign, execution)).toBe('WHATSAPP');
    expect(resolveAdDestination({ ...campaign, objective: 'traffic' }, execution)).toBe('LINK');
    // platform_settings destination wins over the objective default
    expect(resolveAdDestination(campaign, { ...execution, platform_settings: { destination_type: 'WEBSITE' } })).toBe('LINK');
  });

  it('names trace back to Wassell (ref · execution · ad label, content title as fallback)', () => {
    expect(adName(campaign, execution, ad)).toBe('C-037 · ميتا · تعريف بالمشروع ١');
    expect(adName(campaign, execution, { ...ad, label: null })).toBe('C-037 · ميتا · P-131');
  });

  it('Click-to-WhatsApp image creative: page + IG identity, WhatsApp link + CTA, copy in link_data', () => {
    const p = buildCreativePayload(campaign, execution, ad, { kind: 'image', image_hash: 'abc' }, 'PAGE', 'IG');
    expect(p.name).toBe('C-037 · ميتا · تعريف بالمشروع ١');
    const spec = p.object_story_spec as Record<string, unknown>;
    expect(spec.page_id).toBe('PAGE');
    expect(spec.instagram_user_id).toBe('IG');
    const ld = spec.link_data as Record<string, unknown>;
    expect(ld.image_hash).toBe('abc');
    expect(ld.message).toBe('شقق جاهزة في النرجس');
    expect(ld.name).toBe('مينا 52');
    expect(ld.description).toBe('ابدأ من 850 ألف');
    // WhatsApp ad sets ignore the typed CTA + landing url
    expect(ld.link).toBe('https://api.whatsapp.com/send');
    expect(ld.call_to_action).toEqual({ type: 'WHATSAPP_MESSAGE', value: { link: 'https://api.whatsapp.com/send', app_destination: 'WHATSAPP' } });
    expect(spec.video_data).toBeUndefined();
  });

  it('link creative uses the typed CTA + landing url, falls back to LEARN_MORE / wassel.re', () => {
    const traffic = { ...campaign, objective: 'traffic' };
    const p = buildCreativePayload(traffic, execution, ad, { kind: 'image', image_hash: 'abc' }, 'PAGE', null);
    const spec = p.object_story_spec as Record<string, unknown>;
    expect(spec.instagram_user_id).toBeUndefined();
    const ld = spec.link_data as Record<string, unknown>;
    expect(ld.link).toBe('https://wassel.re/p/mina-52');
    expect(ld.call_to_action).toEqual({ type: 'CONTACT_US', value: { link: 'https://wassel.re/p/mina-52' } });

    const loose = buildCreativePayload(traffic, execution, { ...ad, creative: { message: 'hi', cta: 'اعرف المزيد' } }, { kind: 'image', image_hash: 'abc' }, 'PAGE', null);
    const ld2 = (loose.object_story_spec as Record<string, unknown>).link_data as Record<string, unknown>;
    expect(ld2.link).toBe('https://wassel.re');
    expect(ld2.message).toBe('hi');
    expect(ld2.name).toBeUndefined();
    expect((ld2.call_to_action as Record<string, unknown>).type).toBe('LEARN_MORE');
  });

  it('video creative carries video_id + Meta thumbnail + title/link_description', () => {
    const p = buildCreativePayload(campaign, execution, ad, { kind: 'video', video_id: 'V1', thumbnail_url: 'https://cdn/thumb.jpg' }, 'PAGE', 'IG');
    const spec = p.object_story_spec as Record<string, unknown>;
    expect(spec.link_data).toBeUndefined();
    const vd = spec.video_data as Record<string, unknown>;
    expect(vd.video_id).toBe('V1');
    expect(vd.image_url).toBe('https://cdn/thumb.jpg');
    expect(vd.title).toBe('مينا 52');
    expect(vd.link_description).toBe('ابدأ من 850 ألف');
    expect((vd.call_to_action as Record<string, unknown>).type).toBe('WHATSAPP_MESSAGE');
  });

  it('ad payload is PAUSED and binds creative to the Meta ad set', () => {
    expect(buildAdPayload(campaign, execution, ad, 'ADSET', 'CR')).toEqual({
      name: 'C-037 · ميتا · تعريف بالمشروع ١', adset_id: 'ADSET', creative: { creative_id: 'CR' }, status: 'PAUSED',
    });
  });

  it('pickCreativeAsset: final beats source, images by mime (document-kind designs count), links skipped', () => {
    const pick = pickCreativeAsset([
      { asset_id: 'yt', role: 'final', kind: 'video', mime_type: null, file_id: null, url: 'https://www.youtube.com/watch?v=x' },
      { asset_id: 'src', role: 'source', kind: 'photo', mime_type: 'image/jpeg', file_id: 'f1', url: null },
      { asset_id: 'fin', role: 'final', kind: 'document', mime_type: 'image/png', file_id: 'f2', url: null },
      { asset_id: 'heic', role: 'final', kind: 'photo', mime_type: 'image/heic', file_id: 'f3', url: null },
    ]);
    expect(pick?.asset.asset_id).toBe('fin');
    expect(pick?.kind).toBe('image');

    const vid = pickCreativeAsset([
      { asset_id: 'ref', role: 'reference', kind: 'video', mime_type: 'video/mp4', file_id: 'f9', url: null },
    ]);
    expect(vid).toEqual({ asset: expect.objectContaining({ asset_id: 'ref' }), kind: 'video' });

    const pub = pickCreativeAsset([
      { asset_id: 'pub', role: 'final', kind: 'photo', mime_type: 'image/jpeg', file_id: null, url: 'https://x.supabase.co/storage/v1/object/public/marketing-assets/mos/a.jpg' },
    ]);
    expect(pub?.asset.asset_id).toBe('pub');

    expect(pickCreativeAsset([])).toBeNull();
    expect(pickCreativeAsset([
      { asset_id: 'pdf', role: 'final', kind: 'document', mime_type: 'application/pdf', file_id: 'f', url: null },
    ])).toBeNull();
  });
});
