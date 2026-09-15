/**
 * Pure parsing for Anthropic's Usage & Cost Admin API cost report.
 *
 * Split out from the fetcher so the part that is easy to get wrong — the unit
 * conversion — is testable without an Admin API key or a network call.
 *
 * Endpoint: GET https://api.anthropic.com/v1/organizations/cost_report
 * Docs:     https://platform.claude.com/docs/en/manage-claude/usage-cost-api
 *
 * THE UNIT TRAP, stated once so nobody re-derives it wrong: `amount` is a
 * decimal string in the currency's LOWEST UNIT. The API reference spells it
 * out — `"123.45"` in `"USD"` is $1.2345, i.e. cents, NOT dollars. Reading it
 * as dollars overstates every figure by 100x, and a 100x error in a cost
 * report is the kind that gets believed because it is too big to look like a
 * rounding bug.
 */

/** Anthropic reports cents; everything downstream of here is dollars. */
export const CENTS_PER_DOLLAR = 100;

/**
 * Convert one `results[]` item into the shape ai_vendor_cost_replace_day takes.
 * Returns null for an item whose amount cannot be read, rather than silently
 * contributing zero to a total someone will act on.
 */
export function normalizeCostItem(item) {
  if (!item || typeof item !== 'object') return null;

  const raw = item.amount;
  const cents = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return null;

  return {
    amount_usd: cents / CENTS_PER_DOLLAR,
    currency: item.currency ?? 'USD',
    model: item.model ?? null,
    cost_type: item.cost_type ?? null,
    token_type: item.token_type ?? null,
    service_tier: item.service_tier ?? null,
    workspace_id: item.workspace_id ?? null,
    raw: item,
  };
}

/**
 * Turn one page of the cost report into per-day row sets.
 *
 * Buckets are keyed by `starting_at`; the API returns one bucket per interval
 * INCLUDING empty ones, and an empty bucket is meaningful — it says the vendor
 * charged nothing that day, which is different from not having asked. Those
 * come back with an empty `rows` array so the caller still replaces the day.
 */
export function parseCostReportPage(body) {
  if (!body || !Array.isArray(body.data)) {
    throw new Error('cost_report: response has no `data` array');
  }
  const days = [];
  for (const bucket of body.data) {
    const startedAt = bucket?.starting_at;
    if (typeof startedAt !== 'string' || !startedAt) {
      throw new Error('cost_report: bucket is missing `starting_at`');
    }
    const day = startedAt.slice(0, 10); // RFC 3339 → YYYY-MM-DD (buckets are UTC-snapped)
    const items = Array.isArray(bucket.results) ? bucket.results : [];
    const rows = [];
    let skipped = 0;
    for (const it of items) {
      const row = normalizeCostItem(it);
      if (row) rows.push(row);
      else skipped += 1;
    }
    days.push({ day, rows, skipped });
  }
  return {
    days,
    hasMore: body.has_more === true,
    nextPage: body.next_page ?? null,
  };
}

/** Total dollars in a parsed page — for the run summary, not for storage. */
export function sumDays(days) {
  let total = 0;
  for (const d of days) for (const r of d.rows) total += r.amount_usd;
  return Math.round(total * 1e6) / 1e6;
}

/**
 * Build the query string. `starting_at` is required; `group_by[]=description`
 * is what makes the response carry model / cost_type / token_type, without
 * which reconciliation can only ever be a single daily number.
 */
export function buildCostReportUrl({ startingAt, endingAt, limit = 31, page = null }) {
  const qs = new URLSearchParams();
  qs.set('starting_at', startingAt);
  if (endingAt) qs.set('ending_at', endingAt);
  qs.set('bucket_width', '1d');
  qs.append('group_by[]', 'description');
  qs.set('limit', String(limit));
  if (page) qs.set('page', page);
  return `https://api.anthropic.com/v1/organizations/cost_report?${qs.toString()}`;
}
