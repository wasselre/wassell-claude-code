// ============================================================================
// Apify provider foundation — primary collector for IG/TikTok/FB + Meta ads.
// ----------------------------------------------------------------------------
// Actor IDs are NEVER hardcoded: they live in the DB (mkt_actor_configs) and are
// resolved per source_type via an injected `resolveActor`. This class owns the
// mechanics (start run → poll → read dataset → parse → normalize) + health.
// Parsers are named (matching mkt_actor_configs.result_parser) so a config change
// swaps actors without code edits, as long as the named parser exists here.
//
// Operational once APIFY_API_TOKEN is set AND an actor config is enabled + vetted.
// The parsers below map the common public-field shapes of the widely-used actors;
// they must be validated against live dataset output before enabling in prod
// (documented in docs/marketing-intelligence-design.md).
// ============================================================================
import type {
  MarketingIntelligenceProvider,
  ProviderHealthResult,
  CollectAccountContentInput,
  CollectedContentBatch,
  NormalizedContentPost,
  NormalizedMarketingRecord,
  NormalizationContext,
  Platform,
} from '../types';
import { ProviderError } from '../types';
import { withDedupKeys } from '../normalize';

const APIFY = 'https://api.apify.com/v2';

export interface ActorConfig {
  sourceType: string; // 'instagram_profile' | 'tiktok_profile' | 'facebook_posts' | 'meta_ads'
  actorId: string;
  resultParser: string;
  isEnabled: boolean;
}

/** Injected by the caller — reads mkt_actor_configs (DB registry). */
export type ResolveActor = (sourceType: string) => Promise<ActorConfig | null>;

function token(): string {
  const t = process.env.APIFY_API_TOKEN;
  if (!t) throw new ProviderError('APIFY_API_TOKEN not set', 'not_configured');
  return t;
}

async function apify<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${APIFY}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new ProviderError('Apify auth failed (401)', 'auth_failed');
  if (res.status === 429) throw new ProviderError('Apify rate limited (429)', 'rate_limited');
  if (!res.ok) throw new ProviderError(`Apify ${res.status}: ${(await res.text()).slice(0, 200)}`, 'unavailable');
  return (await res.json()) as T;
}

// ── source_type per platform (which actor family to use) ────────────────────
function sourceTypeFor(platform: Platform): string {
  switch (platform) {
    case 'instagram': return 'instagram_profile';
    case 'tiktok': return 'tiktok_profile';
    case 'facebook': return 'facebook_posts';
    default: throw new ProviderError(`Apify: no actor family for platform ${platform}`, 'config_invalid');
  }
}

// ── Input builders (keyed by source_type) ───────────────────────────────────
function buildInput(sourceType: string, handle: string, limit: number): Record<string, unknown> {
  switch (sourceType) {
    case 'instagram_profile':
      return { directUrls: [`https://www.instagram.com/${handle}/`], resultsType: 'posts', resultsLimit: limit };
    case 'tiktok_profile':
      return { profiles: [handle], resultsPerPage: limit, shouldDownloadVideos: false };
    case 'facebook_posts':
      return { startUrls: [{ url: `https://www.facebook.com/${handle}` }], maxPosts: limit };
    default:
      return { handle, limit };
  }
}

// ── Named parsers (must match mkt_actor_configs.result_parser) ──────────────
// Map an actor dataset item → NormalizedContentPost. Field names follow the
// common public output of the seeded candidate actors; validate vs live output.
type Parser = (item: Record<string, unknown>, handle: string) => NormalizedContentPost | null;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && v ? Number(v) : undefined);

