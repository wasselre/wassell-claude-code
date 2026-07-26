// Pure display helpers over the mkt_project_intelligence() payload.
//
// The SERVER is the source of truth for every number — these functions only
// derive presentation-level summaries (who, dominant platform, price direction)
// and must never recompute a metric the RPC already returns. Keeping them pure
// makes the page's headline claims unit-testable without a database.
import type { ProjectIntelligence, PIFactType } from './client';

export type PriceDirection = 'rising' | 'falling' | 'flat' | 'unknown';

export interface ProjectIntelligenceSummary {
  developers: string[];
  marketers: string[];
  confirmedPosts: number;
  speculativePosts: number;
  /** True when attributions are waiting on review. The page must SAY so —
   *  a project showing 7 posts while 105 sit unreviewed is a different claim
   *  from a project that genuinely has 7. */
  hasSpeculativeBacklog: boolean;
  priceRange: { min: number; max: number } | null;
  priceDirection: PriceDirection;
  dominantPlatform: { platform: string; share_pct: number } | null;
}

const ROLE_MARKETER = new Set(['authorized_marketer', 'observed_marketer']);

export function projectIntelligenceSummary(d: ProjectIntelligence): ProjectIntelligenceSummary {
  const named = (r: (role: string) => boolean) =>
    [...new Set(d.organizations.filter((o) => r(o.role)).map((o) => o.name).filter((n): n is string => !!n))];

  const prices = d.trends.price.filter((p) => p.min != null || p.max != null);
  const mins = prices.map((p) => p.min).filter((v): v is number => v != null);
  const maxs = prices.map((p) => p.max).filter((v): v is number => v != null);
  // Absent must stay absent — a 0 here would read as "free".
  const priceRange = mins.length && maxs.length
    ? { min: Math.min(...mins), max: Math.max(...maxs) }
    : null;

  let priceDirection: PriceDirection = 'unknown';
  if (prices.length >= 2) {
    const first = prices[0]!.avg ?? prices[0]!.min ?? null;
    const last = prices[prices.length - 1]!.avg ?? prices[prices.length - 1]!.min ?? null;
    if (first != null && last != null) {
      priceDirection = last > first ? 'rising' : last < first ? 'falling' : 'flat';
    }
  }

  const top = [...d.trends.platforms].sort((a, b) => (b.share_pct ?? 0) - (a.share_pct ?? 0))[0];

  return {
    developers: named((r) => r === 'developer'),
    marketers: named((r) => ROLE_MARKETER.has(r)),
    confirmedPosts: d.attribution_quality.confirmed_posts,
    speculativePosts: d.attribution_quality.speculative_posts,
    hasSpeculativeBacklog: d.attribution_quality.speculative_posts > 0,
    priceRange,
    priceDirection,
    dominantPlatform: top ? { platform: top.platform, share_pct: top.share_pct ?? 0 } : null,
  };
}

/** Fact families that actually carry values, in the payload's own order. */
export function factsPresent(d: ProjectIntelligence): PIFactType[] {
  return (Object.keys(d.facts) as PIFactType[]).filter((k) => (d.facts[k]?.length ?? 0) > 0);
}

/** True when a capped list is hiding rows, so the UI can say "showing N of M". */
export function isTruncated(list: { total: number; shown: number }): boolean {
  return list.total > list.shown;
}

// ── Organization Intelligence helpers ───────────────────────────────────────
import type { OrganizationIntelligence } from './client';

export type Trend = 'up' | 'down' | 'flat' | 'unknown';

export interface OrganizationIntelligenceSummary {
  /** Roles the org actually holds, e.g. ['developer','authorized_marketer'].
   *  An org can hold several — 9 do in production. */
  roles: string[];
  projectCount: number;
  postingTrend: Trend;
  postingChangePct: number | null;
  activeAds: number;
  /** null when growth is not yet measurable — NEVER 0, which would read as
   *  "flat" when the truth is "we cannot see it yet". */
  followerChange: number | null;
  growthMeasurable: boolean;
  dominantPlatform: { platform: string; share_pct: number } | null;
  /** True when content exists but has not been through OCR/enrichment, so an
   *  empty facts section is a processing gap, not advertiser silence. */
  hasUnprocessedContent: boolean;
}

export function organizationIntelligenceSummary(d: OrganizationIntelligence): OrganizationIntelligenceSummary {
  const pct = d.posting_frequency.change_pct;
  let postingTrend: Trend = 'unknown';
  if (pct != null) postingTrend = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';

  const top = [...d.trends.platforms].sort((a, b) => (b.share_pct ?? 0) - (a.share_pct ?? 0))[0];

  return {
    roles: Object.keys(d.roles ?? {}).filter((r) => (d.roles[r] ?? 0) > 0),
    projectCount: d.projects.total,
    postingTrend,
    postingChangePct: pct,
    activeAds: d.ads.active,
    followerChange: d.audience.growth_measurable ? d.audience.net_change : null,
    growthMeasurable: d.audience.growth_measurable,
    dominantPlatform: top ? { platform: top.platform, share_pct: top.share_pct ?? 0 } : null,
    hasUnprocessedContent: d.coverage.content_unprocessed_posts > 0,
  };
}
