// ============================================================================
// Browserbase provider — FALLBACK only (spec §10). Wraps the proven Browserbase
// + cookies + SA-residential-proxy scraper as a provider adapter so its output
// flows through the SAME normalize → dedup → attribute → snapshot path as every
// other provider. It NEVER writes legacy fields (e.g. project_videos) directly.
//
// The heavy scraping runs in the Fly worker (long-lived Browserbase sessions),
// so the actual collector is INJECTED (`scrapeFn`) by the worker. In the API
// layer this class validates config + declares the contract; calling
// collectAccountContent without an injected scraper throws a clear error rather
// than pretending to work. Do NOT auto-loop this provider (cost control).
// ============================================================================
import type {
  MarketingIntelligenceProvider,
  ProviderHealthResult,
  CollectAccountContentInput,
  CollectedContentBatch,
  NormalizedContentPost,
  NormalizedMarketingRecord,
  NormalizationContext,
} from '../types';
import { ProviderError } from '../types';
import { withDedupKeys } from '../normalize';

/** Injected by the worker: runs a real Browserbase session and returns raw posts. */
export type BrowserbaseScrapeFn = (
  input: CollectAccountContentInput,
) => Promise<{ posts: NormalizedContentPost[]; raw?: unknown }>;

export class BrowserbaseProvider implements MarketingIntelligenceProvider {
  readonly providerKey = 'browserbase' as const;
  constructor(private readonly scrapeFn?: BrowserbaseScrapeFn) {}

  async validateConnection(): Promise<ProviderHealthResult> {
    const checkedAt = new Date().toISOString();
    const ok = Boolean(process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID);
    return {
      provider: 'browserbase',
      health: ok ? 'connected' : 'not_configured',
      detail: ok ? undefined : 'BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set',
      checkedAt,
    };
  }

  async collectAccountContent(input: CollectAccountContentInput): Promise<CollectedContentBatch> {
    if (!this.scrapeFn) {
      throw new ProviderError(
        'Browserbase collection runs in the worker; inject a scrapeFn. (Fallback provider — not auto-invoked.)',
        'unavailable',
      );
    }
    const { posts } = await this.scrapeFn(input);
    // Ensure dedup keys even if the scraper didn't set them.
    const normalized = posts.map((p) => withDedupKeys(p, input.handle));
    return { provider: 'browserbase', posts: normalized, hasMore: false, nextCursor: null };
  }

  normalizeRawRecord(record: unknown, _ctx: NormalizationContext): NormalizedMarketingRecord {
    // Browserbase scrapers already emit NormalizedContentPost-shaped objects.
    return withDedupKeys(record as NormalizedContentPost, _ctx.handle);
  }
}
