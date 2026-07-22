// ============================================================================
// Provider registry — the single place the system resolves a provider by key.
// Core code depends on this, never on a concrete provider class (spec §3).
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MarketingIntelligenceProvider, ProviderKey, ProviderHealthResult } from './types';
import { YouTubeProvider } from './providers/youtube';
import { ApifyProvider, type ActorConfig } from './providers/apify';
import { BrowserbaseProvider } from './providers/browserbase';

/** Reads the DB actor registry (mkt_actor_configs) for the Apify provider. */
function makeActorResolver(svc: SupabaseClient) {
  return async (sourceType: string): Promise<ActorConfig | null> => {
    const { data, error } = await svc
      .from('mkt_actor_configs')
      .select('source_type, actor_id, result_parser, is_enabled')
      .eq('source_type', sourceType)
      .order('is_enabled', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return {
      sourceType: data.source_type as string,
      actorId: data.actor_id as string,
      resultParser: data.result_parser as string,
      isEnabled: Boolean(data.is_enabled),
    };
  };
}

/** Build the provider for a key. `svc` (service-role) is needed by Apify to read
 *  its actor registry; the worker additionally injects the Browserbase scraper. */
export function getProvider(key: ProviderKey, svc: SupabaseClient): MarketingIntelligenceProvider {
  switch (key) {
    case 'youtube': return new YouTubeProvider();
    case 'apify': return new ApifyProvider(makeActorResolver(svc));
    case 'browserbase': return new BrowserbaseProvider(); // worker injects scrapeFn
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
