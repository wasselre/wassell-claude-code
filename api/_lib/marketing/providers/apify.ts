// ============================================================================
// Apify provider (API side) — HEALTH-ONLY.
// ----------------------------------------------------------------------------
// Apify COLLECTION runs exclusively in the worker (worker/src/marketing/
// apifyLifecycle.ts is the ONE implementation of start→poll→dataset). This API-
// side provider only validates the connection for the Collection Status UI; its
// collect/normalize paths throw "runs in the worker" (same posture as the
// Browserbase provider) so there is never a second, divergent lifecycle.
// APIFY_API_TOKEN is read server-side and never returned to any caller.
// ============================================================================
import type {
  MarketingIntelligenceProvider,
  ProviderHealthResult,
  CollectAccountContentInput,
  CollectedContentBatch,
  NormalizedMarketingRecord,
  NormalizationContext,
} from '../types';
import { ProviderError } from '../types';

const APIFY = 'https://api.apify.com/v2';

function token(): string {
  const t = process.env.APIFY_API_TOKEN;
  if (!t) throw new ProviderError('APIFY_API_TOKEN not set', 'not_configured');
  return t;
}

export class ApifyProvider implements MarketingIntelligenceProvider {
  readonly providerKey = 'apify' as const;

  async validateConnection(): Promise<ProviderHealthResult> {
    const checkedAt = new Date().toISOString();
    if (!process.env.APIFY_API_TOKEN) return { provider: 'apify', health: 'not_configured', checkedAt };
    try {
      const res = await fetch(`${APIFY}/users/me`, { headers: { Authorization: `Bearer ${token()}` } });
      if (res.status === 401) return { provider: 'apify', health: 'auth_failed', detail: 'invalid token', checkedAt };
      if (res.status === 429) return { provider: 'apify', health: 'rate_limited', checkedAt };
      if (!res.ok) return { provider: 'apify', health: 'unavailable', detail: `HTTP ${res.status}`, checkedAt };
      return { provider: 'apify', health: 'connected', checkedAt };
    } catch (e) {
      return { provider: 'apify', health: 'unavailable', detail: e instanceof Error ? e.message : String(e), checkedAt };
    }
  }

  async collectAccountContent(_input: CollectAccountContentInput): Promise<CollectedContentBatch> {
    throw new ProviderError('Apify collection runs in the worker (worker/src/marketing/apifyLifecycle.ts)', 'unavailable');
  }

  normalizeRawRecord(_record: unknown, _ctx: NormalizationContext): NormalizedMarketingRecord {
    throw new ProviderError('Apify normalization runs in the worker', 'unavailable');
  }
}
