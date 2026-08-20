// ============================================================================
// bundle.social ACCOUNT analytics → mos_account_metric_snapshots.
// ----------------------------------------------------------------------------
// The account-level twin of bundleMetrics.ts. bundle keeps only 30 days of
// analytics and tells you to store the history yourself — so a follower/reach
// growth trend must be OUR daily snapshot, not a read-through. This is the ONE
// implementation of "snapshot every connected account's profile numbers", used
// by BOTH the daily cron (/api/cron/bundle-metrics) and the on-demand
// `account_metrics_pull_all` action in marketing-os.ts.
//
// UPSERT-per-day (not append-on-change): the growth chart wants one clean point
// per account per day, so we write the row for (account, source, today) and let
// the unique index collapse repeated pulls onto the same day — the value simply
// refreshes as bundle's numbers move through the day.
//
// It pulls for every account whose platform we run on bundle (IG/TikTok/
// Snapchat), keyed by teamId + platformType — so it works even before
// platform_sync has stamped bundle_account_id onto the row. A genuinely
// unconnected platform returns no data (404/empty) and is skipped, harmlessly.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type BundleConfig, loadBundleConfig, BUNDLE_PLATFORM_TYPE,
  getSocialAccountAnalytics, latestAccountAnalytics, accountAnalyticsToSnapshot,
  BundleApiError,
} from './bundleSocial.js';

/** An account we can snapshot profile numbers for. */
interface AccountRow {
  id: string;
  platform: string;
}

export type AccountPullStatus = 'inserted' | 'no_data' | 'skipped' | 'error';

/**
 * Pull the latest profile analytics for one account and UPSERT today's daily
 * snapshot. Never throws — returns a structured status so a batch keeps going.
 */
export async function pullAccountMetrics(
  sb: SupabaseClient, cfg: BundleConfig, acc: AccountRow,
): Promise<{ status: AccountPullStatus; reason?: string }> {
  const platformType = BUNDLE_PLATFORM_TYPE[acc.platform];
  if (!platformType) return { status: 'skipped', reason: `platform ${acc.platform}` };

  let analytics;
  try {
    analytics = await getSocialAccountAnalytics(cfg, platformType);
  } catch (e) {
    // 404 = bundle has no profile analytics for this platform yet (not connected,
    // or nothing reported) — "nothing to record", not a failure. Anything else is
    // a real error, surfaced (never swallowed).
    if (e instanceof BundleApiError && e.httpStatus === 404) return { status: 'no_data' };
    const msg = e instanceof BundleApiError ? e.message : (e instanceof Error ? e.message : String(e));
    console.error('[bundle-account-metrics] analytics fetch failed', acc.platform, msg);
    return { status: 'error', reason: msg };
  }

  const item = latestAccountAnalytics(analytics);
  if (!item) return { status: 'no_data' };
  const snap = accountAnalyticsToSnapshot(item, platformType);

  // One row per (account, source, day): UPSERT so the daily cadence stays clean
  // and re-runs within a day refresh the same point instead of stacking rows.
  const up = await sb.from('mos_account_metric_snapshots').upsert(
    {
      account_id: acc.id,
      source: 'api',
      captured_at: new Date().toISOString(),
      followers: snap.followers,
      following: snap.following,
      post_count: snap.post_count,
      impressions: snap.impressions,
      reach: snap.reach,
      views: snap.views,
      likes: snap.likes,
      comments: snap.comments,
      extra: snap.extra,
      entered_by_user_id: null, // machine reading — no human entered it
    },
    { onConflict: 'account_id,source,captured_on' },
  );
  if (up.error) {
    console.error('[bundle-account-metrics] snapshot upsert failed', acc.id, up.error.message);
    return { status: 'error', reason: up.error.message };
  }
  return { status: 'inserted' };
}

export interface BundleAccountMetricsSummary {
  ok?: boolean;
  skipped?: 'not_configured';
  scanned?: number;
  inserted?: number;
  no_data?: number;
  errors?: number;
}

/**
 * Snapshot profile numbers for every non-archived account on a platform we run
 * through bundle.social. Service-role client from the cron, or the caller's
 * (enter_metrics-gated) client on demand; self-disables when bundle isn't set.
 */
export async function runBundleAccountMetricsSync(
  sb: SupabaseClient,
): Promise<BundleAccountMetricsSummary> {
  const cfg = loadBundleConfig();
  if (!cfg) return { skipped: 'not_configured' };

  const rows = await sb.from('mos_platform_accounts')
    .select('id, platform')
    .is('archived_at', null);
  if (rows.error) {
    console.error('[bundle-account-metrics] account scan failed', rows.error.message);
    return { ok: false, errors: 1 };
  }
  // Only the platforms bundle actually serves analytics for.
  const accounts = ((rows.data ?? []) as AccountRow[])
    .filter((a) => Object.prototype.hasOwnProperty.call(BUNDLE_PLATFORM_TYPE, a.platform));

  const out: BundleAccountMetricsSummary = {
    ok: true, scanned: accounts.length, inserted: 0, no_data: 0, errors: 0,
  };
  for (const acc of accounts) {
    const r = await pullAccountMetrics(sb, cfg, acc);
    if (r.status === 'inserted') out.inserted! += 1;
    else if (r.status === 'no_data') out.no_data! += 1;
    else if (r.status === 'error') out.errors! += 1;
  }
  return out;
}
