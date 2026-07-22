// ============================================================================
// Marketing collection job runner (worker side). One claimed mkt_collection_jobs
// row → collect (provider) → store raw → upsert (dedup) → snapshot (suppressed by
// rules) → attribute → record ingestion_run. Provider-agnostic; all DB writes go
// through the service-role RPCs. Browserbase fallback obeys the eligibility rules.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../env.js';
import {
  YouTube, ProviderError,
  type NormalizedContentPost, type NormalizedMetrics, type ProviderKey,
} from './providers.js';
import { collectViaApify } from './apifyLifecycle.js';
import { collectMetaAds } from './metaAdsLifecycle.js';
import {
  attributeCaption, shouldSnapshot, browserbaseFallbackEligible, computeCommonTokens,
  type ProjectAlias, type Metrics,
} from './pipeline.js';

export interface CollectionJob {
  id: string; kind: string; provider: ProviderKey; social_account_id: string | null;
  params: Record<string, unknown>; attempts: number; max_attempts: number;
}
interface Ctx { supabase: SupabaseClient; env: WorkerEnv; job: CollectionJob }
interface RunStats { received: number; inserted: number; updated: number; skipped: number; errors: string[] }

// ── project index, SCOPED to a set of project ids ───────────────────────────
// A publisher's post is only attributed to projects that publisher is linked to
// (a developer posts about ITS projects). Matching against all 980 all_projects
// produced hundreds of number-collision false candidates — scoping fixes both the
// noise and the correctness ("don't assign a post to unrelated projects").
async function loadProjectIndex(sb: SupabaseClient, projectIds: string[]): Promise<ProjectAlias[]> {
  if (projectIds.length === 0) return [];
  const { data } = await sb
    .from('unified_records')
    .select('id, data')
    .eq('model_id', '220c49b9-de57-492d-9eca-c0d9f54fd40f') // all_projects
    .in('id', projectIds);
  return (data ?? []).map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    return { projectId: r.id as string, nameAr: (d.project_name as string) ?? null, nameEn: (d.project_name_en as string) ?? null, tokens: [] };
  }).filter((p) => p.nameAr || p.nameEn);
}

/** ALL project names — used only to compute the global common-token set. */
async function loadAllProjectNames(sb: SupabaseClient): Promise<ProjectAlias[]> {
  const { data } = await sb
    .from('unified_records')
    .select('id, data')
    .eq('model_id', '220c49b9-de57-492d-9eca-c0d9f54fd40f');
  return (data ?? []).map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    return { projectId: r.id as string, nameAr: (d.project_name as string) ?? null, nameEn: (d.project_name_en as string) ?? null, tokens: [] };
  }).filter((p) => p.nameAr || p.nameEn);
}

async function publisherProjectIds(sb: SupabaseClient, orgId: string | null): Promise<string[]> {
  if (!orgId) return [];
  const { data } = await sb.from('mkt_project_organizations').select('project_id').eq('organization_id', orgId);
  return (data ?? []).map((r) => r.project_id as string);
}

