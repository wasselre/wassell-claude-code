// ============================================================================
// Organization discovery engine — the automated, evidence-storing replacement
// for manual browser investigation. Runs in ONE Browserbase session:
//   1. deep-crawl the org's official site (home + about/contact) for social
//      links / JSON-LD sameAs / OG / link-in-bio  → these are SITE-LINKS-TO
//      evidence (near-certain ownership).
//   2. run structured Google queries (Arabic name / English name / domain) →
//      candidate account URLs with titles + snippets.
//   3. inspect the top candidates' profiles → display name, bio links, stable
//      id (YouTube channelId), and whether the bio links BACK to the org domain.
//   4. deterministically score every candidate (identityScoring) and auto-confirm
//      ONLY link-back-anchored, non-marketplace winners that clearly beat rivals.
// Every query, evidence item, and scored candidate is persisted for audit.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../../env.js';
import {
  chromium, createDiscoverySession, crawlSite, webSearch, inspectProfile,
  type EvidenceItem,
} from './browserDiscovery.js';
import { scoreIdentity, decideIdentityAutoConfirm, type OrgIdentity, type IdentityCandidateInput, type ScoredIdentity } from './identityScoring.js';
import { registrableDomain } from '../advertiserScoring.js';

const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'facebook', 'x', 'linkedin', 'snapchat'];
const COLLECTABLE = new Set(['instagram', 'tiktok', 'youtube']);

interface DiscoverResult { runId: string; candidates: number; confirmed: number; evidence: number; queries: number; costUsd: number; summary: Record<string, unknown> }

