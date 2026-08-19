// ============================================================================
// bundle.social analytics → mos_metric_snapshots.
// ----------------------------------------------------------------------------
// The ONE implementation of "pull performance numbers for a published post",
// used by BOTH triggers (mirrors runMetaSync): the daily cron
// (/api/cron/bundle-metrics) and the on-demand `metrics_pull` action in
// marketing-os.ts. bundle auto-refreshes analytics every 24h, so a daily pull
// keeps the Numbers screen current without anyone entering a figure.
//
// Append-only + deduped: a snapshot is inserted only when the reading actually
// changed from the last API snapshot for that publication, so repeated pulls of
// an unchanged post add no noise (same posture as the manual metrics_record).
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type BundleConfig, loadBundleConfig, BUNDLE_PLATFORM_TYPE,
  getPostAnalytics, latestAnalytics, analyticsToSnapshot, BundleApiError,
} from './bundleSocial.js';

/** A published publication we can pull numbers for. */
interface PubRow {
  id: string;
  platform: string;
  bundle_post_id: string | null;
  external_url?: string | null;
}

export type PullStatus = 'inserted' | 'unchanged' | 'no_data' | 'skipped' | 'error';

/** The reading fields that decide whether a new snapshot is worth inserting. */
function coreKey(s: { views: number | null; engagement: number | null;
  likes: number | null; comments: number | null; saves: number | null }): string {
  return [s.views, s.engagement, s.likes, s.comments, s.saves].map((v) => v ?? 'x').join('|');
}

/**
 * Pull the latest analytics for one publication and, if it changed, append an
 * `api` snapshot. Also backfills the permalink into external_url when missing.
 * Never throws — returns a structured status so a batch keeps going.
 */
export async function pullPublicationMetrics(
  sb: SupabaseClient, cfg: BundleConfig, pub: PubRow,
): Promise<{ status: PullStatus; reason?: string }> {
  if (!pub.bundle_post_id) return { status: 'skipped', reason: 'no bundle post' };
  const platformType = BUNDLE_PLATFORM_TYPE[pub.platform];
  if (!platformType) return { status: 'skipped', reason: `platform ${pub.platform}` };

  let analytics;
  try {
    analytics = await getPostAnalytics(cfg, pub.bundle_post_id, platformType);
  } catch (e) {
    // A 404 means bundle has no analytics row for this post yet (fresh post, or
    // a platform that hasn't reported) — that is "nothing to record", not a
    // failure. Anything else is a real error, surfaced (never swallowed).
    if (e instanceof BundleApiError && e.httpStatus === 404) return { status: 'no_data' };
    const msg = e instanceof BundleApiError ? e.message : (e instanceof Error ? e.message : String(e));
    console.error('[bundle-metrics] analytics fetch failed', pub.id, msg);
    return { status: 'error', reason: msg };
  }

  // Opportunistically store the permalink the analytics response carries.
  const permalink = analytics.profilePost?.permalink ?? null;
  if (permalink && !pub.external_url) {
    const u = await sb.from('mos_publications')
      .update({ external_url: permalink }).eq('id', pub.id);
    if (u.error) console.error('[bundle-metrics] permalink backfill failed', pub.id, u.error.message);
  }

  const item = latestAnalytics(analytics);
  if (!item) return { status: 'no_data' };
  const snap = analyticsToSnapshot(item, platformType);

  // Dedupe against the latest API snapshot — insert only on a real change.
  const prev = await sb.from('mos_metric_snapshots')
    .select('views, engagement, likes, comments, saves')
    .eq('publication_id', pub.id).eq('source', 'api')
    .order('captured_at', { ascending: false }).limit(1).maybeSingle();
  if (prev.error) {
    console.error('[bundle-metrics] prev snapshot read failed', pub.id, prev.error.message);
    return { status: 'error', reason: prev.error.message };
  }
  if (prev.data && coreKey(prev.data as never) === coreKey(snap)) {
    return { status: 'unchanged' };
  }

  const ins = await sb.from('mos_metric_snapshots').insert({
    publication_id: pub.id,
    source: 'api',
    views: snap.views,
    engagement: snap.engagement,
    enquiries: snap.enquiries,
    likes: snap.likes,
    comments: snap.comments,
    saves: snap.saves,
    extra: snap.extra,
    entered_by_user_id: null, // machine reading — no human entered it
  }).select('id').maybeSingle();
  if (ins.error) {
    console.error('[bundle-metrics] snapshot insert failed', pub.id, ins.error.message);
    return { status: 'error', reason: ins.error.message };
  }
  return { status: 'inserted' };
}

export interface BundleMetricsSummary {
  ok?: boolean;
  skipped?: 'not_configured';
  scanned?: number;
  inserted?: number;
  unchanged?: number;
  no_data?: number;
  errors?: number;
}

/**
 * Pull metrics for every published publication posted through bundle.social in
 * the retention window (bundle deletes analytics after 30 days). Service-role
 * client from the cron; self-disables when bundle isn't configured.
 */
export async function runBundleMetricsSync(sb: SupabaseClient): Promise<BundleMetricsSummary> {
  const cfg = loadBundleConfig();
  if (!cfg) return { skipped: 'not_configured' };

  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const rows = await sb.from('mos_publications')
    .select('id, platform, bundle_post_id, external_url, published_at, status')
    .not('bundle_post_id', 'is', null)
    .eq('status', 'published')
    .gte('published_at', cutoff)
    .limit(1000);
  if (rows.error) {
    console.error('[bundle-metrics] publication scan failed', rows.error.message);
    return { ok: false, errors: 1 };
  }
  const pubs = (rows.data ?? []) as PubRow[];
  const out: BundleMetricsSummary = {
    ok: true, scanned: pubs.length, inserted: 0, unchanged: 0, no_data: 0, errors: 0,
  };
  for (const pub of pubs) {
    const r = await pullPublicationMetrics(sb, cfg, pub);
    if (r.status === 'inserted') out.inserted! += 1;
    else if (r.status === 'unchanged') out.unchanged! += 1;
    else if (r.status === 'no_data') out.no_data! += 1;
    else if (r.status === 'error') out.errors! += 1;
  }
  return out;
}
