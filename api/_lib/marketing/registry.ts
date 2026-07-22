// ============================================================================
// Provider registry — the single place the system resolves a provider by key.
// Core code depends on this, never on a concrete provider class (spec §3).
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MarketingIntelligenceProvider, ProviderKey, ProviderHealthResult } from './types';
import { YouTubeProvider } from './providers/youtube';
import { ApifyProvider } from './providers/apify';
import { BrowserbaseProvider } from './providers/browserbase';

/** Build the provider for a key. The API-side providers are HEALTH-ONLY for
 *  Apify/Browserbase (collection runs in the worker); only YouTube collects here. */
export function getProvider(key: ProviderKey, _svc: SupabaseClient): MarketingIntelligenceProvider {
  switch (key) {
    case 'youtube': return new YouTubeProvider();
    case 'apify': return new ApifyProvider();          // health-only; lifecycle is worker-side
    case 'browserbase': return new BrowserbaseProvider(); // health-only; worker injects scrapeFn
    default: throw new Error(`Unknown provider: ${key}`);
  }
}

export const ALL_PROVIDERS: ProviderKey[] = ['youtube', 'apify', 'browserbase'];

/** Validate every provider + persist health into mkt_providers (Collection Status UI). */
export async function refreshAllProviderHealth(svc: SupabaseClient): Promise<ProviderHealthResult[]> {
  const results: ProviderHealthResult[] = [];
  for (const key of ALL_PROVIDERS) {
    const provider = getProvider(key, svc);
    const health = await provider.validateConnection();
    results.push(health);
    await svc
      .from('mkt_providers')
      .update({ health_status: health.health, health_detail: health.detail ?? null, last_checked_at: health.checkedAt })
      .eq('provider_key', key);
  }
  return results;
}