export async function runOrganizationDiscovery(sb: SupabaseClient, env: WorkerEnv, orgId: string, trigger = 'manual'): Promise<DiscoverResult> {
  if (!env.BROWSERBASE_API_KEY || !env.BROWSERBASE_PROJECT_ID) throw new Error('BROWSERBASE_* not set on the worker');

  const { data: org } = await sb.from('mkt_organizations')
    .select('name_ar, name_en, website, org_type, metadata').eq('id', orgId).maybeSingle();
  if (!org) throw new Error(`org not found: ${orgId}`);
  const meta = (org.metadata ?? {}) as Record<string, unknown>;
  const identity: OrgIdentity = {
    nameAr: (org.name_ar as string) ?? null, nameEn: (org.name_en as string) ?? null,
    website: (org.website as string) ?? null, orgType: (org.org_type as string) ?? null,
    aliases: Array.isArray(meta.aliases) ? (meta.aliases as string[]) : [],
  };
  const orgDomain = registrableDomain(identity.website);

  const runId = (await sb.rpc('mkt_discovery_run_start', { p_org: orgId, p_trigger: trigger })).data as string;
  const t0 = Date.now();
  const allEvidence: EvidenceItem[] = [];
  const sourcesUsed = new Set<string>();
  let queriesCount = 0;

  const session = await createDiscoverySession(env.BROWSERBASE_API_KEY, env.BROWSERBASE_PROJECT_ID);
  const browser = await chromium.connectOverCDP(session);
  try {
    const ctx = browser.contexts()[0]!;
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    // 1. site crawl
    if (identity.website) {
      const ev = await crawlSite(page, identity.website);
      allEvidence.push(...ev); sourcesUsed.add('site_crawl');
      await sb.rpc('mkt_discovery_query_log', { p_run: runId, p_org: orgId, p_source: 'site_crawl', p_query: identity.website, p_results: ev.length });
      queriesCount++;
    }

    // 2. structured web searches (broad, all platforms per query — cost-efficient).
    //    webSearch tries Bing → DuckDuckGo → Google; each hit's source records
    //    which engine actually answered.
    const queries: string[] = [];
    if (identity.nameAr) queries.push(`${identity.nameAr} العقارية انستقرام تيك توك يوتيوب`);
    if (identity.nameEn) queries.push(`${identity.nameEn} real estate Saudi instagram tiktok youtube`);
    if (orgDomain) queries.push(`"${orgDomain}" instagram OR tiktok OR youtube`);
    for (const q of queries) {
      const ev = await webSearch(page, q, PLATFORMS);
      allEvidence.push(...ev);
      for (const e of ev) sourcesUsed.add(e.source);
      await sb.rpc('mkt_discovery_query_log', { p_run: runId, p_org: orgId, p_source: 'web_search', p_query: q, p_results: ev.length });
      queriesCount++;
    }

    // persist evidence
    for (const e of allEvidence) {
      await sb.rpc('mkt_discovery_evidence_add', {
        p_run: runId, p_org: orgId, p_source: e.source, p_kind: e.kind, p_platform: e.platform, p_handle: e.handle,
        p_url: e.url, p_title: e.title, p_snippet: e.snippet, p_extracted: e.extracted, p_screenshot: null,
      });
    }

    // 3. aggregate candidates per (platform, handle)
    type Agg = { platform: string; handle: string; url: string; sources: Set<string>; siteLinked: boolean };
    const byKey = new Map<string, Agg>();
    for (const e of allEvidence) {
      if (!e.platform || !e.handle || e.platform === 'domain') continue;
      const key = `${e.platform}:${e.handle}`;
      let a = byKey.get(key);
      if (!a) { a = { platform: e.platform, handle: e.handle, url: e.url ?? '', sources: new Set(), siteLinked: false }; byKey.set(key, a); }
      a.sources.add(e.source);
      // the org's OWN site (crawl / jsonld) links to it → strong ownership signal
      if (e.source === 'site_crawl') a.siteLinked = true;
    }

    // 4. inspect the top few candidates per platform (bounded — cost control)
    const inspected = new Map<string, { pageName: string | null; bioLinks: string[]; bioText: string | null; accountId: string | null }>();
    const perPlatform: Record<string, Agg[]> = {};
    for (const a of byKey.values()) (perPlatform[a.platform] ??= []).push(a);
    for (const plat of Object.keys(perPlatform)) {
      // prefer site-linked candidates, then cap at 3 per platform
      const list = perPlatform[plat]!.sort((x, y) => Number(y.siteLinked) - Number(x.siteLinked)).slice(0, 3);
      for (const a of list) {
        if (!a.url) continue;
        try { inspected.set(`${a.platform}:${a.handle}`, await inspectProfile(page, a.platform, a.url)); }
        catch { /* profile wall — score without it */ }
      }
    }

    // 5. score every candidate
    const scored: ScoredIdentity[] = [];
    for (const a of byKey.values()) {
      const info = inspected.get(`${a.platform}:${a.handle}`);
      const input: IdentityCandidateInput = {
        platform: a.platform, handle: a.handle, url: a.url, accountId: info?.accountId ?? null,
        pageName: info?.pageName ?? null, bioText: info?.bioText ?? null, bioLinks: info?.bioLinks ?? [],
        siteLinksToThis: a.siteLinked, sources: [...a.sources],
      };
      scored.push(scoreIdentity(input, identity));
    }

    // 6. decide + persist candidates
    let confirmedCount = 0;
    const confirmDecision: Record<string, string> = {};
    for (const plat of new Set(scored.map((s) => s.platform))) {
      confirmDecision[plat] = decideIdentityAutoConfirm(scored, plat).reason;
    }
    for (const s of scored) {
      const dec = decideIdentityAutoConfirm(scored, s.platform);
      const topOnPlatform = scored.filter((x) => x.platform === s.platform).sort((a, b) => b.score - a.score)[0]!;
      const isWinner = dec.confirm && topOnPlatform.handle === s.handle;
      const status = isWinner ? 'confirmed' : 'candidate';
      if (isWinner) confirmedCount++;
      await sb.rpc('mkt_identity_candidate_upsert', {
        p_org: orgId, p_platform: s.platform, p_handle: s.handle, p_account_id: s.accountId, p_url: s.url,
        p_class: s.accountClass, p_score: s.score, p_confidence: s.confidence, p_is_marketplace: s.isMarketplace,
        p_reasons: s.reasons, p_evidence: { sources: s.sources },
        p_status: status, p_verification_method: isWinner ? dec.reason : null, p_run: runId,
      });
      // auto-confirmed COLLECTABLE account → create a social account (disabled; a human/next step enables collection)
      if (isWinner && COLLECTABLE.has(s.platform)) {
        const { data: existing } = await sb.from('mkt_social_accounts').select('id')
          .eq('organization_id', orgId).eq('platform', s.platform).eq('handle', s.handle).maybeSingle();
        if (!existing) {
          await sb.from('mkt_social_accounts').insert({
            organization_id: orgId, platform: s.platform, handle: s.handle,
            profile_url: s.url, external_account_id: s.accountId,
            provider: s.platform === 'youtube' ? 'youtube' : 'apify', is_active: true, collection_enabled: false,
            cadence: { metrics: 'daily', incremental: 'daily' },
            provider_metadata: { discovered: true, discovery_run_id: runId, confidence: s.confidence },
          });
        }
      }
    }

    const costUsd = Math.round(((Date.now() - t0) / 60000) * 0.10 * 1000) / 1000; // ~$0.10/min Browserbase, rough
    const summary = { session, confirm_decisions: confirmDecision, platforms: [...new Set(scored.map((s) => s.platform))] };
    await sb.rpc('mkt_discovery_run_finish', {
      p_run: runId, p_status: 'done', p_sources: [...sourcesUsed], p_queries: queriesCount, p_evidence: allEvidence.length,
      p_candidates: scored.length, p_confirmed: confirmedCount, p_cost: costUsd, p_summary: summary, p_error: null,
    });
    return { runId, candidates: scored.length, confirmed: confirmedCount, evidence: allEvidence.length, queries: queriesCount, costUsd, summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sb.rpc('mkt_discovery_run_finish', { p_run: runId, p_status: 'failed', p_sources: [...sourcesUsed], p_queries: queriesCount, p_evidence: allEvidence.length, p_candidates: 0, p_confirmed: 0, p_cost: 0, p_summary: {}, p_error: msg });
    throw new Error(`organization_discovery failed (org ${orgId}): ${msg}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