const PARSERS: Record<string, Parser> = {
  parseInstagramPosts: (it, handle) => {
    const id = str(it.id) ?? str(it.shortCode) ?? str(it.code);
    if (!id) return null;
    const isVideo = it.type === 'Video' || Boolean(it.videoUrl);
    return withDedupKeys({
      platform: 'instagram',
      externalId: id,
      postUrl: str(it.url) ?? (str(it.shortCode) ? `https://www.instagram.com/p/${it.shortCode}/` : undefined),
      postType: it.productType === 'clips' ? 'reel' : isVideo ? 'video' : it.type === 'Sidecar' ? 'carousel' : 'image',
      caption: str(it.caption),
      publishedAt: str(it.timestamp),
      thumbnailRef: str(it.displayUrl) ?? str(it.thumbnailUrl),
      mediaRefs: str(it.videoUrl) ? [{ kind: 'video', url: it.videoUrl as string }] : str(it.displayUrl) ? [{ kind: 'image', url: it.displayUrl as string }] : [],
      hashtags: Array.isArray(it.hashtags) ? (it.hashtags as string[]) : [],
      metrics: { likes: num(it.likesCount), comments: num(it.commentsCount), views: num(it.videoViewCount) },
      raw: it,
    }, handle);
  },
  parseTiktokVideos: (it, handle) => {
    const id = str(it.id);
    if (!id) return null;
    return withDedupKeys({
      platform: 'tiktok',
      externalId: id,
      postUrl: str(it.webVideoUrl) ?? `https://www.tiktok.com/@${handle}/video/${id}`,
      postType: 'video',
      caption: str(it.text) ?? str(it.description),
      publishedAt: typeof it.createTimeISO === 'string' ? it.createTimeISO : undefined,
      thumbnailRef: str((it.videoMeta as Record<string, unknown> | undefined)?.coverUrl),
      durationMs: num((it.videoMeta as Record<string, unknown> | undefined)?.duration) != null ? num((it.videoMeta as Record<string, unknown>).duration)! * 1000 : undefined,
      metrics: { views: num(it.playCount), likes: num(it.diggCount), comments: num(it.commentCount), shares: num(it.shareCount), saves: num(it.collectCount) },
      raw: it,
    }, handle);
  },
  parseFacebookPosts: (it, handle) => {
    const id = str(it.postId) ?? str(it.id);
    if (!id) return null;
    return withDedupKeys({
      platform: 'facebook',
      externalId: id,
      postUrl: str(it.url) ?? str(it.postUrl),
      postType: str(it.type) === 'video' ? 'video' : 'image',
      caption: str(it.text) ?? str(it.message),
      publishedAt: str(it.time) ?? str(it.date),
      thumbnailRef: str(it.thumbnail),
      metrics: { likes: num(it.likes), comments: num(it.comments), shares: num(it.shares) },
      raw: it,
    }, handle);
  },
};

export class ApifyProvider implements MarketingIntelligenceProvider {
  readonly providerKey = 'apify' as const;
  constructor(private readonly resolveActor: ResolveActor) {}

  async validateConnection(): Promise<ProviderHealthResult> {
    const checkedAt = new Date().toISOString();
    if (!process.env.APIFY_API_TOKEN) return { provider: 'apify', health: 'not_configured', checkedAt };
    try {
      await apify<unknown>('GET', '/users/me');
      return { provider: 'apify', health: 'connected', checkedAt };
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError(String(e));
      return { provider: 'apify', health: err.health, detail: err.message, checkedAt };
    }
  }

  async collectAccountContent(input: CollectAccountContentInput): Promise<CollectedContentBatch> {
    const sourceType = sourceTypeFor(input.platform);
    const actor = await this.resolveActor(sourceType);
    if (!actor) throw new ProviderError(`No actor configured for ${sourceType}`, 'config_invalid');
    if (!actor.isEnabled) throw new ProviderError(`Actor for ${sourceType} is disabled (vet + enable in mkt_actor_configs)`, 'config_invalid');
    const parser = PARSERS[actor.resultParser];
    if (!parser) throw new ProviderError(`No parser named "${actor.resultParser}"`, 'config_invalid');

    const limit = input.limit ?? 50;
    const runInput = buildInput(sourceType, input.handle, limit);

    // Start a synchronous run that returns dataset items directly (bounded).
    // For large backfills switch to async runs + webhook (design §8) — same parser.
    const items = await apify<Array<Record<string, unknown>>>(
      'POST',
      `/acts/${actor.actorId.replace('/', '~')}/run-sync-get-dataset-items`,
      runInput,
    );
    const posts = items.map((it) => parser(it, input.handle)).filter((p): p is NormalizedContentPost => p !== null);
    return { provider: 'apify', posts, hasMore: false, nextCursor: null };
  }

  normalizeRawRecord(record: unknown, ctx: NormalizationContext): NormalizedMarketingRecord {
    const sourceType = sourceTypeFor(ctx.platform);
    // Best-effort: use the parser matching the platform's default actor family.
    const name = sourceType === 'instagram_profile' ? 'parseInstagramPosts'
      : sourceType === 'tiktok_profile' ? 'parseTiktokVideos' : 'parseFacebookPosts';
    const parsed = PARSERS[name]?.(record as Record<string, unknown>, ctx.handle ?? '');
    if (!parsed) throw new ProviderError('Apify normalize: unparseable record', 'unavailable');
    return parsed;
  }
}
