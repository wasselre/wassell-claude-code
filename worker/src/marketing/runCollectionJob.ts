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
import { collectMetaAdsByPage, discoverAdvertiser } from './metaAdsLifecycle.js';
import { storeCreative } from './creativeStore.js';
import { normalizeLandingUrl, campaignSignature, urlKey, insightKey } from './adIntel.js';
import { scoreCandidates, decideAutoConfirm, type OrgIdentity } from './advertiserScoring.js';
import {
  attributeCaption, shouldSnapshot, browserbaseFallbackEligible, computeCommonTokens,
  type ProjectAlias, type Metrics,
} from './pipeline.js';
import { runOrganizationDiscovery } from './discovery/discoveryEngine.js';
import { runContentProcess } from './content/runContentProcess.js';
import { runCampaignGroup } from './content/runCampaignGroup.js';

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
): Promise<string | null> {
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
  if (!row) { stats.errors.push(`upsert failed ${post.externalId}`); return null; }
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
  return row.id;
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
      const ingestedIds: string[] = [];
      for (const post of batch.posts) {
        try { const id = await ingestPost(ctx, post, orgId, acct!.id as string, runId, index, pubProjects, minIntervalHours, stats, commonTokens); if (id) ingestedIds.push(id); }
        catch (e) { stats.errors.push(`${post.externalId}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      // Prompt content processing (params.process_content): enqueue content_process
      // for each freshly-collected post RIGHT NOW, so ephemeral media URLs (TikTok
      // no-watermark links expire fast) are downloaded within minutes. Higher
      // priority than routine collection so the download wins the race.
      if (job.params.process_content === true && orgId) {
        for (const pid of ingestedIds) {
          await sb.rpc('mkt_job_enqueue', { p_kind: 'content_process', p_provider: 'internal', p_social_account_id: null, p_params: { content_post_id: pid, organization_id: orgId, from: 'collection' }, p_priority: 30, p_requested_by: null, p_fallback_of: null });
        }
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
    } else if (job.kind === 'discover_advertiser') {
      // Keyword search is the DISCOVERY tool only. Candidates are scored against
      // the org's real identity (names, official domain, known FB URL, aliases)
      // and auto-confirmed ONLY when a strong, unambiguous, non-marketplace
      // anchor exists (decideAutoConfirm). Otherwise: store scored candidates for
      // a human decision. This is what prevents another "Almajdiah → Bayut".
      const adOrgId = (job.params.organization_id as string) ?? orgId;
      const advertiser = (job.params.advertiser as string) ?? (acct?.handle as string);
      if (!adOrgId || !advertiser) throw new ProviderError('discover_advertiser needs organization_id + advertiser', 'config_invalid');

      const { data: orgRow } = await sb.from('mkt_organizations')
        .select('name_ar, name_en, website, org_type, metadata, meta_confirmed').eq('id', adOrgId).maybeSingle();
      // known official Facebook page URLs from stored social accounts (identity anchor)
      const { data: fbAccts } = await sb.from('mkt_social_accounts')
        .select('profile_url').eq('organization_id', adOrgId).in('platform', ['facebook', 'meta']);
      const meta = (orgRow?.metadata ?? {}) as Record<string, unknown>;
      const orgIdentity: OrgIdentity = {
        nameAr: (orgRow?.name_ar as string) ?? null, nameEn: (orgRow?.name_en as string) ?? null,
        website: (orgRow?.website as string) ?? null, orgType: (orgRow?.org_type as string) ?? null,
        aliases: Array.isArray(meta.aliases) ? (meta.aliases as string[]) : [],
        facebookUrls: [
          ...((fbAccts ?? []).map((a) => a.profile_url as string).filter(Boolean)),
          ...(Array.isArray(meta.facebook_urls) ? (meta.facebook_urls as string[]) : []),
        ],
      };

      const disc = await discoverAdvertiser(sb, { advertiser, country: (job.params.country as string) ?? 'SA', limit: 30 });
      apifyCost = disc.cost;
      const scored = scoreCandidates(disc.candidates, orgIdentity);
      const decision = decideAutoConfirm(scored);
      stats.received = scored.length;

      // Never silently overwrite an already-confirmed identity from a discovery run.
      if (orgRow?.meta_confirmed) {
        stats.skipped = scored.length;
        stats.errors.push('org already has a confirmed advertiser — discovery did not overwrite it');
      } else if (decision.confirm && decision.winner) {
        const w = decision.winner;
        await sb.rpc('mkt_org_set_advertiser', {
          p_org: adOrgId, p_page_id: w.pageId, p_advertiser_id: w.pageId, p_page_url: w.pageUrl,
          p_display_name: w.pageName, p_confirmed: true,
          p_verification: { source: 'auto', confidence: w.confidence, score: w.score, decision: decision.reason, evidence: w.reasons, confirmed_at: new Date().toISOString() },
          p_candidates: scored,
        });
        stats.inserted = 1;
      } else {
        await sb.rpc('mkt_org_set_advertiser', {
          p_org: adOrgId, p_page_id: null, p_advertiser_id: null, p_page_url: null, p_display_name: null,
          p_confirmed: false,
          p_verification: { source: 'auto', decision: decision.reason, top_confidence: scored[0]?.confidence ?? null },
          p_candidates: scored,
        });
        stats.skipped = scored.length; // needs a human decision (marketplace/ambiguous/low-confidence)
      }
    } else if (job.kind === 'content_process') {
      // Per-post content understanding: permanent media → transcribe videos →
      // sample frames + OCR images → enrich → attribute. Idempotent.
      const postId = job.params.content_post_id as string | undefined;
      if (!postId) throw new ProviderError('content_process needs content_post_id', 'config_invalid');
      const r = await runContentProcess(sb, postId);
      stats.received = r.media_total;
      stats.inserted = r.media_stored;
      stats.skipped = r.media_failed + r.transcribe_failed;
      if (r.errors.length) stats.errors.push(...r.errors.slice(0, 10));
      apifyCost = { usage_total_usd: r.cost_usd, status: r.status, transcribed: r.transcribed, images: r.images_analyzed, frames: r.frames_analyzed, primary_project: r.primary_project, degraded: r.degraded };
      // A post that produced nothing usable, lost its whole OCR step, or was left
      // unroutable is NOT a succeeded job. Until this throw existed, every one of
      // those returned normally and index.ts called mkt_job_complete — which is
      // how four days of exhausted Anthropic credits read as 66 green jobs.
      // Throwing routes it to mkt_job_fail: bounded exponential-backoff retries
      // (media/OCR writes are idempotent, so a retry is cheap and re-uses what
      // already landed), then a terminal `failed` row the queue actually shows.
      // Degradation that retrying cannot fix — an expired TikTok URL, a
      // datacenter-blocked YouTube download — stays in `errors` and does NOT
      // throw, so those never become a retry storm.
      if (r.fatal_errors.length > 0) {
        throw new ProviderError(`content_process ${postId} did not complete: ${r.fatal_errors.slice(0, 3).join('; ')}`);
      }
    } else if (job.kind === 'campaign_group') {
      // Deterministic cross-platform campaign grouping for one org (organic + paid).
      const cgOrgId = (job.params.organization_id as string) ?? orgId;
      if (!cgOrgId) throw new ProviderError('campaign_group needs organization_id', 'config_invalid');
      const r = await runCampaignGroup(sb, cgOrgId);
      stats.received = r.members; stats.inserted = r.new_campaigns; stats.skipped = r.campaigns - r.new_campaigns;
      apifyCost = { campaigns: r.campaigns, new_campaigns: r.new_campaigns, reused_creatives: r.reused_creatives, organic_to_paid: r.organic_to_paid, ended: r.ended };
    } else if (job.kind === 'organization_discovery') {
      // Automated identity discovery: one Browserbase session crawls the org's
      // site + runs structured Google searches + inspects candidate profiles,
      // stores ALL evidence, scores deterministically, and auto-confirms ONLY
      // link-back-anchored non-marketplace winners. Replaces manual browsing.
      const discOrgId = (job.params.organization_id as string) ?? orgId;
      if (!discOrgId) throw new ProviderError('organization_discovery needs organization_id', 'config_invalid');
      const res = await runOrganizationDiscovery(sb, ctx.env, discOrgId, (job.params.trigger as string) ?? 'queue');
      stats.received = res.candidates;
      stats.inserted = res.confirmed;
      stats.skipped = Math.max(0, res.candidates - res.confirmed);
      if (res.candidates === 0) stats.errors.push('discovery found no candidate accounts (site + search returned nothing linkable)');
    } else if (job.kind === 'paid_ads') {
      // PRODUCTION: collect a CONFIRMED advertiser PAGE (never keyword). Downloads
      // creatives permanently, fingerprints them, groups ads into campaigns, tracks
      // landing pages, and emits deterministic intelligence + notification events.
      const adOrgId = (job.params.organization_id as string) ?? orgId;
      if (!adOrgId) throw new ProviderError('paid_ads needs organization_id', 'config_invalid');
      const { data: orgRow } = await sb.from('mkt_organizations').select('meta_page_id, meta_confirmed, name_en, name_ar').eq('id', adOrgId).maybeSingle();
      if (!orgRow?.meta_page_id || !orgRow.meta_confirmed) throw new ProviderError('advertiser page not confirmed — run discover_advertiser first', 'config_invalid');
      const advertiserLabel = (orgRow.name_en as string) ?? (orgRow.name_ar as string) ?? 'advertiser';
      const limit = typeof job.params.limit === 'number' ? Math.min(200, Math.max(1, job.params.limit)) : 50;
      const result = await collectMetaAdsByPage(sb, { pageId: orgRow.meta_page_id as string, country: (job.params.country as string) ?? 'SA', limit });
      apifyCost = result.cost;
      const pubProjects = await publisherProjectIds(sb, adOrgId);
      const index = await loadProjectIndex(sb, pubProjects);
      const commonTokens = computeCommonTokens(await loadAllProjectNames(sb));
      const seen: string[] = [];
      const touchedCampaigns = new Set<string>();
      const newCampaignIds = new Set<string>();
      const fpCounts = new Map<string, number>();
      let newLandings = 0;
      stats.received = result.ads.length;
      for (const ad of result.ads) {
        try {
          if (!ad.externalAdId) { stats.errors.push('malformed ad (no id)'); continue; }
          const rawId = (await sb.rpc('mkt_raw_ingestion_insert', { p_provider: 'apify', p_source_type: 'ad', p_external_identity: ad.externalAdId, p_payload: ad.raw as object, p_dedup_key: `meta:${ad.externalAdId}`, p_run_id: runId })).data as string;
          // permanent creative: reuse if the creative URL-key is unchanged (no re-download)
          const { data: existing } = await sb.from('mkt_paid_ads').select('creative_original_url, creative_stored_url, creative_fingerprint, creative_phash').eq('platform', 'meta').eq('external_ad_id', ad.externalAdId).maybeSingle();
          let stored: { storedUrl: string; fingerprint: string | null; phash: string | null } | null = null;
          if (ad.creativeMediaRef) {
            if (existing?.creative_stored_url && urlKey(existing.creative_original_url as string) === urlKey(ad.creativeMediaRef)) {
              stored = { storedUrl: existing.creative_stored_url as string, fingerprint: existing.creative_fingerprint as string, phash: existing.creative_phash as string };
            } else {
              stored = await storeCreative(ad.creativeMediaRef);
            }
          }
          // landing page (normalized)
          const ln = normalizeLandingUrl(ad.landingUrl);
          let landingId: string | null = null;
          if (ln.canonical) {
            const before = (await sb.from('mkt_landing_pages').select('id').eq('canonical_url', ln.canonical).maybeSingle()).data;
            landingId = (await sb.rpc('mkt_landing_upsert', { p_canonical_url: ln.canonical, p_destination_domain: ln.domain, p_project_id: null, p_organization_id: adOrgId })).data as string;
            if (!before) newLandings++;
          }
          // campaign grouping
          const sig = campaignSignature({ organizationId: adOrgId, advertiserName: ad.advertiserName, landingCanonical: ln.canonical, cta: ad.cta, headline: ad.headline });
          const camp = ((await sb.rpc('mkt_campaign_upsert', { p_signature: sig, p_organization_id: adOrgId, p_advertiser_name: ad.advertiserName ?? advertiserLabel, p_landing_page_id: landingId, p_cta: ad.cta ?? null, p_headline: ad.headline ?? null, p_run_id: runId })).data as Array<{ id: string; was_inserted: boolean }>)[0]!;
          touchedCampaigns.add(camp.id);
          if (camp.was_inserted) newCampaignIds.add(camp.id);
          // core upsert (dedup + change history)
          const up = ((await sb.rpc('mkt_paid_ad_upsert', {
            p_platform: 'meta', p_external_ad_id: ad.externalAdId, p_provider: 'apify', p_organization_id: adOrgId,
            p_advertiser_name: ad.advertiserName ?? advertiserLabel, p_creative_media_ref: ad.creativeMediaRef ?? null,
            p_creative_type: ad.creativeType ?? null, p_headline: ad.headline ?? null, p_body: ad.body ?? null,
            p_description: ad.description ?? null, p_cta: ad.cta ?? null, p_landing_url: ad.landingUrl ?? null,
            p_languages: ad.languages ?? [], p_platform_started_at: ad.platformStartedAt ?? null, p_is_active: ad.isActive,
            p_reach_info: ad.reachInfo ?? {}, p_raw_ref: rawId, p_run_id: runId,
          })).data as Array<{ id: string; was_inserted: boolean; changes: string[] }> | null)?.[0];
          if (!up) { stats.errors.push(`ad upsert failed ${ad.externalAdId}`); continue; }
          if (up.was_inserted) stats.inserted++; else stats.updated++;
          seen.push(ad.externalAdId);
          // intel fields (not in the core RPC)
          await sb.from('mkt_paid_ads').update({ campaign_id: camp.id, landing_page_id: landingId, creative_original_url: ad.creativeMediaRef ?? null, creative_stored_url: stored?.storedUrl ?? null, creative_fingerprint: stored?.fingerprint ?? null, creative_phash: stored?.phash ?? null }).eq('id', up.id);
          if (stored?.fingerprint) fpCounts.set(stored.fingerprint, (fpCounts.get(stored.fingerprint) ?? 0) + 1);
          // attribution (ad text → monitored developer's projects)
          const text = [ad.headline, ad.body, ad.description].filter(Boolean).join(' ');
          for (const c of attributeCaption(text, index, { publisherProjectIds: pubProjects, commonTokens })) {
            await sb.rpc('mkt_ad_attribution_upsert', { p_paid_ad_id: up.id, p_project_id: c.projectId, p_method: c.method, p_confidence: c.confidence, p_evidence: c.evidence, p_auto_accept: c.autoAccept });
          }
          // per-new-creative insight + notification
          if (up.was_inserted) {
            const iid = (await sb.rpc('mkt_insight_emit', { p_kind: 'new_creative', p_dedup_key: insightKey('new_creative', ad.externalAdId), p_title: `إعلان جديد — ${advertiserLabel}`, p_body: ad.headline ?? null, p_severity: 'info', p_organization_id: adOrgId, p_project_id: null, p_campaign_id: camp.id, p_evidence: { ad: ad.externalAdId } })).data as string | null;
            if (iid) await sb.rpc('mkt_notification_emit', { p_insight_id: iid, p_kind: 'new_creative', p_dedup_key: insightKey('notif', 'new_creative', ad.externalAdId), p_organization_id: adOrgId, p_project_id: null, p_payload: { advertiser: advertiserLabel } });
          }
        } catch (e) { stats.errors.push(`${ad.externalAdId}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      // page scan → removed-detection over THIS org's ads
      if (seen.length > 0) {
        const removed = (await sb.rpc('mkt_ad_mark_removed', { p_organization_id: adOrgId, p_platform: 'meta', p_seen_ids: seen, p_run_id: runId })).data as number;
        stats.skipped = Number(removed ?? 0);
      }
      // refresh campaign rollups + campaign-ended (competitor inactive) insights
      for (const cid of touchedCampaigns) {
        await sb.rpc('mkt_campaign_refresh', { p_campaign: cid });
        const { data: c } = await sb.from('mkt_ad_campaigns').select('is_active, ended_at, primary_headline').eq('id', cid).maybeSingle();
        if (c && !c.is_active && c.ended_at) {
          const iid = (await sb.rpc('mkt_insight_emit', { p_kind: 'campaign_ended', p_dedup_key: insightKey('campaign_ended', cid), p_title: `توقّفت حملة — ${advertiserLabel}`, p_body: (c.primary_headline as string) ?? null, p_severity: 'warning', p_organization_id: adOrgId, p_project_id: null, p_campaign_id: cid, p_evidence: {} })).data as string | null;
          if (iid) await sb.rpc('mkt_notification_emit', { p_insight_id: iid, p_kind: 'campaign_ended', p_dedup_key: insightKey('notif', 'campaign_ended', cid), p_organization_id: adOrgId, p_project_id: null, p_payload: {} });
        }
      }
      // deterministic run-level insights
      for (const cid of newCampaignIds) {
        await sb.rpc('mkt_insight_emit', { p_kind: 'new_campaign', p_dedup_key: insightKey('new_campaign', cid), p_title: `حملة جديدة — ${advertiserLabel}`, p_body: null, p_severity: 'opportunity', p_organization_id: adOrgId, p_project_id: null, p_campaign_id: cid, p_evidence: {} });
      }
      for (const [fp, n] of fpCounts) if (n >= 2) {
        await sb.rpc('mkt_insight_emit', { p_kind: 'creative_reused', p_dedup_key: insightKey('creative_reused', fp), p_title: `تصميم مُعاد استخدامه (${n}) — ${advertiserLabel}`, p_body: null, p_severity: 'info', p_organization_id: adOrgId, p_project_id: null, p_campaign_id: null, p_evidence: { fingerprint: fp, count: n } });
      }
      if (newLandings > 0) {
        const dk = insightKey('new_landing', adOrgId, new Date().toISOString().slice(0, 10));
        await sb.rpc('mkt_insight_emit', { p_kind: 'new_landing_page', p_dedup_key: dk, p_title: `صفحات هبوط جديدة (${newLandings}) — ${advertiserLabel}`, p_body: null, p_severity: 'info', p_organization_id: adOrgId, p_project_id: null, p_campaign_id: null, p_evidence: { count: newLandings } });
      }
      if (stats.inserted >= 5) {
        const dk = insightKey('burst', adOrgId, new Date().toISOString().slice(0, 10));
        const iid = (await sb.rpc('mkt_insight_emit', { p_kind: 'creative_burst', p_dedup_key: dk, p_title: `${advertiserLabel} أطلق ${stats.inserted} إعلانًا اليوم`, p_body: null, p_severity: 'opportunity', p_organization_id: adOrgId, p_project_id: null, p_campaign_id: null, p_evidence: { count: stats.inserted } })).data as string | null;
        if (iid) await sb.rpc('mkt_notification_emit', { p_insight_id: iid, p_kind: 'creative_burst', p_dedup_key: insightKey('notif', dk), p_organization_id: adOrgId, p_project_id: null, p_payload: { count: stats.inserted } });
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
    // Carry the cost through on the failure path too — spend that already happened
    // is still spend, and dropping it here would under-report the cost dashboard
    // for exactly the runs most worth accounting for.
    await sb.rpc('mkt_ingestion_run_finish', { p_run_id: runId, p_status: 'failed', p_received: stats.received, p_inserted: stats.inserted, p_updated: stats.updated, p_skipped: stats.skipped, p_errors: [err.message], p_cost: apifyCost ?? null });
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
