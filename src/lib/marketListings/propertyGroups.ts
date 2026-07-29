import type { AppRecord } from '@/types';

/**
 * One property, many broker listings.
 *
 * The same physical property is advertised by several agents at once and each ad
 * is its own row — deed 717823000238 (a 750 m² plot in الخير) is five rows held
 * by five different brokers asking 975,000 to 1,100,002. Showing five listings
 * for one plot inflates every count on the page and buries the fact that the
 * real asking-price anchor is the lowest of the five.
 *
 * The grouping KEY is computed in Postgres (`market_listing_property_identity`),
 * not here — see supabase/migrations/2026-08-30_01_market_listings_property_identity.sql
 * for why it is deed+area+coords (tier 2) or coords+area (tier 3) and why
 * property_type is deliberately not part of it. This module only collapses rows
 * that already agree on that key.
 *
 * NOTHING IS DELETED. The collapsed members travel with the representative row
 * so the UI can show the agent count, the price spread, and offer a split.
 */

/** A set of listings the database resolved to the same physical property. */
export interface PropertyGroup {
  /** The shared `property_key`. */
  key: string;
  /**
   * How the key was resolved — drives how confident the UI is allowed to sound.
   *   1 = same REGA advertisement licence (certain; cross-portal syndication)
   *   2 = same deed + area + coordinates (high confidence)
   *   3 = same coordinates + area, no deed (~88% precise — label it, offer a split)
   */
  tier: 1 | 2 | 3;
  /** Every listing in the group, representative FIRST. */
  members: AppRecord[];
  /** Distinct advertiser names; falls back to member count when names are blank. */
  agentCount: number;
  priceMin: number | null;
  priceMax: number | null;
}

export interface GroupedRecords {
  /** One row per property: the representative, plus every ungrouped listing. */
  rows: AppRecord[];
  /** Keyed by REPRESENTATIVE record id. Only ever holds groups of 2+. */
  groups: Map<string, PropertyGroup>;
  /** How many rows the collapse removed from `rows`. */
  collapsed: number;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toTier(v: unknown): 1 | 2 | 3 {
  const n = toNumber(v);
  return n === 1 || n === 2 ? n : 3;
}

/**
 * Collapse listings that share a `property_key` into one representative row.
 *
 * Order is preserved: the representative is whichever member came FIRST in the
 * incoming (already sorted + filtered) list, so the caller's sort still decides
 * where a property lands on the page. Callers must therefore group AFTER sorting.
 *
 * A listing opts out of grouping when the user has split it (`property_split`)
 * or when the database could not key it (no deed and no usable coordinates —
 * `property_key` is null). Both cases render as ordinary standalone rows.
 */
export function groupRecordsByProperty(records: AppRecord[]): GroupedRecords {
  const byKey = new Map<string, AppRecord[]>();
  const rows: AppRecord[] = [];

  for (const rec of records) {
    const data = rec.data as Record<string, unknown>;
    const key = typeof data.property_key === 'string' && data.property_key ? data.property_key : null;
    // `property_split` is the user's explicit "these are not the same property"
    // decision, persisted per listing by market_listing_set_split().
    if (!key || data.property_split === true) {
      rows.push(rec);
      continue;
    }
    const existing = byKey.get(key);
    if (existing) {
      existing.push(rec);
      continue;
    }
    byKey.set(key, [rec]);
    rows.push(rec); // first member seen becomes the representative, in place
  }

  const groups = new Map<string, PropertyGroup>();
  let collapsed = 0;
  for (const [key, members] of byKey) {
    const rep = members[0];
    if (!rep || members.length < 2) continue; // a lone listing is not a group
    collapsed += members.length - 1;
    const prices = members
      .map((m) => toNumber((m.data as Record<string, unknown>).price))
      .filter((n): n is number => n !== null);
    const agents = new Set(
      members
        .map((m) => String((m.data as Record<string, unknown>).advertiser_name ?? '').trim())
        .filter(Boolean),
    );
    groups.set(rep.id, {
      key,
      tier: toTier((rep.data as Record<string, unknown>).property_tier),
      members,
      agentCount: agents.size || members.length,
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
    });
  }

  return { rows, groups, collapsed };
}
