import type { AppRecord } from '@/types';

/**
 * One property, many broker listings.
 *
 * The same physical property is advertised by several agents at once and each ad
 * is its own row — one 312 m² plot in Riyadh is four rows held by three brokers
 * asking 2,800,000 to 3,000,000. Showing four listings for one plot inflates
 * every count on the page and buries the fact that the real asking-price anchor
 * is the lowest of them.
 *
 * The grouping KEY is computed in Postgres and stored on `dupe_group_id`; this
 * module only collapses rows that already agree on it. Two producers fill it:
 *
 *   pk_<permit>            the importer, for the UAE portals (bayut, dubizzle,
 *                          propertyfinder) — keyed on the RERA permit number, so
 *                          groups legitimately span sources.
 *   dn_<deed>_<area>_<lat>_<lng>   Aqar, deed-based (see
 *   ga_<lat>_<lng>_<area>          market_listing_aqar_dupe_key, and
 *                          supabase/migrations/2026-08-08_01_market_listings_aqar_dupe_groups.sql
 *                          for why the key is shaped that way).
 *
 * NOTHING IS DELETED. The collapsed members travel with the representative row
 * so the UI can show the agent count, the price spread, and offer a split.
 */

/** A set of listings the database resolved to the same physical property. */
export interface PropertyGroup {
  /** The shared `dupe_group_id`. */
  key: string;
  /**
   * How confident the key is, derived from its prefix — drives how the UI is
   * allowed to describe the group.
   *   2 = an official identifier behind it (RERA permit / title deed) — confirmed
   *   3 = coordinates + area only, no identifier (~88% precise) — probable,
   *       so the UI labels it and offers a split
   */
  tier: 2 | 3;
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

/**
 * Confidence from the key's producer. Only the coordinates+area fallback is a
 * guess; a permit or a deed number is an official identifier for the property.
 * Unknown prefixes are treated as confirmed — a future importer keying on some
 * other registry id shouldn't be labelled "probable" by default.
 */
function tierForKey(key: string): 2 | 3 {
  return key.startsWith('ga_') ? 3 : 2;
}

/**
 * Collapse listings that share a `dupe_group_id` into one representative row.
 *
 * Order is preserved: the representative is whichever member came FIRST in the
 * incoming (already sorted + filtered) list, so the caller's sort still decides
 * where a property lands on the page. Callers must therefore group AFTER sorting.
 * `dupe_role` ('canonical'/'duplicate') is deliberately NOT used to pick the
 * representative — honouring the user's sort matters more than showing the row
 * the database happened to mark canonical.
 *
 * A listing opts out of grouping when the user has split it (`dupe_split`) or
 * when the database could not key it (no identifier and no usable coordinates —
 * `dupe_group_id` is null). Both render as ordinary standalone rows.
 */
export function groupRecordsByProperty(records: AppRecord[]): GroupedRecords {
  const byKey = new Map<string, AppRecord[]>();
  const rows: AppRecord[] = [];

  for (const rec of records) {
    const data = rec.data as Record<string, unknown>;
    const key =
      typeof data.dupe_group_id === 'string' && data.dupe_group_id ? data.dupe_group_id : null;
    // `dupe_split` is the user's explicit "these are not the same property"
    // decision, persisted per listing by market_listing_set_split().
    if (!key || data.dupe_split === true) {
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
      tier: tierForKey(key),
      members,
      agentCount: agents.size || members.length,
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
    });
  }

  return { rows, groups, collapsed };
}
