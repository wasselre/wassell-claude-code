// ============================================================================
// campaign_group job (org-level). Deterministic + idempotent cross-platform
// grouping of ORGANIC content + PAID Meta ads into unified campaigns by the
// signature in campaignSignature.ts, plus reused-creative detection (exact media
// checksum shared across items — the strongest organic↔paid bridge). A second
// identical run creates no duplicate campaigns or events (upserts + dedup keys).
// Human corrections (member status confirmed/rejected/moved) are never undone.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { campaignSignature, groupingConfidence, type EnrichmentLike } from './campaignSignature.js';

const ALL_PROJECTS_MODEL = '220c49b9-de57-492d-9eca-c0d9f54fd40f';
const ACTIVE_DAYS = 30;

export interface CampaignGroupStats { campaigns: number; new_campaigns: number; members: number; reused_creatives: number; organic_to_paid: number; ended: number }

interface Item {
  kind: 'content' | 'ad';
  id: string;
  project: string | null;
  platform: string;
  publishedAt: string | null;
  enrichment: EnrichmentLike;
  offer: string | null;
  paymentPlan: string | null;
  ctas: string[];
  message: string | null;
  checksums: string[];
}

export async function runCampaignGroup(sb: SupabaseClient, orgId: string): Promise<CampaignGroupStats> {
  const stats: CampaignGroupStats = { campaigns: 0, new_campaigns: 0, members: 0, reused_creatives: 0, organic_to_paid: 0, ended: 0 };

  // project names for labels
  const { data: projRows } = await sb.from('unified_records').select('id, data').eq('model_id', ALL_PROJECTS_MODEL);
  const projName = new Map<string, string>((projRows ?? []).map((r) => [r.id as string, ((r.data ?? {}) as Record<string, unknown>).project_name as string ?? '']));

  // ── load organic content (enriched + published) with media checksums ──
  const { data: posts } = await sb.from('mkt_content_posts')
    .select('id, platform, published_at, mkt_content_enrichment(primary_project_id, result), mkt_content_media(checksum_sha256)')
    .eq('organization_id', orgId).eq('processing_status', 'processed');
  const items: Item[] = [];
  for (const p of posts ?? []) {
    const enr = (p.mkt_content_enrichment as Array<{ primary_project_id: string | null; result: Record<string, unknown> }> | null)?.[0];
    if (!enr) continue;
    const result = (enr.result ?? {}) as Record<string, unknown>;
    items.push({
      kind: 'content', id: p.id as string, project: enr.primary_project_id, platform: p.platform as string, publishedAt: p.published_at as string | null,
      enrichment: { is_general_branding: result.is_general_branding as boolean, offer: result.offer as string, payment_plan: result.payment_plan as string, campaign_message: result.campaign_message as string, objective: result.objective as string, content_type: result.content_type as string },
      offer: (result.offer as string) ?? null, paymentPlan: (result.payment_plan as string) ?? null, ctas: Array.isArray(result.ctas) ? (result.ctas as string[]) : [], message: (result.campaign_message as string) ?? null,
      checksums: ((p.mkt_content_media as Array<{ checksum_sha256: string | null }> | null) ?? []).map((m) => m.checksum_sha256).filter((c): c is string => !!c),
    });
  }

  // ── load paid Meta ads (attributed to a project) with creative fingerprint ──
  const { data: ads } = await sb.from('mkt_paid_ads')
    .select('id, platform, platform_started_at, headline, body, cta, creative_fingerprint, mkt_ad_attributions(project_id, review_status)')
    .eq('organization_id', orgId);
  for (const a of ads ?? []) {
    const attr = (a.mkt_ad_attributions as Array<{ project_id: string; review_status: string }> | null)?.find((x) => x.review_status !== 'rejected');
    const text = [a.headline, a.body].filter(Boolean).join(' ');
    items.push({
      kind: 'ad', id: a.id as string, project: attr?.project_id ?? null, platform: 'meta', publishedAt: a.platform_started_at as string | null,
      enrichment: { offer: text, campaign_message: (a.headline as string) ?? null, objective: 'paid_ad' },
      offer: null, paymentPlan: null, ctas: a.cta ? [a.cta as string] : [], message: (a.headline as string) ?? null,
      checksums: a.creative_fingerprint ? [a.creative_fingerprint as string] : [],
    });
  }

  // ── group by signature ──
  interface Group { sig: string; project: string; items: Item[]; offers: Set<string>; plans: Set<string>; ctas: Set<string>; platforms: Set<string>; messages: string[]; first: string | null; last: string | null }
  const groups = new Map<string, Group>();
  for (const it of items) {
    const sig = campaignSignature(orgId, it.project, it.enrichment);
    if (!sig) continue; // general branding / no distinguishing signal → not campaigned
    let g = groups.get(sig.signature);
    if (!g) { g = { sig: sig.signature, project: it.project!, items: [], offers: new Set(), plans: new Set(), ctas: new Set(), platforms: new Set(), messages: [], first: null, last: null }; groups.set(sig.signature, g); }
    g.items.push(it);
    if (it.offer) g.offers.add(it.offer);
    if (it.paymentPlan) g.plans.add(it.paymentPlan);
    for (const c of it.ctas) g.ctas.add(c);
    g.platforms.add(it.platform);
    if (it.message) g.messages.push(it.message);
    if (it.publishedAt) { if (!g.first || it.publishedAt < g.first) g.first = it.publishedAt; if (!g.last || it.publishedAt > g.last) g.last = it.publishedAt; }
  }

  const nowMs = Date.now();
  const sigToCampaignId = new Map<string, string>();
  for (const g of groups.values()) {
    // reused creatives within this campaign (same checksum across ≥2 members)
    const checksumCount = new Map<string, number>();
    for (const it of g.items) for (const c of new Set(it.checksums)) checksumCount.set(c, (checksumCount.get(c) ?? 0) + 1);
    const reused = [...checksumCount.values()].filter((n) => n >= 2).length;
    const organicToPaid = g.items.some((i) => i.kind === 'content') && g.items.some((i) => i.kind === 'ad');
    if (organicToPaid) stats.organic_to_paid++;
    stats.reused_creatives += reused;

    const isActive = g.last ? (nowMs - Date.parse(g.last)) / 86400000 <= ACTIVE_DAYS : true;
    const confidence = groupingConfidence({ members: g.items.length, platforms: g.platforms.size, reusedCreatives: reused, hasOffer: g.offers.size > 0 });
    const label = `${projName.get(g.project) ?? g.project.slice(0, 8)} — ${[...g.offers][0] ?? g.messages[0]?.slice(0, 40) ?? 'حملة'}`.slice(0, 120);
    const objective = g.items.some((i) => i.kind === 'ad') && g.items.some((i) => i.kind === 'content') ? 'omnichannel' : (g.items[0]?.enrichment.content_type ?? 'promotion');
    const evidence = { signals: ['project', g.offers.size ? 'offer' : 'message'], platforms: [...g.platforms], reused_creatives: reused, organic_to_paid: organicToPaid };

    const up = (await sb.rpc('mkt_campaign_upsert', {
      p_signature: g.sig, p_org: orgId, p_project: g.project, p_label: label, p_objective: objective,
      p_platforms: [...g.platforms], p_first: g.first, p_last: g.last, p_active: isActive,
      p_offers: [...g.offers], p_payment_plans: [...g.plans], p_ctas: [...g.ctas], p_key_message: g.messages[0] ?? null,
      p_reused: reused, p_confidence: confidence, p_evidence: evidence, p_version: 'cg-v1',
    })).data as Array<{ id: string; was_inserted: boolean }> | null;
    const campaignId = up?.[0]?.id; if (!campaignId) continue;
    sigToCampaignId.set(g.sig, campaignId);
    stats.campaigns++;
    if (up![0]!.was_inserted) { stats.new_campaigns++; await sb.rpc('mkt_campaign_event_emit', { p_campaign: campaignId, p_kind: 'new_campaign', p_dedup: `new_campaign:${g.sig}`, p_payload: { label } }); }

    // members
    for (const it of g.items) {
      const m = (await sb.rpc('mkt_campaign_member_upsert', { p_campaign: campaignId, p_member_type: it.kind, p_content_post: it.kind === 'content' ? it.id : null, p_paid_ad: it.kind === 'ad' ? it.id : null, p_signals: { platform: it.platform, offer: it.offer, message: it.message } })).data as Array<{ id: string; was_inserted: boolean }> | null;
      if (m?.[0]?.was_inserted) { stats.members++; await sb.rpc('mkt_campaign_event_emit', { p_campaign: campaignId, p_kind: 'new_creative', p_dedup: `new_creative:${it.kind}:${it.id}`, p_payload: { platform: it.platform } }); }
    }
    // platform + reuse events (dedup'd)
    for (const plat of g.platforms) await sb.rpc('mkt_campaign_event_emit', { p_campaign: campaignId, p_kind: 'new_platform', p_dedup: `new_platform:${g.sig}:${plat}`, p_payload: { platform: plat } });
    if (reused > 0) await sb.rpc('mkt_campaign_event_emit', { p_campaign: campaignId, p_kind: 'creative_reused', p_dedup: `creative_reused:${g.sig}:${reused}`, p_payload: { count: reused, organic_to_paid: organicToPaid } });
    if (organicToPaid) await sb.rpc('mkt_campaign_event_emit', { p_campaign: campaignId, p_kind: 'new_platform', p_dedup: `omnichannel:${g.sig}`, p_payload: { organic_to_paid: true } });
    if (!isActive) await sb.rpc('mkt_campaign_event_emit', { p_campaign: campaignId, p_kind: 'campaign_ended', p_dedup: `campaign_ended:${g.sig}:${g.last}`, p_payload: { last_seen: g.last } });
    await sb.rpc('mkt_campaign_refresh_rollups', { p_campaign: campaignId });
  }

  // ── cross-campaign reused-creative detection (organic↔paid across signatures) ──
  const byChecksum = new Map<string, Array<{ kind: string; id: string }>>();
  for (const it of items) for (const c of new Set(it.checksums)) { const arr = byChecksum.get(c) ?? []; arr.push({ kind: it.kind, id: it.id }); byChecksum.set(c, arr); }
  for (const [checksum, refs] of byChecksum) {
    if (refs.length < 2) continue;
    const hasContent = refs.some((r) => r.kind === 'content'); const hasAd = refs.some((r) => r.kind === 'ad');
    if (hasContent && hasAd) stats.organic_to_paid++; // an identical creative used both organically and as a paid ad
    void checksum;
  }

  return stats;
}
