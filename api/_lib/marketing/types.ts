// ============================================================================
// Project Marketing Intelligence — provider contract + normalized model.
// ----------------------------------------------------------------------------
// The core DB + UI depend ONLY on these types, never on a provider's raw shape.
// Every provider (Apify, YouTube, Browserbase) converts its raw response into a
// NormalizedContentPost / NormalizedAd, which the ingestion layer upserts via the
// mkt_* RPCs (dedup + snapshots + attribution happen there, provider-agnostically).
// ============================================================================

export type ProviderKey = 'apify' | 'youtube' | 'browserbase';

export type Platform = 'instagram' | 'tiktok' | 'snapchat' | 'youtube' | 'x' | 'facebook';

/** Health states surfaced in the Collection Status UI (spec §4). */
export type ProviderHealth =
  | 'not_configured'
  | 'connected'
  | 'auth_failed'
  | 'rate_limited'
  | 'unavailable'
  | 'config_invalid';

export interface ProviderHealthResult {
  provider: ProviderKey;
  health: ProviderHealth;
  detail?: string;
  checkedAt: string; // ISO
}

export interface DiscoverAccountInput {
  platform: Platform;
  query: string; // handle, url, or channel name
}

export interface DiscoveredAccount {
  platform: Platform;
  handle: string;
  profileUrl?: string;
  externalAccountId?: string; // e.g. YouTube channelId, IG user pk
  displayName?: string;
  followers?: number;
  verified?: boolean;
}

export interface CollectAccountContentInput {
  platform: Platform;
  handle: string;
  externalAccountId?: string;
  /** Incremental cursor from the last run (e.g. uploads-playlist pageToken, or a since-date). */
  cursor?: string | null;
  /** Backfill = walk history; incremental = only new since cursor. */
  mode: 'incremental' | 'backfill';
  limit?: number;
}

/** Provider-agnostic post. `raw` is retained verbatim for reprocessing/debug. */
export interface NormalizedContentPost {
  platform: Platform;
  externalId: string;
  postUrl?: string;
  canonicalUrl?: string;
  postType?: 'image' | 'video' | 'carousel' | 'reel' | 'story' | 'short' | 'text' | 'unknown';
  caption?: string;
  lang?: string;
  publishedAt?: string; // ISO
  mediaRefs?: Array<{ kind: string; url: string; storagePath?: string }>;
  thumbnailRef?: string;
  durationMs?: number;
  hashtags?: string[];
  mentions?: string[];
  metrics?: NormalizedMetrics;
  contentHash?: string;
  raw: unknown;
}

export interface NormalizedMetrics {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  playCount?: number;
  followers?: number;
}

export interface CollectedContentBatch {
  provider: ProviderKey;
  posts: NormalizedContentPost[];
  nextCursor?: string | null;
  hasMore: boolean;
  /** Provider-reported cost/units when available (never fabricated). */
  cost?: Record<string, unknown>;
  rateLimit?: Record<string, unknown>;
}

export interface CollectContentMetricsInput {
  platform: Platform;
  posts: Array<{ externalId: string }>;
}

export interface CollectedMetricBatch {
  provider: ProviderKey;
  metrics: Array<{ externalId: string; metrics: NormalizedMetrics; raw: unknown }>;
}

export interface CollectAdsInput {
  platform: 'meta' | 'tiktok' | 'snapchat';
  advertiserQuery: string; // page name / id / keyword
}

export interface NormalizedAd {
  platform: 'meta' | 'tiktok' | 'snapchat';
  externalAdId: string;
  advertiserName?: string;
  creativeMediaRef?: string;
  creativeType?: string;
  headline?: string;
  body?: string;
  cta?: string;
  landingUrl?: string;
  platformStartedAt?: string;
  isActive?: boolean;
  reachInfo?: Record<string, unknown>; // only if publicly disclosed (EU) — else undefined
  raw: unknown;
}

export interface CollectedAdBatch {
  provider: ProviderKey;
  ads: NormalizedAd[];
  cost?: Record<string, unknown>;
}

export interface NormalizationContext {
  platform: Platform;
  handle?: string;
}

export type NormalizedMarketingRecord = NormalizedContentPost | NormalizedAd;

/**
 * Replaceable provider contract. The core system codes to THIS, never to a
 * specific provider. `collectAds` / `discoverAccount` are optional (not every
 * provider supports them).
 */
export interface MarketingIntelligenceProvider {
  readonly providerKey: ProviderKey;
  validateConnection(): Promise<ProviderHealthResult>;
  discoverAccount?(input: DiscoverAccountInput): Promise<DiscoveredAccount[]>;
  collectAccountContent(input: CollectAccountContentInput): Promise<CollectedContentBatch>;
  collectContentMetrics?(input: CollectContentMetricsInput): Promise<CollectedMetricBatch>;
  collectAds?(input: CollectAdsInput): Promise<CollectedAdBatch>;
  normalizeRawRecord(record: unknown, context: NormalizationContext): NormalizedMarketingRecord;
}

/** Thrown by providers to map cleanly onto a ProviderHealth state. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly health: ProviderHealth = 'unavailable',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
