/**
 * LIVE end-to-end check of the Meta push pipeline against the REAL ad account
 * — the exact client methods + payload builders `meta_push_structure` uses,
 * with real Wassel media from Storage. Creates a PAUSED campaign → ad set →
 * image creative + ad → video creative + ad, verifies them via Graph, then
 * deletes everything (campaign delete cascades; creatives deleted explicitly).
 *
 * Skipped unless META_LIVE=1 — needs `.env.local` (META_* + Supabase service
 * key). Run: `META_LIVE=1 npx vitest run api/_lib/marketing/__tests__/metaPush.live.test.ts`
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { MetaMarketingClient, loadMetaConfig } from '../metaMarketingApi';
import {
  buildAdPayload, buildAdSetPayload, buildCampaignPayload, buildCreativePayload,
  type PushCampaign, type PushExecution, type PushAd,
} from '../metaPush';

const LIVE = process.env.META_LIVE === '1';

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ['.env.local', '.env']) {
    for (const dir of [process.cwd(), path.resolve(process.cwd(), '../../..')]) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^"|"$/g, '');
      }
    }
  }
  return out;
}

// Real, small Wassel assets (mos_assets ⨝ files, 2026-09-10).
const IMAGE = { bucket: 'wassel-files', path: '98e5f23c-0acf-48bc-b15d-14634ce5453a/89e8ed9f-64a8-4cdf-917e-27085ac6651c.jpg' };
const VIDEO = { bucket: 'wassel-files', path: '31621e58-c723-45ad-9e4f-6f8ba1689fe7/79c51dfd-3c0a-4a39-9411-393e9076bda6.mp4' };

describe.skipIf(!LIVE)('meta push — LIVE (creates paused objects, then deletes them)', () => {
  it('image + video creatives and ads round-trip through the real account', async () => {
    const env = loadEnv();
    const cfg = loadMetaConfig(env as NodeJS.ProcessEnv);
    expect(cfg, 'META_* env missing').not.toBeNull();
    if (!cfg) return;
    expect(cfg.pageId).toBeTruthy();
    const svc = createClient(env.VITE_SUPABASE_URL ?? env.SUPABASE_URL ?? '', env.SUPABASE_SERVICE_ROLE_KEY ?? '');
    const client = new MetaMarketingClient(cfg);

    const campaign: PushCampaign = { id: 'live', ref: 'LIVE-TEST', name: 'push probe — delete me', objective: 'leads' };
    const execution: PushExecution = {
      id: 'live', label: 'probe', platform: 'meta', budget: 20, starts_on: null, ends_on: null, targeting: null, platform_settings: null,
    };
    const created: { campaign?: string; creatives: string[] } = { creatives: [] };
    try {
      // Skeleton
      const camp = await client.createCampaign(buildCampaignPayload(campaign, execution));
      created.campaign = camp.id;
      const adset = await client.createAdSet(buildAdSetPayload(campaign, execution, { id: null, name: 'probe set' }, camp.id, cfg.pageId));
      expect(adset.id).toBeTruthy();

      // Image: sign → download → bytes upload → creative → ad
      const sImg = await svc.storage.from(IMAGE.bucket).createSignedUrl(IMAGE.path, 3600);
      expect(sImg.error).toBeNull();
      const dl = await fetch(sImg.data!.signedUrl);
      expect(dl.ok).toBe(true);
      const bytes = new Uint8Array(await dl.arrayBuffer());
      const img = await client.uploadImageBytes(bytes, 'probe image');
      expect(img.hash).toMatch(/^[a-f0-9]{32}$/);
      const imgAd: PushAd = { id: 'a-img', label: 'probe image ad', content_title: null, creative: { primary_text: 'probe — delete me', headline: 'probe', cta: 'CONTACT_US' } };
      const cr1 = await client.createAdCreative(buildCreativePayload(campaign, execution, imgAd, { kind: 'image', image_hash: img.hash }, cfg.pageId!, cfg.instagramId));
      created.creatives.push(cr1.id);
      const ad1 = await client.createAd(buildAdPayload(campaign, execution, imgAd, adset.id, cr1.id));
      expect(ad1.id).toBeTruthy();

      // Video: sign → file_url upload → poll ready → thumbnail → creative → ad
      const sVid = await svc.storage.from(VIDEO.bucket).createSignedUrl(VIDEO.path, 3600);
      expect(sVid.error).toBeNull();
      const vid = await client.uploadVideoByUrl(sVid.data!.signedUrl, 'probe video');
      let st = await client.getVideoStatus(vid.id);
      for (let i = 0; i < 24 && !st.ready; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        st = await client.getVideoStatus(vid.id);
      }
      expect(st.ready, `video status ${st.status}`).toBe(true);
      expect(st.thumbnailUrl).toMatch(/^https:\/\//);
      const vidAd: PushAd = { id: 'a-vid', label: 'probe video ad', content_title: null, creative: { message: 'probe video — delete me' } };
      const cr2 = await client.createAdCreative(buildCreativePayload(campaign, execution, vidAd, { kind: 'video', video_id: vid.id, thumbnail_url: st.thumbnailUrl! }, cfg.pageId!, cfg.instagramId));
      created.creatives.push(cr2.id);
      const ad2 = await client.createAd(buildAdPayload(campaign, execution, vidAd, adset.id, cr2.id));
      expect(ad2.id).toBeTruthy();

      // Verify what Meta actually holds: both ads PAUSED under our ad set.
      const ads = await client.listAds();
      const mine = ads.filter((a) => a.id === ad1.id || a.id === ad2.id);
      expect(mine).toHaveLength(2);
      for (const a of mine) {
        expect(a.status).toBe('PAUSED');
        expect(a.adset_id).toBe(adset.id);
        expect(a.creative?.id).toBeTruthy();
      }
      console.log('[live] created', { campaign: camp.id, adset: adset.id, ads: mine.map((a) => a.id), creatives: created.creatives, image_hash: img.hash, video: vid.id });
    } finally {
      if (created.campaign) await client.deleteNode(created.campaign);
      for (const c of created.creatives) {
        try { await client.deleteNode(c); } catch (e) { console.error('[live] creative delete failed', c, e); }
      }
    }
  }, 240_000);
});
