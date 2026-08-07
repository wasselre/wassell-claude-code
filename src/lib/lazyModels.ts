// ─────────────────────────────────────────────────────────────────
// Large-model load strategies
//
// Most models are loaded in full into memory at boot (the legacy
// `records[modelId]` slice). A few models are too large to ride in the
// main `unified_records` boot payload (which gates the clients /
// followups / units data tail), so they're EXCLUDED from that load and
// handled by one of two strategies:
//
//   • SUMMARY models — a slim projection of EVERY row is loaded into the
//     normal in-memory `records[modelId]` slice in the BACKGROUND, after
//     the app is interactive. The list page then browses/searches/filters
//     all rows client-side exactly like a normal model; the heavy
//     per-record fields are fetched on-demand when a single record is
//     opened. Used by `market_listings` (~46k rows, ~31MB slim vs ~105MB
//     full).
//
//   • LAZY models — rows are NEVER materialized in bulk; they're paged in
//     on demand via the `record_search` RPC + the `recordsByModel`
//     paginated cache + a "Load more" UI. This machinery is kept in place
//     (dormant — no model routes through it today) for a future
//     truly-huge model where even a slim full set is too much.
//
// Both strategies share ONE thing: their rows are excluded from the main
// boot load (`bootExcludedModelIds`). Everything else branches on the
// per-strategy predicate. Non-lazy, non-summary models behave 100%
// identically to before.
// ─────────────────────────────────────────────────────────────────

/** Model `name` slugs loaded as a SLIM full set into the normal store,
 *  in the background after boot. (market_listings: all ~46k rows.) */
export const SUMMARY_MODEL_NAMES = new Set<string>(['market_listings']);

/** Model `name` slugs paged in on demand via record_search (no model
 *  uses this today — the machinery is kept for a future huge model). */
export const LAZY_MODEL_NAMES = new Set<string>([]);

// ─── Summary models ──────────────────────────────────────────────

/** True if a model NAME loads as a background slim full set. Null-safe. */
export function isSummaryModelName(name?: string | null): boolean {
  return !!name && SUMMARY_MODEL_NAMES.has(name);
}

/** True if a model loads as a background slim full set. Accepts any
 *  object carrying a `name`. Null-safe. */
export function isSummaryModel(model?: { name?: string } | null): boolean {
  return isSummaryModelName(model?.name);
}

/** The view name the slim full set is loaded FROM for a summary model.
 *  One deterministic projection view per summary model. */
export function summaryViewName(modelName: string): string {
  return `${modelName}_summary`;
}

/** The exact keys present in the slim `data` of a summary record. The
 *  realtime path slims incoming full rows down to these so the in-memory
 *  store never accumulates heavy fields. MUST stay in sync with the
 *  `<model>_summary` view's `jsonb_build_object(...)` projection. */
export const SUMMARY_DATA_KEYS: Readonly<Record<string, readonly string[]>> = {
  market_listings: [
    'external_id', 'source', 'title', 'listing_type', 'category', 'property_type',
    'price', 'price_per_m2', 'area', 'bedrooms', 'bathrooms',
    // Geography lives in the nested `location` object ({city, region, district}
    // record ids) since the 2026-06-28 geography migration — the old flat
    // district_lookup / city_lookup / region_lookup keys were stripped.
    'location', 'latitude', 'longitude',
    'is_active', 'main_image_url', 'advertiser_name', 'image_count', 'video_count',
    // Advertiser-contact enrichment (REGA lookup, 2026-07-01): the phone + the
    // lookup lifecycle must ride in the slim store so the ContactAdvertiserPanel
    // sees a cached phone on load AND the worker's write via Realtime. Small
    // (null for ~all rows). Keep in sync with the market_listings_summary view.
    'advertiser_phone', 'rega_lookup_status', 'rega_lookup_error', 'rega_lookup_at',
    // Lookup → the advertisers module record (2026-07-01). In the slim store so
    // the list view can show/link the advertiser. Keep in sync with the view.
    'advertiser',
    // Listing quality (2026-07-02): DB-computed score/grade (see
    // market_listing_quality() in the quality-score migration). The grade is a
    // show_in_table dropdown → the list renders it as a colored chip, so both
    // must ride the slim store + realtime. Keep in sync with the view.
    'quality_score', 'quality_grade',
    // Duplicate grouping: the same property is advertised by several brokers at
    // once, so the list collapses rows sharing a `dupe_group_id` into one card.
    // All three must ride the slim store — the grouping happens client-side over
    // the in-memory summary set, so a key that isn't in the projection means no
    // grouping at all (that is exactly what silently broke when the model was
    // frozen on 2026-08-07 and the old `property_key` column went away).
    // `dupe_split` is the user's "show these separately" override.
    'dupe_group_id', 'dupe_role', 'dupe_split',
  ],
};

/** Project a full record's `data` down to its summary keys. Returns the
 *  input unchanged when the model has no declared summary key set (so a
 *  misconfiguration fails open, not silently empty). */
export function slimSummaryData(
  modelName: string | undefined | null,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const keys = modelName ? SUMMARY_DATA_KEYS[modelName] : undefined;
  if (!keys) return data;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in data) out[k] = data[k];
  }
  return out;
}

// ─── Lazy models ─────────────────────────────────────────────────

/** True if a model NAME is paged in on demand. Null-safe. */
export function isLazyModelName(name?: string | null): boolean {
  return !!name && LAZY_MODEL_NAMES.has(name);
}

/** True if a model is paged in on demand. Accepts any object carrying a
 *  `name`. Null-safe. */
export function isLazyModel(model?: { name?: string } | null): boolean {
  return isLazyModelName(model?.name);
}

// ─── Shared: boot exclusion ──────────────────────────────────────

/** Ids of every model that must be EXCLUDED from the bulk boot
 *  `unified_records` load — both summary (background slim-loaded) and
 *  lazy (on-demand paged) models. Keeps their rows out of the main
 *  records tail that gates the rest of the app's data. */
export function bootExcludedModelIds(models: { id: string; name: string }[]): string[] {
  return models
    .filter((m) => isSummaryModelName(m.name) || isLazyModelName(m.name))
    .map((m) => m.id);
}

/** @deprecated kept as an alias for the boot exclusion — the original
 *  lazy-only name. Use `bootExcludedModelIds`. */
export const lazyModelIds = bootExcludedModelIds;