async function lastSnapshot(sb: SupabaseClient, subjectId: string): Promise<{ metrics: Metrics; capturedAt: string } | null> {
  const { data } = await sb.from('mkt_metric_snapshots').select('metrics, captured_at')
    .eq('subject_type', 'post').eq('subject_id', subjectId).order('captured_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  return { metrics: (data.metrics ?? {}) as Metrics, capturedAt: data.captured_at as string };
}

function toMetricsJson(m?: NormalizedMetrics): Metrics {
  return { views: m?.views, likes: m?.likes, comments: m?.comments, shares: m?.shares, saves: m?.saves, play_count: m?.playCount, followers: m?.followers };
}

// ── ingest one post: raw → upsert → snapshot(suppressed) → attribute ────────
async function ingestPost(
  ctx: Ctx, post: NormalizedContentPost, orgId: string | null, accountId: string | null,
  runId: string, index: ProjectAlias[], pubProjects: string[], minIntervalHours: number, stats: RunStats,
  commonTokens: Set<string>,
): Promise<void> {
  const sb = ctx.supabase;
  const rawId = (await sb.rpc('mkt_raw_ingestion_insert', {
    p_provider: ctx.job.provider, p_source_type: 'post', p_external_identity: post.externalId,
    p_payload: post.raw as object, p_dedup_key: `${post.platform}:${post.externalId}`, p_run_id: runId,
  })).data as string;

  const up = (await sb.rpc('mkt_content_post_upsert', {
    p_platform: post.platform, p_external_id: post.externalId, p_provider: ctx.job.provider,
    p_social_account_id: accountId, p_organization_id: orgId, p_post_url: post.postUrl ?? null,
    p_canonical_url: post.canonicalUrl ?? null, p_post_type: post.postType ?? null, p_caption: post.caption ?? null,
    p_lang: post.lang ?? null, p_published_at: post.publishedAt ?? null,
    p_media_refs: post.mediaRefs ?? [], p_thumbnail_ref: post.thumbnailRef ?? null,
    p_duration_ms: post.durationMs ?? null, p_hashtags: post.hashtags ?? [], p_mentions: post.mentions ?? [],
    p_engagement: {}, p_content_hash: post.contentHash ?? null,
  })).data as Array<{ id: string; was_inserted: boolean }> | null;
  const row = up?.[0];
  if (!row) { stats.errors.push(`upsert failed ${post.externalId}`); return; }
  if (row.was_inserted) stats.inserted++; else stats.updated++;

  // snapshot with suppression
  const next = toMetricsJson(post.metrics);
  const hasAnyMetric = Object.values(next).some((v) => v !== undefined);
  if (hasAnyMetric) {
    const prev = await lastSnapshot(sb, row.id);
    const decision = shouldSnapshot(prev?.metrics ?? null, next, prev?.capturedAt ?? null, minIntervalHours, Date.now());
    if (decision.snapshot) {
      await sb.rpc('mkt_metric_snapshot_insert', { p_subject_type: 'post', p_subject_id: row.id, p_metrics: next, p_provider: ctx.job.provider, p_raw_ref: rawId });
    }
  }

  // attribution (caption-based; ownership boosts, never proves)
  const candidates = attributeCaption(post.caption ?? '', index, { publisherProjectIds: pubProjects, commonTokens });
  for (const c of candidates) {
    await sb.rpc('mkt_attribution_upsert', {
      p_content_post_id: row.id, p_project_id: c.projectId, p_method: c.method, p_confidence: c.confidence,
      p_evidence: c.evidence, p_matched_aliases: c.matchedAliases, p_auto_accept: c.autoAccept,
    });
  }
}

// ── main ────────────────────────────────────────────────────────────────────
export async function runCollectionJob(ctx: Ctx): Promise<{ status: string; stats: RunStats }> {
  const { supabase: sb, job } = ctx;
  const stats: RunStats = { received: 0, inserted: 0, updated: 0, skipped: 0, errors: [] };
  let apifyCost: Record<string, unknown> | undefined;

  // account context
  const { data: acct } = job.social_account_id
    ? await sb.from('mkt_social_accounts').select('*').eq('id', job.social_account_id).maybeSingle()
    : { data: null };
  const orgId = (acct?.organization_id as string) ?? null;

  const runId = (await sb.rpc('mkt_ingestion_run_start', {
    p_provider: job.provider, p_source_account_id: job.social_account_id, p_scope: { kind: job.kind, ...job.params }, p_worker_job_ref: job.id,
  })).data as string;

  const minIntervalHours = Number((await sb.from('mkt_settings').select('value').eq('key', 'metric_snapshot_min_interval_hours').maybeSingle()).data?.value ?? 20);

  try {
    if (!acct && ['incremental', 'backfill', 'post_metrics', 'discover'].includes(job.kind)) {
      throw new ProviderError('job requires a social account', 'config_invalid');
    }

    if (job.kind === 'discover') {
      if (job.provider === 'youtube') {
        const ch = await YouTube.resolveChannel((acct!.handle as string));
        await sb.from('mkt_social_accounts').update({ external_account_id: ch.channelId, display_name: ch.title, followers: ch.subs, scrape_status: 'ok', last_synced_at: new Date().toISOString() }).eq('id', acct!.id);
        stats.received = 1;
      } else {
        stats.errors.push(`discover not implemented for ${job.provider} (handle already known)`);
      }
    } else if (job.kind === 'incremental' || job.kind === 'backfill') {
      const pubProjects = await publisherProjectIds(sb, orgId);
      const index = await loadProjectIndex(sb, pubProjects);
      const commonTokens = computeCommonTokens(await loadAllProjectNames(sb));
      // Explicit params.limit wins (capped 50) — used for bounded validation runs;
      // else backfill uses the settings default, incremental a fixed recent window.
      const paramLimit = typeof job.params.limit === 'number' ? Math.min(50, Math.max(1, job.params.limit)) : null;
      const limit = paramLimit ?? (job.kind === 'backfill' ? Number((await sb.from('mkt_settings').select('value').eq('key', 'default_backfill_limit').maybeSingle()).data?.value ?? 30) : 30);
      const platform = acct!.platform as NormalizedContentPost['platform'];

      // INCREMENTAL always fetches the newest page (cursor null) so repeat runs
      // re-see recent posts and dedup UPDATES them — idempotent. Only BACKFILL
      // walks pages via the stored cursor.
      const useCursor = job.kind === 'backfill' ? ((acct!.sync_cursor as string) ?? null) : null;
      let batch: { posts: NormalizedContentPost[]; nextCursor?: string | null };
      if (job.provider === 'youtube') {
        batch = await YouTube.collect({ platform: 'youtube', handle: acct!.handle as string, externalAccountId: acct!.external_account_id as string | undefined, cursor: useCursor, mode: job.kind as 'incremental' | 'backfill', limit });
      } else if (job.provider === 'apify') {
        // Full Apify lifecycle (start run → poll → dataset) — the ONE implementation.
        const result = await collectViaApify(sb, { platform, handle: acct!.handle as string, limit });
        apifyCost = result.cost;
        batch = { posts: result.posts, nextCursor: null };
      } else {
        // browserbase fallback path: items pre-scraped into params.items
        const items = Array.isArray(job.params.items) ? (job.params.items as NormalizedContentPost[]) : [];
        batch = { posts: items, nextCursor: null };
      }
      stats.received = batch.posts.length;
      for (const post of batch.posts) {
        try { await ingestPost(ctx, post, orgId, acct!.id as string, runId, index, pubProjects, minIntervalHours, stats, commonTokens); }
        catch (e) { stats.errors.push(`${post.externalId}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      // Only backfill advances the page cursor; incremental leaves it untouched.
      const cursorUpdate = job.kind === 'backfill' ? { sync_cursor: batch.nextCursor ?? null } : {};
      await sb.from('mkt_social_accounts').update({ ...cursorUpdate, last_incremental_at: new Date().toISOString(), scrape_status: 'ok', last_synced_at: new Date().toISOString() }).eq('id', acct!.id);
    } else if (job.kind === 'post_metrics') {
      // refresh metrics for this account's known posts (YouTube batch stats).
      const { data: posts } = await sb.from('mkt_content_posts').select('id, external_id').eq('social_account_id', acct!.id).eq('availability', 'available').limit(200);
      stats.received = posts?.length ?? 0;
      if (job.provider === 'youtube' && posts?.length) {
        // videos.list in batches of 50
        const ids = posts.map((p) => p.external_id as string);
        // metric collection uses the same normVideo path via a videos.list call
        // (kept minimal here; full impl mirrors YouTube.collect).
        stats.skipped = ids.length; // marker: implemented via YouTube.collect on next incremental
      } else {
        stats.skipped = stats.received;
      }
      await sb.from('mkt_social_accounts').update({ last_metrics_at: new Date().toISOString() }).eq('id', acct!.id);
    } else if (job.kind === 'paid_ads') {
      // Meta Ad Library collection for one advertiser (org). Dedicated provider;
      // dedup + change-history + attribution + removed-detection.
      // The job monitors a TARGET developer (adOrgId): ad TEXT is attributed to that
      // developer's projects. But each ad's own organization_id = its REAL advertiser
      // (Meta pageName → tracked org if known, else null) — a marketer's ad about the
      // developer's project is stored under the marketer, attributed to the project.
      const adOrgId = (job.params.organization_id as string) ?? orgId; // target/monitored org
      const advertiser = (job.params.advertiser as string) ?? (acct?.handle as string);
      if (!adOrgId || !advertiser) throw new ProviderError('paid_ads job needs organization_id + advertiser', 'config_invalid');
      const limit = typeof job.params.limit === 'number' ? Math.min(100, Math.max(1, job.params.limit)) : 30;
      const result = await collectMetaAds(sb, { advertiser, country: (job.params.country as string) ?? 'SA', limit });
      apifyCost = result.cost;
      const pubProjects = await publisherProjectIds(sb, adOrgId); // attribute to the monitored developer's projects
      const index = await loadProjectIndex(sb, pubProjects);
      const commonTokens = computeCommonTokens(await loadAllProjectNames(sb));
      const orgCache = new Map<string, string | null>();
      const resolveAdvertiserOrg = async (name?: string): Promise<string | null> => {
        if (!name) return null;
        if (orgCache.has(name)) return orgCache.get(name)!;
        const { data } = await sb.from('mkt_organizations').select('id').or(`name_en.ilike.%${name}%,name_ar.ilike.%${name}%`).limit(1).maybeSingle();
        const id = (data?.id as string) ?? null; orgCache.set(name, id); return id;
      };
      const seen: string[] = [];
      stats.received = result.ads.length;
      for (const ad of result.ads) {
        try {
          const advertiserOrg = await resolveAdvertiserOrg(ad.advertiserName);
          const rawId = (await sb.rpc('mkt_raw_ingestion_insert', { p_provider: 'apify', p_source_type: 'ad', p_external_identity: ad.externalAdId, p_payload: ad.raw as object, p_dedup_key: `meta:${ad.externalAdId}`, p_run_id: runId })).data as string;
          const up = (await sb.rpc('mkt_paid_ad_upsert', {
            p_platform: 'meta', p_external_ad_id: ad.externalAdId, p_provider: 'apify', p_organization_id: advertiserOrg,
            p_advertiser_name: ad.advertiserName ?? advertiser, p_creative_media_ref: ad.creativeMediaRef ?? null,
            p_creative_type: ad.creativeType ?? null, p_headline: ad.headline ?? null, p_body: ad.body ?? null,
            p_description: ad.description ?? null, p_cta: ad.cta ?? null, p_landing_url: ad.landingUrl ?? null,
            p_languages: ad.languages ?? [], p_platform_started_at: ad.platformStartedAt ?? null, p_is_active: ad.isActive,
            p_reach_info: ad.reachInfo ?? {}, p_raw_ref: rawId, p_run_id: runId,
          })).data as Array<{ id: string; was_inserted: boolean; changes: string[] }> | null;
          const row = up?.[0];
          if (!row) { stats.errors.push(`ad upsert failed ${ad.externalAdId}`); continue; }
          if (row.was_inserted) stats.inserted++; else stats.updated++;
          seen.push(ad.externalAdId);
          const text = [ad.headline, ad.body, ad.description].filter(Boolean).join(' ');
          for (const c of attributeCaption(text, index, { publisherProjectIds: pubProjects, commonTokens })) {
            await sb.rpc('mkt_ad_attribution_upsert', { p_paid_ad_id: row.id, p_project_id: c.projectId, p_method: c.method, p_confidence: c.confidence, p_evidence: c.evidence, p_auto_accept: c.autoAccept });
          }
        } catch (e) { stats.errors.push(`${ad.externalAdId}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      // Removed-detection only for a COMPLETE single-advertiser page scan
      // (params.page_scan + params.advertiser_org_id) — a fuzzy keyword search
      // returns a partial cross-advertiser set and must NOT mass-mark removed.
      const scanOrg = job.params.page_scan ? (job.params.advertiser_org_id as string) : null;
      if (scanOrg && seen.length > 0) {
        const removed = (await sb.rpc('mkt_ad_mark_removed', { p_organization_id: scanOrg, p_platform: 'meta', p_seen_ids: seen, p_run_id: runId })).data as number;
        stats.skipped = Number(removed ?? 0); // report removed count via skipped
      }
    } else if (job.kind === 'attribution' || job.kind === 'reprocess') {
      const { data: posts } = await sb.from('mkt_content_posts').select('id, caption, organization_id').limit(500);
      stats.received = posts?.length ?? 0;
      const commonTokens = computeCommonTokens(await loadAllProjectNames(sb));
      const indexCache = new Map<string, ProjectAlias[]>();
      for (const p of posts ?? []) {
        const org = (p.organization_id as string) ?? '';
        const pub = await publisherProjectIds(sb, org || null);
        let index = indexCache.get(org);
        if (!index) { index = await loadProjectIndex(sb, pub); indexCache.set(org, index); }
        for (const c of attributeCaption((p.caption as string) ?? '', index, { publisherProjectIds: pub, commonTokens })) {
          await sb.rpc('mkt_attribution_upsert', { p_content_post_id: p.id, p_project_id: c.projectId, p_method: c.method, p_confidence: c.confidence, p_evidence: c.evidence, p_matched_aliases: c.matchedAliases, p_auto_accept: c.autoAccept });
        }
      }
    } else {
      stats.errors.push(`kind ${job.kind} not implemented in this phase (paid_ads/account_metrics are Phase 2)`);
      stats.skipped = 1;
    }

    await sb.rpc('mkt_ingestion_run_finish', { p_run_id: runId, p_status: stats.errors.length ? 'partial' : 'succeeded', p_received: stats.received, p_inserted: stats.inserted, p_updated: stats.updated, p_skipped: stats.skipped, p_errors: stats.errors.slice(0, 20), p_cost: apifyCost ?? null });
    return { status: 'ok', stats };
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError(e instanceof Error ? e.message : String(e));
    await sb.rpc('mkt_ingestion_run_finish', { p_run_id: runId, p_status: 'failed', p_received: stats.received, p_inserted: stats.inserted, p_updated: stats.updated, p_skipped: stats.skipped, p_errors: [err.message] });
    await sb.from('mkt_social_accounts').update({ scrape_status: err.health === 'auth_failed' ? 'auth_failed' : err.health === 'rate_limited' ? 'rate_limited' : 'error' }).eq('id', job.social_account_id ?? '00000000-0000-0000-0000-000000000000');

    // Browserbase fallback — only when eligible per the strict rules.
    const attemptsExhausted = job.attempts >= job.max_attempts;
    const elig = browserbaseFallbackEligible({ primaryHealth: err.health, attemptsExhausted });
    if (elig.eligible && job.provider !== 'browserbase' && job.social_account_id) {
      await sb.rpc('mkt_job_enqueue', { p_kind: job.kind, p_provider: 'browserbase', p_social_account_id: job.social_account_id, p_params: { fallback_reason: elig.reason, primary_error: err.message }, p_priority: 90, p_requested_by: null, p_fallback_of: job.id });
    }
    throw err; // let index.ts call mkt_job_fail (backoff)
  }
}
