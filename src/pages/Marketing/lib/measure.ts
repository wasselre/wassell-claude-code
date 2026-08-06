/**
 * Success-measure math — the ONE place that turns a campaign's chosen success
 * measures into headline numbers. Both the campaign card (CampaignsPage) and the
 * campaign detail page read from here, so they never disagree.
 *
 * The goal field is a pure human description now — it is NEVER scraped for a
 * number. Every target/actual/pace figure comes from a success MEASURE. The user
 * picks ONE measure as the «الرئيسي / main» one (stored first in
 * `success_measures`); that is the measure the card headlines.
 */
import { MosCampaign, MosMeasureSource, MosSuccessMeasure } from '@/lib/marketingOS/client';

/** Accumulating, higher-is-better counts — the ones a time-pace can be computed on. */
export const VOLUME_SOURCES: ReadonlySet<MosMeasureSource> = new Set([
  'impressions', 'clicks', 'leads', 'qualified',
]);

export function isVolumeSource(s: MosMeasureSource): boolean {
  return VOLUME_SOURCES.has(s);
}

/**
 * The user-chosen MAIN measure — the one the card headlines. It is stored first
 * in `success_measures` (the editor reorders the picked row to index 0, and the
 * server derives the back-compat scalar pair from `[0]`). We take the first row
 * that carries a real target number; a measure with no threshold can't headline.
 */
export function pickMainMeasure(c: MosCampaign): MosSuccessMeasure | null {
  const ms = Array.isArray(c.success_measures) ? c.success_measures : [];
  return ms.find((m) => m.threshold !== null && m.threshold > 0) ?? null;
}

/**
 * The measure that drives the detail page's «مقابل الهدف» pace / gap / projection
 * math — which only makes sense for an accumulating VOLUME goal. Prefers the
 * user's main measure when it is a volume goal; otherwise falls back to the first
 * volume measure so the pace card still has something to compute on. Returns null
 * when the campaign is judged only by cost/rate measures (no accumulation).
 */
export function pickVolumeMeasure(c: MosCampaign): MosSuccessMeasure | null {
  const ms = Array.isArray(c.success_measures) ? c.success_measures : [];
  const isVolumeTarget = (m: MosSuccessMeasure): boolean =>
    m.direction === 'higher' && m.threshold !== null && m.threshold > 0 && isVolumeSource(m.source);
  const main = ms[0];
  if (main && isVolumeTarget(main)) return main;
  return ms.find(isVolumeTarget) ?? null;
}

/** The live actual for a measure's source, or null when it can't be computed. */
export function measureActual(
  source: MosMeasureSource,
  c: MosCampaign,
  organicImpressions = 0,
  isOrganic = false,
): number | null {
  const spend = c.total_spend ?? 0;
  const leads = c.total_leads ?? 0;
  const qualified = c.total_qualified ?? 0;
  // Paid impressions come from the ad campaigns; an organic campaign's reach is
  // summed from its linked content (the rollup only counts ad impressions).
  const impressions = isOrganic ? organicImpressions : (c.total_impressions ?? 0);
  const clicks = c.total_clicks ?? 0;
  switch (source) {
    case 'impressions': return impressions;
    case 'clicks': return clicks;
    case 'leads': return leads;
    case 'qualified': return qualified;
    case 'spend': return spend;
    case 'cpl': return leads > 0 ? spend / leads : null;
    case 'cpl_qualified': return qualified > 0 ? spend / qualified : null;
    case 'ctr': return impressions > 0 ? (clicks / impressions) * 100 : null;
    default: return null; // 'none' — a descriptive target with no live actual
  }
}
