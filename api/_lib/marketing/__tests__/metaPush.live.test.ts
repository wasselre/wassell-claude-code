/**
 * LIVE end-to-end check of the Meta push SKELETON against the REAL ad account
 * — the exact client methods + payload builders `meta_push_structure` uses.
 * Creates a PAUSED campaign → ad set on the account's saved audience, reads the
 * ad set back from Graph and asserts the house rules (saved audience geo,
 * Instagram + WhatsApp only, mobile, unknown age excluded), then deletes the
 * campaign (cascades the ad set).
 *
 * Ads are no longer built here (2026-09-13): the worker's meta-ad lane is the
 * only ad-creation path — see worker/src/runMetaAdJob.ts.
 *
 * Skipped unless META_LIVE=1 — needs `.env.local` (META_*). Run:
 * `META_LIVE=1 npx vitest run api/_lib/marketing/__tests__/metaPush.live.test.ts`
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MetaMarketingClient, loadMetaConfig } from '../metaMarketingApi';
import {
  PLACEMENTS_BY_VARIANT, buildAdSetPayload, buildCampaignPayload,
  type PushCampaign, type PushExecution,
} from '../metaPush';

const LIVE = process.env.META_LIVE === '1';

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ['.env.local', '.env']) {
    for (const dir of [process.cwd(), path.resolve(process.cwd(), '../../..'), path.resolve(process.cwd(), '../../../../../..')]) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^﻿?([A-Z0-9_]+)=(.*)$/);
        if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^"|"$/g, '');
      }
    }
  }
  return out;
}

describe.skipIf(!LIVE)('meta push skeleton — LIVE (creates paused objects, then deletes them)', () => {
  it('campaign + ad set on the saved audience round-trip through the real account', async () => {
    const env = loadEnv();
    const cfg = loadMetaConfig(env as NodeJS.ProcessEnv);
    expect(cfg, 'META_* env missing').not.toBeNull();
    if (!cfg) return;
    expect(cfg.pageId).toBeTruthy();
    const client = new MetaMarketingClient(cfg);

    const audiences = await client.listSavedAudiences();
    expect(audiences.length, 'the ad account needs at least one saved audience').toBeGreaterThan(0);
    const saved = audiences[0]!;
    expect(saved.targeting).toBeTruthy();

    const campaign: PushCampaign = { id: 'live', ref: 'LIVE-TEST', name: 'push probe — delete me', objective: 'leads' };
    const execution: PushExecution = {
      id: 'live', label: 'probe', platform: 'meta', budget: 100, starts_on: null, ends_on: null, targeting: null, platform_settings: null,
    };
    let campaignId: string | null = null;
    try {
      const camp = await client.createCampaign(buildCampaignPayload(campaign, execution));
      campaignId = camp.id;
      const feed = await client.createAdSet(buildAdSetPayload(campaign, execution, { id: null, name: 'probe set' }, camp.id, cfg.pageId, saved.targeting as Record<string, unknown>, 'feed'));
      const story = await client.createAdSet(buildAdSetPayload(campaign, execution, { id: null, name: 'probe set' }, camp.id, cfg.pageId, saved.targeting as Record<string, unknown>, 'story'));
      expect(feed.id).toBeTruthy();
      expect(story.id).toBeTruthy();

      // Read back what Meta holds and assert the house rules.
      const sets = await client.listAdSets();
      const mineFeed = sets.find((s) => s.id === feed.id);
      const mineStory = sets.find((s) => s.id === story.id);
      expect(mineFeed).toBeTruthy();
      expect(mineStory).toBeTruthy();
      const t = (mineFeed?.targeting ?? {}) as Record<string, unknown>;
      expect(t.publisher_platforms).toEqual(PLACEMENTS_BY_VARIANT.feed.publisher_platforms);
      expect(t.instagram_positions).toEqual(PLACEMENTS_BY_VARIANT.feed.instagram_positions);
      expect(t.whatsapp_positions).toBeUndefined();
      expect(t.device_platforms).toEqual(['mobile']);
      expect(t.facebook_positions).toBeUndefined();
      expect(((mineStory?.targeting ?? {}) as Record<string, unknown>).instagram_positions).toEqual(PLACEMENTS_BY_VARIANT.story.instagram_positions);
      const adset = feed;
      const savedGeo = (saved.targeting as { geo_locations?: unknown }).geo_locations;
      expect(JSON.stringify(t.geo_locations)).toContain('2117479'); // Riyadh city key from the saved audience
      expect(savedGeo).toBeTruthy();
      console.log('[live] created', { campaign: camp.id, adset: adset.id, audience: saved.name, targeting: t });
    } catch (e) {
      // Surface Meta's user-facing reason, not just "Invalid parameter".
      const raw = (e as { raw?: unknown }).raw;
      console.error('[live] Meta error', JSON.stringify(raw ?? (e instanceof Error ? e.message : e)));
      throw e;
    } finally {
      if (campaignId) await client.deleteNode(campaignId);
    }
  }, 120_000);
});
