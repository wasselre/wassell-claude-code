// ============================================================================
// bundle.social STATUS sweep — the reconciliation loop that makes organic
// posting reliable instead of hopeful.
// ----------------------------------------------------------------------------
// The problem it closes: after publication_publish hands a post to bundle, our
// row says «مجدول» and stays that way until someone clicks "Refresh status" or
// the (dashboard-configured, post.published-only) webhook fires. A post that
// FAILS at its scheduled slot posts nothing — and the webhook never reports
// failures — so before this sweep a failure was invisible until a human went
// looking. Real incident class, not hypothetical.
//
// The sweep polls every IN-FLIGHT publication (bundle_post_id set, our status
// not yet published, bundle status not terminal) against GET /post/{id}:
//   POSTED  → status='published' + published_at + permalink (same as the
//             manual publication_sync — one recipe, three triggers: webhook,
//             button, sweep).
//   ERROR   → bundle_status/bundle_error recorded AND, on the transition into
//             ERROR, a `publish_failed` notification is emitted to the
//             publishing roles (in-app always; push/whatsapp per the role
//             rules matrix). The Publishing Board's «يحتاج انتباه» bucket
//             picks it up from the same columns.
//   DELETED / GET 404 → the post is gone on bundle's side; our row returns to
//             'draft' so it can be re-published (the bundle_* audit trail stays).
//
// Triggers: /api/cron/bundle-status (every 10 min, service client) and the
// `publication_sync_all` action (Publishing Board refresh, user client — RLS
// applies). Self-disabling when bundle env is absent.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadBundleConfig, getPost, extractPermalink, BundleApiError,
  type BundlePost,
} from './bundleSocial.js';

/** bundle statuses still worth polling. ERROR is not here: once recorded we
 *  stop polling it (the row waits for a human retry, not another GET). */
const IN_FLIGHT = ['DRAFT', 'SCHEDULED', 'PROCESSING', 'RETRYING', 'REVIEW'];

export interface StatusSweepSummary {
  skipped?: 'not_configured';
  scanned: number;
  published: number;
  failed: number;
  deleted: number;
  unchanged: number;
  errors: number;
}

const PLATFORM_AR: Record<string, string> = {
  instagram: 'انستقرام', tiktok: 'تيك توك', snapchat: 'سناب شات',
};

interface SweepRow {
  id: string;
  content_id: string;
  platform: string;
  bundle_post_id: string;
  bundle_status: string | null;
  published_by_user_id: string | null;
}

/**
 * Emit «فشل النشر التلقائي» to the roles that publish. In-app rows are written
 * unconditionally by notify_emit; push/whatsapp follow the notification_rules
 * matrix (seeded for publish_failed in 2026-08-20_mos_publish_failed_rules.sql).
 * A notification failure must never fail the sweep — logged, not thrown.
 */
async function notifyPublishFailed(
  sb: SupabaseClient, row: SweepRow, errText: string | null,
): Promise<void> {
  const plat = PLATFORM_AR[row.platform] ?? row.platform;
  try {
    const { error } = await sb.rpc('notify_emit', {
      p_workspace: 'marketing',
      p_event: 'publish_failed',
      p_role_keys: ['mos_ops_supervisor', 'mos_marketing_manager'],
      p_user_ids: [],
      p_title_ar: 'فشل النشر التلقائي',
      p_title_en: 'Auto-publish failed',
      p_body_ar: `تعذّر نشر المحتوى على ${plat}${errText ? ` — ${errText}` : ''}. افتحي لوحة النشر لإعادة المحاولة.`,
      p_body_en: `Publishing to ${row.platform} failed${errText ? ` — ${errText}` : ''}. Open the Publishing Board to retry.`,
      p_url: `/m/content/${row.content_id}?tab=publish`,
    });
    if (error) {
      console.error('[bundle-status] notify_emit failed', row.id, error.code, error.message);
    }
  } catch (e) {
    console.error('[bundle-status] notify_emit threw', row.id, e);
  }
}

/**
 * Reconcile every in-flight bundle post with bundle.social. Idempotent; safe
 * to run from the cron and the board button concurrently (the patch is a
 * plain column update — last writer wins with identical truth).
 */
export async function runBundleStatusSweep(sb: SupabaseClient): Promise<StatusSweepSummary> {
  const summary: StatusSweepSummary = {
    scanned: 0, published: 0, failed: 0, deleted: 0, unchanged: 0, errors: 0,
  };
  const cfg = loadBundleConfig();
  if (!cfg) return { skipped: 'not_configured', ...summary };

  // bundle_status IS NULL is included defensively: publish always stamps it,
  // but a webhook-created edge or a partial write must still get swept.
  const res = await sb.from('mos_publications')
    .select('id, content_id, platform, bundle_post_id, bundle_status, published_by_user_id')
    .not('bundle_post_id', 'is', null)
    .neq('status', 'published')
    .or(`bundle_status.is.null,bundle_status.in.(${IN_FLIGHT.join(',')})`);
  if (res.error) {
    console.error('[bundle-status] sweep select failed', res.error.code, res.error.message);
    summary.errors += 1;
    return summary;
  }

  for (const row of (res.data ?? []) as SweepRow[]) {
    summary.scanned += 1;
    let post: BundlePost | null = null;
    let gone = false;
    try {
      post = await getPost(cfg, row.bundle_post_id);
    } catch (e) {
      if (e instanceof BundleApiError && e.httpStatus === 404) {
        gone = true; // deleted on bundle's side — treat as DELETED below
      } else {
        console.error('[bundle-status] getPost failed', row.bundle_post_id, e);
        summary.errors += 1;
        continue;
      }
    }

    const bStatus = gone ? 'DELETED' : (post as BundlePost).status;
    const patch: Record<string, unknown> = {
      bundle_status: bStatus,
      bundle_error: !gone && typeof post?.error === 'string' ? post.error : null,
      bundle_synced_at: new Date().toISOString(),
    };

    if (bStatus === 'POSTED' && post) {
      patch.status = 'published';
      patch.published_at = post.postedDate ?? new Date().toISOString();
      const link = extractPermalink(post);
      if (link) patch.external_url = link;
      summary.published += 1;
    } else if (bStatus === 'DELETED') {
      // The live post no longer exists — the row goes back to editable so it
      // can be re-published; bundle_post_id stays as the audit trail and the
      // publish path treats DELETED as retryable.
      patch.status = 'draft';
      summary.deleted += 1;
    } else if (bStatus === 'ERROR') {
      summary.failed += 1;
    } else {
      summary.unchanged += 1;
    }

    const upd = await sb.from('mos_publications').update(patch).eq('id', row.id);
    if (upd.error) {
      console.error('[bundle-status] update failed', row.id, upd.error.code, upd.error.message);
      summary.errors += 1;
      continue;
    }

    // Notify exactly on the TRANSITION into ERROR — one alert per attempt, no
    // re-alerting on later sweeps (ERROR rows leave the in-flight set anyway).
    if (bStatus === 'ERROR' && row.bundle_status !== 'ERROR') {
      await notifyPublishFailed(sb, row, typeof post?.error === 'string' ? post.error : null);
    }
  }

  return summary;
}
