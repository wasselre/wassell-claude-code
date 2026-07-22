/**
 * POST /api/marketing
 *
 * Read + light-write surface for the Project Marketing Intelligence module.
 * ONE action-dispatch endpoint (like /api/market-intelligence) so the SPA makes a
 * single authenticated call.
 *
 * Auth: the caller's Supabase JWT (RLS-scoped) for reads — the mkt_* tables are
 * authenticated-read (public competitor intel over the shared project catalog).
 * Writes (attribution decisions, provider health refresh) escalate to a
 * service-role client AFTER a server-side check, mirroring market-intelligence.
 *
 * Actions:
 *   provider_health        → mkt_providers rows (Collection Status UI)
 *   project_overview       → dashboard cards for a project
 *   project_content        → paginated attributed posts (Developer/Marketer/All)
 *   project_marketers      → per-organization aggregates for a project
 *   attribution_review     → candidate attributions awaiting review
 *   accounts               → social accounts + orgs linked to a project
 *   attribution_decide     → confirm | reject | reassign (admin-gated write)
 *   refresh_provider_health→ re-validate providers + persist (admin-gated)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';
import { refreshAllProviderHealth } from './_lib/marketing/registry.js';

export const config = { runtime: 'edge' };

interface Body {
  action?: string;
  project_id?: string;
  source?: 'all' | 'developer' | 'marketer';
  page?: number;
  page_size?: number;
  // attribution_decide
  attribution_id?: string;
  decision?: 'confirm' | 'reject' | 'reassign';
  new_project_id?: string;
  // collection ops
  account_id?: string;
  kind?: string;
  provider?: string;
  job_id?: string;
  paused?: boolean;
  collection_enabled?: boolean;
  // paid ads
  active?: boolean;
  advertiser?: string;
  organization_id?: string;
  limit?: number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

function anonClient(req: Request): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('supabase env missing');
  const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
  return createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed');
  return withAuth(req, async (user) => {
    const body = (await req.json().catch(() => ({}))) as Body;
    const action = body.action ?? '';
    let sb: SupabaseClient;
    try { sb = anonClient(req); } catch { return jsonError(500, 'supabase env missing'); }

    switch (action) {
      case 'provider_health': {
        const { data, error } = await sb.from('mkt_providers')
          .select('provider_key, display_name, is_enabled, health_status, health_detail, last_checked_at');
        if (error) return jsonError(500, error.message);
        return jsonOk({ providers: data ?? [] });
      }

      case 'project_overview': {
        const pid = str(body.project_id);
        if (!pid) return jsonError(400, 'project_id required');
        // Attributed, non-rejected posts for this project.
        const { data: attribs, error: aErr } = await sb
          .from('mkt_content_attributions')
          .select('content_post_id, review_status, mkt_content_posts!inner(platform, post_type, published_at, organization_id, mkt_organizations(org_type))')
          .eq('project_id', pid).neq('review_status', 'rejected');
        if (aErr) return jsonError(500, aErr.message);
        const rows = (attribs ?? []) as unknown as Array<{
          review_status: string;
          mkt_content_posts: { post_type: string | null; published_at: string | null; mkt_organizations: { org_type: string } | null };
        }>;
        const monthAgo = Date.now() - 30 * 864e5;
        let devPosts = 0, mktPosts = 0, videos = 0, images = 0, thisMonth = 0, candidates = 0;
        for (const r of rows) {
          const p = r.mkt_content_posts; const t = p?.mkt_organizations?.org_type;
          if (t === 'developer' || t === 'internal') devPosts++; else mktPosts++;
          if (p?.post_type === 'video' || p?.post_type === 'reel' || p?.post_type === 'short') videos++; else images++;
          if (p?.published_at && new Date(p.published_at).getTime() >= monthAgo) thisMonth++;
          if (r.review_status === 'candidate') candidates++;
        }
        const { count: marketerCount } = await sb.from('mkt_project_organizations')
          .select('id', { count: 'exact', head: true })
          .eq('project_id', pid).neq('relationship_type', 'developer');
        return jsonOk({
          developer: { posts: devPosts, videos, images, this_month: thisMonth },
          competitors: { marketers: marketerCount ?? 0, posts: mktPosts },
          our_library: { total: 0, ready: 0, drafts: 0 }, // Our-Content upload UI is a fast-follow
          review_queue: candidates,
        });
      }

      case 'project_content': {
        const pid = str(body.project_id);
        if (!pid) return jsonError(400, 'project_id required');
        const page = Math.max(1, Math.floor(body.page ?? 1));
        const size = Math.min(100, Math.max(1, Math.floor(body.page_size ?? 30)));
        const from = (page - 1) * size;
        let q = sb.from('mkt_content_attributions')
          .select('id, review_status, confidence, attribution_method, evidence, mkt_content_posts!inner(id, platform, external_id, post_url, post_type, caption, published_at, thumbnail_ref, engagement, last_seen_at, providers, first_provider, organization_id, mkt_organizations(name_ar, name_en, org_type))', { count: 'exact' })
          .eq('project_id', pid).neq('review_status', 'rejected');
        if (body.source === 'developer') q = q.eq('mkt_content_posts.mkt_organizations.org_type', 'developer');
        else if (body.source === 'marketer') q = q.neq('mkt_content_posts.mkt_organizations.org_type', 'developer');
        const { data, count, error } = await q
          .order('published_at', { foreignTable: 'mkt_content_posts', ascending: false, nullsFirst: false })
          .range(from, from + size - 1);
        if (error) return jsonError(500, error.message);
        return jsonOk({ rows: data ?? [], total: count ?? 0, page, page_size: size });
      }

      case 'project_marketers': {
        const pid = str(body.project_id);
        if (!pid) return jsonError(400, 'project_id required');
        // Per-org aggregate from attributed posts (dashboard table §4).
        const { data, error } = await sb
          .from('mkt_content_attributions')
          .select('mkt_content_posts!inner(organization_id, post_type, published_at, engagement, mkt_organizations(id, name_ar, name_en, org_type, website))')
          .eq('project_id', pid).neq('review_status', 'rejected');
        if (error) return jsonError(500, error.message);
        const agg = new Map<string, { org: Record<string, unknown>; posts: number; videos: number; images: number; last: string | null }>();
        for (const r of (data ?? []) as unknown as Array<{ mkt_content_posts: { post_type: string | null; published_at: string | null; mkt_organizations: { id: string } & Record<string, unknown> } }>) {
          const p = r.mkt_content_posts; const o = p?.mkt_organizations; if (!o) continue;
          const cur = agg.get(o.id) ?? { org: o, posts: 0, videos: 0, images: 0, last: null };
          cur.posts++;
          if (p.post_type === 'video' || p.post_type === 'reel' || p.post_type === 'short') cur.videos++; else cur.images++;
          if (p.published_at && (!cur.last || p.published_at > cur.last)) cur.last = p.published_at;
          agg.set(o.id, cur);
        }
        return jsonOk({ marketers: [...agg.values()].sort((a, b) => b.posts - a.posts) });
      }

      case 'attribution_review': {
        const pid = str(body.project_id);
        if (!pid) return jsonError(400, 'project_id required');
        const { data, error } = await sb.from('mkt_content_attributions')
          .select('id, confidence, attribution_method, evidence, matched_aliases, mkt_content_posts!inner(id, platform, caption, post_url, thumbnail_ref, published_at, mkt_organizations(name_en, org_type))')
          .eq('project_id', pid).eq('review_status', 'candidate')
          .order('confidence', { ascending: false }).limit(100);
        if (error) return jsonError(500, error.message);
        return jsonOk({ candidates: data ?? [] });
      }

      case 'accounts': {
        const pid = str(body.project_id);
        let q = sb.from('mkt_project_organizations')
          .select('relationship_type, human_confirmed, confidence, mkt_organizations!inner(id, name_ar, name_en, org_type, website, mkt_social_accounts(platform, handle, provider, scrape_status, last_synced_at, followers))');
        if (pid) q = q.eq('project_id', pid);
        const { data, error } = await q.limit(200);
        if (error) return jsonError(500, error.message);
        return jsonOk({ links: data ?? [] });
      }

      case 'attribution_decide': {
        const svc = makeServiceClient('api:marketing');
        if (!svc) return jsonError(500, 'service unavailable');
        const isAdmin = await svc.rpc('wassell_is_admin', { auth_user_id: user.userId });
        if (isAdmin.error || !isAdmin.data) return jsonError(403, 'admin only');
        const aid = str(body.attribution_id);
        if (!aid || !body.decision) return jsonError(400, 'attribution_id + decision required');
        if (body.decision === 'confirm') {
          await svc.from('mkt_content_attributions').update({ review_status: 'confirmed', confirmed_by: user.userId, confirmed_at: new Date().toISOString() }).eq('id', aid);
        } else if (body.decision === 'reject') {
          await svc.from('mkt_content_attributions').update({ review_status: 'rejected', confirmed_by: user.userId, confirmed_at: new Date().toISOString() }).eq('id', aid);
        } else if (body.decision === 'reassign') {
          const np = str(body.new_project_id);
          if (!np) return jsonError(400, 'new_project_id required');
          await svc.from('mkt_content_attributions').update({ project_id: np, review_status: 'confirmed', attribution_method: 'manual', confirmed_by: user.userId, confirmed_at: new Date().toISOString() }).eq('id', aid);
        }
        return jsonOk({ ok: true });
      }

      case 'refresh_provider_health': {
        const svc = makeServiceClient('api:marketing');
        if (!svc) return jsonError(500, 'service unavailable');
        const isAdmin = await svc.rpc('wassell_is_admin', { auth_user_id: user.userId });
        if (isAdmin.error || !isAdmin.data) return jsonError(403, 'admin only');
        const results = await refreshAllProviderHealth(svc);
        return jsonOk({ providers: results });
      }

      case 'project_ads': {
        const pid = str(body.project_id);
        if (!pid) return jsonError(400, 'project_id required');
        const activeFilter = body.active; // true | false | undefined
        let q = sb.from('mkt_ad_attributions')
          .select('id, review_status, confidence, evidence, mkt_paid_ads!inner(id, platform, external_ad_id, advertiser_name, creative_media_ref, creative_type, headline, body, description, cta, landing_url, languages, is_active, first_seen_at, last_seen_at, platform_started_at, platform_ended_at, providers, organization_id, mkt_organizations(name_ar, name_en, org_type))', { count: 'exact' })
          .eq('project_id', pid)
          .neq('review_status', 'rejected')
          .order('last_seen_at', { referencedTable: 'mkt_paid_ads', ascending: false })
          .limit(200);
        if (activeFilter === true || activeFilter === false) q = q.eq('mkt_paid_ads.is_active', activeFilter);
        const { data, error, count } = await q;
        if (error) return jsonError(500, error.message);
        return jsonOk({ rows: data ?? [], total: count ?? 0 });
      }

      case 'ad_timeline': {
        const pid = str(body.project_id);
        if (!pid) return jsonError(400, 'project_id required');
        // the project's attributed ad ids, then their change history (newest first)
        const { data: attribs } = await sb.from('mkt_ad_attributions').select('paid_ad_id').eq('project_id', pid).neq('review_status', 'rejected');
        const adIds = [...new Set((attribs ?? []).map((a) => a.paid_ad_id as string))];
        if (adIds.length === 0) return jsonOk({ events: [] });
        const { data: hist, error } = await sb.from('mkt_ad_history')
          .select('change_type, observed_at, field, old_value, new_value, mkt_paid_ads!inner(external_ad_id, advertiser_name)')
          .in('paid_ad_id', adIds)
          .order('observed_at', { ascending: false })
          .limit(200);
        if (error) return jsonError(500, error.message);
        return jsonOk({ events: hist ?? [] });
      }

      case 'collection_status': {
        // Per-account status: accounts linked to the project + their latest run + latest job.
        const pid = str(body.project_id);
        if (!pid) return jsonError(400, 'project_id required');
        const { data: links } = await sb.from('mkt_project_organizations')
          .select('organization_id, mkt_organizations!inner(name_ar, name_en, mkt_social_accounts(id, platform, handle, provider, scrape_status, collection_enabled, last_synced_at, last_incremental_at, last_metrics_at, followers))')
          .eq('project_id', pid);
        // Latest ingestion run + queued/failed job per account (recent runs table).
        const { data: runs } = await sb.from('mkt_ingestion_runs')
          .select('source_account_id, provider, status, started_at, finished_at, items_received, items_inserted, items_updated, items_skipped, errors')
          .order('started_at', { ascending: false }).limit(50);
        const { data: jobs } = await sb.from('mkt_collection_jobs')
          .select('id, social_account_id, kind, status, attempts, next_run_at, error_message, updated_at')
          .order('updated_at', { ascending: false }).limit(50);
        return jsonOk({ links: links ?? [], runs: runs ?? [], jobs: jobs ?? [] });
      }

      case 'run_ads_collection': {
        const svc = makeServiceClient('api:marketing');
        if (!svc) return jsonError(500, 'service unavailable');
        const isAdmin = await svc.rpc('wassell_is_admin', { auth_user_id: user.userId });
        if (isAdmin.error || !isAdmin.data) return jsonError(403, 'admin only');
        const org = str(body.organization_id); const advertiser = str(body.advertiser);
        if (!org || !advertiser) return jsonError(400, 'organization_id + advertiser required');
        const lim = typeof body.limit === 'number' ? Math.min(100, Math.max(1, body.limit)) : 25;
        const { data, error } = await svc.rpc('mkt_job_enqueue', {
          p_kind: 'paid_ads', p_provider: 'apify', p_social_account_id: null,
          p_params: { advertiser, organization_id: org, country: 'SA', limit: lim, reason: 'manual' },
          p_priority: 60, p_requested_by: user.userId, p_fallback_of: null,
        });
        if (error) return jsonError(500, error.message);
        return jsonOk({ job_id: data });
      }

      case 'run_collection':
      case 'retry_job':
      case 'set_collection_paused':
      case 'set_account_collection': {
        // admin-gated writes
        const svc = makeServiceClient('api:marketing');
        if (!svc) return jsonError(500, 'service unavailable');
        const isAdmin = await svc.rpc('wassell_is_admin', { auth_user_id: user.userId });
        if (isAdmin.error || !isAdmin.data) return jsonError(403, 'admin only');

        if (action === 'run_collection') {
          const acc = str(body.account_id); const kind = str(body.kind) ?? 'incremental'; const prov = str(body.provider);
          if (!acc || !prov) return jsonError(400, 'account_id + provider required');
          const { data, error } = await svc.rpc('mkt_job_enqueue', {
            p_kind: kind, p_provider: prov, p_social_account_id: acc,
            p_params: { reason: 'manual' }, p_priority: 50, p_requested_by: user.userId, p_fallback_of: null,
          });
          if (error) return jsonError(500, error.message);
          return jsonOk({ job_id: data });
        }
        if (action === 'retry_job') {
          const jid = str(body.job_id);
          if (!jid) return jsonError(400, 'job_id required');
          await svc.rpc('mkt_job_retry', { p_job_id: jid, p_requested_by: user.userId });
          return jsonOk({ ok: true });
        }
        if (action === 'set_collection_paused') {
          await svc.from('mkt_settings').update({ value: Boolean(body.paused), updated_at: new Date().toISOString() }).eq('key', 'collection_paused');
          return jsonOk({ ok: true, paused: Boolean(body.paused) });
        }
        // set_account_collection
        const acc = str(body.account_id);
        if (!acc) return jsonError(400, 'account_id required');
        await svc.from('mkt_social_accounts').update({ collection_enabled: Boolean(body.collection_enabled) }).eq('id', acc);
        return jsonOk({ ok: true });
      }

      default:
        return jsonError(400, `unknown action: ${action}`);
    }
  });
}
