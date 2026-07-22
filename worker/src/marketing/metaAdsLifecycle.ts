// ============================================================================
// Meta Ad Library provider (worker, dedicated — NOT mixed into organic).
// Reuses the shared Apify run primitive (runApifyActor) + the actor registry.
// Meta Ad Library only; the returned NormalizedAd shape is platform-agnostic so
// TikTok/Snap ad libraries add later without changing the model.
// NOTE: the actor is apify/facebook-ads-scraper (seeded, source_type 'meta_ads').
// parseMetaAd is written tolerantly and reconciled against real output during the
// pilot (same posture as parseTiktokVideo) — update parser + fixture together.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { runApifyActor, readActorConfig } from './apifyLifecycle.js';
import { ProviderError } from './providers.js';
import { registrableDomain } from './advertiserScoring.js';

export interface NormalizedAd {
  platform: 'meta';
  externalAdId: string;
  advertiserName?: string;
  pageId?: string;
  creativeMediaRef?: string;   // image/video URL (re-host later)
  creativeType?: 'image' | 'video' | 'carousel' | 'unknown';
  headline?: string;
  body?: string;               // primary text
  description?: string;        // link description
  cta?: string;
  landingUrl?: string;
  languages?: string[];
  platformStartedAt?: string;
  isActive: boolean;
  reachInfo?: Record<string, unknown>; // EU-only reach range where present; never estimated
  raw: unknown;
}

const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
function epochToIso(v: unknown): string | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return typeof v === 'string' ? v : undefined;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

/** Tolerant parser for apify/facebook-ads-scraper items (Ad Library). */
export function parseMetaAd(item: Record<string, unknown>): NormalizedAd | null {
  const id = s(item.adArchiveID) ?? s(item.ad_archive_id) ?? s(item.adArchiveId) ?? s(item.adid) ?? s(item.id);
  if (!id) return null;
  const snap = (item.snapshot ?? item.adSnapshot ?? {}) as Record<string, unknown>;
  const bodyObj = snap.body as Record<string, unknown> | string | undefined;
  const body = (bodyObj && typeof bodyObj === 'object' ? s(bodyObj.text) : s(bodyObj)) ?? s(item.adText) ?? s(item.body);
  const images = (snap.images ?? item.images) as Array<Record<string, unknown>> | undefined;
  const videos = (snap.videos ?? item.videos) as Array<Record<string, unknown>> | undefined;
  const cards = (snap.cards) as Array<Record<string, unknown>> | undefined;
  let creativeMediaRef: string | undefined;
  let creativeType: NormalizedAd['creativeType'] = 'unknown';
  if (videos?.length) { creativeMediaRef = s(videos[0]!.videoHdUrl) ?? s(videos[0]!.videoSdUrl) ?? s(videos[0]!.videoPreviewImageUrl); creativeType = 'video'; }
  else if (images?.length) { creativeMediaRef = s(images[0]!.resizedImageUrl) ?? s(images[0]!.originalImageUrl) ?? s(images[0]!.url); creativeType = 'image'; }
  else if (cards?.length) { creativeMediaRef = s(cards[0]!.resizedImageUrl) ?? s(cards[0]!.videoHdUrl); creativeType = 'carousel'; }
  const langs = (item.languages ?? snap.languages) as string[] | undefined;
  const activeRaw = item.isActive ?? item.is_active ?? (s(item.status) ? item.status === 'ACTIVE' : undefined);
  return {
    platform: 'meta', externalAdId: id,
    advertiserName: s(snap.pageName) ?? s(item.pageName) ?? s(item.page_name),
    pageId: s(snap.pageId) ?? s(item.pageID) ?? s(item.page_id),
    creativeMediaRef, creativeType,
    headline: s(snap.title) ?? s(item.title),
    body,
    description: s(snap.linkDescription) ?? s(snap.caption) ?? s(item.linkDescription),
    cta: s(snap.ctaText) ?? s(snap.cta_text) ?? s(item.ctaText),
    landingUrl: s(snap.linkUrl) ?? s(snap.link_url) ?? s(item.linkUrl) ?? s(item.link),
    languages: Array.isArray(langs) ? langs : [],
    platformStartedAt: epochToIso(item.startDate ?? item.start_date ?? item.startDateFormatted),
    isActive: activeRaw === undefined ? true : Boolean(activeRaw),
    reachInfo: (item.reachEstimate ?? item.euTotalReach) ? { reach: item.reachEstimate ?? item.euTotalReach } : undefined,
    raw: item,
  };
}

