// ─────────────────────────────────────────────────────────────────
// Lazy-loaded models
//
// Most models are loaded in full into memory at boot (the legacy
// `records[modelId]` slice). A handful of models are too large for
// that — they're "lazy": their rows NEVER enter the boot payload and
// are instead paged in on demand via the `record_search` RPC + the
// `recordsByModel` paginated cache.
//
// Everything in the app branches on the single predicate `isLazyModel`
// (or `isLazyModelName`). Non-lazy models behave 100% identically to
// before; only models listed here take the on-demand path.
//
// This is intentionally a small, explicit allow-list rather than a
// row-count heuristic — promoting a model to lazy is a deliberate
// decision (the LIST page loses client-side range/OR filters + full
// client sort for that model; the map shows only loaded rows). See the
// market_listings lazy-loading work for the full set of consequences.
// ─────────────────────────────────────────────────────────────────

/** Model `name` slugs that are loaded lazily (on-demand pagination)
 *  instead of fully into memory at boot. */
export const LAZY_MODEL_NAMES = new Set<string>(['market_listings']);

/** True if a model NAME is in the lazy allow-list. Safe on
 *  undefined/null (returns false). */
export function isLazyModelName(name?: string | null): boolean {
  return !!name && LAZY_MODEL_NAMES.has(name);
}

/** True if a model is lazy-loaded. Safe on undefined/null (returns
 *  false). Accepts any object carrying a `name` so callers can pass a
 *  full AppModel or a lightweight `{ name }`. */
export function isLazyModel(model?: { name?: string } | null): boolean {
  return isLazyModelName(model?.name);
}

/** The ids of every lazy model present in the given models list. Used
 *  at boot to exclude their rows from the bulk `unified_records` load. */
export function lazyModelIds(models: { id: string; name: string }[]): string[] {
  return models.filter((m) => isLazyModelName(m.name)).map((m) => m.id);
}