function buildMetaAdsInput(advertiser: string, country: string, limit: number): Record<string, unknown> {
  const url = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${country}` +
    `&q=${encodeURIComponent(advertiser)}&search_type=keyword_unordered&media_type=all`;
  // apify/facebook-ads-scraper: startUrls (Ad Library search URLs) + resultsLimit.
  return { startUrls: [{ url }], resultsLimit: limit };
}
// PRODUCTION path: collect by a specific advertiser PAGE (not a keyword).
function buildPageAdsInput(pageId: string, country: string, limit: number): Record<string, unknown> {
  const url = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${country}&view_all_page_id=${pageId}`;
  return { startUrls: [{ url }], resultsLimit: limit };
}

// Richer candidate: carries the identity signals the scorer needs (landing
// domains + ad count + sample headlines), aggregated across the page's ads.
export interface AdvertiserCandidate {
  pageId: string; pageName: string | null; pageUrl: string;
  adCount: number; landingDomains: string[]; sampleHeadlines: string[];
}

/** DISCOVERY tool only: keyword-search → distinct advertiser pages behind the results. */
export async function discoverAdvertiser(
  sb: SupabaseClient, input: { advertiser: string; country?: string; limit?: number },
): Promise<{ candidates: AdvertiserCandidate[]; runId: string; cost: Record<string, unknown> }> {
  const cfg = await readActorConfig(sb, 'meta_ads');
  if (!cfg?.isEnabled) throw new ProviderError('meta_ads actor disabled', 'config_invalid');
  const { runId, rawItems, cost } = await runApifyActor(cfg.actorId, buildMetaAdsInput(input.advertiser, input.country ?? 'SA', input.limit ?? 30), input.limit ?? 30);
  const byPage = new Map<string, { pageName: string | null; domains: Set<string>; count: number; headlines: string[] }>();
  for (const it of rawItems) {
    const ad = parseMetaAd(it);
    if (!ad?.pageId) continue;
    let e = byPage.get(ad.pageId);
    if (!e) { e = { pageName: ad.advertiserName ?? null, domains: new Set(), count: 0, headlines: [] }; byPage.set(ad.pageId, e); }
    e.count++;
    if (!e.pageName && ad.advertiserName) e.pageName = ad.advertiserName;
    const dom = registrableDomain(ad.landingUrl);
    if (dom) e.domains.add(dom);
    const hl = ad.headline ?? ad.body;
    if (hl && e.headlines.length < 3 && !hl.includes('{{')) e.headlines.push(hl.slice(0, 80));
  }
  const candidates: AdvertiserCandidate[] = [...byPage.entries()].map(([pageId, e]) => ({
    pageId, pageName: e.pageName, pageUrl: `https://www.facebook.com/${pageId}`,
    adCount: e.count, landingDomains: [...e.domains], sampleHeadlines: e.headlines,
  }));
  return { candidates, runId, cost };
}

/** PRODUCTION collection: a specific advertiser page's ads. */
export async function collectMetaAdsByPage(
  sb: SupabaseClient, input: { pageId: string; country?: string; limit: number; timeoutMs?: number },
): Promise<MetaAdsCollectResult> {
  const cfg = await readActorConfig(sb, 'meta_ads');
  if (!cfg?.isEnabled) throw new ProviderError('meta_ads actor disabled', 'config_invalid');
  const { runId, rawItems, cost } = await runApifyActor(cfg.actorId, buildPageAdsInput(input.pageId, input.country ?? 'SA', input.limit), input.limit, input.timeoutMs);
  const ads = rawItems.map(parseMetaAd).filter((a): a is NormalizedAd => a !== null);
  return { ads, runId, rawItems, cost };
}

export interface MetaAdsCollectResult { ads: NormalizedAd[]; runId: string; rawItems: Array<Record<string, unknown>>; cost: Record<string, unknown> }

export async function collectMetaAds(
  sb: SupabaseClient,
  input: { advertiser: string; country?: string; limit: number; timeoutMs?: number },
): Promise<MetaAdsCollectResult> {
  const cfg = await readActorConfig(sb, 'meta_ads');
  if (!cfg) throw new ProviderError('No actor configured for meta_ads', 'config_invalid');
  if (!cfg.isEnabled) throw new ProviderError('meta_ads actor disabled (vet + enable in mkt_actor_configs)', 'config_invalid');
  if (cfg.resultParser !== 'parseMetaAds') throw new ProviderError(`Unexpected parser "${cfg.resultParser}" for meta_ads`, 'config_invalid');
  const runInput = buildMetaAdsInput(input.advertiser, input.country ?? 'SA', input.limit);
  const { runId, rawItems, cost } = await runApifyActor(cfg.actorId, runInput, input.limit, input.timeoutMs);
  const ads = rawItems.map(parseMetaAd).filter((a): a is NormalizedAd => a !== null);
  return { ads, runId, rawItems, cost };
}
